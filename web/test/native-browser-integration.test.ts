import { PassThrough } from 'node:stream';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { DaemonClient, DaemonSessionClient, type DaemonEvent } from '@qwen-code/sdk/daemon';
import { registerDaemonRoutes } from '../../server-node/src/daemon/routes.js';
import { registerPromptRoutes } from '../../server-node/src/routes/prompt.js';
import { installHttpPromptTransport } from '../src/http-prompt-transport.js';
import { verifyAdapter } from '../../scripts/e2e/native-adapter.js';

it('acceptance driver checks two SDK subscribers, two turns and completed replay through the HTTP adapter', async () => {
  const journal: DaemonEvent[] = [];
  const streams = new Set<PassThrough>();
  let submissions = 0;
  const wire = (event: DaemonEvent) => `${event.id === undefined ? '' : `id: ${event.id}\n`}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  const client = {
    loadAgentSessionWithSSE: vi.fn((request: { id: string }) => (async function* () {
      for (const event of journal) if (event.type === 'session_update') yield { body: {
        Jsonrpc: '2.0', RequestId: event.promptId, Method: 'session/update', Params: { sessionId: 'business', update: (event.data as { update: unknown }).update } } };
      yield { body: { Jsonrpc: '2.0', Id: request.id, Result: { stopReason: 'end_turn' } } };
    })()),
    callApi: vi.fn(async (_params: unknown, request: { query: { LastEventId?: string }; headers?: Record<string, string> }) => {
      const body = new PassThrough(); streams.add(body); body.on('close', () => streams.delete(body));
      body.write(wire({ v: 1, type: 'stream_open', data: { sessionId: 'business', nativeSessionId: 'native', eventEpoch: 'epoch' } }));
      const last = request.headers?.['Last-Event-Id'];
      if (last !== undefined) {
        const replay = journal.filter(event => event.id! > Number(last));
        for (const event of replay) body.write(wire(event));
        body.write(wire({ v: 1, type: 'replay_complete', data: { replayedCount: replay.length,
          ...(replay.length ? { lastReplayedEventId: replay.at(-1)!.id } : {}) } }));
      }
      return { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body };
    }),
    callSSEApi: vi.fn((_params: unknown, request: { body: { Id: string; Params: string } }) => (async function* () {
      const promptId = `prompt-${++submissions}`;
      const text = JSON.parse(request.body.Params).Prompt[0].Text;
      const user = { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } };
      const assistant = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
      for (const [type, data] of [['session_update', { sessionId: 'native', update: user }],
        ['session_update', { sessionId: 'native', update: assistant }], ['turn_complete', { sessionId: 'native', promptId, stopReason: 'end_turn' }]] as const) {
        const id = journal.length + 1;
        const event = { v: 1, id, type, data, promptId } as DaemonEvent;
        journal.push(event); for (const body of streams) body.write(wire(event));
        yield { statusCode: 200, headers: {}, event: { data: JSON.stringify({ Jsonrpc: '2.0',
          ...(type === 'turn_complete' ? { Id: request.body.Id, Result: { stopReason: 'end_turn' } }
            : { Method: 'session/update', Params: { sessionId: 'business', update: data.update } }),
          _meta: { eventCursor: { sessionId: 'business', eventEpoch: 'epoch', eventId: String(id), promptId, eventType: type } } }) } };
      }
    })()),
  };
  const cfg = { mock: false, mockRealtime: false, mockSpeed: 4, port: 0, corsOrigin: [], regionId: 'cn-beijing',
    agentName: 'test-agent', sessionSource: 'test-source', accessKeyId: 'synthetic', accessKeySecret: 'synthetic', serverHost: '127.0.0.1' };
  const app = Fastify();
  await registerDaemonRoutes(app, cfg as never, client as never); await registerPromptRoutes(app, cfg as never, client as never);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const result = await verifyAdapter(base, 'business', AbortSignal.timeout(5000));
    expect(result.rounds).toHaveLength(2); expect(submissions).toBe(2);
  } finally { for (const stream of streams) stream.destroy(); await app.close(); }
});

it('real HTTP proxy and SDK submitPrompt deliver a live user echo and terminal without any replay receipt', async () => {
  const sid = 'business';
  const promptId = 'native-prompt';
  const epoch = 'epoch';
  const body = new PassThrough();
  const send = (event: DaemonEvent) => body.write(`${event.id === undefined ? '' : `id: ${event.id}\n`}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const update = { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'only once' } };
  const client = {
    callApi: vi.fn(async () => {
      send({ v: 1, type: 'stream_open', data: { sessionId: sid, nativeSessionId: 'native', eventEpoch: epoch } });
      return { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body };
    }),
    callSSEApi: vi.fn((_params: unknown, request: { body: { Id: string; Params: string } }) => (async function* () {
      expect(JSON.parse(request.body.Params)).toEqual({ SessionId: sid, Prompt: [{ Type: 'text', Text: 'only once' }] });
      send({ v: 1, id: 5, type: 'session_update', promptId, data: { sessionId: 'native', update } });
      send({ v: 1, id: 6, type: 'turn_complete', promptId, data: { sessionId: 'native', promptId, stopReason: 'end_turn' } });
      yield { statusCode: 200, headers: {}, event: { data: JSON.stringify({ Jsonrpc: '2.0', Method: 'session/update',
        Params: { sessionId: sid, update }, _meta: { eventCursor: {
          sessionId: sid, eventEpoch: epoch, eventId: '5', promptId, eventType: 'session_update',
        } } }) } };
      yield { statusCode: 200, headers: {}, event: { data: JSON.stringify({ Jsonrpc: '2.0', Id: request.body.Id,
        Result: { stopReason: 'end_turn' }, _meta: { eventCursor: {
          sessionId: sid, eventEpoch: epoch, eventId: '6', promptId, eventType: 'turn_complete',
        } } }) } };
    })()),
  };
  const cfg = { mock: false, mockRealtime: false, mockSpeed: 4, port: 0, corsOrigin: [], regionId: 'cn-beijing',
    agentName: 'test-agent', sessionSource: 'test-source', accessKeyId: 'synthetic', accessKeySecret: 'synthetic', serverHost: '127.0.0.1' };
  const app = Fastify();
  await registerDaemonRoutes(app, cfg as never, client as never);
  await registerPromptRoutes(app, cfg as never, client as never);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });
  const daemon = new DaemonClient({ baseUrl: `${base}/d` });
  const adapter = installHttpPromptTransport(daemon, `${base}/d`, async () => 'http-stream');
  const session = new DaemonSessionClient({ client: daemon, session: { sessionId: sid, clientId: 'browser', workspaceCwd: '/data-agent', attached: false } });
  adapter.decorate(session);
  const abort = new AbortController();
  const observed: DaemonEvent[] = [];
  const reading = (async () => { for await (const event of session.events({ signal: abort.signal })) observed.push(event); })();
  try {
    await expect.poll(() => observed.some(event => event.type === 'stream_open')).toBe(true);
    const accepted = await session.submitPrompt({ prompt: [{ type: 'text', text: 'only once' }] });
    expect(accepted.promptId).toBeTruthy();
    await expect.poll(() => observed.filter(event => event.type === 'turn_complete').length).toBe(1);
    expect(observed.filter(event => event.type === 'session_update')).toEqual([
      expect.objectContaining({ data: { sessionId: sid, update } }),
    ]);
    expect(observed.some(event => event.type === 'replay_complete')).toBe(false);
    expect(client.callSSEApi).toHaveBeenCalledOnce();
    expect(observed.some(event => event.promptId === accepted.promptId && event._meta?.nativePromptId === promptId)).toBe(true);
    expect(observed.find(event => event.type === 'turn_complete')?.promptId).toBe(accepted.promptId);
    expect(client.callApi.mock.calls.length).toBeGreaterThan(0);
    for (const [, request] of client.callApi.mock.calls as unknown as Array<[unknown, { query?: { EventEpoch?: string }; headers?: Record<string, string> }]>) {
      if (request.headers?.['Last-Event-Id'] !== undefined) expect(request.query?.EventEpoch).toBe(epoch);
    }
  } finally {
    abort.abort(); adapter.dispose(); daemon.dispose(); body.destroy();
    await reading.catch(() => {}); await app.close();
  }
});
