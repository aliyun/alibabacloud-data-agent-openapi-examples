import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { lanApiProxy } from '../lan-proxy';

let upstream: Server;
let vite: ViteDevServer;
let root: string;
let base: string;
let target: string;
let received = 0;
let streamEnded = false;

beforeAll(async () => {
  upstream = createHttpServer((req, res) => {
    received++;
    if (req.url?.includes('/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Qwen-Event-Epoch': 'epoch' });
      res.write('id: 1\nevent: session_update\ndata: first\n\n');
      const timer = setTimeout(() => {
        streamEnded = true;
        res.end('id: 2\nevent: turn_complete\ndata: done\n\n');
      }, 250);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (req.url === '/api/missing') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin,
        cursor: req.headers['last-event-id'], clientId: req.headers['x-qwen-client-id'],
        epoch: req.headers['x-qwen-event-epoch'], body, path: req.url }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  root = await mkdtemp(join(tmpdir(), 'das-lan-proxy-'));
  await writeFile(join(root, 'index.html'), '<html><body>LAN test shell</body></html>');
  vite = await createServer({
    root, configFile: false, envFile: false, logLevel: 'silent',
    plugins: [lanApiProxy(target)],
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  });
  await vite.listen();
  base = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await vite?.close();
  if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});

it('proxies same-origin writes with backend-compatible Host/Origin and intact daemon headers', async () => {
  const response = await fetch(`${base}/d/standalone/sessions`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json',
      'Last-Event-ID': '7', 'X-Qwen-Client-Id': 'browser-1', 'X-Qwen-Event-Epoch': 'old-epoch' },
    body: JSON.stringify({ prompt: 'hello' }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ host: new URL(target).host, origin: target,
    cursor: '7', clientId: 'browser-1', epoch: 'old-epoch',
    body: '{"prompt":"hello"}', path: '/d/standalone/sessions' });
});

it('rejects cross-origin writes before forwarding to the privileged backend', async () => {
  const before = received;
  const response = await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { Origin: 'http://untrusted.example' }, body: 'hello',
  });
  expect(response.status).toBe(403);
  expect(received).toBe(before);
});

it('streams SSE before upstream completion, preserving response headers', async () => {
  const response = await fetch(`${base}/d/session/real-id/events`);
  expect(response.headers.get('x-qwen-event-epoch')).toBe('epoch');
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('data: first');
  expect(streamEnded).toBe(false);
  let remainder = '';
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    remainder += new TextDecoder().decode(part.value);
  }
  expect(remainder).toContain('event: turn_complete');
});

it('keeps SPA session deep links separate from API 404 responses', async () => {
  const page = await fetch(`${base}/session/real-id`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('LAN test shell');
  const api = await fetch(`${base}/api/missing`);
  expect(api.status).toBe(404);
  expect(await api.json()).toEqual({ error: 'missing' });
});
