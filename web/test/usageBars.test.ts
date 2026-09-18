import { describe, expect, it } from 'vitest';

import { cachedPct, usageDenominator, usageSegments, type UsageParts } from '@/lib/usageBars';

/**
 * Token 用量条形图的数据。
 *
 * 期望值一律写死字面量，不用 `usageSegments()` 自己的输出反推——否则"分母取错了"
 * 这类缺陷会让期望值和实际值一起错，测试恒绿。
 *
 * 真实数字那一组是真实链路一次历史抓包的实测值：
 * prompt 72478 / completion 848 / thoughts 311 / cached 64886 / total 73326。
 * 注意 **三项之和 73637 比上游报的 totalTokens 73326 还大**，这正是分母要取
 * `max(sum, total)` 的原因：拿 total 当分母会把 prompt 画成 100.4%。
 */
const REAL: UsageParts = {
  promptTokens: 72_478,
  completionTokens: 848,
  thoughtsTokens: 311,
  cachedTokens: 64_886,
  totalTokens: 73_326,
};

describe('usageSegments', () => {
  it('三项正好凑成总量时，只有三段、百分比之和是 100', () => {
    const segments = usageSegments({
      promptTokens: 50,
      completionTokens: 30,
      thoughtsTokens: 20,
      cachedTokens: undefined,
      totalTokens: undefined,
    });
    expect(segments.map((s) => s.key)).toEqual(['prompt', 'completion', 'thoughts']);
    expect(segments.map((s) => s.pct)).toEqual([50, 30, 20]);
    expect(segments.map((s) => s.label)).toEqual(['prompt', 'completion', 'thoughts']);
  });

  it('total 比三项之和大时，差额单独画成「未归类」而不是悄悄少算', () => {
    const segments = usageSegments({
      promptTokens: 60,
      completionTokens: 20,
      thoughtsTokens: 10,
      cachedTokens: undefined,
      totalTokens: 100,
    });
    expect(segments.map((s) => s.key)).toEqual(['prompt', 'completion', 'thoughts', 'unaccounted']);
    expect(segments[3]).toEqual({ key: 'unaccounted', label: '未归类', tokens: 10, pct: 10 });
  });

  it('实测数值：三项之和超过 totalTokens，分母取和，不产生未归类段', () => {
    const segments = usageSegments(REAL);
    expect(segments.map((s) => s.key)).toEqual(['prompt', 'completion', 'thoughts']);
    expect(segments.map((s) => s.tokens)).toEqual([72_478, 848, 311]);
    expect(segments.map((s) => s.pct)).toEqual([98.4, 1.2, 0.4]);
  });

  it('cached 不进堆叠：它与 prompt 重叠，画进去会把总量画超', () => {
    expect(usageSegments(REAL).some((s) => s.label === 'cached')).toBe(false);
    expect(usageSegments(REAL).reduce((acc, s) => acc + s.tokens, 0)).toBe(73_637);
  });

  it('为零或缺失的段直接不出现，不占一格 0%', () => {
    const segments = usageSegments({
      promptTokens: 100,
      completionTokens: 0,
      thoughtsTokens: undefined,
      cachedTokens: undefined,
      totalTokens: 100,
    });
    expect(segments).toEqual([{ key: 'prompt', label: 'prompt', tokens: 100, pct: 100 }]);
  });

  it('负数与非有限值按 0 处理：上游没承诺过这些字段干净', () => {
    const segments = usageSegments({
      promptTokens: -5,
      completionTokens: Number.NaN,
      thoughtsTokens: Number.POSITIVE_INFINITY,
      cachedTokens: undefined,
      totalTokens: 40,
    });
    expect(segments).toEqual([{ key: 'unaccounted', label: '未归类', tokens: 40, pct: 100 }]);
  });

  it('全是零就没法画，返回空数组', () => {
    expect(
      usageSegments({
        promptTokens: 0,
        completionTokens: undefined,
        thoughtsTokens: undefined,
        cachedTokens: undefined,
        totalTokens: 0,
      }),
    ).toEqual([]);
  });
});

describe('usageDenominator', () => {
  it('取三项之和与 totalTokens 的大者', () => {
    expect(usageDenominator(REAL)).toBe(73_637);
    expect(
      usageDenominator({
        promptTokens: 60,
        completionTokens: 20,
        thoughtsTokens: 10,
        cachedTokens: undefined,
        totalTokens: 100,
      }),
    ).toBe(100);
  });

  it('画不出条时是 undefined，而不是 0（0 会让百分比变成 Infinity）', () => {
    expect(
      usageDenominator({
        promptTokens: undefined,
        completionTokens: undefined,
        thoughtsTokens: undefined,
        cachedTokens: 999,
        totalTokens: undefined,
      }),
    ).toBeUndefined();
  });
});

describe('cachedPct', () => {
  it('占总量，不声称自己是 prompt 的子集', () => {
    expect(cachedPct(REAL)).toBe(88.1);
  });

  it('没有 cached 或画不出条时是 undefined', () => {
    expect(cachedPct({ ...REAL, cachedTokens: undefined })).toBeUndefined();
    expect(cachedPct({ ...REAL, cachedTokens: 0 })).toBeUndefined();
    expect(
      cachedPct({
        promptTokens: undefined,
        completionTokens: undefined,
        thoughtsTokens: undefined,
        cachedTokens: 10,
        totalTokens: undefined,
      }),
    ).toBeUndefined();
  });
});
