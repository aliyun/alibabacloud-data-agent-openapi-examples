import { EventEmitter } from 'node:events';
import type { OutgoingHttpHeaders } from 'node:http';

import { describe, expect, it } from 'vitest';

import type { FastifyBaseLogger, FastifyReply } from 'fastify';

import { streamWire } from '../src/ndjson.js';
import type { WireEvent } from '@das/shared';

/**
 * 被 `hijack()` 接管的那条裸 socket 上的收尾逻辑。
 *
 * 这里每一个分支都对应一种**整进程级**故障，不是"这条请求失败"那么轻：
 * 不挂 error 监听 ⇒ 客户端半路断开的 ECONNRESET 以 uncaughtException 干掉服务；
 * 背压等待不与 close 竞速 ⇒ write 永不返回 ⇒ 在途锁永久持有，这个会话再也发不了第二轮；
 * 硬上限不生效 ⇒ 连接无限挂着。这些在真实链路上都要等几分钟才复现一次，
 * 所以用假 socket 把它们压到几十毫秒里钉死。
 */
class FakeRaw extends EventEmitter {
  written: string[] = [];
  ended = false;
  status: number | undefined;
  headers: OutgoingHttpHeaders | undefined;
  /** write 的返回值由测试控制：false 就是"内核缓冲满了"，用来模拟背压。 */
  flushResult = true;
  throwOnWrite: Error | undefined;

  writeHead(status: number, headers: OutgoingHttpHeaders): void {
    this.status = status;
    this.headers = headers;
  }

  write(chunk: string): boolean {
    if (this.throwOnWrite) throw this.throwOnWrite;
    this.written.push(chunk);
    return this.flushResult;
  }

  end(): void {
    this.ended = true;
  }

  get events(): WireEvent[] {
    return this.written.map((line) => JSON.parse(line) as WireEvent);
  }
}

interface Harness {
  raw: FakeRaw;
  reply: FastifyReply;
  warns: unknown[][];
}

function harness(rawOverrides: Partial<FakeRaw> = {}): Harness {
  const raw = Object.assign(new FakeRaw(), rawOverrides);
  const warns: unknown[][] = [];
  const log = { warn: (...args: unknown[]) => warns.push(args) } as unknown as FastifyBaseLogger;
  const reply = {
    hijack() {
      /* 显式接管：框架从此不再负责这条响应 */
    },
    raw,
    getHeaders: () => ({ 'access-control-allow-origin': 'http://localhost:5199' }),
    log,
  } as unknown as FastifyReply;
  return { raw, reply, warns };
}

/** 永远不返回的 next()：模拟上游正在算（长轮里几十秒不吐帧是常态）。 */
function hangingSource(onReturn?: () => void): AsyncIterable<WireEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<WireEvent>>(() => {}),
        return: async () => {
          onReturn?.();
          return { done: true, value: undefined } as IteratorResult<WireEvent>;
        },
      };
    },
  };
}

const meta: WireEvent = {
  type: 'meta',
  rid: 'rid-1',
  marker: 'DAS-TEST01',
  sessionId: 'sess-1',
  mock: false,
  startedAt: 1_000,
};
const frame = (offset: number): WireEvent => ({
  type: 'frame',
  rid: 'rid-1',
  offset,
  body: { Jsonrpc: '2.0', RequestId: 'rid-1', Params: { update: { sessionUpdate: 'agent_message_chunk' } } },
});
const done: WireEvent = { type: 'done', rid: 'rid-1', stopReason: 'end_turn', rawStopReason: 'end_turn', frameCount: 2 };

async function* sourceOf(events: WireEvent[], onReturn?: () => void): AsyncGenerator<WireEvent> {
  try {
    for (const e of events) yield e;
  } finally {
    onReturn?.();
  }
}

describe('streamWire：正常收尾', () => {
  it('响应头带上 CORS 与 no-transform，写完 end()，量都记对', async () => {
    const { raw, reply } = harness();

    const outcome = await streamWire(reply, sourceOf([meta, frame(1), frame(2), done]), {
      log: reply.log,
      sessionId: 'sess-1',
      heartbeatMs: 60_000,
      hardLimitMs: 5_000,
    });

    expect(raw.status).toBe(200);
    expect(raw.headers?.['content-type']).toBe('application/x-ndjson; charset=utf-8');
    // hijack 之后框架不再发响应头，@fastify/cors 挂上去的那几个必须自己抄过来，
    // 漏了的话浏览器预检过了、实际请求却被 CORS 挡住
    expect(raw.headers?.['access-control-allow-origin']).toBe('http://localhost:5199');
    expect(raw.headers?.['cache-control']).toBe('no-store, no-transform');
    expect(raw.headers?.['x-accel-buffering']).toBe('no');

    expect(raw.ended).toBe(true);
    expect(raw.events.map((e) => e.type)).toEqual(['meta', 'frame', 'frame', 'done']);
    expect(outcome.endedBy).toBe('source');
    expect(outcome.eventsWritten).toBe(4);
    expect(outcome.framesWritten).toBe(2);
    expect(outcome.rid).toBe('rid-1');
    expect(outcome.stopReason).toBe('end_turn');
    expect(outcome.error).toBeUndefined();
    // 收尾之后不该留下监听器：这条 socket 已经被 end()，留着只会 accumulate
    expect(raw.listenerCount('close')).toBe(0);
    expect(raw.listenerCount('error')).toBe(0);
  });
});

describe('streamWire：onRid 的触发时机', () => {
  it('第一个带 rid 的事件写出去就回调，不必等流结束', async () => {
    const { raw, reply } = harness();
    const seen: string[] = [];

    // 手写迭代器而不是 async generator：generator 在 next() 挂住时 return() 要排在其后，
    // 得等满 ndjson.ts 里那 5s 宽限才收尾；这里只需要"next() 永不返回"。
    // 吐两条带 rid 的事件再挂住：这样"只回调一次"才验得到（只吐一条时去掉去重也看不出来）。
    const metaThenHang: AsyncIterable<WireEvent> = {
      [Symbol.asyncIterator]() {
        let n = 0;
        return {
          next: () => {
            n += 1;
            if (n === 1) return Promise.resolve({ done: false, value: meta } as IteratorResult<WireEvent>);
            if (n === 2) return Promise.resolve({ done: false, value: frame(1) } as IteratorResult<WireEvent>);
            return new Promise<IteratorResult<WireEvent>>(() => {});
          },
          return: async () => ({ done: true, value: undefined } as IteratorResult<WireEvent>),
        };
      },
    };

    const pending = streamWire(reply, metaThenHang, {
      log: reply.log,
      sessionId: 'sess-1',
      heartbeatMs: 60_000,
      hardLimitMs: 5_000,
      onRid: (rid) => seen.push(rid),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 此刻流还没结束（pending 未 settle），而 rid 已经交出去了。
    // 唯一读者是"第二个请求撞上在途锁"那条日志：它要报的是**正在跑**的那一轮，
    // 等流结束再回填就等于把这条线索丢掉。
    expect(seen).toEqual(['rid-1']);
    raw.emit('close');
    await pending;
    // 只回调一次：后续每一帧都带同一个 rid，重复回调会让调用方的日志噪音翻倍
    expect(seen).toEqual(['rid-1']);
  });
});

describe('streamWire：客户端断开', () => {
  it('背压等待被 close 打断，promise 会 settle，上游迭代器被释放，并记下"服务端仍在执行"', async () => {
    // write 恒返回 false = 慢客户端把内核缓冲塞满。此时若只等 drain，
    // 客户端一断开 drain 就永远不来，write 不返回 ⇒ 在途锁永久持有。
    const { raw, reply, warns } = harness({ flushResult: false });
    let returned = false;

    async function* backpressureSource(): AsyncGenerator<WireEvent> {
      try {
        yield meta; // 这一条 write 返回 false，于是挂在 drain 上
        await new Promise<never>(() => {});
      } finally {
        returned = true;
      }
    }

    const pending = streamWire(reply, backpressureSource(), {
      log: reply.log,
      sessionId: 'sess-1',
      heartbeatMs: 60_000,
      hardLimitMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    raw.emit('close');

    // 这次 await 能返回本身就是断言：不与 close 竞速的话它会永远挂着
    const outcome = await pending;
    expect(outcome.endedBy).toBe('client-close');
    expect(returned).toBe(true);
    expect(warns.some((args) => String(args[1]).includes('未调用 cancel'))).toBe(true);
  });

  it('上游挂在 next() 里时断开也看得见（close 参与竞速），endedBy 记 client-close', async () => {
    const { raw, reply } = harness();
    let returned = false;

    const pending = streamWire(reply, hangingSource(() => (returned = true)), {
      log: reply.log,
      sessionId: 'sess-1',
      heartbeatMs: 60_000,
      hardLimitMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    raw.emit('close');

    const outcome = await pending;
    expect(outcome.endedBy).toBe('client-close');
    expect(returned).toBe(true);
    expect(raw.ended).toBe(false);
  });

  it('对已销毁的 socket 写入同步抛错 ⇒ 当成断开，不往上冒成 uncaughtException', async () => {
    const { raw, reply } = harness({
      throwOnWrite: Object.assign(new Error('write after end'), { code: 'ERR_STREAM_DESTROYED' }),
    });

    const outcome = await streamWire(reply, sourceOf([meta, frame(1)]), {
      log: reply.log,
      sessionId: 'sess-1',
      heartbeatMs: 60_000,
      hardLimitMs: 5_000,
    });

    expect(outcome.endedBy).toBe('client-close');
    expect(outcome.eventsWritten).toBe(0);
  });
});

describe('streamWire：硬上限与心跳', () => {
  it('撞上限时主动收尾成 stream_break，期间心跳一直在写', async () => {
    const { raw, reply } = harness();

    const outcome = await streamWire(reply, hangingSource(), {
      log: reply.log,
      sessionId: 'sess-1',
      heartbeatMs: 20,
      hardLimitMs: 120,
    });

    expect(outcome.endedBy).toBe('hard-limit');
    expect(raw.ended).toBe(true);

    const events = raw.events;
    const heartbeats = events.filter((e) => e.type === 'hb');
    // 心跳是给前端的判活信号，也是防中间层按空闲回收连接；上限 120ms / 心跳 20ms ⇒ 至少该有几条
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);

    const last = events[events.length - 1] as Extract<WireEvent, { type: 'error' }>;
    expect(last.type).toBe('error');
    expect(last.error.kind).toBe('stream_break');
    // 静默截断不能当成功：这条 error 是"撞墙"与"正常结束"在 UI 上的唯一区别
    expect(last.error.retryable).toBe(false);
  });
});
