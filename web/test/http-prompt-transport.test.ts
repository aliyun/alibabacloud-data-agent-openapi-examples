import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DaemonClient, DaemonSessionClient, type DaemonEvent } from '@qwen-code/sdk/daemon';
import { installOpenApiSessionCreation } from '../src/session-client';

const base = 'http://workbench.invalid';
const sid = 'session /中文';
const promptPath = `/api/sessions/${encodeURIComponent(sid)}/prompt`;
const question = { prompt: [{ type: 'text' as const, text: '只执行一次 🌏' }] };
const sessionResponse = {
  sessionId: sid, clientId: 'browser-client', workspaceCwd: '/data-agent', attached: false,
  sourceType: 'standalone', context: { kind: 'standalone' },
  projectlessOutputDirectory: '/data-agent/out/session', workingDirectory: { state: 'ready' },
  state: {}, hasActivePrompt: false, compactedReplay: [], liveJournal: [],
};
const done = { type: 'done', rid: 'rpc-result', stopReason: 'end_turn', rawStopReason: 'end_turn', frameCount: 1 };
const local = (event: DaemonEvent) => event._meta?.source === 'workbench_prompt_result';
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => vi.stubGlobal('window', { location: { href: `${base}/` } }));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${phase}`)), 1500);
    })]);
  } finally { clearTimeout(timer); }
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Real byte streams, including fetch abort semantics. No SDK methods are mocked. */
function byteStream(signal?: AbortSignal | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  let cancelled = false;
  const encoder = new TextEncoder();
  const aborted = () => {
    if (!ended) { ended = true; controller.error(signal?.reason ?? new DOMException('Aborted', 'AbortError')); }
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { cancelled = true; ended = true; signal?.removeEventListener('abort', aborted); },
  });
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  const close = () => {
    signal?.removeEventListener('abort', aborted);
    if (!ended) { ended = true; controller.close(); }
  };
  cleanups.push(close);
  return {
    body, close,
    get cancelled() { return cancelled; },
    get aborted() { return signal?.aborted ?? false; },
    bytes(value: Uint8Array) { if (!ended) controller.enqueue(value); },
    text(value: string) { if (!ended) controller.enqueue(encoder.encode(value)); },
    line(value: unknown) { if (!ended) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)); },
    event(value: DaemonEvent) {
      if (!ended) controller.enqueue(encoder.encode(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`));
    },
  };
}
type ByteStream = ReturnType<typeof byteStream>;

function fixture(options: { transport?: 'http-stream' | 'daemon'; capabilityStatus?: number; capabilityBody?: unknown; capabilityError?: Error;
  http?: (signal?: AbortSignal | null) => Response | Promise<Response>; } = {}) {
  const requests: Array<{ path: string; method: string; body: unknown; signal?: AbortSignal | null }> = [];
  const http: ByteStream[] = [];
  const sse: ByteStream[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const path = new URL(request?.url ?? String(input)).pathname;
    const method = init?.method ?? request?.method ?? 'GET';
    const signal = init?.signal ?? request?.signal;
    requests.push({ path, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, signal });
    if (signal?.aborted) throw signal.reason;
    if (path === '/d/openapi/session-options' && options.capabilityError) throw options.capabilityError;
    if (path === '/d/openapi/session-options') return Response.json(options.capabilityBody ?? {
      agentName: 'fixture', models: [], approvalMode: 'default', promptTransport: options.transport ?? 'http-stream',
    }, { status: options.capabilityStatus ?? 200 });
    if (path === '/d/capabilities') return Response.json({ v: 1, features: ['standalone_sessions_v1'] });
    if (path === '/d/standalone/sessions' || path === '/d/session' || /\/(load|resume)$/.test(path)) return Response.json(sessionResponse);
    if (path.endsWith('/events')) {
      const stream = byteStream(signal); sse.push(stream);
      stream.event({ v: 1, type: 'stream_open', data: {} });
      return new Response(stream.body, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path === promptPath) {
      expect(method).toBe('POST');
      expect(requests.at(-1)?.body).toEqual({ text: question.prompt[0]!.text });
      if (options.http) return options.http(signal);
      const stream = byteStream(signal); http.push(stream);
      return new Response(stream.body, { headers: { 'content-type': 'application/x-ndjson' } });
    }
    if (path === `/d/session/${encodeURIComponent(sid)}/prompt`) {
      if (options.transport !== 'daemon') throw new Error(`LIVE unexpectedly used daemon prompt: ${path}`);
      return Response.json({ stopReason: 'end_turn' });
    }
    if (path.endsWith('/heartbeat') || path.endsWith('/cancel') || path.endsWith('/detach')) return new Response(null, { status: 204 });
    throw new Error(`Unexpected fixture request: ${method} ${path}`);
  });
  function browser() {
    const client = new DaemonClient({ baseUrl: `${base}/d` });
    const restore = installOpenApiSessionCreation(client, `${base}/d`);
    cleanups.push(() => { restore(); client.dispose(); });
    return { client, restore };
  }
  return { requests, http, sse, browser,
    prompts: () => requests.filter(request => request.path.endsWith('/prompt')),
    cancels: () => requests.filter(request => request.path.endsWith('/cancel')),
  };
}
function subscribe(session: DaemonSessionClient, onEvent?: (event: DaemonEvent) => void) {
  const abort = new AbortController();
  const connected = deferred();
  const events: DaemonEvent[] = [];
  let ended = false;
  const consume = (async () => {
    try {
      for await (const event of session.events({ signal: abort.signal })) {
        events.push(event); onEvent?.(event);
        if (event.type === 'stream_open') connected.resolve();
      }
    } finally { ended = true; }
  })();
  void consume.catch(() => {});
  cleanups.push(async () => { abort.abort(); await bounded(consume.catch(() => {}), 'subscription cleanup'); });
  return { events, abort, consume, connected: connected.promise, get ended() { return ended; } };
}
async function opened(f: ReturnType<typeof fixture>, rawSdkWaiter = false) {
  const { client, restore } = f.browser();
  const session = rawSdkWaiter
    ? new DaemonSessionClient({ client, session: sessionResponse })
    : await DaemonSessionClient.createStandalone(client);
  const subscription = subscribe(session);
  await bounded(subscription.connected, 'initial SSE');
  return { client, restore, session, subscription };
}
async function terminal(events: DaemonEvent[], promptId: string) {
  await expect.poll(() => events.find(event => local(event) && (event.data as { promptId?: string })?.promptId === promptId),
    { timeout: 1500 }).toBeDefined();
  return events.find(event => local(event) && (event.data as { promptId?: string })?.promptId === promptId)!;
}
function assertOwn(event: DaemonEvent, promptId: string, type = 'turn_complete') {
  expect(event).toMatchObject({ v: 1, type, data: { sessionId: sid, promptId }, _meta: { source: 'workbench_prompt_result' } });
  expect(event.id).toBeUndefined();
}
function assertSingleHttp(f: ReturnType<typeof fixture>) {
  expect(f.prompts()).toHaveLength(1);
  expect(f.prompts()[0]).toMatchObject({ path: promptPath, method: 'POST', body: { text: question.prompt[0]!.text } });
  expect(f.requests.some(request => /receipt|openapi-prompt/.test(request.path))).toBe(false);
}

it('caches fast done until public submitPrompt admission and publishes one browser-local terminal', async () => {
  const f = fixture({ http: () => new Response(`${JSON.stringify(done)}\n`, { headers: { 'content-type': 'application/x-ndjson' } }) });
  const { session, subscription } = await opened(f);
  const accepted = await session.submitPrompt(question);
  expect(accepted.promptId).toEqual(expect.any(String));
  expect(accepted.promptId).not.toBe('rpc-result');
  const event = await terminal(subscription.events, accepted.promptId);
  assertOwn(event, accepted.promptId);
  expect(event.data).toMatchObject({ stopReason: 'end_turn' });
  await tick();
  expect(subscription.events.filter(local)).toHaveLength(1);
  assertSingleHttp(f);
});

it.each(['before replacement', 'after replacement'])('retains own HTTP across subscription replacement: terminal %s', async timing => {
  const f = fixture();
  const { session, subscription } = await opened(f);
  const accepted = await bounded(session.submitPrompt(question), 'admission without terminal');
  subscription.abort.abort();
  await bounded(subscription.consume.catch(() => {}), 'unsubscribe');
  if (timing === 'before replacement') { f.http[0]!.line(done); f.http[0]!.close(); await tick(); }
  const replacement = subscribe(session);
  await bounded(replacement.connected, 'replacement SSE');
  expect(f.http[0]!.aborted).toBe(false);
  if (timing === 'after replacement') { f.http[0]!.line(done); f.http[0]!.close(); }
  assertOwn(await terminal(replacement.events, accepted.promptId), accepted.promptId);
  expect(replacement.events.filter(local)).toHaveLength(1);
  assertSingleHttp(f);
});

it('keeps the original SDK waiter pending through remote SSE EOF until own HTTP done', async () => {
  const f = fixture();
  const { session, subscription } = await opened(f, true);
  let settled = false;
  const result = session.prompt(question);
  void result.then(() => { settled = true; }, () => { settled = true; });
  await expect.poll(() => f.http.length).toBe(1);
  f.sse[0]!.close();
  await tick(); await tick();
  expect(settled).toBe(false);
  expect(f.http[0]!.aborted).toBe(false);
  f.http[0]!.line(done); f.http[0]!.close();
  expect(await bounded(result, 'HTTP outlives SSE EOF')).toMatchObject({ stopReason: 'end_turn' });
  await expect.poll(() => subscription.events.filter(local).length).toBe(1);
  assertSingleHttp(f);
});

it('settles HTTP before SSE terminal and preserves remote events without duplicate local terminal', async () => {
  const f = fixture();
  const { session, subscription } = await opened(f);
  const accepted = await session.submitPrompt(question);
  f.http[0]!.line(done); f.http[0]!.close();
  const own = await terminal(subscription.events, accepted.promptId);
  assertOwn(own, accepted.promptId);
  f.sse[0]!.event({ v: 1, id: 42, type: 'turn_complete', data: { sessionId: sid, promptId: 'other-browser', stopReason: 'end_turn' } });
  // A remote result claiming our local marker is never an owned HTTP result.
  f.sse[0]!.event({ ...own });
  f.sse[0]!.event({ v: 1, id: 43, type: 'turn_complete', data: { sessionId: sid, promptId: 'remote-after', stopReason: 'end_turn' } });
  await expect.poll(() => subscription.events.some(event => event.id === 43)).toBe(true);
  expect(subscription.events.some(event => event.id === 42)).toBe(true);
  expect(subscription.events.filter(local)).toHaveLength(1);
  assertSingleHttp(f);
});

it('does not let a foreign SSE terminal settle an own HTTP request or leak ownership to another browser', async () => {
  const f = fixture();
  const first = await opened(f, true);
  const second = await opened(f);
  const result = first.session.prompt(question);
  let settled = false;
  void result.then(() => { settled = true; }, () => { settled = true; });
  await expect.poll(() => f.http.length).toBe(1);
  f.sse[0]!.event({ v: 1, id: 8, type: 'turn_complete', data: { sessionId: sid, promptId: 'foreign', stopReason: 'end_turn' } });
  await expect.poll(() => first.subscription.events.some(event => event.id === 8)).toBe(true);
  expect(settled).toBe(false);
  f.http[0]!.line(done); f.http[0]!.close();
  await bounded(result, 'own completion');
  await expect.poll(() => first.subscription.events.filter(local).length).toBe(1);
  const own = first.subscription.events.find(local)!;
  f.sse[1]!.event(own);
  f.sse[1]!.event({ v: 1, id: 9, type: 'stream_open', data: {} });
  await expect.poll(() => second.subscription.events.some(event => event.id === 9)).toBe(true);
  expect(second.subscription.events.filter(local)).toHaveLength(0);
  assertSingleHttp(f);
});

it.each(['client', 'createStandalone', 'load', 'resume', 'loadStandalone', 'resumeStandalone', 'createOrAttach'] as const)(
  'public %s prompt completes over HTTP with no Events subscription', async factory => {
    const f = fixture();
    const { client } = f.browser();
    let session: DaemonSessionClient | undefined;
    if (factory === 'createStandalone' || factory === 'createOrAttach') session = await DaemonSessionClient[factory](client);
    else if (factory !== 'client') session = await DaemonSessionClient[factory](client, sid);
    const result = session ? session.prompt(question) : client.prompt(sid, question);
    void result.catch(() => {});
    await expect.poll(() => f.http.length).toBe(1);
    f.http[0]!.line(done); f.http[0]!.close();
    expect(await bounded(result, 'no-subscription HTTP prompt')).toMatchObject({ stopReason: 'end_turn' });
    expect(f.sse).toHaveLength(0);
    assertSingleHttp(f);
  },
);

it('decodes byte-fragmented UTF8 and never renders HTTP meta/frame/hb as transcript events', async () => {
  const f = fixture();
  const { session, subscription } = await opened(f);
  const accepted = await session.submitPrompt(question);
  const records = [
    { type: 'meta', rid: '中文🌏', sessionId: sid, mock: false, startedAt: 1 },
    { type: 'frame', rid: '中文🌏', body: { Result: { text: 'HTTP文字不能重复渲染🌏' } } },
    { type: 'hb', t: 2 },
    { ...done, rid: '中文🌏' },
  ];
  const encoded = new TextEncoder().encode(records.map(value => JSON.stringify(value)).join('\r\n') + '\r\n');
  for (const byte of encoded) f.http[0]!.bytes(Uint8Array.of(byte));
  f.http[0]!.close();
  assertOwn(await terminal(subscription.events, accepted.promptId), accepted.promptId);
  expect(subscription.events.filter(event => event.type !== 'stream_open')).toHaveLength(1);
  expect(JSON.stringify(subscription.events)).not.toContain('HTTP文字');
  assertSingleHttp(f);
});

it.each([
  ['EOF', ''],
  ['partial-only EOF', `${JSON.stringify({ type: 'hb', t: 1 })}\n`],
  ['malformed JSON', '{broken}\n'],
  ['malformed then done', `{broken}\n${JSON.stringify(done)}\n`],
  ['unknown record', '{"type":"unexpected"}\n'],
  ['done without stopReason', '{"type":"done"}\n'],
  ['error', '{"type":"error","error":{"kind":"upstream","message":"fixture upstream failure"}}\n'],
])('rejects %s without success or re-execution', async (_name, body) => {
  const f = fixture({ http: () => new Response(body, { headers: { 'content-type': 'application/x-ndjson' } }) });
  const { client } = f.browser();
  await bounded(expect(client.prompt(sid, question)).rejects.toThrow(), 'invalid HTTP terminal');
  assertSingleHttp(f);
});

it('publishes one local turn_error for malformed HTTP to public session.events', async () => {
  const f = fixture();
  const { session, subscription } = await opened(f);
  const accepted = await session.submitPrompt(question);
  f.http[0]!.text('{invalid}\n'); f.http[0]!.close();
  const event = await terminal(subscription.events, accepted.promptId);
  assertOwn(event, accepted.promptId, 'turn_error');
  expect((event.data as { message: string }).message).toEqual(expect.any(String));
  expect(subscription.events.filter(local)).toHaveLength(1);
  assertSingleHttp(f);
});

it.each(['abort', 'unmount'] as const)('%s disconnects local HTTP reading without upstream Cancel', async action => {
  const f = fixture();
  const { session, restore } = await opened(f);
  const abort = new AbortController();
  const result = session.prompt(question, abort.signal);
  void result.catch(() => {});
  await expect.poll(() => f.http.length).toBe(1);
  if (action === 'abort') abort.abort(); else restore();
  await bounded(expect(result).rejects.toThrow(), `${action} settles local prompt`);
  await expect.poll(() => f.http[0]!.aborted || f.http[0]!.cancelled).toBe(true);
  await tick();
  expect(f.cancels()).toHaveLength(0);
  assertSingleHttp(f);
});

it('explicit session.cancel sends exactly one Cancel even when the local prompt is subsequently aborted', async () => {
  const f = fixture();
  const { session } = await opened(f);
  const abort = new AbortController();
  const result = session.prompt(question, abort.signal);
  void result.catch(() => {});
  await expect.poll(() => f.http.length).toBe(1);
  await session.cancel();
  abort.abort();
  await bounded(expect(result).rejects.toThrow(), 'local abort after explicit cancel');
  await tick();
  expect(f.cancels()).toHaveLength(1);
  assertSingleHttp(f);
});

it('accepts heartbeat 204 through public client and factory session wrappers', async () => {
  const f = fixture();
  const { client } = f.browser();
  const session = await DaemonSessionClient.createStandalone(client);
  await expect(client.heartbeat(sid)).resolves.toBeDefined();
  await expect(session.heartbeat()).resolves.toBeDefined();
  expect(f.requests.filter(request => request.path.endsWith('/heartbeat'))).toHaveLength(2);
  expect(f.prompts()).toHaveLength(0);
});

it.each([
  { capabilityStatus: 503 },
  { capabilityError: new TypeError('fixture capability network failure') },
  { capabilityBody: { promptTransport: 'unknown' } },
  { capabilityBody: {} },
])('fails closed on unavailable/invalid transport capability: %j', async options => {
  const f = fixture(options);
  const { client } = f.browser();
  await bounded(expect(client.prompt(sid, question)).rejects.toThrow(), 'capability failure');
  expect(f.prompts()).toHaveLength(0);
  expect(f.requests.filter(request => request.path === '/d/openapi/session-options')).toHaveLength(1);
});

it('does not retry HTTP admission failure or fall back to daemon Prompt', async () => {
  const f = fixture({ http: () => Response.json({ error: 'admission failed' }, { status: 503 }) });
  const { client } = f.browser();
  await bounded(expect(client.prompt(sid, question)).rejects.toThrow(), 'failed POST');
  assertSingleHttp(f);
});

it('keeps MOCK on the original SDK daemon path', async () => {
  const f = fixture({ transport: 'daemon' });
  const { client } = f.browser();
  expect(await client.prompt(sid, question)).toMatchObject({ stopReason: 'end_turn' });
  expect(f.prompts()).toHaveLength(1);
  expect(f.prompts()[0]).toMatchObject({ path: `/d/session/${encodeURIComponent(sid)}/prompt`, body: question });
  expect(f.http).toHaveLength(0);
});

it('consumes HTTP independently of a stalled public Events consumer and replays the terminal on replacement', async () => {
  const f = fixture();
  const { client } = f.browser();
  const session = await DaemonSessionClient.createStandalone(client);
  const abort = new AbortController();
  const events = session.events({ signal: abort.signal });
  cleanups.push(async () => { abort.abort(); await events.return(); });
  expect((await bounded(events.next(), 'slow consumer opens')).value?.type).toBe('stream_open');
  // Deliberately never call next() again on this subscription.
  const accepted = await session.submitPrompt(question);
  for (let i = 0; i < 4000; i++) f.http[0]!.line({ type: 'hb', t: i });
  // Keep the producer open: cancel() on an already closed stream has no underlying-source callback.
  f.http[0]!.line(done);
  await expect.poll(() => f.http[0]!.cancelled).toBe(true);
  abort.abort();
  await bounded(events.return(), 'release stalled consumer');
  const replacement = subscribe(session);
  await bounded(replacement.connected, 'slow consumer replacement');
  assertOwn(await terminal(replacement.events, accepted.promptId), accepted.promptId);
  expect(replacement.events.filter(local)).toHaveLength(1);
  assertSingleHttp(f);
});

it('delivers fast done after admission to the original public SDK waiter', async () => {
  const f = fixture({ http: () => new Response(`${JSON.stringify(done)}\n`, { headers: { 'content-type': 'application/x-ndjson' } }) });
  const { session, subscription } = await opened(f, true);
  expect(await bounded(session.prompt(question), 'fast result reaches original SDK waiter')).toMatchObject({ stopReason: 'end_turn' });
  await expect.poll(() => subscription.events.filter(local).length).toBe(1);
  assertSingleHttp(f);
});

it('never publishes a local terminal before submitPrompt admission returns', async () => {
  const f = fixture({ http: () => new Response(`${JSON.stringify(done)}\n`, { headers: { 'content-type': 'application/x-ndjson' } }) });
  const { client } = f.browser();
  const session = await DaemonSessionClient.createStandalone(client);
  const order: string[] = [];
  const subscription = subscribe(session, event => { if (local(event)) order.push('terminal'); });
  await bounded(subscription.connected, 'ordering SSE');
  const accepted = await session.submitPrompt(question).then(value => { order.push('admission'); return value; });
  await terminal(subscription.events, accepted.promptId);
  expect(order).toEqual(['admission', 'terminal']);
  assertSingleHttp(f);
});

it('bounds retained browser results while keeping the newest own terminal available', async () => {
  const f = fixture({ http: () => new Response(`${JSON.stringify(done)}\n`, { headers: { 'content-type': 'application/x-ndjson' } }) });
  const { client } = f.browser();
  const session = await DaemonSessionClient.createStandalone(client);
  const admitted: string[] = [];
  // Observe eviction only through public APIs; the cache and its limit are implementation details.
  for (let i = 0; i < 256; i++) {
    admitted.push((await session.submitPrompt(question)).promptId);
    await tick();
  }
  const subscription = subscribe(session);
  await bounded(subscription.connected, 'retained results subscription');
  await terminal(subscription.events, admitted.at(-1)!);
  f.sse[0]!.close();
  await bounded(subscription.consume, 'drain bounded result replay');
  const retained = subscription.events.filter(local);
  expect(retained.length).toBeGreaterThan(0);
  expect(retained.length).toBeLessThan(admitted.length);
  expect(new Set(retained.map(event => (event.data as { promptId: string }).promptId)).size).toBe(retained.length);
  expect(f.prompts()).toHaveLength(admitted.length);
});

it('ignores an SSE terminal claiming the owned browser marker until its HTTP actually completes', async () => {
  const f = fixture();
  const { session, subscription } = await opened(f);
  const accepted = await session.submitPrompt(question);
  f.sse[0]!.event({ v: 1, type: 'turn_complete', data: { sessionId: sid, promptId: accepted.promptId, stopReason: 'end_turn' },
    _meta: { source: 'workbench_prompt_result' } });
  f.sse[0]!.event({ v: 1, id: 20, type: 'stream_open', data: {} });
  await expect.poll(() => subscription.events.some(event => event.id === 20)).toBe(true);
  expect(subscription.events.filter(local)).toHaveLength(0);
  f.http[0]!.line(done); f.http[0]!.close();
  assertOwn(await terminal(subscription.events, accepted.promptId), accepted.promptId);
  expect(subscription.events.filter(local)).toHaveLength(1);
  assertSingleHttp(f);
});

it('does not retry or downgrade an ambiguous HTTP network failure', async () => {
  const f = fixture({ http: () => { throw new TypeError('fixture disconnected after POST'); } });
  const { client } = f.browser();
  await bounded(expect(client.prompt(sid, question)).rejects.toThrow('fixture disconnected'), 'ambiguous HTTP failure');
  assertSingleHttp(f);
});

it('rejects invalid UTF8 instead of silently replacing damaged bytes and accepting done', async () => {
  const f = fixture();
  const { client } = f.browser();
  const result = client.prompt(sid, question);
  void result.catch(() => {});
  await expect.poll(() => f.http.length).toBe(1);
  f.http[0]!.bytes(Uint8Array.from([0xff, 0xfe, 0x0a]));
  f.http[0]!.line(done); f.http[0]!.close();
  await bounded(expect(result).rejects.toThrow(), 'invalid UTF8');
  assertSingleHttp(f);
});

it('applies the 1 MiB limit per NDJSON line, not to a chunk containing many small valid records', async () => {
  const f = fixture();
  const { client } = f.browser();
  const result = client.prompt(sid, question);
  void result.catch(() => {});
  await expect.poll(() => f.http.length).toBe(1);
  const coalesced = `${JSON.stringify({ type: 'hb', t: 1 })}\n`.repeat(60_000);
  expect(new TextEncoder().encode(coalesced).length).toBeGreaterThan(1024 * 1024);
  f.http[0]!.text(coalesced);
  f.http[0]!.line(done); f.http[0]!.close();
  expect(await bounded(result, 'coalesced short records')).toMatchObject({ stopReason: 'end_turn' });
  assertSingleHttp(f);
});

it('rejects an oversized unfinished NDJSON line before it can grow without bound', async () => {
  const f = fixture();
  const { client } = f.browser();
  const result = client.prompt(sid, question);
  void result.catch(() => {});
  await expect.poll(() => f.http.length).toBe(1);
  f.http[0]!.text(`{"type":"frame","body":"${'x'.repeat(1024 * 1024)}`);
  await bounded(expect(result).rejects.toThrow(/上限|limit|large|size/i), 'oversized line');
  expect(f.http[0]!.cancelled).toBe(true);
  assertSingleHttp(f);
});

it('ends the merged subscription when SSE EOF precedes a POST network failure before response headers', async () => {
  const postStarted = deferred();
  const failBeforeHeaders = deferred();
  const f = fixture({ http: async () => {
    postStarted.resolve();
    await failBeforeHeaders.promise;
    throw new TypeError('fixture POST disconnected before response headers');
  } });
  cleanups.push(() => failBeforeHeaders.resolve());
  const { session, subscription } = await opened(f);
  const admission = session.submitPrompt(question);
  void admission.catch(() => {});
  await bounded(postStarted.promise, 'POST waiting for response headers');
  f.sse[0]!.close();
  // Let the real SDK reader consume EOF while the POST is still unresolved.
  await tick(); await tick();
  expect(subscription.ended).toBe(false);
  failBeforeHeaders.resolve();
  await bounded(expect(admission).rejects.toThrow('fixture POST disconnected before response headers'), 'failed admission');
  // Ending normally or reporting a stream error is acceptable; waiting forever is not.
  await bounded(subscription.consume.catch(() => {}), 'merged subscription exits after failed admission');
  expect(subscription.ended).toBe(true);
  expect(subscription.events.filter(local)).toHaveLength(0);
  assertSingleHttp(f);
});

it('delivers the same owned terminal to a slow subscription after a fast subscription has consumed it on the same client/session', async () => {
  const f = fixture();
  const { client, session, subscription: fast } = await opened(f);
  const slowSession = await DaemonSessionClient.loadStandalone(client, sid);
  const abortSlow = new AbortController();
  const slow = slowSession.events({ signal: abortSlow.signal });
  cleanups.push(async () => { abortSlow.abort(); await bounded(slow.return(), 'slow subscription cleanup'); });
  expect((await bounded(slow.next(), 'slow subscription connects')).value?.type).toBe('stream_open');
  // Leave the slow public iterator suspended at stream_open until the fast one has resumed past its terminal.
  const accepted = await session.submitPrompt(question);
  f.http[0]!.line(done); f.http[0]!.close();
  assertOwn(await terminal(fast.events, accepted.promptId), accepted.promptId);
  f.sse[0]!.event({ v: 1, id: 30, type: 'stream_open', data: {} });
  await expect.poll(() => fast.events.some(event => event.id === 30)).toBe(true);
  const received = await bounded(slow.next(), 'slow subscription receives already consumed own terminal');
  expect(received.done).toBe(false);
  assertOwn(received.value!, accepted.promptId);
  expect(fast.events.filter(local)).toHaveLength(1);
  assertSingleHttp(f);
});

it('keeps admission cursor at 20 when old SSE generation 8 delivers late event 9 after the new generation reaches 20', async () => {
  const f = fixture();
  const { client } = f.browser();
  const oldAbort = new AbortController();
  const newAbort = new AbortController();
  const oldGeneration = client.subscribeEvents(sid, { signal: oldAbort.signal, lastEventId: 8 });
  const newGeneration = client.subscribeEvents(sid, { signal: newAbort.signal, lastEventId: 20 });
  cleanups.push(async () => {
    oldAbort.abort(); newAbort.abort();
    await bounded(Promise.all([oldGeneration.return(undefined), newGeneration.return(undefined)]), 'cursor generations cleanup');
  });
  await bounded(oldGeneration.next(), 'old SSE connects');
  f.sse[0]!.event({ v: 1, id: 8, type: 'stream_open', data: {} });
  expect((await bounded(oldGeneration.next(), 'old SSE cursor 8')).value?.id).toBe(8);
  await bounded(newGeneration.next(), 'new SSE connects');
  f.sse[1]!.event({ v: 1, id: 20, type: 'stream_open', data: {} });
  expect((await bounded(newGeneration.next(), 'new SSE cursor 20')).value?.id).toBe(20);
  f.sse[0]!.event({ v: 1, id: 9, type: 'stream_open', data: {} });
  expect((await bounded(oldGeneration.next(), 'late old SSE cursor 9')).value?.id).toBe(9);
  const accepted = await client.promptNonBlocking(sid, question);
  expect(accepted).toMatchObject({ promptId: expect.any(String), lastEventId: 20 });
  f.http[0]!.line(done); f.http[0]!.close();
  assertSingleHttp(f);
});

it('retains the own terminal for an owner replacement after an observer consumes it and the paused owner exits without consuming it', async () => {
  const f = fixture();
  const { client } = f.browser();
  const ownerSession = await DaemonSessionClient.createStandalone(client);
  const ownerAbort = new AbortController();
  const ownerEvents = ownerSession.events({ signal: ownerAbort.signal });
  cleanups.push(async () => { ownerAbort.abort(); await bounded(ownerEvents.return(), 'paused owner cleanup'); });
  expect((await bounded(ownerEvents.next(), 'owner subscribes')).value?.type).toBe('stream_open');
  // The owner remains suspended here: it never requests or consumes its terminal.
  const observerSession = await DaemonSessionClient.loadStandalone(client, sid);
  const observer = subscribe(observerSession);
  await bounded(observer.connected, 'observer subscribes alongside owner');
  const accepted = await ownerSession.submitPrompt(question);
  f.http[0]!.line(done); f.http[0]!.close();
  assertOwn(await terminal(observer.events, accepted.promptId), accepted.promptId);
  // A later remote event proves the observer resumed execution past the local terminal yield.
  f.sse[1]!.event({ v: 1, id: 31, type: 'stream_open', data: {} });
  await expect.poll(() => observer.events.some(event => event.id === 31)).toBe(true);
  expect(observer.events.filter(local)).toHaveLength(1);

  ownerAbort.abort();
  expect((await bounded(ownerEvents.return(), 'unconsumed owner unsubscribes')).done).toBe(true);
  const replacement = subscribe(ownerSession);
  await bounded(replacement.connected, 'owner replacement subscribes');
  assertOwn(await terminal(replacement.events, accepted.promptId), accepted.promptId);
  f.sse[2]!.event({ v: 1, id: 32, type: 'stream_open', data: {} });
  await expect.poll(() => replacement.events.some(event => event.id === 32)).toBe(true);
  expect(replacement.events.filter(local)).toHaveLength(1);
  expect(observer.events.filter(local)).toHaveLength(1);
  assertSingleHttp(f);
});

it.each([
  { error: { message: 'upstream denied', requestId: 'POP-http' } },
  { error: 'upstream denied', requestId: 'POP-http' },
])('retains requestId on HTTP admission failure: %j', async body => {
  const f = fixture({ http: () => Response.json({ ...body, token: 'hidden' }, { status: 502 }) });
  const { client } = f.browser();
  await expect(client.prompt(sid, question)).rejects.toThrow('upstream denied (requestId=POP-http)');
  assertSingleHttp(f);
});

it.each(['upstream denied', 'upstream denied (requestId=POP-stream)'])(
  'publishes the upstream requestId once in NDJSON errors: %s', async message => {
    const f = fixture();
    const { session, subscription } = await opened(f);
    const accepted = await session.submitPrompt(question);
    f.http[0]!.line({ type: 'error', rid: 'daemon-rpc', id: 123,
      error: { message, requestId: 'POP-stream', permissionRequestId: 'daemon-permission' } });
    const event = await terminal(subscription.events, accepted.promptId);
    expect(event.data).toMatchObject({ message: 'upstream denied (requestId=POP-stream)' });
    assertOwn(event, accepted.promptId, 'turn_error');
  },
);

it('does not label NDJSON daemon correlation IDs as POP requestId', async () => {
  const f = fixture();
  const { client } = f.browser();
  const result = client.prompt(sid, question);
  const assertion = expect(result).rejects.toThrow(/^upstream denied$/);
  await expect.poll(() => f.http.length).toBe(1);
  f.http[0]!.line({ type: 'error', rid: 'rpc', id: 'event',
    error: { message: 'upstream denied', permissionRequestId: 'permission' } });
  await assertion;
});

it('uses a safe fallback for a non-JSON HTTP error body', async () => {
  const f = fixture({ http: () => new Response('<html>hidden-response-token</html>', { status: 502 }) });
  const { client } = f.browser();
  await expect(client.prompt(sid, question)).rejects.toThrow(/^OpenAPI 请求失败或未返回 NDJSON$/);
});
