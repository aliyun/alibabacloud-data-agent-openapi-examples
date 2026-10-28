import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { AcpFrame } from '@das/shared';
import { readLoadSnapshot } from '../src/load-recovery.js';
import { liveLoadFrames } from '../src/live.js';
import { toApiError } from '../src/normalize.js';
const chunk = (text: string): AcpFrame => ({ RequestId: 'turn', Params: { sessionId: 's',
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const end = (id: string): AcpFrame => ({ Id: id, Result: { stopReason: 'end_turn' } });
async function* frames(rows: AcpFrame[], error?: Error) { yield* rows; if (error) throw error; }
const retry = (e: unknown) => toApiError(e, 'LoadAgentSession').kind === 'transport';
const options = { delayMs: 0 };
describe('Load snapshot completeness', () => {
  it('discards truncated snapshot and historical terminal before a complete reload', async () => {
    const open = vi.fn(() => ({ id: 'load', frames: frames(open.mock.calls.length === 1
      ? [chunk('partial'), end('old-prompt')] : [chunk('complete'), end('load')]) }));
    expect(await readLoadSnapshot(open, retry, options)).toEqual([chunk('complete'), end('load')]);
    expect(open).toHaveBeenCalledTimes(2);
  });
  it('retries transport errors, never returns duplicated partial content', async () => {
    let calls = 0;
    const open = () => ({ id: 'load', frames: ++calls === 1
      ? frames([chunk('x')], new Error('connection reset')) : frames([chunk('x'), end('load')]) });
    expect(await readLoadSnapshot(open, retry, options)).toEqual([chunk('x'), end('load')]);
  });
  it('fails closed after three EOFs and does not publish partial history', async () => {
    const open = vi.fn(() => ({ id: 'load', frames: frames([chunk('partial')]) }));
    await expect(readLoadSnapshot(open, retry, options)).rejects.toThrow('未返回部分历史');
    expect(open).toHaveBeenCalledTimes(3);
  });
  it('does not retry business or authentication failures', async () => {
    const denied = vi.fn(() => ({ id: 'load', frames: frames([], Object.assign(new Error('denied'), { statusCode: 403 })) }));
    await expect(readLoadSnapshot(denied, retry, options)).rejects.toThrow('denied');
    expect(denied).toHaveBeenCalledOnce();
    const business = vi.fn(() => ({ id: 'load', frames: frames([{ Id: 'load', Error: { code: -32603, message: 'permission_required' } }]) }));
    await expect(readLoadSnapshot(business, retry, options)).rejects.toThrow('permission_required');
    expect(business).toHaveBeenCalledOnce();
  });
  it('closes the source as soon as the current Load receipt arrives', async () => {
    let closed = false;
    const open = () => ({ id: 'load', frames: (async function* () {
      try { yield end('load'); await new Promise(() => {}); } finally { closed = true; }
    })() });
    expect(await readLoadSnapshot(open, retry, options)).toEqual([end('load')]);
    expect(closed).toBe(true);
  });
  it('bounds idle and continuously flowing history by one total deadline', async () => {
    vi.useFakeTimers();
    try {
      const open = vi.fn(() => ({ id: 'load', frames: (async function* () {
        await new Promise(resolve => setTimeout(resolve, 100)); yield chunk('late');
      })() }));
      const result = readLoadSnapshot(open, retry, { budgetMs: 15, delayMs: 0 });
      const assertion = expect(result).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(20); await assertion;
      expect(open).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(100);
    } finally { vi.useRealTimers(); }
  });
  it('SDK snapshot reopens Load without a cross-turn offset', async () => {
    const client = { loadAgentSessionWithSSE: vi.fn((request: { id: string }) => frames(
      client.loadAgentSessionWithSSE.mock.calls.length === 1 ? [{ body: chunk('discard') } as never]
        : [{ body: chunk('all') } as never, { body: end(request.id) } as never])) };
    const out = await liveLoadFrames({ client } as never, 's');
    expect(out[0]).toEqual(chunk('all'));
    expect(client.loadAgentSessionWithSSE).toHaveBeenCalledTimes(2);
    for (const [request] of client.loadAgentSessionWithSSE.mock.calls) {
      expect((request as any).toMap().Params.Meta).toEqual({ IsReload: true });
    }
  });
});

it('real SDK: Prompt EOF → Load EOF → Load success preserves offsets and submits Prompt once', async () => {
  const { createServer } = await import('node:http');
  const { createSdkClient } = await import('../src/sdk.js');
  const { livePromptFrames } = await import('../src/live.js');
  const calls: { action: string; params: Record<string, any> }[] = [];
  let originalPromptId = '';

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    const action = String(req.headers['x-acs-action'] ?? form.get('Action'));
    const params = JSON.parse(form.get('Params') ?? '{}');
    const id = form.get('Id')!;
    calls.push({ action, params });
    const frame = (offset: number) => ({ Jsonrpc: '2.0', RequestId: 'original', Params: {
      sessionId: 's', _meta: { offset }, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(offset) } } } });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    if (action === 'PromptAgentSession') { originalPromptId = id; send(frame(1)); res.end(); return; }
    const n = calls.filter(c => c.action === 'LoadAgentSession').length;
    send(end(id)); // Load's own receipt is not the Prompt terminal.
    send(frame(n)); send(frame(n + 1));
    if (n === 2) send({ Jsonrpc: '2.0', RequestId: 'original', Id: originalPromptId, Result: { stopReason: 'end_turn' } });
    res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = createSdkClient({ accessKeyId: 'synthetic', accessKeySecret: 'synthetic', regionId: 'cn-hangzhou',
    endpoint: `127.0.0.1:${(server.address() as { port: number }).port}` } as never);
  (client as unknown as { _protocol: string })._protocol = 'http';
  try {
    const result: AcpFrame[] = [];
    for await (const frame of livePromptFrames({ client } as never, 's', 'local fixture')) result.push(frame);
    expect(calls.map(c => c.action)).toEqual(['PromptAgentSession', 'LoadAgentSession', 'LoadAgentSession']);
    expect(calls.slice(1).map(c => c.params.Meta.BeginLogOffset)).toEqual([1, 2]);
    expect(result.filter(f => f.Params).map(f => f.Params!._meta!.offset)).toEqual([1, 2, 3]);
    expect(result.at(-1)?.Result?.stopReason).toBe('end_turn');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('real SDK: a truncated standalone Load is replaced by a complete snapshot', async () => {
  const { createServer } = await import('node:http');
  const { createSdkClient } = await import('../src/sdk.js');
  const paramsSeen: Record<string, any>[] = [];
  const server = createServer(async (req, res) => {
    const body: Buffer[] = []; for await (const c of req) body.push(c);
    const form = new URLSearchParams(Buffer.concat(body).toString());
    paramsSeen.push(JSON.parse(form.get('Params')!));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (value: unknown) => res.write(`data: ${JSON.stringify({ Jsonrpc: '2.0', ...value as object })}\n\n`);
    if (paramsSeen.length === 1) { send(chunk('partial')); send(end('historic-prompt')); }
    else { send(chunk('full')); send(end(form.get('Id')!)); }
    res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = createSdkClient({ accessKeyId: 'synthetic', accessKeySecret: 'synthetic', regionId: 'cn-hangzhou',
    endpoint: `127.0.0.1:${(server.address() as { port: number }).port}` } as never);
  (client as unknown as { _protocol: string })._protocol = 'http';
  try {
    const result = await liveLoadFrames({ client } as never, 's');
    expect(result.filter(f => f.Params).map(f => (f.Params!.update as any).content.text)).toEqual(['full']);
    expect(paramsSeen).toHaveLength(2);
    expect(paramsSeen.every(p => p.Meta.IsReload === true && !('BeginLogOffset' in p.Meta))).toBe(true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
