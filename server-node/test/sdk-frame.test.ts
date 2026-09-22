import { describe, expect, it } from 'vitest';
import * as $dara from '@darabonba/typescript';
import { PromptAgentSessionResponse } from '@alicloud/dataworks-public20240518/dist/models/PromptAgentSessionResponse.js';

import {
  countFramesForRid,
  frameFromSdkBody,
  hasRequestId,
  popAckRequestId,
  reduceHistory,
  requestIdOf,
  type AcpFrame,
} from '@das/shared';

import { FIXTURES, loadFixture } from './helpers/fixtures.js';

/**
 * LIVE 与 MOCK 的形状契约。
 *
 * 这条测试存在的原因是一次真实的静默失效风险：SDK 的 `*WithSSE()` 不是把 SSE 载荷原样交出来，
 * 而是 `$dara.cast(payload, new PromptAgentSessionResponse({}))` —— 顶层键被按模型 names()
 * 改成 camelCase，模型没声明的键直接丢。而本工程的录制件、reducer、rid 过滤全部按线格式
 * （PascalCase）写。少了适配层，LIVE 下 `frame.Params` 恒 undefined，表现是
 * "一整轮什么都不显示，且不报任何错"。
 *
 * 所以这里**直接用真 SDK 的 cast** 来造输入，而不是自己假想一个 camelCase 对象：
 * 契约的一方是第三方包，只有拿它本尊对账，这条测试才有意义。
 */

/** 走一遍 SDK 真实做的事：cast 成 Model，取 body。 */
function throughSdkCast(frame: AcpFrame): unknown {
  const resp = $dara.cast(
    { statusCode: 200, headers: {}, id: 'evt-1', event: 'result', body: frame },
    new PromptAgentSessionResponse({}),
  );
  return resp.body;
}

const ALL_STREAM_FIXTURES = Object.values(FIXTURES);

describe('SDK 响应体 → 线格式帧', () => {
  it('cast 之后顶层键确实变成了 camelCase（前提成立，否则这条测试测了个空气）', () => {
    const firstFrame = loadFixture(FIXTURES.promptShort)[0];
    if (!firstFrame) throw new Error(`${FIXTURES.promptShort} 是空的，这条前提断言无法进行`);
    const body = throughSdkCast(firstFrame) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['jsonrpc', 'method', 'params', 'requestId', 'timestamp']);
    expect(body.Params).toBeUndefined();
    expect(body.params).toBeDefined();
  });

  it.each(ALL_STREAM_FIXTURES)('%s：每一帧过一遍真 SDK cast 再适配，与线格式逐字相等', (name) => {
    const frames = loadFixture(name);
    expect(frames.length).toBeGreaterThan(0);
    for (const [i, frame] of frames.entries()) {
      const back = frameFromSdkBody(throughSdkCast(frame));
      expect(back, `${name} 第 ${i} 帧适配后丢了`).toBeDefined();
      expect(back, `${name} 第 ${i} 帧`).toEqual(frame);
    }
  });

  it('缺 RequestId 的帧适配后仍然缺这个键（rid 过滤判据是键是否存在）', () => {
    // 内部录制与公开合成样例都包含有/无 RequestId 的帧。
    const frames = loadFixture(FIXTURES.loadPolluted);
    const withRid = frames.filter((f) => hasRequestId(f));
    const without = frames.filter((f) => !hasRequestId(f));
    expect(without.length).toBeGreaterThan(0);
    expect(withRid.length).toBeGreaterThan(0);

    for (const frame of without) {
      const back = frameFromSdkBody(throughSdkCast(frame));
      expect(back).toBeDefined();
      expect(hasRequestId(back!), `${JSON.stringify(back).slice(0, 120)} 多出了 RequestId 键`).toBe(false);
    }
    for (const frame of withRid) {
      expect(hasRequestId(frameFromSdkBody(throughSdkCast(frame))!)).toBe(true);
    }
  });

  it('适配后整份历史 reduce 的结果与直接喂线格式完全一致', () => {
    const wire = loadFixture(FIXTURES.loadPolluted);
    const viaSdk = wire.map((f) => frameFromSdkBody(throughSdkCast(f))!);

    const a = reduceHistory(wire);
    const b = reduceHistory(viaSdk);
    expect(b.droppedRidLess).toBe(wire.filter((frame) => !hasRequestId(frame)).length);
    expect(b.totalFrames).toBe(a.totalFrames);
    expect(b.turns).toEqual(a.turns);
    expect(b.nonTurnRids).toEqual(a.nonTurnRids);
  });

  it('长轮那一份的 rid 帧数在适配后不变', () => {
    const wire = loadFixture(FIXTURES.promptLong);
    const viaSdk = wire.map((f) => frameFromSdkBody(throughSdkCast(f))!);
    const rid = wire.find((f) => hasRequestId(f))!.RequestId!;
    expect(countFramesForRid(viaSdk, rid)).toBe(countFramesForRid(wire, rid));
  });
});

describe('适配器的边界行为', () => {
  it('线格式输入原样通过 ⇒ 回放与 LIVE 共用同一个函数', () => {
    const frame: AcpFrame = { Jsonrpc: '2.0', Method: 'session/update', Params: { sessionId: 's' } };
    expect(frameFromSdkBody(frame)).toEqual(frame);
  });

  it('带 data 信封的输入也能吃（录制件形态）', () => {
    const frame = { Jsonrpc: '2.0', Method: 'session/update', Params: { sessionId: 's' } };
    expect(frameFromSdkBody({ data: frame })).toEqual(frame);
  });

  it('空 Model 返回 undefined，而不是一个什么都没有的帧', () => {
    // 载荷外面多套一层信封时，cast 会把字段全丢，剩下一个空壳。
    // 这种情况必须显式失败：静默当成"这轮没内容"会让用户以为任务跑完了。
    expect(frameFromSdkBody(throughSdkCast({ data: { Jsonrpc: '2.0' } } as unknown as AcpFrame))).toBeUndefined();
    expect(frameFromSdkBody({})).toBeUndefined();
    expect(frameFromSdkBody(null)).toBeUndefined();
    expect(frameFromSdkBody('nope')).toBeUndefined();
    expect(frameFromSdkBody([1, 2])).toBeUndefined();
  });

  it('只有 POP 回执的载荷不是帧，但里面的 RequestId 要能单独捞出来', () => {
    // 2026-09-15 真实链路实测：prompt 被上游 200 收下，SSE 只回这一个事件就关流。
    // 早先它被当成"帧"透传，还被 requestIdOf 当成本轮 rid——拿这个 32 位十六进制的
    // POP RequestId 去过滤历史（ACP 帧上是 UUID）必然一无所获。
    expect(frameFromSdkBody({ RequestId: '0dd3b146c75bf132a65efa7a3080e7cd' })).toBeUndefined();
    expect(frameFromSdkBody({ data: { RequestId: '0dd3b146c75bf132a65efa7a3080e7cd' } })).toBeUndefined();
    // SDK cast 之后是 camelCase，同样不能认成帧
    expect(frameFromSdkBody({ requestId: '0dd3b146c75bf132a65efa7a3080e7cd' })).toBeUndefined();
    // 再加上 Timestamp / Id 也不够：录制件里 100% 的帧都带 Jsonrpc
    expect(frameFromSdkBody({ RequestId: 'r', Timestamp: 1789483174719, Id: 'null' })).toBeUndefined();

    expect(popAckRequestId({ requestId: '0dd3b146c75bf132a65efa7a3080e7cd' })).toBe('0dd3b146c75bf132a65efa7a3080e7cd');
    expect(popAckRequestId({ data: { RequestId: 'abc' } })).toBe('abc');
    expect(popAckRequestId({ Jsonrpc: '2.0' })).toBeUndefined();
  });

  it('真实帧带着 RequestId 时仍然是帧（新判据不能误伤）', () => {
    const frame = frameFromSdkBody({ Jsonrpc: '2.0', Method: 'session/update', RequestId: 'abc', Params: { sessionId: 's' } });
    expect(frame?.Method).toBe('session/update');
    expect(requestIdOf(frame!)).toBe('abc');
  });

  it('模型没声明的键原样带过去，便于发现上游新增字段', () => {
    const body = { jsonrpc: '2.0', method: 'session/update', SomeNewField: { a: 1 } };
    expect(frameFromSdkBody(body)).toEqual({ Jsonrpc: '2.0', Method: 'session/update', SomeNewField: { a: 1 } });
  });

  it('终态帧与错误帧适配后仍能被识别', () => {
    const terminal = frameFromSdkBody(throughSdkCast({ Jsonrpc: '2.0', Id: '1', Result: { stopReason: 'end_turn' } }));
    expect(terminal?.Result).toEqual({ stopReason: 'end_turn' });

    const failed = frameFromSdkBody(
      throughSdkCast({
        Jsonrpc: '2.0',
        Id: '1',
        Error: { code: -32603, errorCode: '0x48833000000000d1', message: 'session stream ended without turn terminal' },
      }),
    );
    expect(failed?.Error?.code).toBe(-32603);
    expect(failed?.Error?.message).toContain('session stream ended without turn terminal');
  });
});
