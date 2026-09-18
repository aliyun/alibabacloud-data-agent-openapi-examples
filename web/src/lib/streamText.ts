/**
 * 流式正文的两条判据（纯函数，node 环境直接单测）：
 * **这一片要不要立刻上屏** 与 **整段要不要放弃 Markdown 解析**。
 */

/**
 * 节流间隔。
 *
 * 长轮实测 191s、平均约 4.7 帧/s，最密的 1 秒里 15 帧。每一帧都重跑一次
 * Markdown 解析（remark 建 AST + React 重建整棵子树）意味着每秒最多 15 次全量重排，
 * 而人眼读正文并不需要这个刷新率。80ms ≈ 12.5 帧/s，已经高于最密的那一秒，
 * 所以**看不出卡顿**，同时把绝大多数帧合并掉了。
 */
export const STREAM_THROTTLE_MS = 80;

/**
 * 超过这个字数就整段降级成纯文本 `<pre>`。
 *
 * Markdown 解析的成本随长度线性涨，而流式期间它每 80ms 就要重来一次：
 * 一段几万字的回答（把整张表的数据贴进正文是 agent 干得出来的事）会让
 * 每一次重排都吃掉几百毫秒，滚动和打字一起变粘。降级之后每帧只是一次文本节点更新。
 *
 * 代价说清楚：降级期间**看不到**标题、列表、表格与代码块的颜色，只有换行与等宽。
 * 收流结束后 `streaming` 翻 false，节流与降级一起解除，正文恢复完整渲染。
 */
export const MARKDOWN_PLAINTEXT_CHARS = 32_000;

export function shouldRenderPlainText(text: string, streaming: boolean): boolean {
  return streaming && text.length >= MARKDOWN_PLAINTEXT_CHARS;
}

/** 降级块上那句说明。带实际字数，用户才知道自己离阈值有多远。 */
export function plainTextNotice(text: string): string {
  return (
    `这段回答有 ${text.length.toLocaleString('zh-CN')} 字，超过 ` +
    `${MARKDOWN_PLAINTEXT_CHARS.toLocaleString('zh-CN')} 字，流式期间按纯文本显示` +
    '（不做 Markdown 解析，否则每次追加都要重排整棵子树）；收完之后会恢复完整排版。'
  );
}

/**
 * 这一片要不要立刻上屏。
 *
 * `prev` 是上一次真正渲染出去的文字，`elapsedMs` 是距那次渲染过了多久。
 *
 * 三条：
 *  · 文字没变 → 不渲染（流式帧里有大量重复推送，重渲染等于白重排一次）；
 *  · **非单调** → 立刻渲染。`next` 不是 `prev` 的延长，说明内容被整体换掉了
 *    （切换轮次、重取历史、回放还原），这时候压着不显示就是界面上留着上一段的话；
 *  · 否则按节流间隔合并。
 */
export function shouldEmitNow(prev: string, next: string, elapsedMs: number, throttleMs: number): boolean {
  if (next === prev) return false;
  if (!next.startsWith(prev)) return true;
  return elapsedMs >= throttleMs;
}
