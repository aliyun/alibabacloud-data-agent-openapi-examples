import { describe, expect, it } from 'vitest';

import {
  COLLAPSE_TOOL_COUNT,
  shouldCollapseTools,
  toolGroupFacts,
  toolGroupLabel,
} from '@/lib/turnCollapse';
import type { ToolGroupItem } from '@/lib/turnCollapse';

/**
 * 工具卡片组什么时候默认折叠。
 *
 * 折叠是降噪，但降噪不能顺手把坏消息也降掉——失败的工具调用、以及上游没送终态帧的那些，
 * 恰恰是最需要一眼看见的。所以判据的三条例外（收流中、条数不够、有 failed/unsettled）
 * 在这里逐条钉住，阈值用字面量。
 */

function tools(statuses: string[], names?: (string | undefined)[]): ToolGroupItem[] {
  return statuses.map((status, i) => ({ status, name: names?.[i] }));
}

const OK5 = tools(['success', 'success', 'success', 'success', 'success']);

describe('COLLAPSE_TOOL_COUNT', () => {
  it('阈值是 4：四次以内摊开，第五次起才折叠', () => {
    expect(COLLAPSE_TOOL_COUNT).toBe(4);
  });
});

describe('toolGroupFacts', () => {
  it('数条数与失败数', () => {
    const facts = toolGroupFacts(tools(['success', 'failed', 'success']));
    expect(facts.count).toBe(3);
    expect(facts.failed).toBe(1);
    expect(facts.unsettled).toBe(0);
  });

  it('pending 与 in_progress 都算没落定', () => {
    const facts = toolGroupFacts(tools(['success', 'pending', 'in_progress', 'failed']));
    expect(facts.unsettled).toBe(2);
    expect(facts.failed).toBe(1);
  });

  it('lastName 取最后一个**有名字**的：上游的 name 实测会缺', () => {
    expect(toolGroupFacts(tools(['success', 'success'], ['read_file', undefined])).lastName).toBe(
      'read_file',
    );
    expect(toolGroupFacts(tools(['success', 'success'], ['read_file', ''])).lastName).toBe(
      'read_file',
    );
  });

  it('全都没有名字时 lastName 是 undefined，不是空串', () => {
    expect(toolGroupFacts(tools(['success'], [undefined])).lastName).toBeUndefined();
    expect(toolGroupFacts([]).lastName).toBeUndefined();
  });

  it('空组：count 0，没有失败也没有未落定', () => {
    expect(toolGroupFacts([])).toEqual({ count: 0, lastName: undefined, failed: 0, unsettled: 0 });
  });
});

describe('shouldCollapseTools', () => {
  it('条数刚好到阈值不折叠，多一条才折叠', () => {
    expect(shouldCollapseTools(toolGroupFacts(OK5.slice(0, 4)), false)).toBe(false);
    expect(shouldCollapseTools(toolGroupFacts(OK5), false)).toBe(true);
  });

  it('收流中一律不折叠：卡片逐个出现本身就是进度条', () => {
    expect(shouldCollapseTools(toolGroupFacts(tools(Array(12).fill('success'))), true)).toBe(false);
  });

  it('有一个失败就不折叠——坏消息不能被降噪降掉', () => {
    const mixed = tools(Array(5).fill('success'));
    mixed[2] = { name: undefined, status: 'failed' };
    expect(shouldCollapseTools(toolGroupFacts(mixed), false)).toBe(false);
  });

  it('收流结束后仍有 pending 的不折叠（那是上游没送终态帧）', () => {
    const mixed = tools(Array(5).fill('success'));
    mixed[4] = { name: undefined, status: 'pending' };
    expect(shouldCollapseTools(toolGroupFacts(mixed), false)).toBe(false);
  });

  it('十几个全部成功的长轮才折叠', () => {
    expect(shouldCollapseTools(toolGroupFacts(tools(Array(14).fill('success'))), false)).toBe(true);
  });
});

describe('toolGroupLabel', () => {
  it('带最近一次的工具名', () => {
    expect(toolGroupLabel(toolGroupFacts(tools(['success', 'success'], ['a', 'run_sql'])))).toBe(
      '2 次工具调用 · 最近 run_sql',
    );
  });

  it('没有名字时只报条数', () => {
    expect(toolGroupLabel(toolGroupFacts(OK5))).toBe('5 次工具调用');
  });

  /**
   * 摘要行刻意**不**报失败数与未终态数：这两种情况本来就会让卡片摊开着，
   * 折叠行再报一次就是同一条消息在界面上出现两遍，而重复的消息会被读成两件不同的事。
   */
  it('摘要里不出现失败数与未终态数（那由摊开＋染色表达）', () => {
    const mixed = tools(Array(5).fill('success'));
    mixed[1] = { name: undefined, status: 'failed' };
    mixed[3] = { name: undefined, status: 'pending' };
    const label = toolGroupLabel(toolGroupFacts(mixed));
    expect(label).toBe('5 次工具调用');
    expect(label).not.toContain('失败');
    expect(label).not.toContain('终态');
  });
});
