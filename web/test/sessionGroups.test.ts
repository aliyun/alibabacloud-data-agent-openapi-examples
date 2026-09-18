import { describe, expect, it } from 'vitest';

import { groupSessions, type LocalSessionFlags } from '@/lib/sessionGroups';

interface Row {
  sessionId: string;
  createdAt: number;
}

/** 上游返回顺序刻意打乱（不按时间排），排序必须由分组函数自己保证。 */
const ROWS: Row[] = [
  { sessionId: 'mid', createdAt: 2_000 },
  { sessionId: 'newest', createdAt: 3_000 },
  { sessionId: 'oldest', createdAt: 1_000 },
];

function group(flags: Record<string, LocalSessionFlags>) {
  return groupSessions(ROWS, (row) => flags[row.sessionId]);
}

describe('groupSessions', () => {
  it('没有任何本地标记时全部落在普通组，且按 createdAt 倒序', () => {
    const g = group({});
    expect(g.normal.map((r) => r.sessionId)).toEqual(['newest', 'mid', 'oldest']);
    expect(g.pinned).toEqual([]);
    expect(g.archived).toEqual([]);
    expect(g.hiddenCount).toBe(0);
  });

  it('置顶的排进置顶组，组内同样按时间倒序', () => {
    const g = group({ oldest: { pinned: true }, mid: { pinned: true } });
    expect(g.pinned.map((r) => r.sessionId)).toEqual(['mid', 'oldest']);
    expect(g.normal.map((r) => r.sessionId)).toEqual(['newest']);
  });

  it('隐藏的只计数，不进任何组', () => {
    const g = group({ newest: { hidden: true }, mid: { hidden: true } });
    expect(g.hiddenCount).toBe(2);
    expect(g.normal.map((r) => r.sessionId)).toEqual(['oldest']);
    expect(g.pinned).toEqual([]);
    expect(g.archived).toEqual([]);
  });

  it('归档压过置顶：既置顶又归档的会话落在归档组', () => {
    const g = group({ newest: { pinned: true, archived: true } });
    expect(g.archived.map((r) => r.sessionId)).toEqual(['newest']);
    expect(g.pinned).toEqual([]);
  });

  it('隐藏压过归档与置顶', () => {
    const g = group({ newest: { pinned: true, archived: true, hidden: true } });
    expect(g.hiddenCount).toBe(1);
    expect(g.archived).toEqual([]);
  });

  it('标记为 false 与没有标记等价', () => {
    const g = group({ newest: { pinned: false, archived: false, hidden: false } });
    expect(g.normal.map((r) => r.sessionId)).toEqual(['newest', 'mid', 'oldest']);
    expect(g.hiddenCount).toBe(0);
  });

  it('flagsOf 返回 undefined（这个会话没有本地记录）时按普通处理', () => {
    const g = groupSessions(ROWS, () => undefined);
    expect(g.normal).toHaveLength(3);
  });

  it('createdAt 相同则保持传入顺序，不会每次刷新都抖', () => {
    const tied: Row[] = [
      { sessionId: 'a', createdAt: 5 },
      { sessionId: 'b', createdAt: 5 },
      { sessionId: 'c', createdAt: 5 },
    ];
    expect(groupSessions(tied, () => undefined).normal.map((r) => r.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('空列表给出四个空结果', () => {
    const g = groupSessions<Row>([], () => undefined);
    expect(g).toEqual({ pinned: [], normal: [], archived: [], hiddenCount: 0 });
  });
});
