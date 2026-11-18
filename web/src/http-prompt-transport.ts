import { type DaemonClient, type DaemonEvent, type DaemonSessionClient, type PromptResult } from '@qwen-code/sdk/daemon';
import { STOP_REASONS } from '@das/shared';
import { apiHttpError, formatApiError } from './api-error';
import { decodePromptEvent, type NativePromptCursor } from './prompt-event-frame';

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
  cursor?: NativePromptCursor;
  lastPromptEventId?: number;
  frames: Array<{ sequence: number; event: DaemonEvent; bytes: number }>;
  frameSequence: number;
  frameBytes: number;
  readers: Map<symbol, number>;
}
interface SessionState { cursor?: number; epoch?: string; listeners: Set<() => void>; subscribers: Set<symbol>; recoveries: number; generation: number }
const MAX_REQUESTS = 64;
const MAX_LINE = 1024 * 1024;
const MAX_PENDING_FRAME_BYTES = 4 * 1024 * 1024;
const SUBSCRIPTION_RECOVERY_CODES = new Set(['INSTANCE_NOT_FOUND', 'RUNTIME_NOT_READY', 'DAEMON_STREAM_CONTRACT_INVALID']);
const MAX_EVENT_RECONNECTS = 8;

/** Interruptible bounded reconnect delay; never delays or retries the owned Prompt. */
function reconnectDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}


/** Consume this request's result independently of the Events subscriber; never render its content twice. */
async function consume(body: ReadableStream<Uint8Array>, onFrame: (body: unknown) => void): Promise<PromptResult> {
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
        const event = value as { type: unknown; stopReason?: unknown; error?: unknown };
        if (event.type === 'frame') onFrame((value as { body?: unknown }).body);
        if (event.type === 'error') throw new Error(formatApiError(value, 'OpenAPI 请求失败'));
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
export function installHttpPromptTransport(client: DaemonClient, baseUrl: string, transport: () => Promise<PromptTransport>,
  onRecoveryRequired?: (sessionId: string, automatic: boolean) => void,
  fetcher: typeof fetch = (...args) => fetch(...args)) {
  const originals = { prompt: client.prompt, promptNonBlocking: client.promptNonBlocking,
    subscribeEvents: client.subscribeEvents, heartbeat: client.heartbeat };
  const requests = new Map<string, RequestState>();
  const sessions = new Map<string, SessionState>();
  const disposal = new AbortController();
  let disposed = false;
  const stateFor = (id: string) => {
    let state = sessions.get(id);
    if (!state) {
      if (sessions.size >= MAX_REQUESTS) {
        for (const [key, saved] of sessions) {
          if (!saved.listeners.size && ![...requests.values()].some(record => record.sessionId === key && !record.outcome)) {
            sessions.delete(key); break;
          }
        }
        if (sessions.size >= MAX_REQUESTS) throw new Error('当前浏览器在途会话过多');
      }
      state = { listeners: new Set(), subscribers: new Set(), recoveries: 0, generation: 0 }; sessions.set(id, state);
    }
    return state;
  };
  const notify = (id: string) => { for (const listener of sessions.get(id)?.listeners ?? []) listener(); };
  const forgetSession = (id: string) => {
    if (!sessions.get(id)?.listeners.size && !sessions.get(id)?.recoveries && ![...requests.values()].some(record => record.sessionId === id)) sessions.delete(id);
  };
  const apiBase = new URL(baseUrl, globalThis.location?.href ?? 'http://localhost/');
  if (!apiBase.pathname.replace(/\/$/, '').endsWith('/d')) throw new Error('OpenAPI daemon baseURL 必须以 /d 结尾');
  apiBase.pathname = apiBase.pathname.replace(/\/d\/?$/, '/api');
  apiBase.search = ''; apiBase.hash = '';

  const begin = async (sessionId: string, req: Parameters<DaemonClient['prompt']>[1], signal: AbortSignal | undefined,
    publish: boolean, clientId?: string): Promise<RequestState> => {
    signal?.throwIfAborted();
    if (disposed) throw new Error('OpenAPI client 已关闭');
    stateFor(sessionId).recoveries = 0;
    if (!Array.isArray(req.prompt) || !req.prompt.length || req.prompt.some(block => block.type !== 'text' || typeof block.text !== 'string')) throw new Error('OpenAPI 仅支持文本 prompt');
    const text = req.prompt.map(block => (block as { text: string }).text).join('').trim();
    if (!text) throw new Error('prompt 不能为空');
    for (const [key, record] of requests) {
      if (requests.size < MAX_REQUESTS) break;
      const readers = sessions.get(record.sessionId)?.subscribers ?? [];
      if (record.outcome && record.ready && !record.frames.length
        && [...readers].every(reader => !record.publish || record.delivered.has(reader))) {
        requests.delete(key); forgetSession(record.sessionId);
      }
    }
    if (requests.size >= MAX_REQUESTS) throw new Error('当前浏览器在途请求过多');
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const record: RequestState = { sessionId, promptId: crypto.randomUUID(), controller, ready: false,
      publish, delivered: new Set(), frames: [], frameSequence: 0, frameBytes: 0, readers: new Map(),
      finished: Promise.resolve({ error: new Error('请求尚未开始') }),
      cleanup: () => signal?.removeEventListener('abort', abort) };
    requests.set(record.promptId, record);
    notify(sessionId);
    try {
      const url = `${apiBase.href.replace(/\/$/, '')}/sessions/${encodeURIComponent(sessionId)}/prompt`;
      const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }), signal: AbortSignal.any([controller.signal, disposal.signal]) });
      if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('application/x-ndjson')) {
        const value: unknown = await response.json().catch(() => ({}));
        throw apiHttpError(response.status, value, 'OpenAPI 请求失败或未返回 NDJSON');
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
      record.finished = consume(response.body, body => {
        const decoded = decodePromptEvent(body, sessionId, record.promptId);
        if (decoded.cursor) {
          if (record.cursor && (record.cursor.eventEpoch !== decoded.cursor.eventEpoch || record.cursor.promptId !== decoded.cursor.promptId))
            throw new Error('本轮原生事件身份发生变化；请核对历史，不要重复发送。');
          if (record.lastPromptEventId !== undefined && decoded.cursor.eventId <= record.lastPromptEventId) return;
          record.lastPromptEventId = decoded.cursor.eventId;
          record.cursor ??= decoded.cursor;
        }
        if (decoded.event && (publish || stateFor(sessionId).subscribers.size > 0)) {
          const data = decoded.event.data as { update?: { sessionUpdate?: string } };
          if (clientId && data.update?.sessionUpdate === 'user_message_chunk') decoded.event.originatorClientId = clientId;
          const bytes = JSON.stringify(decoded.event).length * 2;
          if (record.frameBytes + bytes > MAX_PENDING_FRAME_BYTES) throw new Error('未消费的会话内容超过缓存上限，请读取历史核对；原问题没有重发。');
          record.frames.push({ sequence: record.frameSequence++, event: decoded.event, bytes });
          record.frameBytes += bytes;
        }
        if (!disposed) notify(sessionId);
      }).then(result => finish({ result }), error => {
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
    const record = await begin(sessionId, req, signal, false, clientId);
    try { const outcome = await record.finished; if (outcome.error) throw outcome.error; return outcome.result; }
    finally {
      record.ready = true;
      if (!record.frames.length) requests.delete(record.promptId);
      notify(sessionId); forgetSession(sessionId);
    }
  };
  client.promptNonBlocking = async (sessionId, req, signal, clientId) => {
    if (await transport() === 'daemon') return originals.promptNonBlocking.call(client, sessionId, req, signal, clientId);
    const record = await begin(sessionId, req, signal, true, clientId);
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
    const response = await fetcher(`${baseUrl}/session/${encodeURIComponent(sessionId)}/heartbeat`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.any([disposal.signal, AbortSignal.timeout(10_000)]) });
    if (!response.ok) throw apiHttpError(response.status, await response.json().catch(() => undefined), 'heartbeat 失败');
    // Adapter acknowledgement time, not proof of remote task liveness.
    return response.status === 204 ? { sessionId, clientId, lastSeenAt: Date.now() } : await response.json();
  };
  client.subscribeEvents = async function* (sessionId, options) {
    if (await transport() === 'daemon') { yield* originals.subscribeEvents.call(client, sessionId, options); return; }
    const state = stateFor(sessionId);
    const epoch = options?.epoch;
    if (epoch !== undefined && state.epoch !== undefined && epoch !== state.epoch) state.cursor = undefined;
    if (epoch !== undefined) state.epoch = epoch;
    if (options?.lastEventId === undefined) state.cursor = undefined;
    else state.cursor = Math.max(state.cursor ?? 0, options.lastEventId);
    const subscriber = Symbol('Events subscriber');
    state.subscribers.add(subscriber);
    const closing = new AbortController();
    const signal = AbortSignal.any([closing.signal, disposal.signal, ...(options?.signal ? [options.signal] : [])]);
    let connection = new AbortController();
    let promptGeneration: RequestState | undefined;
    let strictGeneration: RequestState | undefined;
    const open = () => {
      const streamConnection = connection;
      const generation = state.generation;
      const expectedEpoch = state.epoch;
      return originals.subscribeEvents.call(client, sessionId, { ...options,
        signal: AbortSignal.any([streamConnection.signal, signal]), lastEventId: state.cursor, epoch: state.epoch,
        onEpoch: value => {
          if (streamConnection.signal.aborted || generation !== state.generation) return;
          if (expectedEpoch !== undefined && value !== expectedEpoch) throw new Error('Events 返回了其他运行代次，原问题没有重发。');
          state.epoch = value; options?.onEpoch?.(value);
        } });
    };
    let upstream: ReturnType<typeof originals.subscribeEvents> | undefined = open();
    let wake!: () => void;
    let awakened: Promise<{ kind: 'wake' }>;
    const reset = () => { awakened = new Promise(resolve => { wake = () => resolve({ kind: 'wake' }); }); };
    reset();
    const listener = () => wake(); state.listeners.add(listener);
    const aborted = new Promise<{ kind: 'abort' }>(resolve => signal.addEventListener('abort', () => resolve({ kind: 'abort' }), { once: true }));
    const read = () => { const generation = state.generation; return upstream!.next().then(value => ({ kind: 'remote' as const, value, generation }), error => ({ kind: 'error' as const, error, generation })); };
    let next: ReturnType<typeof read> | undefined = read();
    let retry: Promise<{ kind: 'retry' }> | undefined;
    let failures = 0;
    let recoveryNeeded = false;
    let recoveryNotified = false;
    const scheduleReconnect = () => {
      if (++failures > MAX_EVENT_RECONNECTS) { next = undefined; retry = undefined; connection.abort(); return; }
      retry = reconnectDelay(Math.min(250 * 2 ** (failures - 1), 2000), signal).then(() => ({ kind: 'retry' as const }));
    };
    try {
      while (!signal.aborted) {
        reset();
        const owned = [...requests.values()].filter(record => record.sessionId === sessionId);
        const latest = owned.at(-1);
        // Keep an already healthy observer stream; a paused/failed subscription
        // waits for the new Prompt's proven native position before opening another GET.
        if (latest && latest !== promptGeneration) {
          promptGeneration = latest;
        }
        if (latest?.cursor && !latest.outcome && strictGeneration !== latest) {
          connection.abort(); await upstream?.return(undefined).catch(() => {});
          strictGeneration = latest;
          if (state.epoch !== latest.cursor.eventEpoch) state.generation++;
          state.cursor = latest.cursor.eventId; state.epoch = latest.cursor.eventEpoch;
          connection = new AbortController(); upstream = open(); next = read();
          failures = 0;
        }
        const queued = owned.find(record => record.frames.some(frame => frame.sequence >= (record.readers.get(subscriber) ?? 0)));
        if (queued) {
          const frame = queued.frames.find(frame => frame.sequence >= (queued.readers.get(subscriber) ?? 0))!;
          if (queued.cursor) {
            if (queued.cursor.eventEpoch !== state.epoch) {
              state.generation++; state.cursor = undefined; state.epoch = queued.cursor.eventEpoch;
            }
            options?.onEpoch?.(queued.cursor.eventEpoch);
          }
          yield frame.event;
          queued.readers.set(subscriber, frame.sequence + 1);
          // Retain only data not yet applied by a currently attached reader.
          const readers = [...state.subscribers].map(reader => queued.readers.get(reader) ?? 0);
          const applied = Math.min(...readers);
          while (queued.frames[0] && queued.frames[0].sequence < applied) queued.frameBytes -= queued.frames.shift()!.bytes;
          continue;
        }
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
        const pending = [...requests.values()].some(record => record.sessionId === sessionId && (!record.outcome || (record.publish && !record.delivered.has(subscriber))));
        if (recoveryNeeded && !pending && !recoveryNotified) {
          if (!onRecoveryRequired) throw new Error('会话运行实例已变化，请重新加载历史后继续；原问题没有重发。');
          recoveryNotified = true;
          const automatic = state.recoveries++ < 1;
          onRecoveryRequired(sessionId, automatic);
        }
        if (retry && !pending) return;
        const incoming = await Promise.race([...(next ? [next] : []), ...(retry ? [retry] : []), awakened!, aborted]);
        if (incoming.kind === 'abort') return;
        if (incoming.kind === 'wake') continue;
        if (incoming.kind === 'retry') {
          retry = undefined;
          connection.abort();
          await upstream?.return(undefined).catch(() => {});
          if (signal.aborted) return;
          connection = new AbortController(); upstream = open(); next = read();
          continue;
        }
        if (incoming.generation !== state.generation) {
          connection.abort(); await upstream?.return(undefined).catch(() => {});
          connection = new AbortController(); upstream = open(); next = read();
          continue;
        }
        if (incoming.kind === 'error' || incoming.value.done) {
          // A POST can be admitted while this await was reading the remote stream.
          const stillPending = [...requests.values()].some(record => record.sessionId === sessionId && (!record.outcome || (record.publish && !record.delivered.has(subscriber))));
          if (!stillPending) {
            const error = incoming.kind === 'error' ? incoming.error : undefined;
            const status = (error as { status?: number } | undefined)?.status;
            if (error && (status === 502 || /DAEMON_SESSION_NOT_FOUND|INSTANCE_NOT_FOUND|RUNTIME_NOT_READY/.test(String(error)))) {
              connection.abort(); await upstream?.return(undefined).catch(() => {});
              upstream = undefined; next = undefined;
              continue;
            }
            if (error) throw error;
            return;
          }
          next = undefined;
          if (incoming.kind === 'error' || (strictGeneration === promptGeneration && promptGeneration?.cursor)) {
            connection.abort(); await upstream?.return(undefined).catch(() => {});
            upstream = undefined;
            continue;
          }
          scheduleReconnect();
          continue;
        }
        next = read();
        const event = incoming.value.value;
        // These idless, promptless errors describe the subscription, never a failed model turn.
        const data = event.data as Record<string, unknown>;
        const nativePromptId = event.promptId ?? data.promptId;
        const owner = typeof nativePromptId === 'string' ? owned.find(record => record.cursor?.promptId === nativePromptId) : undefined;
        // Owned content has one ordered source: Prompt SSE. Independent Events remains
        // available for observers; never append a second copy of this browser's turn.
        if (owner && ['session_update', 'permission_request', 'permission_resolved', 'turn_complete', 'turn_error'].includes(event.type)) continue;
        if (!owner && owned.some(record => !record.outcome && !record.cursor && record.frameSequence > 0)
          && ['session_update', 'permission_request', 'permission_resolved'].includes(event.type)) continue;
        if (['turn_error', 'stream_error'].includes(event.type) && event.id === undefined && !event.promptId && !data.promptId
          && ['DAEMON_SESSION_NOT_FOUND', 'INSTANCE_NOT_FOUND', 'RUNTIME_NOT_READY'].includes(String(data.code))) {
          connection.abort(); await upstream?.return(undefined).catch(() => {});
          upstream = undefined; next = undefined;
          continue;
        }
        if (event.type === 'turn_error' && event.id === undefined && !event.promptId && !data.promptId
          && SUBSCRIPTION_RECOVERY_CODES.has(String(data.code))) {
          recoveryNeeded = true; next = undefined; connection.abort();
          await upstream?.return(undefined).catch(() => {});
          continue;
        }
        if (event.id !== undefined) failures = 0;
        // Proxy-owned receipt markers from an older server are not this browser's HTTP result.
        if (event._meta?.source === 'workbench_prompt_result') continue;
        if (event.id !== undefined) state.cursor = Math.max(state.cursor ?? 0, event.id);
        yield event;
      }
    } finally {
      closing.abort(); state.listeners.delete(listener); state.subscribers.delete(subscriber);
      for (const record of requests.values()) if (record.sessionId === sessionId) { record.delivered.delete(subscriber); record.readers.delete(subscriber); }
      forgetSession(sessionId);
      await upstream?.return(undefined).catch(() => {});
    }
  };
  return {
    decorate(session: DaemonSessionClient) {
      const originalEvents = session.events;
      let observedEpoch = session.eventEpoch;
      session.events = async function* (options) {
        for await (const event of originalEvents.call(session, options)) {
          const epoch = typeof event._meta?.eventEpoch === 'string' ? event._meta.eventEpoch : session.eventEpoch;
          if (epoch !== undefined && epoch !== observedEpoch) {
            session.setLastEventId(undefined);
            observedEpoch = epoch;
          }
          yield event;
        }
      };
      const original = session.prompt;
      const originalSubmit = session.submitPrompt;
      session.prompt = async (req, signal) => {
        if (await transport() === 'daemon') return original.call(session, req, signal);
        // The SDK's default prompt abort invokes Cancel. Local view disposal must only close this HTTP read.
        return client.prompt(session.sessionId, req, signal, session.clientId);
      };
      session.submitPrompt = async (req, signal) => {
        if (await transport() === 'daemon') return originalSubmit.call(session, req, signal);
        const accepted = await client.promptNonBlocking(session.sessionId, req, signal, session.clientId);
        if (!('promptId' in accepted) || typeof accepted.promptId !== 'string' || !accepted.promptId) throw new Error('Prompt 标识缺失');
        return accepted as Awaited<ReturnType<typeof originalSubmit>>;
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
