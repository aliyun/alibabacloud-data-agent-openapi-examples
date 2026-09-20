import type { OutgoingHttpHeaders } from 'node:http';

import type { FastifyReply } from 'fastify';

import { HEARTBEAT_MS } from '@das/shared';

import { sessionSnapshotEvent, type DaemonEvent } from './events.js';
import type { SessionJournal } from './journal.js';

export interface SseOptions {
  journal: SessionJournal;
  /** 客户端视角的会话 id（alias 或 real），写进事件 data.sessionId。 */
  sessionId: string;
  /** 进程级事件纪元，响应头回给客户端，配合游标检测"进程重启过"。 */
  epoch: string;
  streamId: string;
  /** 客户端 `Last-Event-ID` 头（断线续传游标）；缺省 = 只看新事件。 */
  lastEventId: number | undefined;
  /** `?snapshot=1`：连接即附一条 session_snapshot（合成事件，不入 journal、无 id）。 */
  snapshot: boolean;
}

/**
 * 把 journal 分发成一条 SSE 长连接（`GET /session/:id/events`）。
 *
 * 帧格式对齐真 daemon：`id: <n>` + `event: <type>` + `data: {v:1,...}` 三行一帧。
 * hijack / CORS 头手动补写 / close+error 双监听 / 背压——这四件事的 why
 * 全部继承自 `ndjson.ts` 的 streamWire（那边每条注释在这里同样成立）。
 *
 * 与 streamWire 的关键差异：这里**没有**"上游迭代器释放"问题——journal 是纯内存，
 * 客户端断开只需停轮询；上游那一轮由 runner 独立消费，与这条连接无关。
 */
export async function streamSse(reply: FastifyReply, opts: SseOptions): Promise<void> {
  reply.hijack();
  const raw = reply.raw;

  // 必须把 reply 上已有的响应头（@fastify/cors 挂的 Access-Control-Allow-*）一起写出，
  // 否则浏览器拦下整条流（预检过了、实际请求却被 CORS 挡住）。
  const headers: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) headers[key] = value;
  }
  headers['content-type'] = 'text/event-stream; charset=utf-8';
  headers['cache-control'] = 'no-store, no-transform';
  headers.connection = 'keep-alive';
  headers['x-accel-buffering'] = 'no';
  headers['x-qwen-event-epoch'] = opts.epoch;
  headers['x-qwen-sse-stream-id'] = opts.streamId;
  raw.writeHead(200, headers);

  let closed = false;
  let cursor = opts.lastEventId ?? opts.journal.lastId();
  if (
    opts.lastEventId !== undefined &&
    opts.journal.lastId() > 0 &&
    opts.journal.firstId() > opts.lastEventId + 1
  ) {
    // 游标落在已不存在的区间（journal 触顶丢弃 / 进程重启）。真 daemon 此处强制
    // resync；v1 先尽力续播——从现存最旧事件开始，丢段比整个会话打不开轻。
    cursor = opts.journal.firstId() - 1;
  }

  let resolveClose!: () => void;
  const closeSignal = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const onClose = (): void => {
    if (!closed) {
      closed = true;
      resolveClose();
    }
  };
  raw.on('close', onClose);
  raw.on('error', onClose);

  /** 返回 write() 的结果：false = 内核缓冲满（背压）或已断开。 */
  const writeEvent = (event: DaemonEvent, id: number | undefined): boolean => {
    if (closed) return false;
    const lines: string[] = [];
    if (id !== undefined) lines.push(`id: ${id}`);
    lines.push(`event: ${event.type}`);
    lines.push(`data: ${JSON.stringify(event)}`);
    try {
      return raw.write(`${lines.join('\n')}\n\n`);
    } catch {
      // 对已销毁的 socket 写入会同步抛 ERR_STREAM_DESTROYED，按"客户端已断开"处理
      onClose();
      return false;
    }
  };

  if (opts.snapshot) {
    writeEvent(sessionSnapshotEvent(opts.sessionId), undefined);
  }

  try {
    while (!closed) {
      const entries = await Promise.race([
        opts.journal.waitForMore(cursor, HEARTBEAT_MS),
        closeSignal.then(() => null),
      ]);
      if (closed || entries === null) break;

      if (entries.length === 0) {
        // 心跳注释行：保活 + 让中间层别缓冲（不占事件 id 空间）。
        // write 返回 false 是背压不是断开——必须与内容帧同样等 drain（与 close 竞速），
        // 直接 break 会把"慢客户端"误杀成"连接关闭"。
        const flushed = writeHeartbeat();
        if (closed) break;
        if (!flushed) {
          await Promise.race([new Promise<void>((resolve) => raw.once('drain', resolve)), closeSignal]);
          if (closed) break;
        }
        continue;
      }

      let broke = false;
      for (const entry of entries) {
        const flushed = writeEvent(entry.event, entry.id);
        if (!flushed) {
          if (closed) {
            broke = true;
            break;
          }
          // 背压：等 drain，且必须与 close 竞速（慢客户端断开时 drain 永远不来）
          await Promise.race([new Promise<void>((resolve) => raw.once('drain', resolve)), closeSignal]);
          if (closed) {
            broke = true;
            break;
          }
        }
        cursor = entry.id;
      }
      if (broke) break;
    }
  } finally {
    raw.off('close', onClose);
    raw.off('error', onClose);
    if (!closed) raw.end();
  }

  function writeHeartbeat(): boolean {
    if (closed) return false;
    try {
      return raw.write(': hb\n\n');
    } catch {
      onClose();
      return false;
    }
  }
}
