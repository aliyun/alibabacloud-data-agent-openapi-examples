import type { FastifyReply } from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';
import type { LiveContext } from '../live.js';
import { openSessionEvents, parseSse, type RawSseEvent } from '../openapi.js';
import { permissionRequestEvent, type DaemonEvent } from './events.js';
import { apiError, withRequestId } from '@das/shared';
import { headerRequestId, toApiError } from '../normalize.js';
import { SdkError } from '../sdk.js';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const json = (v: unknown): unknown => typeof v === 'string' ? JSON.parse(v) : v;

/** POP can wrap a daemon frame in Event, or expose the event's Data separately. */
function decodeRemoteEvent(frame: RawSseEvent, sessionId: string, nativeSessionId?: string): DaemonEvent | undefined {
  if (frame.data === '') return undefined;
  const outer = json(frame.data);
  if (!object(outer)) throw new Error('GetAgentSessionEvents 返回无效事件');
  if (outer.Error || outer.error || outer.Code || outer.code) throw new Error('GetAgentSessionEvents 返回上游错误');
  let value: unknown = outer;
  const eventField = outer.Event ?? outer.event;
  if (eventField !== undefined) {
    if (typeof eventField === 'string' && !eventField.trim().startsWith('{')) {
      const payload = json(outer.Data ?? outer.data);
      value = object(payload) && typeof payload.type === 'string' ? payload : { type: eventField, data: payload };
    } else value = json(eventField);
  } else if (outer.type === undefined) {
    const payload = json(outer.Data ?? outer.data);
    if (object(payload) && typeof payload.type === 'string') value = payload;
  }
  if (!object(value)) throw new Error('GetAgentSessionEvents 返回无效事件载荷');
  for (const [capital, lower] of [['SessionId', 'sessionId'], ['Update', 'update'], ['StopReason', 'stopReason'], ['PromptId', 'promptId']]) {
    if (value[lower!] === undefined && value[capital!] !== undefined) value[lower!] = value[capital!];
  }
  let type = value.type ?? value.Type ?? frame.event;
  let data = value.data ?? value.Data;
  if (!type && object(value.update)) { type = 'session_update'; data = value; }
  if (!type && typeof value.stopReason === 'string') { type = 'turn_complete'; data = value; }
  if (typeof type !== 'string') {
    // POP's acknowledgement is not a daemon event.
    if (Object.keys(value).every(key => ['RequestId', 'requestId'].includes(key))) return undefined;
    throw new Error('GetAgentSessionEvents 的事件缺少 type');
  }
  if (/[\r\n]/.test(type)) throw new Error('无效的远端事件类型');
  if (frame.event !== undefined && frame.event !== 'message' && frame.event !== type) throw invalidReplay();
  data = json(data ?? {});
  if (!object(data)) throw new Error('GetAgentSessionEvents 的事件缺少 data');
  const subject = data.sessionId ?? value.sessionId;
  for (const supplied of [data.sessionId, value.sessionId]) {
    if (supplied !== undefined && supplied !== sessionId && supplied !== nativeSessionId) throw invalidReplay();
  }
  for (const promptId of [value.promptId, data.promptId]) {
    if (promptId !== undefined && (typeof promptId !== 'string' || !promptId)) throw invalidReplay();
  }
  if (value.promptId !== undefined && data.promptId !== undefined && value.promptId !== data.promptId) throw invalidReplay();
  if (['turn_complete', 'turn_error'].includes(type) && value.promptId === undefined && data.promptId === undefined) throw invalidReplay();
  const projected: Record<string, unknown> = subject !== undefined && nativeSessionId !== undefined ? { ...data, sessionId } : data;
  const rawId = value.id ?? value.Id ?? outer.Id ?? outer.id ?? frame.id;
  const control = ['stream_open', 'replay_complete', 'slow_client_warning'].includes(type);
  if (control && value.id !== undefined) throw new Error('控制事件不能签发原生业务游标');
  let id: number | undefined;
  if (!control && rawId !== undefined && rawId !== '') {
    if (!/^\d+$/.test(String(rawId)) || !Number.isSafeInteger(Number(rawId))) throw new Error('无效的远端事件游标');
    id = Number(rawId);
    if (frame.id !== undefined && frame.id !== '' && Number(frame.id) !== id) throw new Error('SSE 与事件游标不一致');
  }
  const event: DaemonEvent = { v: 1, type, data: projected, ...(id !== undefined ? { id } : {}) };
  const promptId = value.promptId ?? projected.promptId;
  if (typeof promptId === 'string') event.promptId = promptId;
  if (typeof value.originatorClientId === 'string') event.originatorClientId = value.originatorClientId;
  if (object(value._meta)) event._meta = value._meta;
  if (type === 'permission_request' && typeof projected.requestId === 'string' && Array.isArray(projected.options)) {
    const converted = permissionRequestEvent(sessionId, projected as unknown as Parameters<typeof permissionRequestEvent>[1]);
    event.data = { ...projected, ...converted.data };
  }
  return event;
}

export function remoteEvent(frame: RawSseEvent, sessionId: string, nativeSessionId?: string): DaemonEvent | undefined {
  try { return decodeRemoteEvent(frame, sessionId, nativeSessionId); }
  catch { throw invalidReplay(); }
}

export interface RemoteIdentity { eventEpoch: string; nativeSessionId: string }
export const invalidReplay = () => new SdkError(apiError('stream_break', '原生事件续传契约校验失败'));

/** One request owns one route/epoch and replay receipt; other prompts still participate in sequence verification. */
export class RemoteReplay {
  identity?: RemoteIdentity;
  receipt = false;
  scanned?: number;
  private count = 0;
  constructor(readonly sessionId: string, readonly cursor?: string, readonly epoch?: string) {
    if (epoch !== undefined && (cursor === undefined || !/^[A-Za-z0-9_-]{1,64}$/.test(epoch))) throw invalidReplay();
    if (cursor !== undefined) {
      if (!/^[0-9]{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw invalidReplay();
      this.scanned = Number(cursor);
    }
  }
  take(frame: RawSseEvent): DaemonEvent | undefined {
    let event: DaemonEvent | undefined;
    try { event = remoteEvent(frame, this.sessionId, this.identity?.nativeSessionId); }
    catch { throw invalidReplay(); }
    if (!event) return undefined;
    if (['stream_open', 'replay_complete', 'slow_client_warning'].includes(event.type) && frame.id !== undefined
      && (frame.id === '' ? event.type !== 'stream_open' && !(event.type === 'replay_complete' && event.data.replayedCount === 0)
        : !/^[0-9]+$/.test(frame.id) || Number(frame.id) !== this.scanned)) throw invalidReplay();
    if (event.type === 'stream_open') {
      const { eventEpoch, nativeSessionId, sessionId } = event.data;
      if (this.identity || event.id !== undefined || sessionId !== this.sessionId
        || typeof eventEpoch !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(eventEpoch)
        || typeof nativeSessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(nativeSessionId)
        || (this.epoch !== undefined && this.epoch !== eventEpoch)) throw invalidReplay();
      this.identity = { eventEpoch, nativeSessionId };
      return event;
    }
    if (!this.identity || ['stream_error', 'state_resync_required', 'client_evicted', 'session_died'].includes(event.type)
      || event.type === 'turn_error' && !event.promptId && !event.data.promptId) throw invalidReplay();
    if (event.type === 'replay_complete') {
      const count = event.data.replayedCount;
      if (this.receipt || event.id !== undefined || !Number.isSafeInteger(count) || Number(count) < 0) throw invalidReplay();
      if (count !== this.count || (this.cursor !== undefined && this.scanned !== Number(this.cursor) + this.count)) throw invalidReplay();
      const values = [event.data.lastReplayedEventId, event.data.lastEventId].filter(value => value !== undefined);
      if (Number(count) === 0 ? values.length !== 0 : values.length === 0 || values.some(value => value !== this.scanned)) throw invalidReplay();
      this.receipt = true;
      return event;
    }
    if (event.type === 'slow_client_warning') {
      if (event.id !== undefined) throw invalidReplay();
      return event;
    }
    if (event.id === undefined || event.id < 1 || (this.scanned !== undefined && event.id !== this.scanned + 1)) throw invalidReplay();
    this.scanned = event.id;
    if (!this.receipt) this.count++;
    return event;
  }
}

/** SDK core owns signing and transport. Every subscription is disposed with its downstream reader. */
export async function* remoteEvents(ctx: LiveContext, sessionId: string, cursor?: string, epoch?: string,
  options: { signal?: AbortSignal; timeoutMs?: number; onOpen?: (identity: RemoteIdentity, requestId?: string) => void } = {}): AsyncGenerator<DaemonEvent> {
  const upstream = await openSessionEvents(ctx.client, sessionId, cursor, epoch, options.timeoutMs);
  const requestId = headerRequestId(upstream.headers);
  const abort = () => upstream.body.destroy();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const contentType = Object.entries(upstream.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
    if (upstream.statusCode !== 200 || !/^text\/event-stream(?:\s*;.*)?$/i.test(contentType)) throw invalidReplay();
    const replay = new RemoteReplay(sessionId, cursor, epoch);
    const suffix: DaemonEvent[] = [];
    let suffixBytes = 0;
    for await (const frame of parseSse(upstream.body)) {
      const event = replay.take(frame);
      if (!event) continue;
      if (event.type === 'stream_open') {
        const headerEpoch = Object.entries(upstream.headers).find(([key]) => key.toLowerCase() === 'x-qwen-event-epoch')?.[1];
        if (headerEpoch && headerEpoch !== replay.identity!.eventEpoch) throw invalidReplay();
        options.onOpen?.(replay.identity!, requestId);
      }
      if (cursor !== undefined && !replay.receipt && (suffix.length || ['turn_complete', 'turn_error'].includes(event.type))) {
        suffixBytes += Buffer.byteLength(JSON.stringify(event));
        if (suffix.length >= 4096 || suffixBytes > 4 * 1024 * 1024) throw invalidReplay();
        suffix.push(event);
        continue;
      }
      if (event.type === 'replay_complete') {
        for (const buffered of suffix) yield buffered;
        suffix.length = 0;
      }
      yield event;
    }
    if (cursor !== undefined && !replay.receipt) throw invalidReplay();
  } catch (error) {
    throw new SdkError(withRequestId(toApiError(error, 'GetAgentSessionEvents'), requestId));
  } finally {
    options.signal?.removeEventListener('abort', abort);
    upstream.body.destroy();
  }
}

/** Commit browser response headers only after the complete verified opener has supplied the actual native epoch. */
export async function streamRemoteEvents(reply: FastifyReply, ctx: LiveContext, sessionId: string,
  lastEventId: string | undefined, epoch?: string): Promise<void> {
  const raw = reply.raw;
  const closing = new AbortController();
  const close = () => closing.abort();
  raw.on('close', close); raw.on('error', close);
  let requestId: string | undefined;
  let identity: RemoteIdentity | undefined;
  const events = remoteEvents(ctx, sessionId, lastEventId, epoch, { signal: closing.signal,
    onOpen: (value, id) => { identity = value; requestId = id; } });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const first = await events.next();
    if (raw.destroyed || closing.signal.aborted) return;
    if (first.done || first.value.type !== 'stream_open' || !identity) throw invalidReplay();
    if (requestId) reply.header('x-acs-request-id', requestId);
    const headers: OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(reply.getHeaders())) if (value !== undefined) headers[key] = value;
    reply.hijack();
    raw.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no',
      'x-qwen-event-epoch': identity.eventEpoch, 'x-qwen-sse-stream-id': crypto.randomUUID() });
    heartbeat = setInterval(() => { if (!raw.destroyed && !raw.writableNeedDrain) raw.write(': hb\n\n'); }, 15_000);
    let next: IteratorResult<DaemonEvent> = first;
    while (!next.done && !closing.signal.aborted) {
      const event = next.value;
      const chunk = `${event.id === undefined ? '' : `id: ${event.id}\n`}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      if (!raw.write(chunk)) await new Promise<void>(resolve => {
        const done = () => { raw.off('drain', done); raw.off('close', done); raw.off('error', done); resolve(); };
        raw.once('drain', done); raw.once('close', done); raw.once('error', done);
      });
      if (!closing.signal.aborted) next = await events.next();
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    closing.abort();
    await events.return(undefined).catch(() => {});
    raw.off('close', close); raw.off('error', close);
    if (reply.sent && !raw.destroyed && !raw.writableEnded) raw.end();
  }
}
