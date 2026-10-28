import { once } from 'node:events';
import { createServer } from 'node:http';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { expect, it, vi, afterEach, beforeEach } from 'vitest';
import { DEFAULT_READ_TIMEOUT_MS } from '@das/shared';
import type { AppConfig } from '../src/config.js';
import { liveCreateSession } from '../src/live.js';
import { createSdkClient, runtimeFor, runtimeForCreate, runtimeForSse, type SdkClient } from '../src/sdk.js';

beforeEach(() => {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) vi.stubEnv(key, '');
  vi.stubEnv('NO_PROXY', '127.0.0.1');
  vi.stubEnv('no_proxy', '127.0.0.1');
});
afterEach(() => vi.unstubAllEnvs());

async function fixture(response: 'slow' | 'reset' | 'denied', token?: string) {
  const requests: Array<{ action: string; token: string | string[] | undefined }> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((req, res) => {
    requests.push({ action: String(req.headers['x-acs-action']), token: req.headers['x-acs-security-token'] });
    req.resume();
    if (response === 'reset') { req.socket.destroy(); return; }
    const send = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ RequestId: 'loopback-create', JsonRpcResponse: response === 'denied'
        ? { Error: { Code: 'Denied', Message: 'synthetic denial' } }
        : { Result: { SessionId: 'synthetic-session' } } }));
    };
    if (response === 'slow') timers.add(setTimeout(send, 11_200));
    else send();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const cfg: AppConfig = {
    mock: false, mockRealtime: false, mockSpeed: 1, port: 0, corsOrigin: [], regionId: 'cn-hangzhou',
    endpoint: `127.0.0.1:${(server.address() as { port: number }).port}`,
    agentName: 'synthetic-agent', sessionSource: 'test', resourceGroupId: undefined,
    accessKeyId: 'synthetic-key', accessKeySecret: 'synthetic-secret', securityToken: token,
    serverHost: '127.0.0.1', webDist: undefined,
  };
  const client = createSdkClient(cfg);
  client._protocol = 'http';
  return { client, cfg, requests, async close() {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

it('keeps ordinary RPC and SSE budgets while exposing a separate creation budget', () => {
  expect(runtimeFor().connectTimeout).toBe(10_000);
  expect(runtimeForSse().connectTimeout).toBe(DEFAULT_READ_TIMEOUT_MS);
  expect(runtimeForCreate().connectTimeout).toBe(DEFAULT_READ_TIMEOUT_MS);
  expect(runtimeForCreate(1234)).toMatchObject({ connectTimeout: 1234, readTimeout: 1234, autoretry: false, maxAttempts: 1 });
  expect(runtimeForCreate()).not.toBe(runtimeForCreate());
});

it('reproduces the old 10s socket timeout and accepts a later liveCreateSession response with AK or AK/token', async () => {
  await Promise.all([true, false, false].map(async (legacy, index) => {
    const token = index === 2 ? 'synthetic-token' : undefined;
    const f = await fixture('slow', token);
    try {
      if (legacy) {
        // Bypass only our action budget to reproduce the original SDK dispatch.
        f.client.callApi = (Object.getPrototypeOf(f.client) as SdkClient).callApi.bind(f.client);
      }
      const result = await liveCreateSession(f);
      if (legacy) {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.kind).toBe('transport');
          expect(result.error.message).toMatch(/timeout/i);
        }
      } else {
        expect(result).toMatchObject({ ok: true, result: { sessionId: 'synthetic-session' } });
      }
      expect(f.requests).toEqual([{ action: 'CreateAgentSession', token }]);
    } finally { await f.close(); }
  }));
}, 25_000);

it.each(['reset', 'denied'] as const)('does not retry CreateAgentSession after %s', async response => {
  const f = await fixture(response);
  try {
    const result = await liveCreateSession(f);
    expect(result.ok).toBe(false);
    if (!result.ok && response === 'denied') expect(result.error.message).toContain('synthetic denial');
    expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
});

it('honors a shorter caller budget and still never retries a timed-out creation', async () => {
  const f = await fixture('slow');
  try {
    const runtime = runtimeFor(100);
    await expect(f.client.callApi(new $OpenApiUtil.Params({ action: 'CreateAgentSession', version: '2024-05-18',
      protocol: 'HTTP', pathname: '/', method: 'POST', authType: 'AK', style: 'RPC', reqBodyType: 'formData', bodyType: 'json' }),
    new $OpenApiUtil.OpenApiRequest({ body: {} }), runtime)).rejects.toThrow(/timeout/i);
    expect(f.requests).toHaveLength(1);
    expect(runtime.connectTimeout).toBe(10_000); // Caller-owned options are not mutated.
  } finally { await f.close(); }
});
