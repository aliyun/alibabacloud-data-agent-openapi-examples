import { afterEach, expect, it, vi } from 'vitest';
import { DaemonClient, DaemonSessionClient, createDaemonTranscriptStore, normalizeDaemonEvent, type DaemonEvent } from '@qwen-code/sdk/daemon';
import { installHttpPromptTransport } from '../src/http-prompt-transport';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
const question = { prompt: [{ type: 'text' as const, text: 'run once' }] };

function fixture(holdEvents = false) {
  const paths: string[] = [];
  const streams: Array<{ signal: AbortSignal; controller: ReadableStreamDefaultController<Uint8Array> }> = [];
  let closeEvents = () => {};
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path.endsWith('/events')) {
      // Real SDK SSE parser sees stream_open followed by EOF. It must wait for the owned HTTP request.
      const opening = 'event: stream_open\ndata: {"v":1,"type":"stream_open","data":{}}\n\n';
      const body = holdEvents ? new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(opening));
        closeEvents = () => controller.close();
      } }) : opening;
      return new Response(body,
        { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path.endsWith('/cancel')) return new Response(null, { status: 204 });
    if (path === '/api/sessions/s/prompt') {
      const signal = init!.signal!;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const abort = () => controller.error(signal.reason);
      const body = new ReadableStream<Uint8Array>({
        start(value) { controller = value; signal.addEventListener('abort', abort, { once: true }); },
        cancel() { signal.removeEventListener('abort', abort); },
      });
      streams.push({ signal, controller });
      return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
    }
    throw new Error(`Unexpected local fixture path: ${path}`);
  });
  const client = new DaemonClient({ baseUrl: 'http://fixture.invalid/d' });
  const adapter = installHttpPromptTransport(client, 'http://fixture.invalid/d', async () => 'http-stream');
  const session = new DaemonSessionClient({ client, session: {
    sessionId: 's', clientId: 'browser', workspaceCwd: '/fixture', attached: false,
  } });
  adapter.decorate(session);
  cleanups.push(() => { adapter.dispose(); client.dispose(); });
  return { client, session, streams, paths, closeEvents: () => closeEvents() };
}

it.each([false, true])('local nonblocking abort (explicit Cancel=%s) publishes no failure or fabricated terminal and wakes EOF', async explicitCancel => {
  const f = fixture();
  const abort = new AbortController();
  const events: DaemonEvent[] = [];
  const store = createDaemonTranscriptStore();
  const consume = (async () => {
    for await (const event of f.session.events()) {
      events.push(event);
      store.dispatch(normalizeDaemonEvent(event));
    }
  })();
  const admission = await f.session.submitPrompt(question, abort.signal);
  // Match WebShell Stop: abort local ownership, then explicitly call Cancel once.
  abort.abort();
  if (explicitCancel) await f.session.cancel();
  await consume;
  expect(f.streams[0]!.signal.aborted).toBe(true);
  expect(events.some(event => ['turn_error', 'turn_complete', 'prompt_cancelled'].includes(event.type))).toBe(false);
  expect(store.getSnapshot().blocks.some(block => block.kind === 'error')).toBe(false);
  const replay: DaemonEvent[] = [];
  for await (const event of f.session.events()) replay.push(event);
  expect(replay.some(event => event.promptId === admission.promptId)).toBe(false);
  expect(f.paths.filter(path => path.endsWith('/cancel'))).toHaveLength(explicitCancel ? 1 : 0);
  expect(f.paths.filter(path => path.endsWith('/prompt'))).toEqual(['/api/sessions/s/prompt']);
});

it.each([undefined, 'local stop'])('decorated direct prompt preserves AbortError without Cancel (reason=%s)', async reason => {
  const f = fixture();
  const abort = new AbortController();
  const result = f.session.prompt(question, abort.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await expect.poll(() => f.streams.length).toBe(1);
  abort.abort(reason);
  await rejected;
  expect(f.paths.filter(path => path.endsWith('/cancel'))).toHaveLength(0);
  expect(f.paths.filter(path => path.endsWith('/prompt'))).toHaveLength(1);
});

it.each(['upstream', 'unrequested AbortError'])('still reports %s failure to the real SDK waiter', async failure => {
  const f = fixture(true);
  // Undecorated SDK exercises the existing public nonblocking waiter path.
  const session = new DaemonSessionClient({ client: f.client, session: {
    sessionId: 's', clientId: 'waiter', workspaceCwd: '/fixture', attached: false,
  } });
  const events: DaemonEvent[] = [];
  const consume = (async () => { for await (const event of session.events()) events.push(event); })();
  await expect.poll(() => events.length).toBe(1);
  const result = session.prompt(question);
  const rejected = expect(result).rejects.toThrow('real request failure');
  await expect.poll(() => f.streams.length).toBe(1);
  f.closeEvents();
  if (failure === 'upstream') {
    f.streams[0]!.controller.enqueue(new TextEncoder().encode('{"type":"error","error":{"message":"real request failure"}}\n'));
  } else f.streams[0]!.controller.error(new DOMException('real request failure', 'AbortError'));
  await rejected;
  await consume;
  expect(events.filter(event => event.type === 'turn_error')).toHaveLength(1);
  expect(f.streams[0]!.signal.aborted).toBe(false);
  expect(f.paths.filter(path => path.endsWith('/prompt'))).toHaveLength(1);
  expect(f.paths.filter(path => path.endsWith('/cancel'))).toHaveLength(0);
});
