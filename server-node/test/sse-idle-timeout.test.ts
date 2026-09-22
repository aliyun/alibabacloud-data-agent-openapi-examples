import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { PromptAgentSessionRequest, PromptAgentSessionRequestParams } from '@alicloud/dataworks-public20240518';
import type { RuntimeOptions } from '@darabonba/typescript';
import { createSdkClient, runtimeFor, runtimeForSse } from '../src/sdk.js';
import type { AppConfig } from '../src/config.js';

async function consumePausedStream(runtime: RuntimeOptions, pauseMs: number) {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let requests = 0;
  let frames = 0;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"Jsonrpc":"2.0","Params":{"kind":"permission_request","data":{"requestId":"question"}}}\n\n');
    timers.push(setTimeout(() => res.end('data: {"Jsonrpc":"2.0","Result":{"stopReason":"end_turn"}}\n\n'), pauseMs));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const client = createSdkClient({
    accessKeyId: 'synthetic', accessKeySecret: 'synthetic', regionId: 'cn-hangzhou', endpoint: `127.0.0.1:${port}`,
  } as AppConfig);
  (client as unknown as { _protocol: string })._protocol = 'http';
  try {
    for await (const _frame of client.promptAgentSessionWithSSE(new PromptAgentSessionRequest({
      jsonrpc: '2.0', id: 'test', params: new PromptAgentSessionRequestParams({ sessionId: 'synthetic' }),
    }), runtime)) frames++;
    return frames;
  } finally {
    timers.forEach(clearTimeout);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(requests).toBe(1); // A stream failure must never resend the prompt.
  }
}

it('reproduces the SDK socket idle abort despite a longer readTimeout', async () => {
  const runtime = runtimeFor(1000);
  runtime.connectTimeout = 50;
  await expect(consumePausedStream(runtime, 180)).rejects.toThrow('aborted');
});

it('receives the terminal after a pause longer than the former 10s socket timeout', async () => {
  await expect(consumePausedStream(runtimeForSse(20_000), 10_500)).resolves.toBe(2);
}, 20_000);

it('keeps a finite stream read budget and disables retries', () => {
  expect(runtimeForSse()).toMatchObject({ readTimeout: 600_000, connectTimeout: 600_000, autoretry: false, maxAttempts: 1 });
  expect(runtimeForSse(30_000)).toMatchObject({ readTimeout: 30_000, connectTimeout: 30_000 });
  expect(runtimeFor().connectTimeout).toBe(10_000);
});
