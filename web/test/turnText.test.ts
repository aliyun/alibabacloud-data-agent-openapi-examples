import { describe, expect, it } from 'vitest';

import { turnToText } from '@/lib/turnText';
import type { ToolCallView } from '@das/shared';

/**
 * 「复制整轮」的序列化。
 *
 * 关键性质是**不能静默少内容**：界面上思考过程与工具结果默认是折叠的，
 * 复制如果取的是渲染出来的 DOM 文本，用户拿到手的东西会比屏幕上看到的还少，
 * 而且看不出来少了什么。这里断言的就是"折叠的部分也在"。
 */

function tool(partial: Partial<ToolCallView>): ToolCallView {
  return {
    toolCallId: 'call_1',
    name: undefined,
    title: undefined,
    status: 'completed',
    command: undefined,
    description: undefined,
    rawInput: undefined,
    locations: [],
    resultText: undefined,
    firstOffset: undefined,
    lastOffset: undefined,
    firstTimestamp: undefined,
    lastTimestamp: undefined,
    ...partial,
  };
}

describe('turnToText', () => {
  it('默认折叠的思考过程与工具结果都要在', () => {
    const text = turnToText({
      rid: 'rid-1',
      userText: '查一下表',
      thoughtText: '先看元数据',
      messageText: '共有 12 张表',
      tools: [
        tool({
          name: 'shell',
          title: 'odpscmd -e "show tables"',
          status: 'completed',
          command: 'odpscmd -e "show tables"',
          rawInput: { command: 'odpscmd -e "show tables"', skill: 'dataworks-meta-table' },
          resultText: 'Exit Code: 0\n12 tables',
        }),
      ],
      stopReason: 'end_turn',
    });

    expect(text).toContain('# 提示词\n查一下表');
    expect(text).toContain('# 思考过程\n先看元数据');
    expect(text).toContain('# 回答\n共有 12 张表');
    expect(text).toContain('[工具 completed] odpscmd -e "show tables"');
    expect(text).toContain('Exit Code: 0\n12 tables');
    expect(text).toContain('rid=rid-1');
    expect(text).toContain('stopReason=end_turn');
  });

  it('command 单独成行，且不在参数表里重复一遍', () => {
    const text = turnToText({
      userText: '',
      thoughtText: '',
      messageText: '',
      tools: [tool({ command: 'ls -la', rawInput: { command: 'ls -la', timeout: 30 } })],
    });

    expect(text).toContain('command: ls -la');
    expect(text).toContain('timeout: 30');
    // 参数表里不该再出现一次 command
    expect(text.match(/command:/g)).toHaveLength(1);
  });

  it('对象型参数 JSON 化，字符串型不加引号', () => {
    const text = turnToText({
      userText: '',
      thoughtText: '',
      messageText: '',
      tools: [tool({ rawInput: { where: { col: 'a' }, note: '纯文本' } })],
    });

    expect(text).toContain('where: {"col":"a"}');
    expect(text).toContain('note: 纯文本');
  });

  it('locations 上游填了就要出现（真实帧里恒为空，但不能因此就不接）', () => {
    const text = turnToText({
      userText: '',
      thoughtText: '',
      messageText: '',
      tools: [tool({ locations: ['odps://prj/tables/t1'] })],
    });
    expect(text).toContain('location: odps://prj/tables/t1');
  });

  it('空的部分不产出空标题', () => {
    const text = turnToText({ userText: '只有一句话', thoughtText: '', messageText: '', tools: [] });
    expect(text).toBe('# 提示词\n只有一句话');
    expect(text).not.toContain('# 思考过程');
    expect(text).not.toContain('# 回答');
  });
});
