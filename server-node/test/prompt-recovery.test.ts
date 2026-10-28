import { describe, expect, it, vi } from 'vitest';
import type { AcpFrame } from '@das/shared';
import { recoverPromptFrames, type ResumeSource } from '../src/prompt-recovery.js';
import { toApiError } from '../src/normalize.js';
import { livePromptFrames } from '../src/live.js';

const chunk = (offset: number, text = 'x', rid = 'turn'): AcpFrame => ({ Jsonrpc: '2.0', RequestId: rid,
  Params: { sessionId: 'session', _meta: { offset }, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const end = (id = 'prompt', rid = 'turn', reason = 'end_turn'): AcpFrame =>
  ({ Jsonrpc: '2.0', RequestId: rid, Id: id, Result: { stopReason: reason } });
async function* frames(rows: AcpFrame[], error?: Error) { yield* rows; if (error) throw error; }
const source = (rows: AcpFrame[], id = 'prompt', error?: Error): ResumeSource => ({ id, frames: frames(rows, error) });
const retry = (e: unknown) => toApiError(e, 'LoadAgentSession').kind === 'transport';
async function collect(rows: AsyncIterable<AcpFrame>) { const out: AcpFrame[] = []; for await (const r of rows) out.push(r); return out; }
const opts = { delayMs: 0, attempts: 3 };

describe('旧 Prompt 有界 Load 续接', () => {
  it('EOF 后按已消费游标续接，忽略旧历史、重复帧及 Load 自身终态', async () => {
    const load = vi.fn((_offset: number, _remaining: number) => source([chunk(99, 'old', 'older'), end('load', 'load-rid'), end('load', 'turn'), chunk(1), chunk(2, 'new'), end()], 'load'));
    const result = await collect(recoverPromptFrames(source([chunk(1)]), load, retry, opts));
    expect(result).toEqual([chunk(1), chunk(2, 'new'), end()]);
    expect(load.mock.calls[0]?.[0]).toBe(1);
  });
  it('旧 LSP buffer 缺 RequestId 时按同 session 游标接回正文；不接收其他 session', async () => {
    const buffered = chunk(2, 'recovered'); delete buffered.RequestId;
    const foreign = chunk(99, 'foreign'); delete foreign.RequestId; foreign.Params!.sessionId = 'other';
    const result = await collect(recoverPromptFrames(source([chunk(1)]),
      () => source([foreign, buffered, end()], 'load'), retry, opts));
    expect(result).toEqual([chunk(1), buffered, end()]);
  });
  it('跨多次断线继续推进游标，不重复已交付帧', async () => {
    const load = vi.fn((offset: number) => source(offset === 1 ? [chunk(1), chunk(2)] : [chunk(2), chunk(3), end()], 'load'));
    const result = await collect(recoverPromptFrames(source([chunk(1)]), load, retry, opts));
    expect(result).toEqual([chunk(1), chunk(2), chunk(3), end()]);
    expect(load.mock.calls.map(c => c[0])).toEqual([1, 2]);
  });
  it.each(['end_turn', 'cancelled'])('收到原轮 %s 后不再 Load', async reason => {
    const load = vi.fn();
    await collect(recoverPromptFrames(source([chunk(1), end('prompt', 'turn', reason)]), load, retry, opts));
    expect(load).not.toHaveBeenCalled();
  });
  it('原流传输异常可恢复，业务错误帧不恢复', async () => {
    const load = vi.fn(() => source([end()], 'load'));
    await collect(recoverPromptFrames(source([chunk(1)], 'prompt', new Error('socket closed')), load, retry, opts));
    expect(load).toHaveBeenCalledOnce();
    load.mockClear();
    await collect(recoverPromptFrames(source([chunk(1), { Error: { code: -32603, message: 'permission_required' } }]), load, retry, opts));
    expect(load).not.toHaveBeenCalled();
  });
  it('没有原轮游标不猜测续点，Load 反复空结束最多调用三次', async () => {
    const load = vi.fn(() => source([], 'load'));
    await collect(recoverPromptFrames(source([{ Jsonrpc: '2.0', RequestId: 'turn' }]), load, retry, opts));
    expect(load).not.toHaveBeenCalled();
    await collect(recoverPromptFrames(source([chunk(1)]), load, retry, opts));
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('Load 认证失败立即报错，不继续重连', async () => {
    const load = vi.fn(() => source([], 'load', Object.assign(new Error('denied'), { statusCode: 403 })));
    await expect(collect(recoverPromptFrames(source([chunk(1)]), load, retry, opts))).rejects.toThrow('denied');
    expect(load).toHaveBeenCalledOnce();
  });
  it('Load 自身的 JSON-RPC 错误会报错，旧历史错误不污染本轮', async () => {
    const load = vi.fn(() => source([
      { Jsonrpc: '2.0', Id: 'old', RequestId: 'older', Error: { code: -32603, message: 'old failure' } },
      { Jsonrpc: '2.0', Id: 'load', RequestId: 'load-rid', Error: { code: -32603, message: 'denied' } },
    ], 'load'));
    await expect(collect(recoverPromptFrames(source([chunk(1)]), load, retry, opts))).rejects.toThrow('denied');
    expect(load).toHaveBeenCalledOnce();
  });
  it('消费者关闭时关闭源，不启动恢复', async () => {
    let closed = false;
    const initial = { id: 'prompt', frames: (async function* () { try { yield chunk(1); yield chunk(2); } finally { closed = true; } })() };
    const load = vi.fn();
    const stream = recoverPromptFrames(initial, load, retry, opts);
    await stream.next(); await stream.return(undefined);
    expect(closed).toBe(true); expect(load).not.toHaveBeenCalled();
  });
  it('当前轮回放文本缺失 offset 时不能追加整份历史并报成功', async () => {
    const unsafe = chunk(2); delete unsafe.Params!._meta;
    await expect(collect(recoverPromptFrames(source([chunk(1)]), () => source([unsafe, end()], 'load'), retry, opts)))
      .rejects.toThrow('缺少 offset');
  });
  it('Load 静默时仍受恢复总预算限制', async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn(() => ({ id: 'load', frames: (async function* () {
        await new Promise(resolve => setTimeout(resolve, 100)); yield chunk(2);
      })() }));
      const result = collect(recoverPromptFrames(source([chunk(1)]), load, retry,
        { delayMs: 0, budgetMs: 15 }));
      await vi.advanceTimersByTimeAsync(20);
      expect(await result).toEqual([chunk(1)]);
      expect(load).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(100);
    } finally { vi.useRealTimers(); }
  });
  it('SDK 集成只发一次 Prompt，Load 使用契约字段 BeginLogOffset', async () => {
    const client = {
      promptAgentSessionWithSSE: vi.fn((req: { id: string }) => (async function* () { yield { body: chunk(7) }; })()),
      loadAgentSessionWithSSE: vi.fn((req: { id: string }) => (async function* () {
        yield { body: end(req.id, 'load-rid') };
        yield { body: chunk(8) };
        yield { body: end('1') };
      })()),
    };
    // 以真实生成的 Prompt id 构造原轮终态，避免依赖全局计数器。
    client.loadAgentSessionWithSSE.mockImplementation(req => (async function* () {
      yield { body: end(req.id, 'load-rid') }; const buffered = chunk(8); delete buffered.RequestId; yield { body: buffered };
      yield { body: end(client.promptAgentSessionWithSSE.mock.calls[0]![0].id) };
    })());
    const result = await collect(livePromptFrames({ client } as never, 'session', 'test'));
    expect(client.promptAgentSessionWithSSE).toHaveBeenCalledOnce();
    const request = client.loadAgentSessionWithSSE.mock.calls[0]![0] as any;
    expect(request.toMap().Params.Meta).toEqual({ IsReload: true, BeginLogOffset: 7 });
    expect(result).toHaveLength(3);
  });
});
