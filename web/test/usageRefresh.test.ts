import { describe, expect, it } from 'vitest';

import { USAGE_REFRESH_MS, usageRefetchInterval } from '@/hooks/useUsage';

/**
 * 用量轮询的间隔与可见性门控。
 *
 * 30s 这个值是刻意选的：用量是会话累计值、只在一轮跑完后才变，秒级刷新没有意义；
 * 而 GetAgentSessionTokenUsage 实测约 0.3s 返回，是右栏五个 tab 里最便宜的一个，
 * 所以轮询它、而不是轮询 RUNNING 期能阻塞到 178s 的 LoadAgentSession。
 *
 * 期望值一律字面量，不用 USAGE_REFRESH_MS 反推——否则改错了常量测试还恒绿。
 */
describe('usageRefetchInterval', () => {
  it('前台标签页按 30s 轮询', () => {
    expect(USAGE_REFRESH_MS).toBe(30_000);
    expect(usageRefetchInterval(false)).toBe(30_000);
  });

  it('后台标签页停轮询（返回 false）——开一整天的页面不该白打上千次上游', () => {
    expect(usageRefetchInterval(true)).toBe(false);
  });
});
