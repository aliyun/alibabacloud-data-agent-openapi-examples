import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { SessionRegistry } from '../src/daemon/registry.js';
import { registerDaemonRoutes } from '../src/daemon/routes.js';
import { registerPromptRoutes } from '../src/routes/prompt.js';
import type { SdkClient } from '../src/sdk.js';

const cfg: AppConfig = {
  mock: false, mockRealtime: false, mockSpeed: 4, port: 0, corsOrigin: [], regionId: 'cn-beijing',
  endpoint: undefined, agentName: 'test-agent', sessionSource: 'test-source', resourceGroupId: undefined,
  accessKeyId: 'test-id', accessKeySecret: 'test-secret', serverHost: '127.0.0.1', webDist: undefined,
};
const apps: FastifyInstance[] = [];
async function appFor(client?: SdkClient) {
  const app = Fastify(); apps.push(app);
  await registerDaemonRoutes(app, { ...cfg, mock: !client }, client);
  await registerPromptRoutes(app, { ...cfg, mock: !client }, client);
  return app;
}
function fakeClient() {
  const callApi = vi.fn(async (params: { action: string }) => ({ body: { JsonRpcResponse: { Result:
    params.action === 'ListAgentSessions' ? { AgentSessions: [{ SessionId: 'sid', SessionTitle: 'remote title',
      SessionCreatedAt: 1, SessionUpdatedAt: 2, Meta: { SessionSource: cfg.sessionSource } }], TotalCount: 1 }
      : params.action === 'CancelAgentSession' ? { Delivered: true, Noop: false }
        : params.action === 'CreateAgentSession' ? { SessionId: 'sid' } : {},
  } } }));
  const replyAgentSessionWithOptions = vi.fn(async () => ({ body: { jsonRpcResponse: { result: { accepted: true } } } }));
  const promptAgentSessionWithSSE = vi.fn(async function* () {
    yield { body: { RequestId: 'own-rid', Jsonrpc: '2.0', Result: { stopReason: 'end_turn' } } };
  });
  const loadAgentSessionWithSSE = vi.fn(async function* (request: { id: string }) {
    yield { body: { Id: request.id, RequestId: 'history-rid', Jsonrpc: '2.0', Result: { stopReason: 'end_turn' } } };
  });
  return { callApi, replyAgentSessionWithOptions, promptAgentSessionWithSSE, loadAgentSessionWithSSE };
}
function clientOf(fake: ReturnType<typeof fakeClient>) { return fake as unknown as SdkClient; }
function poisonRegistry() {
  for (const name of ['resolve', 'ensure', 'remove', 'listSummaries', 'allRecords', 'archivedSummaries', 'stats', 'summaryFor'] as const) {
    vi.spyOn(SessionRegistry.prototype, name).mockImplementation(() => { throw new Error(`LIVE must not access SessionRegistry.${name}`); });
  }
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  vi.restoreAllMocks();
});

describe('LIVE stateless HTTP prompt and remote daemon projection', () => {
  beforeEach(poisonRegistry);

  it('announces the connection-owned HTTP prompt transport', async () => {
    const app = await appFor(clientOf(fakeClient()));
    const response = await app.inject('/d/openapi/session-options');
    expect(response.statusCode).toBe(200);
    expect(response.json().promptTransport).toBe('http-stream');
  });

  it('retires both the background 202 admission and the completion receipt without dispatch', async () => {
    const fake = fakeClient(); const app = await appFor(clientOf(fake));
    for (const url of ['/d/session/sid/prompt', '/d/session/sid/openapi-prompt/old-prompt/receipt']) {
      const response = await app.inject({ method: 'POST', url, payload: { prompt: [{ type: 'text', text: 'never dispatch' }] } });
      expect([404, 410]).toContain(response.statusCode);
    }
    expect(fake.promptAgentSessionWithSSE).not.toHaveBeenCalled();
  });

  it('reports unknown status as unavailable while heartbeat remains a protocol acknowledgement', async () => {
    const app = await appFor(clientOf(fakeClient()));
    expect((await app.inject('/d/daemon/status')).statusCode).toBe(404);
    expect((await app.inject('/d/session/sid/status')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/d/session/sid/heartbeat' })).statusCode).toBe(204);
  });

  it('reads every directory from the upstream and omits unsupported activity assertions', async () => {
    const fake = fakeClient(); const app = await appFor(clientOf(fake));
    for (const url of ['/d/standalone/sessions', '/d/standalone/sessions?archiveState=archived']) {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(200);
      const [summary] = response.json().sessions;
      expect(summary).toMatchObject({ sessionId: 'sid', displayName: 'remote title', sourceType: 'standalone' });
      for (const field of ['hasActivePrompt', 'isWaitingForPermission', 'clientCount']) expect(summary).not.toHaveProperty(field);
    }
    expect(fake.callApi.mock.calls.map(([params]) => params.action)).toEqual(['ListAgentSessions', 'ListAgentSessions']);
  });

  it('returns the upstream creation ID without registering creation options', async () => {
    const fake = fakeClient(); const app = await appFor(clientOf(fake));
    const response = await app.inject({ method: 'POST', url: '/d/standalone/sessions',
      payload: { modelServiceId: 'requested-model', approvalMode: 'auto', reasoningEffort: 'none' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().sessionId).toBe('sid');
    expect(fake.callApi.mock.calls.map(([params]) => params.action)).toEqual(['CreateAgentSession']);
  });

  it('loads and resumes fresh history without a local model snapshot or invented Events watermark', async () => {
    const fake = fakeClient(); const app = await appFor(clientOf(fake));
    for (const operation of ['load', 'resume']) {
      const response = await app.inject({ method: 'POST', url: `/d/standalone/sessions/sid/${operation}`, payload: {} });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ sessionId: 'sid', liveJournal: [], state: { models: { currentModelId: null } } });
      expect(response.json()).not.toHaveProperty('lastEventId');
    }
    expect(fake.loadAgentSessionWithSSE).toHaveBeenCalledTimes(2);
  });

  it('performs mutations remotely and does not retain a deleted or renamed overlay', async () => {
    const fake = fakeClient(); const app = await appFor(clientOf(fake));
    expect((await app.inject({ method: 'PATCH', url: '/d/session/sid/metadata', payload: { displayName: 'requested title' } })).statusCode).toBe(200);
    for (const action of ['archive', 'unarchive', 'delete']) {
      const response = await app.inject({ method: 'POST', url: `/d/standalone/sessions/${action}`, payload: { sessionIds: ['sid'] } });
      expect(response.statusCode).toBe(200);
      expect(response.json().errors).toEqual([]);
    }
    expect((await app.inject({ method: 'DELETE', url: '/d/session/sid' })).statusCode).toBe(204);
    const listed = await app.inject('/d/standalone/sessions');
    expect(listed.json().sessions).toEqual([expect.objectContaining({ sessionId: 'sid', displayName: 'remote title' })]);
    expect(fake.callApi.mock.calls.map(([params]) => params.action)).toEqual([
      'UpdateAgentSessionTitle', 'ArchiveAgentSession', 'ArchiveAgentSession', 'DeleteAgentSession', 'DeleteAgentSession', 'ListAgentSessions',
    ]);
  });

  it('forwards every scoped permission attempt and rejects unscoped legacy replies', async () => {
    const fake = fakeClient(); const app = await appFor(clientOf(fake));
    const payload = { outcome: { outcome: 'selected', optionId: 'proceed_once' } };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await app.inject({ method: 'POST', url: '/d/session/sid/permission/question', payload })).statusCode).toBe(200);
    }
    expect(fake.replyAgentSessionWithOptions).toHaveBeenCalledTimes(2);
    const legacy = await app.inject({ method: 'POST', url: '/d/permission/question', payload });
    expect([400, 404, 410]).toContain(legacy.statusCode);
    expect(fake.replyAgentSessionWithOptions).toHaveBeenCalledTimes(2);
  });

  it('keeps legacy Cancel SDK acceptance without using a session record', async () => {
    const fake = fakeClient(); const app = await appFor(clientOf(fake));
    expect((await app.inject({ method: 'POST', url: '/d/session/sid/cancel' })).statusCode).toBe(204);
    expect(fake.callApi.mock.calls.map(([params]) => params.action)).toEqual(['CancelAgentSession']);
  });

  it.each([undefined, '0', '42'])('forwards only this request cursor (%s) and preserves a remote terminal without own controls', async lastEventId => {
    const event = { v: 1, id: 43, type: 'turn_complete', data: { sessionId: 'sid', stopReason: 'end_turn' } };
    const callApi = vi.fn(async () => ({ statusCode: 200, headers: { 'content-type': 'text/event-stream' },
      body: Readable.from([`id: 43\nevent: turn_complete\ndata: ${JSON.stringify(event)}\n\n`]),
    }));
    const app = await appFor({ callApi } as unknown as SdkClient);
    const response = await app.inject({ method: 'GET', url: '/d/session/sid/events',
      headers: lastEventId === undefined ? {} : { 'last-event-id': lastEventId },
    });
    expect(response.statusCode).toBe(200);
    const line = response.body.split('\n').find(line => line.startsWith('data: '));
    expect(JSON.parse(line!.slice(6))).toEqual(event);
    expect(response.body).not.toContain('workbench_prompt_result');
    expect(callApi).toHaveBeenCalledTimes(1);
    const request = callApi.mock.calls[0] as unknown as [unknown, { headers: Record<string, string>; query: unknown }];
    expect(request[1].query).toEqual({ SessionCode: 'sid' });
    expect(request[1].headers['Last-Event-Id']).toBe(lastEventId);
  });

  it('does not reuse a previous subscriber cursor on the next request', async () => {
    const callApi = vi.fn(async () => ({ statusCode: 200, headers: { 'content-type': 'text/event-stream' },
      body: Readable.from(['data: {"v":1,"id":99,"type":"stream_open","data":{"sessionId":"sid"}}\n\n']),
    }));
    const app = await appFor({ callApi } as unknown as SdkClient);
    expect((await app.inject({ url: '/d/session/sid/events', headers: { 'last-event-id': '7' } })).statusCode).toBe(200);
    expect((await app.inject('/d/session/sid/events')).statusCode).toBe(200);
    const calls = callApi.mock.calls as unknown as Array<[unknown, { headers: Record<string, string> }]>;
    expect(calls[0]?.[1].headers['Last-Event-Id']).toBe('7');
    expect(calls[1]?.[1].headers).not.toHaveProperty('Last-Event-Id');
  });

  it('does not hide an upstream listing failure as an empty directory', async () => {
    const callApi = vi.fn().mockResolvedValue({ body: { JsonRpcResponse: { Error: { Code: 'Denied', Message: 'list denied' } } } });
    const app = await appFor({ callApi } as unknown as SdkClient);
    const response = await app.inject('/d/standalone/sessions');
    expect(response.statusCode).toBe(502);
    expect(response.json()).not.toHaveProperty('sessions');
  });

  it('does not infer a missing session from truncated active and archived lists', async () => {
    const callApi = vi.fn().mockResolvedValue({ body: { JsonRpcResponse: { Result: { AgentSessions: [], NextToken: 'more', TotalCount: 2000 } } } });
    const app = await appFor({ callApi } as unknown as SdkClient);
    const response = await app.inject('/d/standalone/sessions/sid');
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('lookup_incomplete');
  });

  it('flushes admission headers before any upstream frame and never cancels or replays on client disconnect', async () => {
    const fake = fakeClient();
    let release!: () => void; let finished = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fake.promptAgentSessionWithSSE.mockImplementation(async function* () {
      try { await gate; yield { body: { RequestId: 'own-rid', Jsonrpc: '2.0', Result: { stopReason: 'end_turn' } } }; }
      finally { finished = true; }
    });
    const app = await appFor(clientOf(fake));
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        fetch(`${base}/api/sessions/sid/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'wait before first token' }), signal: abort.signal }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('headers waited for the first model frame')), 2000); }),
      ]);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/x-ndjson');
      expect(finished).toBe(false);
      await vi.waitFor(() => expect(fake.promptAgentSessionWithSSE).toHaveBeenCalledOnce());
      abort.abort();
      await response.body?.cancel().catch(() => undefined);
      release();
      await vi.waitFor(() => expect(finished).toBe(true));
      expect(fake.callApi).not.toHaveBeenCalled(); // Includes CancelAgentSession.
      expect(fake.promptAgentSessionWithSSE).toHaveBeenCalledOnce();
    } finally { if (timer) clearTimeout(timer); abort.abort(); release(); }
  });

  it('reports an owned stream EOF before terminal as unknown without retrying Prompt or cancelling', async () => {
    const fake = fakeClient();
    const promptAgentSessionWithSSE = vi.fn(async function* () {
      yield { body: { Jsonrpc: '2.0', RequestId: 'own-rid', Params: { sessionId: 'sid',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } } } } };
    });
    const app = await appFor({ ...fake, promptAgentSessionWithSSE } as unknown as SdkClient);
    const response = await app.inject({ method: 'POST', url: '/api/sessions/sid/prompt', payload: { text: 'question' } });
    const events = response.body.trim().split('\n').map(line => JSON.parse(line));
    expect(events.filter(event => event.type === 'done')).toEqual([]);
    expect(events.filter(event => event.type === 'error')).toEqual([expect.objectContaining({ error: expect.objectContaining({ kind: 'stream_break' }) })]);
    expect(promptAgentSessionWithSSE).toHaveBeenCalledOnce();
    expect(fake.callApi).not.toHaveBeenCalled();
    expect(fake.loadAgentSessionWithSSE).not.toHaveBeenCalled();
  });

  it('admits two LIVE HTTP streams for the same session and keeps each RPC terminal on its own connection', async () => {
    let release!: () => void;
    let bothStarted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { bothStarted = resolve; });
    let calls = 0;
    const promptAgentSessionWithSSE = vi.fn(async function* () {
      const index = ++calls;
      if (calls === 2) bothStarted();
      await gate;
      yield { body: { Jsonrpc: '2.0', RequestId: `own-${index}`, Result: { stopReason: index === 1 ? 'end_turn' : 'cancelled' } } };
    });
    const app = await appFor({ promptAgentSessionWithSSE } as unknown as SdkClient);
    const first = app.inject({ method: 'POST', url: '/api/sessions/sid/prompt', payload: { text: 'first' } }).then(response => response);
    const second = app.inject({ method: 'POST', url: '/api/sessions/sid/prompt', payload: { text: 'second' } }).then(response => response);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([entered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('LIVE used the global inflight lock')), 1000); })]);
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await Promise.all([first, second]);
    }
    const responses = await Promise.all([first, second]);
    expect(calls).toBe(2);
    const terminals = responses.map(response => {
      expect(response.headers['content-type']).toContain('application/x-ndjson');
      const events = response.body.trim().split('\n').map(line => JSON.parse(line));
      const done = events.filter(event => event.type === 'done');
      expect(done).toHaveLength(1);
      return done[0].rid;
    });
    expect(new Set(terminals)).toEqual(new Set(['own-1', 'own-2']));
  });
});

it('keeps MOCK on daemon admission and event transport', async () => {
  const app = await appFor();
  expect((await app.inject('/d/openapi/session-options')).json().promptTransport).toBe('daemon');
});
