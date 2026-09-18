import { useEffect, useState } from 'react';

/**
 * 一个会定期更新的"现在"。
 *
 * 相对时间（"3 分钟前"）如果只在渲染时算一次，就会停在页面加载那一刻：
 * 挂着一整天不动的界面上，所有会话都显示"3 分钟前"。所以要有个心跳。
 *
 * 心跳放在**用它的组件**里而不是全局 store：只有会话列表需要它，
 * 而 30 秒一次的重渲染只该发生在那一栏。间隔刻意比"分钟"这个显示粒度细，
 * 否则刚过整分的那一刻会多显示一分钟的旧值。
 *
 * 后台标签页里 setInterval 会被节流到 ≥1s，对 30s 的心跳没有影响。
 *
 * @param active 关掉心跳（默认开）。底栏与轮次视图只在"这一轮正在收流"时才需要
 *   每秒重渲染；空闲时还挂着 1s 心跳，等于让整个底栏无谓地每秒重排一次。
 */
export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);

  return now;
}
