import type { OutgoingHttpHeaders } from 'node:http';

import type { FastifyBaseLogger, FastifyReply } from 'fastify';

import {
  HEARTBEAT_MS,
  STREAM_HARD_LIMIT_MS,
  WIRE_CONTENT_TYPE,
  streamBreakWithoutTerminal,
  type ApiError,
  type WireEvent,
} from '@das/shared';

export interface StreamOutcome {
  rid: string | undefined;
  framesWritten: number;
  eventsWritten: number;
  stopReason: string | undefined;
  error: ApiError | undefined;
  /** 流是怎么结束的：源正常收尾 / 客户端断开 / 撞硬上限。 */
  endedBy: 'source' | 'client-close' | 'hard-limit';
  elapsedMs: number;
}

export interface StreamOptions {
  log: FastifyBaseLogger;
  sessionId: string;
  heartbeatMs?: number;
  hardLimitMs?: number;
  /**
   * 第一次从事件里认出 rid 时回调一次。
   *
   * rid 是上游给的，事先不知道；而调用方需要在**流进行中**就拿到它——
   * 在途锁被第二个请求撞上时要能报出"正在跑的是哪一轮"，等流结束再回填就没有意义了。
   */
  onRid?: (rid: string) => void;
}

const DEADLINE = Symbol('deadline');
const CLOSED = Symbol('closed');
const TIMED_OUT_RETURN = Symbol('return-timeout');

/**
 * 等上游迭代器释放的宽限时长。
 * 超过就放手并记日志——上游那一轮不会因为我们松手而停下，无限等只会把挂死换个位置。
 */
const RETURN_GRACE_MS = 5_000;

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT_RETURN> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT_RETURN>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT_RETURN), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 把 wire 事件流写到一条被 `hijack()` 接管的裸 socket 上。
 *
 * 为什么 hijack：Fastify 的 reply 是"一次性 send"模型，而这里要的是一条
 * 持续几分钟、边算边写、客户端随时可能断开的长连接。把"这条路由接管裸 socket"
 * 写成显式代码，比用一堆 reply.raw 偷偷绕开框架要诚实得多。
 *
 * 四个必须做对的细节，每一个都对应一个真实故障模式：
 *  1. **心跳**（默认 15s）：防中间层按空闲回收连接，同时给前端一个判活信号——
 *     前端的存活判定绝不能挂在 requestAnimationFrame 上（后台标签会暂停）。
 *  2. **背压**：901 帧的长轮遇上慢客户端时 `write()` 会返回 false，
 *     不 await drain 就是往 Node 侧内存里堆。
 *  3. **close 时 `it.return()`**：客户端断开要释放上游迭代器；
 *     但**绝不调用 cancel、绝不重发**——服务端那一轮还在跑，重发等于写两遍。
 *  4. **硬上限**（默认 330s）：对齐实测 218~258s 的断流墙，主动收尾成 stream_break，
 *     而不是让连接无限挂着。用 Promise.race 是因为上游可能卡在 `next()` 里不返回。
 */
export async function streamWire(
  reply: FastifyReply,
  events: AsyncIterable<WireEvent>,
  opts: StreamOptions,
): Promise<StreamOutcome> {
  const startedAt = Date.now();
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const hardLimitMs = opts.hardLimitMs ?? STREAM_HARD_LIMIT_MS;

  reply.hijack();
  const raw = reply.raw;

  // 必须把 reply 上已有的响应头一起写出去：@fastify/cors 在 onRequest 阶段
  // 就把 Access-Control-Allow-* 挂在 reply 上了，而 hijack 之后框架不再负责发送，
  // 漏掉这一步浏览器会拦下整条流（预检过了、实际请求却被 CORS 挡住，极难查）。
  const headers: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) headers[key] = value;
  }
  headers['content-type'] = `${WIRE_CONTENT_TYPE}; charset=utf-8`;
  headers['cache-control'] = 'no-store, no-transform';
  headers.connection = 'keep-alive';
  // 反代（nginx 等）默认会缓冲响应，这一行让它别缓冲
  headers['x-accel-buffering'] = 'no';
  raw.writeHead(200, headers);

  const outcome: StreamOutcome = {
    rid: undefined,
    framesWritten: 0,
    eventsWritten: 0,
    stopReason: undefined,
    error: undefined,
    endedBy: 'source',
    elapsedMs: 0,
  };

  let closed = false;
  let timedOut = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  // 两个"该收尾了"的信号用 sentinel 而不是 throw：收尾要写日志、清定时器、限时释放迭代器。
  let resolveDeadline!: (value: typeof DEADLINE) => void;
  let resolveClose!: (value: typeof CLOSED) => void;
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    resolveDeadline = resolve;
  });
  const closeSignal = new Promise<typeof CLOSED>((resolve) => {
    resolveClose = resolve;
  });
  /** 让任何等待都能被"客户端已断开"打断；落败的那个 promise 之后 settle 也无人再关心。 */
  const raceWithClose = <T>(p: Promise<T>): Promise<T | typeof CLOSED> =>
    Promise.race([p, closeSignal]);

  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    resolveDeadline(DEADLINE);
  }, hardLimitMs);

  /**
   * close / error 都走这里，因为 hijack 之后这条 socket 的错误没有任何人会接：
   * 不挂 `error` 监听时，客户端半路断开导致的 ECONNRESET / EPIPE 会以
   * uncaughtException 的形式直接干掉整个进程（不是这条请求失败，是服务全挂）。
   */
  const onClose = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    resolveClose(CLOSED);
  };
  raw.on('close', onClose);
  raw.on('error', onClose);

  heartbeat = setInterval(() => {
    if (closed) return;
    // 心跳只有一行，不参与背压等待：真要堵住了，堵住的是内容帧，不是心跳。
    try {
      raw.write(`${JSON.stringify({ type: 'hb', t: Date.now() } satisfies WireEvent)}\n`);
    } catch {
      onClose();
    }
  }, heartbeatMs);

  async function write(event: WireEvent): Promise<boolean> {
    if (closed) return false;
    let flushed: boolean;
    try {
      flushed = raw.write(`${JSON.stringify(event)}\n`);
    } catch {
      // 对已销毁的 socket 写入会同步抛 ERR_STREAM_DESTROYED；这里当成"客户端已断开"。
      onClose();
      return false;
    }
    /**
     * 背压等待必须与 close 竞速。
     *
     * 只等 `drain` 的话：慢客户端把内核缓冲塞满 → write 返回 false → 我们挂在这里，
     * 此时客户端断开，`drain` 永远不会来。write() 不返回 ⇒ 下面的 finally 不执行 ⇒
     * 心跳定时器泄漏、上游迭代器不释放、`raw.end()` 不调用、整个 promise 不 settle ⇒
     * 调用方（routes/prompt.ts）的在途锁**永久持有**，这个会话再也发不了第二轮。
     */
    if (!flushed) await raceWithClose(new Promise<void>((resolve) => raw.once('drain', resolve)));
    if (closed) return false;
    outcome.eventsWritten += 1;
    if (event.type === 'frame') outcome.framesWritten += 1;
    if (event.type === 'meta' || event.type === 'frame' || event.type === 'error' || event.type === 'done') {
      if (event.rid && outcome.rid === undefined) opts.onRid?.(event.rid);
      if (event.rid) outcome.rid = event.rid;
    }
    if (event.type === 'done') outcome.stopReason = event.rawStopReason;
    if (event.type === 'error') outcome.error = event.error;
    return true;
  }

  const iterator = events[Symbol.asyncIterator]();

  try {
    for (;;) {
      if (closed) {
        outcome.endedBy = 'client-close';
        break;
      }
      if (timedOut) {
        outcome.endedBy = 'hard-limit';
        break;
      }

      /**
       * close 必须参与竞速，否则"客户端断开时释放上游迭代器"这句承诺是假的：
       * 901 帧的长轮里 `next()` 可能几十秒不返回（上游在算），这期间断开连接
       * 我们完全看不见，只能等 next() 自己回来才发现 socket 早没了。
       *
       * 落败的 `next()` 不会变成 unhandledRejection：`Promise.race` 会给**所有**输入
       * 挂上 handler（已实测），所以它稍后拒绝也是被吞掉的。
       */
      const next = await Promise.race([iterator.next(), deadline, closeSignal]);
      if (next === DEADLINE) {
        outcome.endedBy = 'hard-limit';
        break;
      }
      if (next === CLOSED) {
        outcome.endedBy = 'client-close';
        break;
      }
      if (next.done) break;
      if (!(await write(next.value))) {
        outcome.endedBy = 'client-close';
        break;
      }
    }

    if (outcome.endedBy === 'hard-limit') {
      await write({
        type: 'error',
        rid: outcome.rid ?? '',
        error: streamBreakWithoutTerminal(outcome.framesWritten),
      });
    }
  } finally {
    clearInterval(heartbeat);
    // 每条流都留一个 330s 的定时器，不清理的话事件循环要等它自己走完才可能退出。
    clearTimeout(deadlineTimer);
    raw.off('close', onClose);
    raw.off('error', onClose);
    /**
     * 客户端断开时释放上游迭代器。
     *
     * 日志必须写清楚"服务端仍在执行"：这一轮 prompt 是写操作，断开连接不会停掉它，
     * 而 CancelAgentSession 实测不下达执行端（返回 503）。所以这里既不 cancel 也不重发，
     * 结果稍后拉历史能看到。
     */
    if (outcome.endedBy !== 'source') {
      opts.log.warn(
        {
          sessionId: opts.sessionId,
          rid: outcome.rid,
          endedBy: outcome.endedBy,
          framesWritten: outcome.framesWritten,
          elapsedMs: Date.now() - startedAt,
        },
        '流提前结束：服务端那一轮可能仍在执行；未调用 cancel，也不会重发',
      );
    }
    /**
     * `return()` 也要限时。
     *
     * 上游那一侧的连接不随客户端断开而关闭，所以 `next()` 可能还挂在网络读上；
     * 异步生成器的 `return()` 会排在那个未完成的 `next()` 之后，无限等下去
     * 就等于把上面刚修好的挂死换了个位置。等不到就记日志走人：
     * 上游那一轮本来也不会因为我们放手而停下。
     */
    try {
      const returned = await raceTimeout(
        Promise.resolve().then(() => iterator.return?.()),
        RETURN_GRACE_MS,
      );
      if (returned === TIMED_OUT_RETURN) {
        opts.log.warn(
          { sessionId: opts.sessionId, rid: outcome.rid, graceMs: RETURN_GRACE_MS },
          `上游迭代器在 ${RETURN_GRACE_MS}ms 内没有释放（仍挂着一次未完成的 next），放弃等待`,
        );
      }
    } catch (err) {
      opts.log.warn({ err }, '释放上游迭代器时出错（已忽略）');
    }
    if (!closed) raw.end();
    outcome.elapsedMs = Date.now() - startedAt;
  }

  return outcome;
}
