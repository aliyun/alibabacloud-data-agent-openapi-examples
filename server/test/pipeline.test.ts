import { describe, expect, it } from 'vitest';

import { type AcpFrame, type WireEvent } from '@das/shared';

import { toWireEvents } from '../src/pipeline.js';

/**
 * 上游帧流 → wire 事件流。**live 与 mock 共用这一个函数**，
 * 所以"mock 下验收通过"能不能推广到真实链路，全看这里的判据对不对。
 *
 * 这个文件存在的原因是它此前**没有任何直接测试**：分类逻辑只在端到端里被间接走过，
 * 而收尾那一步（有帧 vs 零帧）恰好是真实链路上最容易出错、也最容易给出错误指引的地方。
 */
async function* from(frames: AcpFrame[], thenThrow?: unknown): AsyncGenerator<AcpFrame> {
  for (const f of frames) yield f;
  if (thenThrow) throw thenThrow;
}

async function collect(
  frames: AcpFrame[],
  extra: { popRequestIds?: string[]; thenThrow?: unknown } = {},
): Promise<WireEvent[]> {
  const out: WireEvent[] = [];
  for await (const e of toWireEvents({
    frames: from(frames, extra.thenThrow),
    marker: 'DAS-TEST01',
    sessionId: 'sess-1',
    mock: false,
    startedAt: Date.now(),
    popRequestIds: extra.popRequestIds,
  })) {
    out.push(e);
  }
  return out;
}

const contentFrame = (rid: string): AcpFrame => ({
  Jsonrpc: '2.0',
  Method: 'session/update',
  RequestId: rid,
  Params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } },
});

describe('toWireEvents：零帧收尾', () => {
  it('一帧都没收到 ⇒ prompt_not_dispatched，并把 POP RequestId 带进 message', async () => {
    const events = await collect([], { popRequestIds: ['0dd3b146c75bf132a65efa7a3080e7cd'] });

    expect(events.map((e) => e.type)).toEqual(['error']);
    const error = events[0] as Extract<WireEvent, { type: 'error' }>;
    expect(error.error.kind).toBe('prompt_not_dispatched');
    expect(error.error.message).toContain('0dd3b146c75bf132a65efa7a3080e7cd');
    expect(error.error.retryable).toBe(false);
    expect(error.error.fatalForSession).toBe(false);
  });

  it('零帧且上游连回执都没给 ⇒ 仍是 prompt_not_dispatched，message 里如实说没有 RequestId', async () => {
    const events = await collect([]);
    const error = events[0] as Extract<WireEvent, { type: 'error' }>;
    expect(error.error.kind).toBe('prompt_not_dispatched');
    expect(error.error.message).toContain('上游未给出 RequestId');
  });

  it('零帧绝不发 done，也绝不发 meta（rid 无从得知，不能拿 POP 回执冒充）', async () => {
    const events = await collect([], { popRequestIds: ['pop-ack-1'] });
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(events.some((e) => e.type === 'meta')).toBe(false);
  });
});

describe('toWireEvents：有帧收尾', () => {
  it('有帧但没有终态 ⇒ stream_break（不是 prompt_not_dispatched）', async () => {
    const events = await collect([contentFrame('rid-uuid-1'), contentFrame('rid-uuid-1')]);
    const error = events[events.length - 1] as Extract<WireEvent, { type: 'error' }>;
    expect(error.type).toBe('error');
    expect(error.error.kind).toBe('stream_break');
    expect(error.error.message).toContain('received 2 frames');
  });

  it('有终态 ⇒ done，且不发 error', async () => {
    const events = await collect([
      contentFrame('rid-uuid-1'),
      { Jsonrpc: '2.0', Id: '1', RequestId: 'rid-uuid-1', Result: { stopReason: 'end_turn' } },
    ]);
    const done = events[events.length - 1] as Extract<WireEvent, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.stopReason).toBe('end_turn');
    expect(done.frameCount).toBe(2);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('meta 在第一个带 RequestId 的帧时才发，rid 取自 ACP 帧', async () => {
    const events = await collect([contentFrame('rid-uuid-1')]);
    const meta = events[0] as Extract<WireEvent, { type: 'meta' }>;
    expect(meta.type).toBe('meta');
    expect(meta.rid).toBe('rid-uuid-1');
    expect(meta.marker).toBe('DAS-TEST01');
  });

  it('带 Error 的帧既透传又额外产出一条归一化 error，且不再补 stream_break', async () => {
    const events = await collect([
      contentFrame('rid-uuid-1'),
      {
        Jsonrpc: '2.0',
        RequestId: 'rid-uuid-1',
        Error: { code: -32603, errorCode: '0x48833000000000d1', message: 'session stream ended without turn terminal' },
      },
    ]);
    expect(events.filter((e) => e.type === 'frame')).toHaveLength(2);
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as Extract<WireEvent, { type: 'error' }>).error.kind).toBe('stream_break');
  });

  it('帧内错误的 message 也要脱敏：上游回显的 AccessKeyId 不能经 wire 事件进前端', async () => {
    const events = await collect([
      {
        Jsonrpc: '2.0',
        RequestId: 'rid-uuid-1',
        Error: { code: -32603, message: 'Deny: LTAIfakefakefakefake1|source ip: 203.0.113.7' },
      },
    ]);
    const error = events.filter((e) => e.type === 'error')[0] as Extract<WireEvent, { type: 'error' }>;

    expect(error.error.message).not.toContain('LTAIfakefakefakefake1');
    expect(error.error.message).toContain('<AccessKeyId 已隐去>');
    // "被身份级安全管控拦下"这条判断依据要留着，脱敏只换掉 AK 本身
    expect(error.error.message).toContain('source ip: 203.0.113.7');

    /**
     * 帧本体**不做凭证脱敏**：原样透传是 wire 与样例同形的前提，
     * 动了它 live 与 mock 就没法共用同一个 reducer。所以这里如实断言它还是原样，
     * 而不是假装整条链路都干净——凭证脱敏不归这一层管（见 README）。
     */
    const frame = events.filter((e) => e.type === 'frame')[0] as Extract<WireEvent, { type: 'frame' }>;
    expect(JSON.stringify(frame.body)).toContain('LTAIfakefakefakefake1');
  });

  it('帧源中途抛异常 ⇒ 归一成一条 error 后结束，不再补收尾分类', async () => {
    /**
     * 抛的必须是 Error 实例：`toApiError` 按形状认上游错误（`name` / 数字 `statusCode`）。
     * 传输层那种由 `@darabonba/typescript` 自己构造的 ResponseError，因为 ES5 产物的
     * `__extends` 丢了原型链，`instanceof ResponseError` 为 false（openapi-core 的子类相反，为 true）。
     * 顺手把那条修复也钉在这里。
     */
    const upstream = new Error('prompt forward failed, upstream_status=422');
    (upstream as unknown as { name: string; statusCode: number }).name = 'ResponseError';
    (upstream as unknown as { statusCode: number }).statusCode = 422;

    const events = await collect([contentFrame('rid-uuid-1')], { thenThrow: upstream });
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    const error = errors[0] as Extract<WireEvent, { type: 'error' }>;
    expect(error.error.kind).toBe('session_ghost');
    expect(error.error.upstreamStatus).toBe(422);
    expect(error.error.fatalForSession).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });
});
