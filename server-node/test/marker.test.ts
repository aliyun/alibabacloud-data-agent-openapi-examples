import { describe, expect, it } from 'vitest';
import { stripMarkerInstruction } from '@das/shared';

/**
 * marker 归属校验已退役（2026-09-20）：注入/生成/流式 Scrubber/verified 判定全部移除。
 * 这个文件只保留 `stripMarkerInstruction` 的用例——它仍**有用**：
 * fixtures（抓包时代录制）里残留的「（本轮校验码 DAS-XXXXXX：…）」要从历史
 * 轮次的标题/提示词中剥掉，机制本身已不再注入。
 */
describe('stripMarkerInstruction（legacy 清洗助手）', () => {
  it('剥掉录制内容里残留的校验码说明', () => {
    const title = '只读任务，不要做任何写操作\n\n（本轮校验码 DAS-ABC123：请在回答的第一行原样输出这个校验码，不要改写、不要翻译、不要解释它。）';
    expect(stripMarkerInstruction(title)).toBe('只读任务，不要做任何写操作');
  });

  it('用户自己写的相似文字不会被误删（宁可多显示，不可静默删用户内容）', () => {
    const text = '请说明（本轮校验码是什么意思）';
    expect(stripMarkerInstruction(text)).toBe(text);
    expect(stripMarkerInstruction('完全无关的提示词')).toBe('完全无关的提示词');
  });

  it('Multi occurrences/casing：只在上述严格"今天录制的说明"形态时才剥', () => {
    expect(stripMarkerInstruction('（本轮校验码 DAS-ABC123：测试） trailing')).toBe('（本轮校验码 DAS-ABC123：测试） trailing');
  });
});
