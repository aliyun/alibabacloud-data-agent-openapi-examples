/**
 * Token 用量的条形图数据。
 *
 * 只有 prompt / completion / thoughts 三段进堆叠条：**cached 与它们重叠**
 * （缓存命中的那部分本来就算在 prompt 里），画进同一条会把总量画超。
 * cached 单独给一个"占总量百分比"，不参与堆叠。
 *
 * 三项之和与 `totalTokens` 不保证相等（上游没承诺过），所以对不上的差额
 * 单独画成「未归类」一段——宁可多一段灰的，也不让条形图悄悄少算或多算。
 */
export interface UsageParts {
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  thoughtsTokens: number | undefined;
  cachedTokens: number | undefined;
  totalTokens: number | undefined;
}

export type SegmentKey = 'prompt' | 'completion' | 'thoughts' | 'unaccounted';

export interface UsageSegment {
  key: SegmentKey;
  label: string;
  tokens: number;
  /** 占分母的百分比，保留一位小数。同一条里所有段之和 ≤ 100。 */
  pct: number;
}

const LABELS: Record<SegmentKey, string> = {
  prompt: 'prompt',
  completion: 'completion',
  thoughts: 'thoughts',
  unaccounted: '未归类',
};

function positive(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

function pctOf(tokens: number, denominator: number): number {
  return Number(((tokens / denominator) * 100).toFixed(1));
}

export function usageSegments(usage: UsageParts): UsageSegment[] {
  const parts: Array<[SegmentKey, number]> = [
    ['prompt', positive(usage.promptTokens)],
    ['completion', positive(usage.completionTokens)],
    ['thoughts', positive(usage.thoughtsTokens)],
  ];
  const sum = parts.reduce((acc, [, tokens]) => acc + tokens, 0);
  const denominator = Math.max(sum, positive(usage.totalTokens));
  if (denominator === 0) return [];

  const segments: UsageSegment[] = parts
    .filter(([, tokens]) => tokens > 0)
    .map(([key, tokens]) => ({ key, label: LABELS[key], tokens, pct: pctOf(tokens, denominator) }));

  const unaccounted = denominator - sum;
  if (unaccounted > 0) {
    segments.push({
      key: 'unaccounted',
      label: LABELS.unaccounted,
      tokens: unaccounted,
      pct: pctOf(unaccounted, denominator),
    });
  }
  return segments;
}

/** 条形图的分母：三项之和与 totalTokens 取大者，全为零时返回 undefined（没法画）。 */
export function usageDenominator(usage: UsageParts): number | undefined {
  const sum =
    positive(usage.promptTokens) + positive(usage.completionTokens) + positive(usage.thoughtsTokens);
  const denominator = Math.max(sum, positive(usage.totalTokens));
  return denominator > 0 ? denominator : undefined;
}

/** 缓存命中占总量（不是占 prompt——上游没说过 cached 是 prompt 的子集，只说过它同属这次用量）。 */
export function cachedPct(usage: UsageParts): number | undefined {
  const denominator = usageDenominator(usage);
  const cached = positive(usage.cachedTokens);
  if (denominator === undefined || cached === 0) return undefined;
  return pctOf(cached, denominator);
}
