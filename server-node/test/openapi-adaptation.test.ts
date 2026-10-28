import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { AppConfig } from '../src/config.js';
import { createSdkClient, type SdkClient } from '../src/sdk.js';
import { callOpenApi, openSessionEvents, parseSse } from '../src/openapi.js';
import { remoteEvent } from '../src/daemon/remote-events.js';
import { registerDaemonRoutes } from '../src/daemon/routes.js';
import { buildCreateSessionRequest, liveCancel } from '../src/live.js';

const cfg: AppConfig = { mock: false, mockRealtime: false, mockSpeed: 4, port: 0, corsOrigin: [],
  regionId: 'cn-beijing', endpoint: undefined, agentName: 'test-agent', sessionSource: 'test-source',
  resourceGroupId: undefined, accessKeyId: 'test-id', accessKeySecret: 'test-secret', serverHost: '127.0.0.1', webDist: undefined };
afterEach(() => vi.restoreAllMocks());

describe('new OpenAPI wire and event adaptation', () => {
  it('preserves new creation fields and does not send ACS resource identifiers', () => {
    const wire = buildCreateSessionRequest(cfg, { modelServiceId: 'test-model', approvalMode: 'auto', reasoningEffort: 'none' }).toMap();
    expect(wire.Params.Meta.Agent.AgentName).toBe('test-agent');
    expect(wire.Params.Meta.InitialConfigOptions).toMatchObject({ Model: 'test-model', Mode: 'auto', ReasoningEffort: 'none' });
    expect(wire.Params.Meta.InitialConfigOptions.ResourceGroupId).toBeUndefined();
  });

  it('normalizes generic RPC results and rejects JSON-RPC business errors', async () => {
    const callApi = vi.fn().mockResolvedValueOnce({ body: { RequestId: 'rid', JsonRpcResponse: { Result: { SessionId: 'sid' } } } })
      .mockResolvedValueOnce({ body: { RequestId: 'failed-rid', JsonRpcResponse: { Error: { Code: 'DENIED', Message: 'denied' } } } });
    const client = { callApi } as unknown as SdkClient;
    expect((await callOpenApi(client, 'CreateAgentSession', {})).body).toMatchObject({ requestId: 'rid', jsonRpcResponse: { result: { sessionId: 'sid' } } });
    await expect(callOpenApi(client, 'DeleteAgentSession', {})).rejects.toMatchObject({ message: 'denied', requestId: 'failed-rid' });
    expect(JSON.parse(callApi.mock.calls[0]![1].body.Params)).toEqual({});
  });

  it('parses split UTF-8, CRLF and multiline data without inventing a final event', async () => {
    const bytes = Buffer.from('id: 12\r\nevent: session_update\r\ndata: 中文\r\ndata: 第二行\r\n\r\ndata: incomplete');
    const frames = [];
    for await (const frame of parseSse(Readable.from([...bytes].map(value => Buffer.from([value]))))) frames.push(frame);
    expect(frames).toEqual([{ id: '12', event: 'session_update', data: '中文\n第二行' }]);
  });

  it('unwraps POP Event strings and preserves remote cursor and permission controls', () => {
    const event = { v: 1, type: 'permission_request', data: { sessionId: 'sid', requestId: 'question',
      toolCall: { _meta: { toolName: 'ask_user_question' } }, options: [] } };
    const result = remoteEvent({ data: JSON.stringify({ Id: '42', Event: JSON.stringify(event) }) }, 'sid')!;
    expect(result.id).toBe(42);
    expect(result.data.options).toEqual([expect.objectContaining({ optionId: '__openapi_answers__' })]);
    expect(() => remoteEvent({ data: JSON.stringify({ type: 'session_update', data: { sessionId: 'other' } }) }, 'sid')).toThrow('其他会话');
    expect(() => remoteEvent({ data: JSON.stringify({ Event: 42 }) }, 'sid')).toThrow('无效事件载荷');
  });

  it('performs rename/archive/delete upstream and does not mutate locally on denial', async () => {
    const callApi = vi.fn().mockResolvedValue({ body: { JsonRpcResponse: { Result: {} } } });
    const app = Fastify();
    await registerDaemonRoutes(app, cfg, { callApi } as unknown as SdkClient);
    try {
      expect((await app.inject({ method: 'PATCH', url: '/d/standalone/sessions/sid/metadata', payload: { displayName: 'new title' } })).statusCode).toBe(200);
      expect(JSON.parse(callApi.mock.calls[0]![1].body.Params)).toEqual({ SessionId: 'sid', Title: 'new title' });
      await app.inject({ method: 'POST', url: '/d/standalone/sessions/archive', payload: { sessionIds: ['sid'] } });
      expect(JSON.parse(callApi.mock.calls[1]![1].body.Params)).toEqual({ SessionId: 'sid', Archived: true });
      callApi.mockResolvedValueOnce({ body: { JsonRpcResponse: { Error: { Message: 'forbidden' } } } });
      const result = await app.inject({ method: 'POST', url: '/d/standalone/sessions/delete', payload: { sessionIds: ['sid'] } });
      expect(result.json().removed).toEqual([]);
      expect(result.json().errors).toHaveLength(1);
      callApi.mockResolvedValueOnce({ body: { JsonRpcResponse: { Result: { AgentSessions: [{ SessionId: 'sid', SessionTitle: 'remote title' }] } } } });
      expect((await app.inject('/d/standalone/sessions/sid')).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it('rejects invalid creation options before any cloud request; existing edits require a new session', async () => {
    const callApi = vi.fn(); const app = Fastify();
    await registerDaemonRoutes(app, cfg, { callApi } as unknown as SdkClient);
    try {
      expect((await app.inject({ method: 'POST', url: '/d/standalone/sessions', payload: { approvalMode: 'typo' } })).statusCode).toBe(400);
      expect(callApi).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'POST', url: '/d/session/sid/model', payload: { modelId: 'new' } })).statusCode).toBe(409);
    } finally { await app.close(); }
  });

  it.each([
    { Error: { Code: 'Denied', Message: 'cancel denied' } },
    {},
    { Result: { Delivered: false, Noop: false } },
    { Result: { SessionId: 'another-session' } },
    { Result: { Delivered: false, Noop: false, SessionId: 'sid' } },
  ])('does not acknowledge a failed or unconfirmed remote cancellation: %j', async rpc => {
    const callApi = vi.fn().mockResolvedValue({ statusCode: 200, body: {
      RequestId: 'cancel-denied', JsonRpcResponse: rpc,
    } });
    const app = Fastify();
    await registerDaemonRoutes(app, cfg, { callApi } as unknown as SdkClient);
    try {
      const result = await app.inject({ method: 'POST', url: '/d/session/sid/cancel' });
      expect(result.statusCode).toBe(502);
      expect(result.json().code).toBe('cancel_failed');
      expect(callApi).toHaveBeenCalledOnce();
      expect(JSON.parse(callApi.mock.calls[0]![1].body.Params)).toEqual({ SessionId: 'sid' });
    } finally { await app.close(); }
  });

  it('accepts only a matching legacy cancel acknowledgement without claiming delivery', async () => {
    const client = { callApi: vi.fn().mockResolvedValue({ statusCode: 200, body: {
      JsonRpcResponse: { Result: { SessionId: 'sid' } },
    } }) } as unknown as SdkClient;
    expect(await liveCancel({ client, cfg }, 'sid')).toMatchObject({ ok: true, result: {
      accepted: true, delivered: false, warning: 'cancel-accepted-legacy',
    } });
    const app = Fastify(); await registerDaemonRoutes(app, cfg, client);
    try { expect((await app.inject({ method: 'POST', url: '/d/session/sid/cancel' })).statusCode).toBe(204); }
    finally { await app.close(); }
  });

  it('official SDK binary GET remains incremental and keeps SessionCode and cursor on the wire', async () => {
    let observedUrl = ''; let cursor: string | undefined;
    const server = createServer((req, res) => {
      observedUrl = req.url ?? ''; cursor = req.headers['last-event-id'] as string;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('id: 8\nevent: stream_open\ndata: {"type":"stream_open","data":{}}\n\n');
      // Keep HTTP open: buffering the whole response would make the first read time out.
      req.on('close', () => res.end());
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const client = createSdkClient({ ...cfg, endpoint: `127.0.0.1:${address.port}` });
    (client as unknown as { _protocol: string })._protocol = 'HTTP';
    let stream: Readable | undefined;
    try {
      const response = await openSessionEvents(client, 'sid', '7'); stream = response.body;
      const frame = await parseSse(stream).next();
      expect(frame.value?.id).toBe('8');
      expect(new URL(observedUrl, 'http://localhost').searchParams.get('SessionCode')).toBe('sid');
      expect(cursor).toBe('7');
    } finally {
      stream?.destroy(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 4000);
});
