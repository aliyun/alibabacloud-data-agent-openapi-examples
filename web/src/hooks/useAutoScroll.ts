import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { followAfterScroll, metricsOf, shouldAutoScroll, shouldShowJump } from '@/lib/scrollPolicy';

export interface AutoScroll {
  /** 挂到滚动容器上。 */
  ref: RefObject<HTMLDivElement>;
  /** 「回到底部」按钮该不该出现。 */
  jumpVisible: boolean;
  /** 点「回到底部」：恢复跟随并平滑落底。 */
  jumpToBottom: () => void;
  /** 用户按下发送：强制恢复跟随（规则 5）。 */
  pinToBottom: () => void;
}

/** 选区起点是否在这个容器里——只在这时候，自动滚动才算"打断了用户"。 */
function isSelectingInside(el: HTMLElement): boolean {
  const selection = document.getSelection();
  if (selection === null || selection.isCollapsed) return false;
  return selection.anchorNode !== null && el.contains(selection.anchorNode);
}

/**
 * 显式点「回到底部」时用平滑滚动，但**尊重 prefers-reduced-motion**：
 * index.css 里那条 `scroll-behavior: auto !important` 管不到这里——
 * 规范规定显式传 'smooth' 会压过计算样式，所以必须自己判一次。
 */
function smoothBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

/**
 * 流式时间线的滚动跟随。判据在 `lib/scrollPolicy.ts`（纯函数，逐条钉住），
 * 这里只负责把它们接到 DOM 事件上。
 *
 * 跟随态存在 ref 里而不是 state 里：它每帧都可能被读一次（内容追加时就问一遍
 * "还在跟随吗"），而它本身不驱动任何渲染——渲染只看 `jumpVisible`。
 * 放 state 会让长轮里每次滚动都触发一次中栏重排，正是 turnStore 用 rAF 节流
 * 想要避开的那件事。
 *
 * @param deps 内容变化的依赖数组，等价于 useEffect 的 deps：这些值一变就问一次
 *   "要不要落底"。刻意不做成 ResizeObserver——高度变化的来源就是这几个聚合值，
 *   而流式期间 ResizeObserver 每帧都会回调，多出来的那次测量只会与 rAF 抢同一帧。
 */
export function useAutoScroll(deps: unknown[]): AutoScroll {
  const ref = useRef<HTMLDivElement>(null);
  // 规则 1：初值就是"跟随"，所以挂载后第一次内容落地时直接停在底部。
  const following = useRef(true);
  const [jumpVisible, setJumpVisible] = useState(false);

  /** 规则 3/4：滚动事件本身就是"用户想停在哪"的唯一事实源。 */
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    /**
     * 上一次的度量。脱离跟随必须由一次**真实的向上位移**触发（判据见
     * `scrolledUp`）：只按"离底部多远"判的话，流式期间内容长高而 scrollTop
     * 还没跟上的那一瞬间就会误判成"用户翻上去了"，跟随就此断掉、再也接不回来。
     */
    let prev = metricsOf(el);
    const onScroll = (): void => {
      const next = metricsOf(el);
      following.current = followAfterScroll(prev, next);
      prev = next;
      setJumpVisible(shouldShowJump(following.current, next));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (shouldAutoScroll(following.current, isSelectingInside(el))) {
      // 必须是 instant：流式期间每秒约 4.7 帧，平滑滚动会排队一堆动画，
      // 视觉上变成"正文一直在往下漂"，而且永远追不上最新一帧。
      el.scrollTop = el.scrollHeight;
    }
    setJumpVisible(shouldShowJump(following.current, metricsOf(el)));
  }, deps);

  const jumpToBottom = useCallback(() => {
    const el = ref.current;
    following.current = true;
    setJumpVisible(false);
    if (el === null) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smoothBehavior() });
  }, []);

  const pinToBottom = useCallback(() => {
    const el = ref.current;
    following.current = true;
    setJumpVisible(false);
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, []);

  return { ref, jumpVisible, jumpToBottom, pinToBottom };
}
