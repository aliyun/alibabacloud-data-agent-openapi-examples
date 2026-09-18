import { describe, expect, it } from 'vitest';

import { formatCompact, formatCount, formatDuration, formatRelative, formatTime } from '@/lib/format';

/**
 * 相对时间的边界。
 *
 * `now` 由参数注入，所以这里不需要假时钟——假时钟下 `Date.now()` 与
 * `toLocaleDateString` 的时区行为会互相干扰，边界反而钉不住。
 */
const NOW = Date.parse('2026-09-16T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatRelative', () => {
  it('一分钟内一律"刚刚"', () => {
    expect(formatRelative(NOW, NOW)).toBe('刚刚');
    expect(formatRelative(NOW - 59_999, NOW)).toBe('刚刚');
  });

  it('时钟不同步（createdAt 落在未来）也归"刚刚"，不显示负数', () => {
    expect(formatRelative(NOW + 5 * MINUTE, NOW)).toBe('刚刚');
  });

  it('分钟档在 60 分钟处进位', () => {
    expect(formatRelative(NOW - MINUTE, NOW)).toBe('1 分钟前');
    expect(formatRelative(NOW - 59 * MINUTE - 59_999, NOW)).toBe('59 分钟前');
    expect(formatRelative(NOW - HOUR, NOW)).toBe('1 小时前');
  });

  it('小时档在 24 小时处进位', () => {
    expect(formatRelative(NOW - 23 * HOUR, NOW)).toBe('23 小时前');
    expect(formatRelative(NOW - DAY, NOW)).toBe('1 天前');
    expect(formatRelative(NOW - 29 * DAY, NOW)).toBe('29 天前');
  });

  it('超过 30 天回落成日期——"45 天前"已经没有排序价值', () => {
    const text = formatRelative(NOW - 31 * DAY, NOW);
    expect(text).not.toContain('天前');
    expect(text).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2}$/);
  });

  it('缺失与非法时间戳给破折号，和 formatTime 一致', () => {
    expect(formatRelative(undefined, NOW)).toBe('—');
    expect(formatRelative(Number.NaN, NOW)).toBe('—');
  });
});

describe('formatTime / formatDuration', () => {
  it('formatTime 对缺失值给破折号', () => {
    expect(formatTime(undefined)).toBe('—');
  });

  it('formatDuration 的秒以下走毫秒', () => {
    expect(formatDuration(820)).toBe('820ms');
    expect(formatDuration(92_000)).toBe('1m 32s');
    expect(formatDuration(undefined)).toBe('—');
  });
});

describe('formatCompact（右栏 hero 的累计 token 数）', () => {
  it('一百万以下给千分位，逐位可读', () => {
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(73_326)).toBe('73,326');
    expect(formatCompact(999_999)).toBe('999,999');
  });

  it('一百万起缩写成 M——七位数在 320px 宽的右栏、28px 字号下必折行', () => {
    expect(formatCompact(1_000_000)).toBe('1.0M');
    expect(formatCompact(1_234_567)).toBe('1.2M');
    expect(formatCompact(-1_000_000)).toBe('-1.0M');
  });

  it('缺失与非法值给破折号，和 formatTime / formatCount 一致', () => {
    expect(formatCompact(undefined)).toBe('—');
    expect(formatCompact(Number.NaN)).toBe('—');
    expect(formatCompact(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('与 formatCount 的分工：formatCount 一千就缩写，hero 处不能用它', () => {
    // 这条断言钉的是"为什么要有第二个函数"。formatCount 服务窄栏里的 token chip，
    // 1234 → "1.2k" 在那个尺寸下是对的；但 hero 那个 28px 的大数字要能逐位读，
    // 用 formatCount 会把 73,326 显示成 "73.3k"，用户没法核对上游报的确切值。
    expect(formatCount(73_326)).toBe('73.3k');
    expect(formatCompact(73_326)).toBe('73,326');
  });
});
