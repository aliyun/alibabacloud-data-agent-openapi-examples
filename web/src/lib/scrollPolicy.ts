/**
 * 滚动跟随策略：把"该不该自动滚到底"的判据从 DOM 里剥出来。
 *
 * 剥出来的理由是这一组判据全靠肉眼验不出来：流式期间每秒约 4.7 帧，
 * 抢滚动条与不抢的差别只在"用户往上翻的那一瞬间"才显现，而那正是长轮里
 * 最容易发生的事。放在纯函数里才能逐条钉住。
 *
 * 六条规则（编号与 useAutoScroll 里的落点一一对应）：
 *  1. 挂载即落底——打开会话时应当看到最新一轮，而不是开头；
 *  2. 内容增长时，**只有仍在跟随**才落底；
 *  3. 用户**向上翻**（一次真实的向上位移，不是内容长高造成的错觉）⇒ 脱离跟随，
 *     此后新内容不再抢滚动条；
 *  4. 用户自己滚回阈值内 ⇒ 恢复跟随；
 *  5. 用户按下发送 ⇒ 强制恢复跟随并落底（他刚发的那句必须在视野里）；
 *  6. 用户正在选中文本 ⇒ 本次跳过落底，但**不改变**跟随态
 *     （拖蓝复制到一半被滚走是最难恢复的交互，而选完还在底部就该继续跟随）。
 */

/**
 * "还在底部附近"的阈值（px）。
 *
 * 不能是 0：流式内容一帧一帧地长，滚动事件与内容追加之间有先后，用 0 判的话
 * 用户在底部也会被误判成"翻上去了"，跟随就此断掉、再也接不回来。
 * 也不能太大：一行正文约 24px，给到 120px（约 5 行）意味着用户往上翻了
 * 两三行都还算"在底部"，那几行会被下一次自动滚动吃掉。
 */
export const NEAR_BOTTOM_PX = 120;

/** 只取判据需要的三个量，这样测试可以直接喂字面量而不必造 DOM。 */
export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function metricsOf(el: ScrollMetrics): ScrollMetrics {
  return { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, clientHeight: el.clientHeight };
}

/** 距底部还有多少 px。内容不够一屏时是负数，按 0 处理。 */
export function distanceToBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight);
}

/** 规则 3/4 的判据：是否仍在底部阈值内。 */
export function isNearBottom(m: ScrollMetrics): boolean {
  return distanceToBottom(m) <= NEAR_BOTTOM_PX;
}

/**
 * 这一次滚动事件是不是用户**真的往上翻**了。
 *
 * 只看"离底部多远"是不够的，而且会误伤：流式期间内容一帧一帧长高，
 * `scrollHeight` 跳了一大步而 `scrollTop` 还没跟上（自动滚动在下一个 effect 里才执行），
 * 这中间只要来一次滚动事件，按距离判就会把跟随判成 false——用户什么都没做，
 * 跟随却断了，此后新内容不再落底，长轮里正文一直往上跑出视野。
 *
 * 所以脱离跟随必须由一次**向上的位移**触发。两个例外：
 *  · 内容变矮（切窗口、折叠了一块）时浏览器会把 `scrollTop` 夹小，那是被动的；
 *  · 位移小于等于 1px 的抖动（高分屏上的亚像素滚动）不算一次"翻"。
 */
export function scrolledUp(prev: ScrollMetrics, next: ScrollMetrics): boolean {
  if (next.scrollHeight < prev.scrollHeight) return false;
  return next.scrollTop < prev.scrollTop - 1;
}

/**
 * 规则 3 + 4 合起来：一次滚动事件之后的跟随态。
 *
 * 刻意**不**再加一个"用户意图时间窗"（滚轮/触摸后 1 秒内不自动滚）：
 * 上翻必然产生一次向上的位移，上面的方向判据已经覆盖；再加一层时间窗
 * 只会让"用户翻回底部后多久才恢复跟随"变成一个说不清的数。
 */
export function followAfterScroll(prev: ScrollMetrics, next: ScrollMetrics): boolean {
  if (scrolledUp(prev, next)) return false;
  return isNearBottom(next);
}

/**
 * 内容是否真的超出了一屏。
 *
 * 「回到底部」按钮必须靠它兜住：不判溢出的话，一个只有两轮的短会话
 * （压根没有可滚动的距离）也会挂着一个点了没反应的按钮。
 */
export function hasOverflow(m: ScrollMetrics): boolean {
  return m.scrollHeight - m.clientHeight > 1;
}

/**
 * 规则 2 + 6：这一次内容更新要不要落底。
 *
 * `selecting` 只让本次跳过，不写回跟随态——所以它是个入参而不是状态。
 */
export function shouldAutoScroll(following: boolean, selecting: boolean): boolean {
  return following && !selecting;
}

/** 「回到底部」按钮该不该出现：翻上去了，且确实有可滚动的距离。 */
export function shouldShowJump(following: boolean, m: ScrollMetrics): boolean {
  return !following && hasOverflow(m);
}
