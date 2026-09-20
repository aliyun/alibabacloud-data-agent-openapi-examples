import type { ApiError } from './errors.js';
import type { AcpFrame } from './frames.js';
import type { StopReason } from './constants.js';

/**
 * 前后端之间的流式 wire 协议：NDJSON，一行一个 JSON 对象。
 *
 * 为什么不用 SSE：前端无论如何都要手解（EventSource 不支持 POST body，而 prompt
 * 必须 POST），SSE 的 `data:` 转义是纯负担；更关键的是 SSE 的 `id:` /
 * `Last-Event-ID` 语义**暗示可以断点续传**，而 BeginLogOffset 实测是死参数、
 * 服务端根本没有增量续传——用 SSE 等于在协议层撒谎。
 *
 * 帧一律**原样透传**（`body` 就是上游那一帧，不重塑、不改名），
 * 这样 wire 形状与录制 fixture 同形，live 与 mock 才能共用同一个 reducer。
 * 后端唯一加工的地方是错误归一化。
 */
export type WireEvent =
  | WireMeta
  | WireFrame
  | WireHeartbeat
  | WireError
  | WireDone;

/** 流的第一条：告诉前端这一轮的 rid。 */
export interface WireMeta {
  type: 'meta';
  rid: string;
  sessionId: string;
  mock: boolean;
  startedAt: number;
}

export interface WireFrame {
  type: 'frame';
  rid: string;
  /**
   * 上游给的帧序号，可能缺失（归档合并态的帧就没有）。
   * 前端只用于展示与去重，**绝不持久化**：空闲约 5 分钟后服务端计数器会重置。
   */
  offset: number | undefined;
  body: AcpFrame;
}

/** 心跳：防中间层空闲回收连接，同时给前端一个判活信号（存活判定不能挂在 rAF 上）。 */
export interface WireHeartbeat {
  type: 'hb';
  t: number;
}

export interface WireError {
  type: 'error';
  rid: string;
  error: ApiError;
}

/**
 * 流的最后一条。
 *
 * `stopReason` 为空表示上游给了 Result 但原因不认识；而"生成器结束了却从未出现
 * Result.stopReason"不会走到 done，而是发一条 error(kind=stream_break)——
 * 静默截断不能当成功。
 */
export interface WireDone {
  type: 'done';
  rid: string;
  stopReason: StopReason | undefined;
  rawStopReason: string | undefined;
  frameCount: number;
}

export const WIRE_CONTENT_TYPE = 'application/x-ndjson';

/** 解析一行 wire 数据；不是合法对象或 type 不认识时返回 undefined。 */
export function parseWireLine(line: string): WireEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  if (type !== 'meta' && type !== 'frame' && type !== 'hb' && type !== 'error' && type !== 'done') {
    return undefined;
  }
  return value as WireEvent;
}
