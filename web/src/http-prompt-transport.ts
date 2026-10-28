import { DaemonHttpError, type DaemonClient, type DaemonEvent, type DaemonSessionClient, type PromptResult } from '@qwen-code/sdk/daemon';
import { STOP_REASONS } from '@das/shared';

export type PromptTransport = 'http-stream' | 'daemon';
type Outcome = { result: PromptResult; error?: never } | { error: Error; result?: never };
interface RequestState {
  sessionId: string;
  promptId: string;
  controller: AbortController;
  ready: boolean;
  publish: boolean;
  delivered: Set<symbol>;
  outcome?: Outcome;
  finished: Promise<Outcome>;
  cleanup: () => void;
}
interface SessionState { cursor?: number; epoch?: string; listeners: Set<() => void>; subscribers: Set<symbol> }
const MAX_REQUESTS = 64;
const MAX_LINE = 1024 * 1024;

/** Consume this request's result independently of the Events subscriber; never render its content twice. */
async function consume(body: ReadableStream<Uint8Array>): Promise<PromptResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        if (newline > MAX_LINE) throw new Error('请求流超出单帧上限');
        const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1);
        if (!line) continue;
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || !('type' in value)) throw new Error('无效的请求流事件');
        const event = value as { type: unknown; stopReason?: unknown; error?: { message?: unknown } };
        if (event.type === 'error') throw new Error(typeof event.error?.message === 'string' ? event.error.message : 'OpenAPI 请求失败');
        if (event.type === 'done') {
          if (typeof event.stopReason !== 'string' || !(STOP_REASONS as readonly string[]).includes(event.stopReason)) throw new Error('请求流缺少有效终态');
          return { stopReason: event.stopReason };
        }
        if (!['meta', 'frame', 'hb'].includes(String(event.type))) throw new Error('未知的请求流事件');
      }
      if (pending.length > MAX_LINE) throw new Error('请求流超出单帧上限');
      if (chunk.done) throw new Error('请求流中断，任务状态未知；请读取历史核对，不要重复发送。');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Browser-local request ownership. No receipt lookup or session state is stored on the proxy. */
export function installHttpPromptTransport(client: DaemonClient, baseUrl: string, transport: () => Promise<PromptTransport>) {
  const originals = { prompt: client.prompt, promptNonBlocking: client.promptNonBlocking,
    subscribeEvents: client.subscribeEvents, heartbeat: client.heartbeat };
  const requests = new Map<string, RequestState>();
  const sessions = new Map<string, SessionState>();
  const disposal = new AbortController();
  let disposed = false;
  const stateFor = (id: string) => {
    let state = sessions.get(id);
    if (!state) { state = { listeners: new Set(), subscribers: new Set() }; sessions.set(id, state); }
    return state;
  };
  const notify = (id: string) => { for (const listener of sessions.get(id)?.listeners ?? []) listener(); };
  const forgetSession = (id: string) => {
    if (!sessions.get(id)?.listeners.size && ![...requests.values()].some(record => record.sessionId === id)) sessions.delete(id);
  };
  const apiBase = new URL(baseUrl, globalThis.location?.href ?? 'http://localhost/');
  if (!apiBase.pathname.replace(/\/$/, '').endsWith('/d')) throw new Error('OpenAPI daemon baseURL 必须以 /d 结尾');
  apiBase.pathname = apiBase.pathname.replace(/\/d\/?$/, '/api');
  apiBase.search = ''; apiBase.hash = '';

  const begin = async (sessionId: string, req: Parameters<DaemonClient['prompt']>[1], signal: AbortSignal | undefined,
    publish: boolean): Promise<RequestState> => {
    signal?.throwIfAborted();
    if (disposed) throw new Error('OpenAPI client 已关闭');
    if (!Array.isArray(req.prompt) || !req.prompt.length || req.prompt.some(block => block.type !== 'text' || typeof block.text !== 'string')) throw new Error('OpenAPI 仅支持文本 prompt');
    const text = req.prompt.map(block => (block as { text: string }).text).join('').trim();
    if (!text) throw new Error('prompt 不能为空');
    for (const [key, record] of requests) {
      if (requests.size < MAX_REQUESTS) break;
      if (record.outcome && record.ready) { requests.delete(key); forgetSession(record.sessionId); }
    }
    if (requests.size >= MAX_REQUESTS) throw new Error('当前浏览器在途请求过多');
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const record: RequestState = { sessionId, promptId: crypto.randomUUID(), controller, ready: false,
      publish, delivered: new Set(),
      finished: Promise.resolve({ error: new Error('请求尚未开始') }),
      cleanup: () => signal?.removeEventListener('abort', abort) };
    requests.set(record.promptId, record);
    try {
      const url = `${apiBase.href.replace(/\/$/, '')}/sessions/${encodeURIComponent(sessionId)}/prompt`;
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }), signal: AbortSignal.any([controller.signal, disposal.signal]) });
      if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('application/x-ndjson')) {
        const value: unknown = await response.json().catch(() => ({}));
        throw new DaemonHttpError(response.status, value, 'OpenAPI 请求失败或未返回 NDJSON');
      }
      if (!response.body) throw new Error('OpenAPI 请求没有响应流');
      const finish = (outcome: Outcome, localAbort = false): Outcome => {
        record.cleanup();
        // A local read abort says nothing about the remote task's terminal state.
        // WebShell already settles its local waiter on abort; do not render/replay a turn_error.
        if (localAbort) requests.delete(record.promptId); else record.outcome = outcome;
        if (publish && !disposed) notify(sessionId);
        if (localAbort) forgetSession(sessionId);
        return outcome;
      };
      record.finished = consume(response.body).then(result => finish({ result }), error => {
        const localAbort = controller.signal.aborted || disposal.signal.aborted;
        return finish({ error: localAbort ? new DOMException('Aborted', 'AbortError')
          : error instanceof Error ? error : new Error(String(error)) }, localAbort);
      });
      return record;
    } catch (error) {
      const localAbort = controller.signal.aborted || disposal.signal.aborted;
      record.cleanup(); controller.abort(); requests.delete(record.promptId); notify(sessionId); forgetSession(sessionId);
      throw localAbort ? new DOMException('Aborted', 'AbortError') : error;
    }
  };

  client.prompt = async (sessionId, req, signal, clientId) => {
    if (await transport() === 'daemon') return originals.prompt.call(client, sessionId, req, signal, clientId);
    const record = await begin(sessionId, req, signal, false);
    try { const outcome = await record.finished; if (outcome.error) throw outcome.error; return outcome.result; }
    finally { requests.delete(record.promptId); notify(sessionId); forgetSession(sessionId); }
  };
  client.promptNonBlocking = async (sessionId, req, signal, clientId) => {
    if (await transport() === 'daemon') return originals.promptNonBlocking.call(client, sessionId, req, signal, clientId);
    const record = await begin(sessionId, req, signal, true);
    // Keep early HTTP results until admission has returned AND a subscription consumes them.
    // A subscription restart does not remove this browser-owned request.
    setTimeout(() => { if (!disposed && requests.has(record.promptId)) { record.ready = true; notify(sessionId); } }, 0);
    // SDK accepts an absent cursor at runtime, despite its admission type requiring number.
    // Do not manufacture 0 or a watermark from an unrelated request.
    const state = stateFor(sessionId);
    return { promptId: record.promptId, lastEventId: state.cursor, ...(state.epoch ? { eventEpoch: state.epoch } : {}) } as Awaited<ReturnType<typeof originals.promptNonBlocking>>;
  };
  client.heartbeat = async (sessionId, clientId) => {
    if (await transport() === 'daemon') return originals.heartbeat.call(client, sessionId, clientId);
    const response = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/heartbeat`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.any([disposal.signal, AbortSignal.timeout(10_000)]) });
    if (!response.ok) throw new DaemonHttpError(response.status, {}, 'heartbeat 失败');
    // Adapter acknowledgement time, not proof of remote task liveness.
    return response.status === 204 ? { sessionId, clientId, lastSeenAt: Date.now() } : await response.json();
  };
  client.subscribeEvents = async function* (sessionId, options) {
    if (await transport() === 'daemon') { yield* originals.subscribeEvents.call(client, sessionId, options); return; }
    const state = stateFor(sessionId);
    const epoch = options?.epoch;
    if (epoch !== undefined && state.epoch !== undefined && epoch !== state.epoch) state.cursor = undefined;
    if (epoch !== undefined) state.epoch = epoch;
    if (options?.lastEventId !== undefined) state.cursor = Math.max(state.cursor ?? 0, options.lastEventId);
    const subscriber = Symbol('Events subscriber');
    state.subscribers.add(subscriber);
    const closing = new AbortController();
    const signal = AbortSignal.any([closing.signal, disposal.signal, ...(options?.signal ? [options.signal] : [])]);
    const upstream = originals.subscribeEvents.call(client, sessionId, { ...options, signal });
    let wake!: () => void;
    let awakened: Promise<{ kind: 'wake' }>;
    const reset = () => { awakened = new Promise(resolve => { wake = () => resolve({ kind: 'wake' }); }); };
    reset();
    const listener = () => wake(); state.listeners.add(listener);
    const aborted = new Promise<{ kind: 'abort' }>(resolve => signal.addEventListener('abort', () => resolve({ kind: 'abort' }), { once: true }));
    const read = () => upstream.next().then(value => ({ kind: 'remote' as const, value }), error => ({ kind: 'error' as const, error }));
    let next = read(); let ended = false; let remoteError: unknown;
    try {
      while (!signal.aborted) {
        reset();
        const completion = [...requests.values()].find(record => record.publish && record.sessionId === sessionId && record.ready && record.outcome && !record.delivered.has(subscriber));
        if (completion) {
          const outcome = completion.outcome!;
          const event: DaemonEvent = { v: 1, type: outcome.error ? 'turn_error' : 'turn_complete', promptId: completion.promptId,
            data: { sessionId, promptId: completion.promptId, ...(outcome.error
              ? { message: outcome.error.message, code: 'openapi_request_failed' } : { stopReason: outcome.result.stopReason }) },
            _meta: { source: 'workbench_prompt_result' } };
          yield event;
          // Delivery to an observer is not an acknowledgement by another logical consumer.
          // Retain bounded completed results for replacement generations; only admission evicts old results.
          completion.delivered.add(subscriber);
          continue;
        }
        const pending = [...requests.values()].some(record => record.publish && record.sessionId === sessionId && !record.delivered.has(subscriber));
        if (ended && !pending) { if (remoteError) throw remoteError; return; }
        const incoming = await Promise.race(ended ? [awakened!, aborted] : [next, awakened!, aborted]);
        if (incoming.kind === 'abort') return;
        if (incoming.kind === 'wake') continue;
        if (incoming.kind === 'error') { ended = true; remoteError = incoming.error; continue; }
        if (incoming.value.done) { ended = true; continue; }
        next = read();
        const event = incoming.value.value;
        // Proxy-owned receipt markers from an older server are not this browser's HTTP result.
        if (event._meta?.source === 'workbench_prompt_result') continue;
        if (event.id !== undefined && (epoch === undefined || epoch === state.epoch)) state.cursor = Math.max(state.cursor ?? 0, event.id);
        yield event;
      }
    } finally {
      closing.abort(); state.listeners.delete(listener); state.subscribers.delete(subscriber);
      for (const record of requests.values()) if (record.sessionId === sessionId) record.delivered.delete(subscriber);
      forgetSession(sessionId);
      await upstream.return(undefined).catch(() => {});
    }
  };
  return {
    decorate(session: DaemonSessionClient) {
      const original = session.prompt;
      session.prompt = async (req, signal) => {
        if (await transport() === 'daemon') return original.call(session, req, signal);
        // The SDK's default prompt abort invokes Cancel. Local view disposal must only close this HTTP read.
        return client.prompt(session.sessionId, req, signal, session.clientId);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true; disposal.abort();
      for (const record of requests.values()) { record.cleanup(); record.controller.abort(); }
      for (const id of sessions.keys()) notify(id);
      requests.clear(); sessions.clear();
      client.prompt = originals.prompt; client.promptNonBlocking = originals.promptNonBlocking;
      client.subscribeEvents = originals.subscribeEvents; client.heartbeat = originals.heartbeat;
    },
  };
}
