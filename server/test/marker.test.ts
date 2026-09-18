import { describe, expect, it } from 'vitest';
import {
  MARKER_PREFIX,
  extractMarker,
  generateMarker,
  markerInstruction,
  markerVerified,
  stripMarkerInstruction,
  withMarker,
} from '@das/shared';

/**
 * marker 是"这段回答真属于我这一轮"的唯一证据。
 * 服务端有跨会话串答案的历史（实测 5 会话并发隔离率 1/5），
 * 所以校验失败必须能如实显示"归属未校验"，绝不能默认成已校验。
 */
describe('generateMarker', () => {
  it('形状固定：前缀 + 6 位大写十六进制', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateMarker()).toMatch(new RegExp(`^${MARKER_PREFIX}-[0-9A-F]{6}$`));
    }
  });

  it('连续生成不重复（同一会话内多轮各带各的码）', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateMarker()));
    expect(seen.size).toBe(500);
  });
});

describe('注入与剥离往返', () => {
  it('剥掉注入段后逐字还原用户原文', () => {
    const cases = [
      '回复且只回复：DAS-C0FFEE',
      '查一下 dwd_demo_table 的字段',
      '多行\n第二行\n第三行',
      '结尾带空行\n\n',
      '带全角括号（用户自己写的）不应该被删',
      '',
    ];
    for (const text of cases) {
      const marker = generateMarker();
      expect(stripMarkerInstruction(withMarker(text, marker))).toBe(text.replace(/\n+$/u, ''));
    }
  });

  it('注入段总在末尾，且带 marker 原文', () => {
    const marker = generateMarker();
    const injected = withMarker('干活', marker);
    expect(injected.startsWith('干活')).toBe(true);
    expect(injected.endsWith('）')).toBe(true);
    expect(injected).toContain(marker);
    expect(extractMarker(injected)).toBe(marker);
  });

  it('用户自己写的相似文字不会被误删（宁可多显示，不可静默删用户内容）', () => {
    const text = '请说明（本轮校验码是什么意思）';
    expect(stripMarkerInstruction(text)).toBe(text);
    expect(stripMarkerInstruction('完全无关的提示词')).toBe('完全无关的提示词');
  });

  it('SessionTitle 就是首条 prompt 原文，所以左栏要靠剥离才能看', () => {
    const marker = generateMarker();
    const title = withMarker('只读任务，不要做任何写操作', marker);
    expect(title).not.toBe('只读任务，不要做任何写操作');
    expect(stripMarkerInstruction(title)).toBe('只读任务，不要做任何写操作');
  });

  it('markerInstruction 是幂等可读的：同 marker 两次注入文本相同', () => {
    expect(markerInstruction('DAS-ABC123')).toBe(markerInstruction('DAS-ABC123'));
    expect(markerInstruction('DAS-ABC123')).not.toBe(markerInstruction('DAS-ABC124'));
  });
});

describe('markerVerified', () => {
  it('回答里含 marker 才算已校验', () => {
    expect(markerVerified('DAS-ABC123\n\n正文', 'DAS-ABC123')).toBe(true);
    expect(markerVerified('正文里夹着 DAS-ABC123 也算', 'DAS-ABC123')).toBe(true);
  });

  it('不含、被改写、大小写不同都算未校验', () => {
    expect(markerVerified('正文', 'DAS-ABC123')).toBe(false);
    expect(markerVerified('das-abc123', 'DAS-ABC123')).toBe(false);
    expect(markerVerified('DAS-ABC124', 'DAS-ABC123')).toBe(false);
    expect(markerVerified('校验码：DAS ABC 123', 'DAS-ABC123')).toBe(false);
  });

  it('没有 marker 时一律未校验，不会默认通过', () => {
    expect(markerVerified('DAS-ABC123', undefined)).toBe(false);
    expect(markerVerified('正文', undefined)).toBe(false);
    expect(markerVerified('正文', '')).toBe(false);
  });

  it('空回答不算已校验', () => {
    expect(markerVerified('', 'DAS-ABC123')).toBe(false);
  });
});
