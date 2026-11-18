import { createServer, type Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { DaemonClient } from '@qwen-code/sdk/daemon';
import { afterEach, describe, expect, it } from 'vitest';
import { registerLiveDaemonRoutes } from '../src/daemon/live-routes.js';
import { createSdkClient } from '../src/sdk.js';
import type { AppConfig } from '../src/config.js';

const cfg = { mock: false, mockRealtime: false, mockSpeed: 4, port: 0, corsOrigin: [], regionId: 'cn-beijing',
  agentName: 'test-agent', sessionSource: 'test-source', accessKeyId: 'test-id', accessKeySecret: 'test-secret',
  serverHost: '127.0.0.1', endpoint: undefined, resourceGroupId: undefined, webDist: undefined } satisfies AppConfig;
const apps: FastifyInstance[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});
async function fixture(headerEpoch = false, frameEpoch: string | null = 'native-epoch') {
  const requests: Array<{ epoch: string | null; cursor: string | undefined }> = [];
  const upstream = createServer((req, res) => {
    const epoch = new URL(req.url!, 'http://localhost').searchParams.get('EventEpoch');
    requests.push({ epoch, cursor: req.headers['last-event-id'] as string | undefined });
    res.writeHead(200, { 'content-type': 'text/event-stream', ...(headerEpoch ? { 'x-qwen-event-epoch': 'native-epoch' } : {}) });
    if (epoch !== null && epoch !== 'native-epoch') {
      res.end('data: {"code":"EVENT_EPOCH_MISMATCH","message":"epoch mismatch"}\n\n');
      return;
    }
    const nextId = Number(req.headers['last-event-id'] ?? 0) + 1;
    const opening = { v: 1, type: 'stream_open', data: { sessionId: 'sid', nativeSessionId: 'native-session',
      ...(frameEpoch === null ? {} : { eventEpoch: frameEpoch }) } };
    const terminal = { v: 1, id: nextId, type: 'turn_complete', promptId: 'native-prompt', data: { sessionId: 'sid', stopReason: 'end_turn' } };
    const receipt = { v: 1, type: 'replay_complete', data: { replayedCount: 1, lastReplayedEventId: nextId } };
    res.end(`data: ${JSON.stringify(opening)}\n\nid: ${nextId}\ndata: ${JSON.stringify(terminal)}\n\n${req.headers['last-event-id'] === undefined ? '' : `data: ${JSON.stringify(receipt)}\n\n`}`);
  });
  servers.push(upstream);
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const client = createSdkClient({ ...cfg, endpoint: `127.0.0.1:${(upstream.address() as { port: number }).port}` });
  (client as unknown as { _protocol: string })._protocol = 'HTTP';
  const app = Fastify(); apps.push(app);
  await registerLiveDaemonRoutes(app, cfg, client);
  return { app, requests };
}

describe('native Events epoch through local HTTP and the official POP/daemon SDKs', () => {
  it.each([undefined, '0', '42'])('preserves cursor %s and forwards native epoch to the signed POP query', async cursor => {
    const { app, requests } = await fixture();
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const response = await fetch(`${base}/d/session/sid/events`, { headers: cursor === undefined ? {} : { 'X-Qwen-Event-Epoch': 'native-epoch', 'Last-Event-ID': cursor } });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-qwen-event-epoch')).toBe('native-epoch');
    expect(await response.text()).toContain('"eventEpoch":"native-epoch"');
    expect(requests).toEqual([{ epoch: cursor === undefined ? null : 'native-epoch', cursor }]);
  });

  it('rejects epoch without a cursor before calling POP', async () => {
    const { app, requests } = await fixture();
    const response = await app.inject({ url: '/d/session/sid/events', headers: { 'x-qwen-event-epoch': 'native-epoch' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('invalid_cursor');
    expect(requests).toEqual([]);
  });

  it('returns an upstream mismatch as HTTP failure before committing SSE and never invents an epoch', async () => {
    const { app, requests } = await fixture();
    const response = await app.inject({ url: '/d/session/sid/events', headers: { 'last-event-id': '0', 'x-qwen-event-epoch': 'old-epoch' } });
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe('events_upstream_failed');
    expect(response.headers).not.toHaveProperty('x-qwen-event-epoch');
    expect(requests).toEqual([{ epoch: 'old-epoch', cursor: '0' }]);
  });

  it.each([null, 'unexpected-native-epoch'])('rejects an unproven strict epoch (%s) before writing SSE', async frameEpoch => {
    const { app } = await fixture(false, frameEpoch);
    const response = await app.inject({ url: '/d/session/sid/events', headers: { 'last-event-id': '0', 'x-qwen-event-epoch': 'native-epoch' } });
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe('events_upstream_failed');
    expect(response.headers).not.toHaveProperty('x-qwen-event-epoch');
  });

  it.each([false, true])('SDK 0.1.31 learns the native epoch from the response header (upstream header=%s)', async headerEpoch => {
    const { app, requests } = await fixture(headerEpoch);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const sdk = new DaemonClient({ baseUrl: `${base}/d` });
    try {
      const learned: string[] = [];
      const received = [];
      for await (const event of sdk.subscribeEvents('sid', { onEpoch: epoch => learned.push(epoch) })) received.push(event);
      expect(learned).toEqual(['native-epoch']);
      expect(received.map(event => event.type)).toEqual(['stream_open', 'turn_complete']);
      for await (const _event of sdk.subscribeEvents('sid', { lastEventId: 0, epoch: learned[0] })) { /* consume reconnect */ }
      expect(requests).toEqual([{ epoch: null, cursor: undefined }, { epoch: 'native-epoch', cursor: '0' }]);
    } finally { sdk.dispose(); }
  });
});
