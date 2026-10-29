import Fastify, { type FastifyInstance } from 'fastify';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { apiError, classifyError, withRequestId, validRequestId, popAckRequestId, type AcpFrame } from '@das/shared';
import type { AppConfig } from '../src/config.js';
import { registerDaemonRoutes } from '../src/daemon/routes.js';
import { registerPromptRoutes } from '../src/routes/prompt.js';
import { registerRestRoutes } from '../src/routes/rest.js';
import { toApiError } from '../src/normalize.js';
import { createSdkClient, SdkError, type SdkClient } from '../src/sdk.js';
import { liveCreateSession, liveHistory, livePromptFrames } from '../src/live.js';
import type { StreamTraceScope } from '../src/stream-diagnostics.js';

vi.mock('dotenv', () => ({ config: vi.fn() }));
const cfg: AppConfig = { mock: false, mockRealtime: false, mockSpeed: 4, port: 0, corsOrigin: [], regionId: 'cn-hangzhou',
  endpoint: undefined, agentName: 'test-agent', sessionSource: 'test-source', resourceGroupId: undefined,
  accessKeyId: 'synthetic-key', accessKeySecret: 'synthetic-secret', serverHost: '127.0.0.1', webDist: undefined };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.unstubAllEnvs(); });
async function appFor(client: SdkClient) {
  const app = Fastify(); apps.push(app);
  await registerDaemonRoutes(app, cfg, client);
  await registerPromptRoutes(app, cfg, client);
  await registerRestRoutes(app, cfg, client);
  return app;
}

it('keeps bounded upstream IDs through classification, redaction, and API naming', () => {
  const error = classifyError({ code: 500, message: 'denied', requestId: 'pop-id' });
  expect(toApiError(new SdkError(error), 'CreateAgentSession')).toMatchObject({ requestId: 'pop-id', kind: 'rpc_error' });
  expect(withRequestId(error, 'fallback-id').requestId).toBe('pop-id');
  for (const requestId of [undefined, '', '\r\ninvalid', 'x'.repeat(257), { rid: 'not-an-id' }]) {
    expect(validRequestId(requestId)).toBeUndefined();
    expect(JSON.parse(JSON.stringify(withRequestId(apiError('transport', 'local'), requestId)))).not.toHaveProperty('requestId');
  }
  expect(toApiError(Object.assign(new Error('socket failed'), { data: { RequestId: 'sdk-data-id' } }), 'LoadAgentSession').requestId).toBe('sdk-data-id');
  expect(popAckRequestId({ RequestId: 'pop-only' })).toBe('pop-only');
  expect(popAckRequestId({ Id: 'rpc-id', RequestId: 'turn-rid' })).toBeUndefined();
  expect(popAckRequestId({ Jsonrpc: '2.0', RequestId: 'turn-rid' })).toBeUndefined();
});

it('preserves real SDK HTTP error IDs and never retries Create', async () => {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) vi.stubEnv(key, '');
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* Drain the synthetic request. */ }
    requests++;
    res.writeHead(403, { 'content-type': 'application/json', 'x-acs-request-id': 'pop-http-denied' });
    res.end(JSON.stringify({ Code: 'Forbidden', Message: 'denied', RequestId: 'pop-http-denied' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const client = createSdkClient({ ...cfg, endpoint: `127.0.0.1:${(server.address() as { port: number }).port}` });
    client._protocol = 'http';
    const result = await liveCreateSession({ client, cfg });
    expect(result).toMatchObject({ ok: false, error: { requestId: 'pop-http-denied', upstreamStatus: 403 } });
    expect(requests).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('keeps ordinary HTTP-200 RPC errors on REST and daemon create responses without leaking IDs into the next request', async () => {
  let requestId: string | undefined = 'pop-create-denied';
  const client = { callApi: vi.fn(async () => ({ statusCode: 200, body: {
    ...(requestId ? { RequestId: requestId } : {}), JsonRpcResponse: { Error: { Code: 500, Message: 'INSTANCE_START_FAILED' } },
  } })) } as unknown as SdkClient;
  const app = await appFor(client);
  expect((await app.inject({ method: 'POST', url: '/api/sessions', payload: {} })).json()).toMatchObject({ ok: false, error: { requestId } });
  expect((await app.inject({ method: 'POST', url: '/d/standalone/sessions', payload: {} })).json()).toMatchObject({ code: 'create_failed', requestId });
  requestId = undefined;
  const next = (await app.inject({ method: 'POST', url: '/d/standalone/sessions', payload: {} })).json();
  expect(next).not.toHaveProperty('requestId');
});

it('forwards IDs for daemon management, reply, and cancellation rejections', async () => {
  const client = {
    callApi: vi.fn(async () => ({ statusCode: 200, body: { RequestId: 'pop-rpc-denied', JsonRpcResponse: { Error: { Code: 403, Message: 'denied' } } } })),
    replyAgentSessionWithOptions: vi.fn(async () => ({ statusCode: 200, body: { requestId: 'pop-reply-denied', jsonRpcResponse: { error: { code: 403, message: 'denied' } } } })),
  } as unknown as SdkClient;
  const app = await appFor(client);
  for (const request of [
    { method: 'GET' as const, url: '/d/standalone/sessions' },
    { method: 'PATCH' as const, url: '/d/standalone/sessions/sid/metadata', payload: { displayName: 'title' } },
    { method: 'DELETE' as const, url: '/d/session/sid' },
    { method: 'POST' as const, url: '/d/session/sid/cancel' },
  ]) expect((await app.inject(request)).json().requestId).toBe('pop-rpc-denied');
  const batch = await app.inject({ method: 'POST', url: '/d/standalone/sessions/archive', payload: { sessionIds: ['sid'] } });
  expect(batch.json().errors[0].requestId).toBe('pop-rpc-denied');
  const reply = await app.inject({ method: 'POST', url: '/d/session/sid/permission/permission-id', payload: { outcome: { outcome: 'selected', optionId: 'allow' } } });
  expect(reply.json().requestId).toBe('pop-reply-denied');
});

it('keeps Load HTTP header ID while never using a historical turn RID as the diagnostic ID', async () => {
  const load = vi.fn(async function* (request: { id: string }) {
    yield { headers: { 'x-acs-request-id': 'pop-load-denied' }, body: { Jsonrpc: '2.0', Id: request.id, RequestId: 'turn-rid', Error: { code: 500, message: 'load failed' } } };
  });
  const app = await appFor({ loadAgentSessionWithSSE: load } as unknown as SdkClient);
  const result = await app.inject({ method: 'POST', url: '/d/standalone/sessions/sid/load' });
  expect(result.json()).toMatchObject({ code: 'load_failed', requestId: 'pop-load-denied' });
  expect(load).toHaveBeenCalledOnce();
});

it('keeps the final Load attempt ID when history ends without a snapshot terminal', async () => {
  let calls = 0;
  const load = vi.fn(async function* () {
    calls++;
    yield { headers: { 'x-acs-request-id': `load-attempt-${calls}` }, body: { RequestId: 'pop-only-ack' } };
  });
  const app = await appFor({ loadAgentSessionWithSSE: load } as unknown as SdkClient);
  const result = await app.inject({ method: 'POST', url: '/d/standalone/sessions/sid/load' });
  expect(result.json()).toMatchObject({ code: 'load_failed', requestId: 'load-attempt-3' });
  expect(load).toHaveBeenCalledTimes(3);
});

it.each([true, false])('Events exposes the actual upstream header even when its body is rejected (SSE=%s)', async streaming => {
  const client = { callApi: vi.fn(async () => ({ statusCode: 200,
    headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json', 'x-acs-request-id': 'pop-events' },
    body: Readable.from([streaming ? 'data: {"v":1,"type":"stream_open","data":{}}\n\n' : '{}']),
  })) } as unknown as SdkClient;
  const app = await appFor(client);
  const result = await app.inject('/d/session/sid/events');
  expect(result.headers['x-acs-request-id']).toBe('pop-events');
  if (streaming) expect(result.statusCode).toBe(200);
  else expect(result.json()).toMatchObject({ code: 'events_upstream_failed', requestId: 'pop-events' });
});

it('keeps IDs for acknowledged but rejected cancellation and reply outcomes', async () => {
  const client = {
    callApi: vi.fn(async () => ({ body: { RequestId: 'pop-cancel', JsonRpcResponse: { Result: { Delivered: false, Noop: false } } } })),
    replyAgentSessionWithOptions: vi.fn(async () => ({ body: { requestId: 'pop-reply', jsonRpcResponse: { result: { accepted: false } } } })),
  } as unknown as SdkClient;
  const app = await appFor(client);
  const cancel = await app.inject({ method: 'POST', url: '/d/session/sid/cancel' });
  expect(cancel.json().requestId).toBe('pop-cancel');
  const reply = await app.inject({ method: 'POST', url: '/d/session/sid/permission/not-a-pop-id', payload: { outcome: { outcome: 'selected', optionId: 'allow' } } });
  expect(reply.json().requestId).toBe('pop-reply');
});

it.each([true, false])('NDJSON error carries only the actual POP header ID (header available: %s)', async hasHeader => {
  const client = { promptAgentSessionWithSSE: vi.fn(async function* () {
    yield { ...(hasHeader ? { headers: { 'x-acs-request-id': 'pop-prompt-denied' } } : {}),
      body: { Jsonrpc: '2.0', RequestId: 'turn-rid', Error: { code: 500, message: 'prompt failed' } } };
  }) } as unknown as SdkClient;
  const app = await appFor(client);
  const result = await app.inject({ method: 'POST', url: '/api/sessions/sid/prompt', payload: { text: 'synthetic prompt' } });
  const error = result.body.trim().split('\n').map(line => JSON.parse(line)).find(event => event.type === 'error').error;
  if (hasHeader) expect(error.requestId).toBe('pop-prompt-denied');
  else expect(error).not.toHaveProperty('requestId');
});

type LoopbackCall = { action: string; id: string; params: Record<string, unknown> };
async function withLoopbackSdk(
  respond: (call: LoopbackCall, res: ServerResponse) => void,
  run: (client: SdkClient, calls: LoopbackCall[]) => Promise<void>,
) {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) vi.stubEnv(key, '');
  const calls: LoopbackCall[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    const call = { action: String(req.headers['x-acs-action']), id: body.get('Id') ?? '',
      params: JSON.parse(body.get('Params') ?? '{}') as Record<string, unknown> };
    calls.push(call);
    respond(call, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const client = createSdkClient({ ...cfg, endpoint: `127.0.0.1:${(server.address() as { port: number }).port}` });
    client._protocol = 'http';
    await run(client, calls);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
const sseData = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
const resumeChunk = (sessionId = 'sid'): AcpFrame => ({ Jsonrpc: '2.0', RequestId: 'original-turn',
  Params: { sessionId, _meta: { offset: 7 },
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'synthetic' } } } });
async function collectRequestIdFrames(stream: AsyncIterable<AcpFrame>) {
  const frames: AcpFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

it.each(['Prompt', 'Load'] as const)('real SDK %s retains the HTTP ID when its first SSE data is invalid JSON', async action => {
  const headerId = `first-invalid-${action}`;
  await withLoopbackSdk((_call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-acs-request-id': headerId });
    res.end('data: {invalid-json\n\n');
  }, async (client, calls) => {
    if (action === 'Prompt') {
      const scope: StreamTraceScope = {};
      await expect(collectRequestIdFrames(livePromptFrames({ client, cfg }, 'sid', 'synthetic', [], scope)))
        .rejects.toMatchObject({ apiError: { requestId: headerId, kind: 'transport' } });
      expect(scope.current?.requestId()).toBe(headerId);
      expect(calls).toHaveLength(1);
    } else {
      expect(await liveHistory({ client, cfg }, 'sid')).toMatchObject({ ok: false,
        error: { requestId: headerId, kind: 'transport' } });
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call.action === `${action}AgentSession`)).toBe(true);
  });
});

it('real SDK Load replay ignores another turn error without Id and reaches the original Prompt terminal', async () => {
  let promptId = '';
  const terminal = { Jsonrpc: '2.0', RequestId: 'original-turn', Id: '', Result: { stopReason: 'end_turn' } };
  await withLoopbackSdk((call, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-acs-request-id': `header-${call.action}` });
    if (call.action === 'PromptAgentSession') {
      promptId = call.id;
      res.end(sseData(resumeChunk()));
    } else {
      terminal.Id = promptId;
      res.end(sseData({ Jsonrpc: '2.0', RequestId: 'historical-other-turn',
        Error: { code: 500, message: 'synthetic historical failure' } }) + sseData(terminal));
    }
  }, async (client, calls) => {
    const frames = await collectRequestIdFrames(livePromptFrames({ client, cfg }, 'sid', 'synthetic'));
    expect(frames).toEqual([resumeChunk(), terminal]);
    expect(calls.map(call => call.action)).toEqual(['PromptAgentSession', 'LoadAgentSession']);
    expect(calls[1]?.params).toMatchObject({ Meta: { IsReload: true, BeginLogOffset: 7 } });
  });
});

it('real SDK recovery replaces Load1 header trace before Load2 fails with no ID', async () => {
  let loads = 0;
  await withLoopbackSdk((call, res) => {
    if (call.action === 'PromptAgentSession') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-acs-request-id': 'prompt-header' });
      res.end(sseData(resumeChunk()));
    } else if (++loads === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-acs-request-id': 'load1-header' });
      res.end(sseData({ RequestId: 'load1-ack' }));
    } else {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Code: 'Forbidden', Message: 'synthetic Load2 denied' }));
    }
  }, async (client, calls) => {
    const scope: StreamTraceScope = {};
    const acks: string[] = [];
    let caught: unknown;
    try { await collectRequestIdFrames(livePromptFrames({ client, cfg }, 'sid', 'synthetic', acks, scope)); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(SdkError);
    const error = toApiError(caught, 'LoadAgentSession');
    expect(error).toMatchObject({ upstreamStatus: 403 });
    expect(error).not.toHaveProperty('requestId');
    expect(scope.current).toBeDefined();
    expect(scope.current?.requestId()).toBeUndefined();
    expect(loads).toBe(2);
    expect(calls.map(call => call.action)).toEqual(['PromptAgentSession', 'LoadAgentSession', 'LoadAgentSession']);
  });
});

it.each(['Prompt', 'Load'] as const)('%s prefers the observed stream header H over a later SDK exception ID E', async action => {
  // Keep the generated SDK parser/cast; inject only its raw SSE transport so a
  // single stream can yield header H and subsequently throw an SDK-shaped E.
  const client = createSdkClient({ ...cfg, endpoint: '127.0.0.1:1' });
  const original = client.callSSEApi;
  client.callSSEApi = vi.fn(async function* () {
    yield { statusCode: 200, headers: { 'x-acs-request-id': 'header-H' },
      event: { data: JSON.stringify({ RequestId: 'ack-A' }) } };
    throw Object.assign(new Error('synthetic stream failure'), { requestId: 'exception-E', statusCode: 403 });
  }) as SdkClient['callSSEApi'];
  try {
    if (action === 'Prompt') {
      await expect(collectRequestIdFrames(livePromptFrames({ client, cfg }, 'sid', 'synthetic')))
        .rejects.toMatchObject({ apiError: { requestId: 'header-H' } });
    } else {
      expect(await liveHistory({ client, cfg }, 'sid')).toMatchObject({ ok: false, error: { requestId: 'header-H' } });
    }
    expect(client.callSSEApi).toHaveBeenCalledOnce();
  } finally { client.callSSEApi = original; }
});

it('real SDK concurrent ParseErrors on the same client retain distinct per-stream header IDs', async () => {
  const pending = new Map<string, ServerResponse>();
  await withLoopbackSdk((call, res) => {
    const sessionId = String(call.params.SessionId);
    pending.set(sessionId, res);
    // Both RPCs must be open before either parser fails. Send B before A to
    // expose a shared-client hook or a shared last-request-ID accumulator.
    if (pending.size === 2) {
      for (const sid of ['session-B', 'session-A']) {
        const response = pending.get(sid)!;
        response.writeHead(200, { 'content-type': 'text/event-stream', 'x-acs-request-id': `parse-${sid}` });
        response.end('data: {invalid-json\n\n');
      }
    }
  }, async (client, calls) => {
    const original = client.callSSEApi;
    const scopes: StreamTraceScope[] = [{}, {}];
    const results = await Promise.allSettled(['session-A', 'session-B'].map((sid, index) =>
      collectRequestIdFrames(livePromptFrames({ client, cfg }, sid, 'synthetic', [], scopes[index]))));
    for (const [index, result] of results.entries()) {
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') throw new Error('Expected the generated SDK JSON parser to reject');
      const expectedId = `parse-session-${index === 0 ? 'A' : 'B'}`;
      expect(toApiError(result.reason, 'PromptAgentSession')).toMatchObject({ requestId: expectedId, kind: 'transport' });
      expect(scopes[index]?.current?.requestId()).toBe(expectedId);
    }
    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.action === 'PromptAgentSession')).toBe(true);
    expect(client.callSSEApi).toBe(original);
    expect(Object.hasOwn(client, 'callSSEApi')).toBe(false);
  });
});
