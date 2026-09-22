import { describe, expect, it } from 'vitest';

import { readFixtureFrames } from '../src/mock/fixtures.js';
import { filterHistoryFrames, frameToSessionUpdate, terminalOfFrame } from '../src/daemon/translate.js';
import {
  reduceHistory,
  stripMarkerInstruction,
  type AcpFrame,
} from '@das/shared';

/** 造一帧 session/update（线格式，PascalCase 顶层键）。 */
function updateFrame(update: Record<string, unknown>, requestId?: string): AcpFrame {
  return {
    Jsonrpc: '2.0',
    Method: 'session/update',
    ...(requestId !== undefined ? { RequestId: requestId } : {}),
    Params: { update },
  };
}

describe('daemon 翻译层：frame → session_update', () => {
  it('user_message_chunk 剥掉录制内容残留的校验码说明，信封形状对齐契约', () => {
    // 抓包时代录制的提示词尾部带着注入的校验码说明（mechanism itself 已退役，
    // 注入/生成全部移除），这里验证的是 legacy 清洗助手这条显示路径还活着。
    const text = '你好\n\n（本轮校验码 DAS-ABC123：请在回答的第一行原样输出这个校验码，不要改写、不要翻译、不要解释它。）';
    const event = frameToSessionUpdate(
      updateFrame({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }),
      'sess-1',
      { originatorClientId: 'client-9' },
    );
    expect(event).toBeDefined();
    expect(event?.v).toBe(1);
    expect(event?.type).toBe('session_update');
    expect(event?.originatorClientId).toBe('client-9');
    expect(event?.data.sessionId).toBe('sess-1');
    const update = event?.data.update as Record<string, unknown>;
    expect(update.sessionUpdate).toBe('user_message_chunk');
    expect(update.content).toEqual({ type: 'text', text: '你好' });
  });

  it('agent_message_chunk 载荷整包透传，content 不重塑', () => {
    const content = { type: 'text', text: '回答片段' };
    const event = frameToSessionUpdate(
      updateFrame({ sessionUpdate: 'agent_message_chunk', content }),
      'sess-1',
    );
    const update = event?.data.update as Record<string, unknown>;
    expect(update.content).toBe(content);
  });

  it('agent chunk 文本原样透传（含 markdown 结构空白、含 legacy token 碎片）', () => {
    // 曾在此层按整文 stripMarkerToken 逐 chunk 处理：段首的 '\n\n' 被 trim 掉，
    // 在途流里 markdown 段落/代码块围栏的边界空白被吃光（load 大块返回不受影响，
    // 表现为"流式乱、刷新好"）。机制退役后更直接：本层一个字都不能动——
    // 包括 token 碎片、结构空白、纯换行 chunk（不再有任何剥离器）。
    const boundary = frameToSessionUpdate(
      updateFrame({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\n先加载元数据表详情…\n\n' } }),
      'sess-1',
    );
    const boundaryUpdate = boundary?.data.update as { content?: { text?: string } };
    expect(boundaryUpdate.content?.text).toBe('\n\n先加载元数据表详情…\n\n');

    const newlineOnly = frameToSessionUpdate(
      updateFrame({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '\n' } }),
      'sess-1',
    );
    const newlineUpdate = newlineOnly?.data.update as { content?: { text?: string } };
    expect(newlineUpdate.content?.text).toBe('\n');

    const tokenChunk = frameToSessionUpdate(
      updateFrame({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DAS-ABDAE7\n我是 Data Agent。' } }),
      'sess-1',
    );
    const tokenUpdate = tokenChunk?.data.update as { content?: { text?: string } };
    expect(tokenUpdate.content?.text).toBe('DAS-ABDAE7\n我是 Data Agent。');
  });

  it('排队通知帧（无 update）与终态帧不产出 session_update', () => {
    const notice: AcpFrame = { Jsonrpc: '2.0', Method: '_qwen/notify', Params: { kind: 'pending_prompt_added' } };
    expect(frameToSessionUpdate(notice, 's')).toBeUndefined();

    const terminal: AcpFrame = { Jsonrpc: '2.0', Id: 1, RequestId: 'rid-1', Result: { stopReason: 'end_turn' } };
    expect(frameToSessionUpdate(terminal, 's')).toBeUndefined();
    expect(terminalOfFrame(terminal)).toEqual({ stopReason: 'end_turn', rawStopReason: 'end_turn' });
  });
});

describe('daemon 翻译层：历史帧过滤（journal 种子判据）', () => {
  it('与 reduceHistory 的轮次口径一致：rid-less 污染与 load 伪轮次都不进 journal', () => {
    const frames = readFixtureFrames('load-polluted.jsonl');
    const reduced = reduceHistory(frames);
    expect(reduced.droppedRidLess).toBeGreaterThan(0); // 这份录制件本身就有污染，先钉住前提

    const filtered = filterHistoryFrames(frames);

    // 过滤后的 rid 集合 === reduceHistory 认定的轮次 rid 集合
    const turnRids = new Set(reduced.turns.map((t) => t.rid));
    const filteredRids = new Set(filtered.map((f) => f.RequestId));
    expect(filteredRids).toEqual(turnRids);

    // 数量对账：总数 - rid-less - 非轮次 rid 的帧 = 过滤后帧数
    const nonTurnFrames = reduced.nonTurnRids.reduce((sum, rid) => sum + (reduced.rids[rid] ?? 0), 0);
    expect(filtered.length).toBe(reduced.totalFrames - reduced.droppedRidLess - nonTurnFrames);
  });

  it('轮次内帧序保持到达顺序（rid 分组后按首现顺序拼接）', () => {
    const frames = readFixtureFrames('load-clean.jsonl');
    const filtered = filterHistoryFrames(frames);
    const reduced = reduceHistory(frames);
    expect(filtered.length).toBeGreaterThan(0);
    // 首帧属于第一个轮次的 rid
    expect(filtered[0]?.RequestId).toBe(reduced.turns[0]?.rid);
  });
});
