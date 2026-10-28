import { createServer } from 'node:http';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { expect, it } from 'vitest';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { PromptAgentSessionRequest, PromptAgentSessionRequestParams } from '@alicloud/dataworks-public20240518';
import { createSdkClient, runtimeFor, runtimeForSse } from '../src/sdk.js';
import type { AppConfig } from '../src/config.js';

/** A local intermediary model: a reused socket is reset, a fresh socket works.
 * This proves the mitigation's mechanism, not the origin of a production reset. */
async function scenario(legacy: boolean, resetEveryPrompt = false) {
  const sockets = new Set<Socket>();
  const calls: Array<{ action: string; reused: boolean; connection: string | undefined }> = [];
  const server = createServer((req, res) => {
    const action = String(req.headers['x-acs-action']);
    const reused = sockets.has(req.socket);
    sockets.add(req.socket);
    calls.push({ action, reused, connection: req.headers.connection });
    req.resume();
    if (reused || (resetEveryPrompt && action === 'PromptAgentSession')) { req.socket.destroy(); return; }
    if (action === 'PromptAgentSession') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"JsonRpcResponse":{"jsonrpc":"2.0","id":"test","result":{"stopReason":"end_turn"}}}\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"RequestId":"local-only","JsonRpcResponse":{"Result":{"Sessions":[]}}}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = createSdkClient({ accessKeyId: 'synthetic', accessKeySecret: 'synthetic', regionId: 'cn-hangzhou',
    endpoint: `127.0.0.1:${(server.address() as { port: number }).port}` } as AppConfig);
  client._protocol = 'http';
  if (legacy) client._globalParameters = new $OpenApiUtil.GlobalParameters({ headers: {} });
  try {
    await client.callApi(new $OpenApiUtil.Params({ action: 'ListAgentSessions', version: '2024-05-18',
      protocol: 'HTTP', pathname: '/', method: 'POST', authType: 'AK', style: 'RPC', reqBodyType: 'formData', bodyType: 'json' }),
    new $OpenApiUtil.OpenApiRequest({ body: {} }), runtimeFor(1000));
    let frames = 0;
    let error: unknown;
    try {
      for await (const _ of client.promptAgentSessionWithSSE(new PromptAgentSessionRequest({ id: 'test', jsonrpc: '2.0',
        params: new PromptAgentSessionRequestParams({ sessionId: 'synthetic' }) }), runtimeForSse(1000))) frames++;
    } catch (caught) { error = caught; }
    return { calls, frames, error };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

it('reproduces reset when a signed Prompt reuses the raw API idle connection', async () => {
  const result = await scenario(true);
  expect(result.error).toMatchObject({ code: 'ECONNRESET' });
  expect(result.calls.map(call => call.reused)).toEqual([false, true]);
  expect(result.calls.map(call => call.action)).toEqual(['ListAgentSessions', 'PromptAgentSession']);
  expect(result.frames).toBe(0);
});

it('keeps both raw and generated SDK requests out of its own idle pool without repeating Prompt', async () => {
  const result = await scenario(false);
  expect(result.error).toBeUndefined();
  expect(result.frames).toBe(1);
  expect(result.calls).toEqual([
    { action: 'ListAgentSessions', reused: false, connection: 'close' },
    { action: 'PromptAgentSession', reused: false, connection: 'close' },
  ]);
});

it('still reports a reset on a fresh connection and never resends the write', async () => {
  const result = await scenario(false, true);
  expect(result.error).toMatchObject({ code: 'ECONNRESET' });
  expect(result.frames).toBe(0);
  expect(result.calls.filter(call => call.action === 'PromptAgentSession')).toHaveLength(1);
  expect(result.calls.every(call => !call.reused)).toBe(true);
});
