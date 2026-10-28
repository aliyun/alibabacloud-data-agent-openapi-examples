import type { FastifyReply } from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';
import type { LiveContext } from '../live.js';
import { openSessionEvents, parseSse, type RawSseEvent } from '../openapi.js';
import { permissionRequestEvent, type DaemonEvent } from './events.js';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const json = (v: unknown): unknown => typeof v === 'string' ? JSON.parse(v) : v;

/** POP can wrap a daemon frame in Event, or expose the event's Data separately. */
export function remoteEvent(frame: RawSseEvent, sessionId: string): DaemonEvent | undefined {
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
  data = json(data ?? {});
  if (!object(data)) throw new Error('GetAgentSessionEvents 的事件缺少 data');
  const subject = data.sessionId ?? value.sessionId;
  if (subject !== undefined && subject !== sessionId) throw new Error('拒绝其他会话的事件');
  const rawId = value.id ?? value.Id ?? outer.Id ?? outer.id ?? frame.id;
  let id: number | undefined;
  if (rawId !== undefined && rawId !== '') {
    if (!/^\d+$/.test(String(rawId)) || !Number.isSafeInteger(Number(rawId))) throw new Error('无效的远端事件游标');
    id = Number(rawId);
  }
  const event: DaemonEvent = { v: 1, type, data, ...(id !== undefined ? { id } : {}) };
  if (typeof value.promptId === 'string') event.promptId = value.promptId;
  if (typeof value.originatorClientId === 'string') event.originatorClientId = value.originatorClientId;
  if (object(value._meta)) event._meta = value._meta;
  if (type === 'permission_request' && typeof data.requestId === 'string' && Array.isArray(data.options)) {
    const converted = permissionRequestEvent(sessionId, data as unknown as Parameters<typeof permissionRequestEvent>[1]);
    event.data = { ...data, ...converted.data };
  }
  return event;
}

/** Request-owned remote subscription; no local session state or completion controls. */
export async function streamRemoteEvents(reply: FastifyReply, ctx: LiveContext, sessionId: string,
  lastEventId: string | undefined): Promise<void> {
  const upstream = await openSessionEvents(ctx.client, sessionId, lastEventId);
  const contentType = Object.entries(upstream.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    upstream.body.destroy();
    throw new Error('GetAgentSessionEvents 未返回 text/event-stream');
  }
  const raw = reply.raw;
  let closed = raw.destroyed;
  let resolveClose!: () => void;
  const closeSignal = new Promise<{ kind: 'close' }>(resolve => { resolveClose = () => resolve({ kind: 'close' }); });
  const close = () => { closed = true; upstream.body.destroy(); resolveClose(); };
  raw.on('close', close); raw.on('error', close);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    if (closed) return;
    reply.hijack();
    const headers: OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(reply.getHeaders())) if (value !== undefined) headers[key] = value;
    raw.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no',
      'x-qwen-event-epoch': `openapi:${ctx.cfg.regionId}:${sessionId}`, 'x-qwen-sse-stream-id': crypto.randomUUID() });
    heartbeat = setInterval(() => { if (!closed && !raw.writableNeedDrain) raw.write(': hb\n\n'); }, 15_000);
    const iterator = parseSse(upstream.body)[Symbol.asyncIterator]();
    while (!closed) {
      const incoming = await Promise.race([iterator.next().then(result => ({ kind: 'remote' as const, result })), closeSignal]);
      if (incoming.kind === 'close' || incoming.result.done) break;
      const event = remoteEvent(incoming.result.value, sessionId);
      if (!event) continue;
      const chunk = `${event.id === undefined ? '' : `id: ${event.id}\n`}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      if (!raw.write(chunk)) await new Promise<void>(resolve => {
        const done = () => { raw.off('drain', done); raw.off('close', done); raw.off('error', done); resolve(); };
        raw.once('drain', done); raw.once('close', done); raw.once('error', done);
      });
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    upstream.body.destroy();
    raw.off('close', close); raw.off('error', close);
    if (!closed && !raw.writableEnded) raw.end();
  }
}
