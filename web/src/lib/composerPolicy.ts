/**
 * 输入框的三条判据（纯函数，node 环境直接单测）：
 * **大段粘贴什么时候折叠**、**上下箭头什么时候翻提示词历史**、**Enter 是发送还是换行**。
 *
 * 剥出来是因为这三条都只能在真实按键时序里出错，而浏览器里很难稳定复现：
 * 折叠判据错了，粘一段 SQL 进来输入框会变成一整屏滚动区；翻历史的门槛错了，
 * 多行草稿里按上箭头本该移动光标，却把整段文字换成了上一句提示词——后者是静默丢内容；
 * Enter 判据错了，⌘/Ctrl+Enter 会把半句话直接发出去，而发出去就撤不回。
 */

/**
 * 折叠阈值。输入框最高 240px（约 12 行），超过这个量级的粘贴内容已经把
 * "我正在写的任务"挤出视野了，所以折成一块 chip，发送时原文一并送出。
 *
 * 字数与行数两条判据都要：一段没有换行的 3000 字日志按行数看只有 1 行，
 * 一份 40 行的短 SQL 按字数看可能不到 1000 字。
 */
export const PASTE_COLLAPSE_CHARS = 1_200;
export const PASTE_COLLAPSE_LINES = 20;

export function countLines(text: string): number {
  return text.split('\n').length;
}

export function shouldCollapsePaste(text: string): boolean {
  return text.length >= PASTE_COLLAPSE_CHARS || countLines(text) >= PASTE_COLLAPSE_LINES;
}

/** chip 上的字：只给量，不给内容预览——预览会把折叠省下来的空间又吃回去。 */
export function pasteLabel(text: string): string {
  return `粘贴的 ${text.length.toLocaleString('zh-CN')} 字 · ${countLines(text)} 行`;
}

/** 翻历史的游标。`index === null` 表示没在翻（此时 stash 无意义）。 */
export interface HistoryCursor {
  index: number | null;
  /** 进入历史之前框里那段还没发的文字，退出历史时要还回去。 */
  stash: string;
}

export const IDLE_CURSOR: HistoryCursor = { index: null, stash: '' };

export interface HistoryStep {
  cursor: HistoryCursor;
  /** 该显示在输入框里的文字。没变化时原样返回 draft。 */
  text: string;
}

/**
 * 上箭头：往更早的一句走。
 *
 * 第一次进入历史时把当前草稿存进 stash——用户可能已经写了半句才想起"上一句怎么写的"，
 * 不存就会把那半句直接覆盖掉。历史为空时什么都不做（游标保持 idle）。
 */
export function recallOlder(cursor: HistoryCursor, history: readonly string[], draft: string): HistoryStep {
  if (history.length === 0) return { cursor, text: draft };

  if (cursor.index === null) {
    const first = history[0];
    if (first === undefined) return { cursor, text: draft };
    return { cursor: { index: 0, stash: draft }, text: first };
  }
  const next = cursor.index + 1;
  const text = history[next];
  if (text === undefined) return { cursor, text: draft };
  return { cursor: { ...cursor, index: next }, text };
}

/**
 * 下箭头：往更新的一句走，走到头（index 0 再往下）就把 stash 还回去并退出历史。
 * 不在历史里时下箭头什么都不做——那时候它该由浏览器拿去移动光标。
 */
export function recallNewer(cursor: HistoryCursor, history: readonly string[], draft: string): HistoryStep {
  if (cursor.index === null) return { cursor, text: draft };
  if (cursor.index === 0) return { cursor: IDLE_CURSOR, text: cursor.stash };
  const next = cursor.index - 1;
  const text = history[next];
  if (text === undefined) return { cursor: IDLE_CURSOR, text: cursor.stash };
  return { cursor: { ...cursor, index: next }, text };
}

/** 判定 Enter 需要的最小事件面：给真实 KeyboardEvent 用，也给测试用的字面量用。 */
export interface EnterKeyState {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export type EnterIntent = 'submit' | 'newline';

/**
 * 这一记 Enter 是发送还是换行。
 *
 * **只有光秃秃的 Enter 才是发送**，带任何修饰键一律换行。理由是代价不对称：
 * 换行错了，用户按一下退格就修回来；发送错了，那句话已经进了会话历史、
 * 而且服务端可能立刻开始执行写操作，撤不回（CancelAgentSession 实测 503）。
 * ⌘/Ctrl+Enter 在编辑器与聊天工具里普遍是"换行 / 另起一段"的肌肉记忆，
 * 把它判成发送等于专门坑这批用户。
 */
export function enterIntent(event: EnterKeyState): EnterIntent {
  return event.shiftKey || event.metaKey || event.ctrlKey || event.altKey ? 'newline' : 'submit';
}

/**
 * 这一记上下箭头该不该拿去翻历史（而不是移动光标 / 移屏）。
 *
 * 三个条件缺一不可：
 *  · 没有选区——有选区时箭头的第一职责是收选区；
 *  · 光标在边界——上箭头要在最前面、下箭头要在最后面，中间位置一律还给编辑器；
 *  · 上箭头额外要求"框是空的或已经在翻历史"：一段多行草稿里光标停在第一行行首时，
 *    按上箭头应该什么都不发生，而不是把整段草稿换成上一句提示词。
 */
export function shouldRecall(
  key: 'ArrowUp' | 'ArrowDown',
  cursor: HistoryCursor,
  draft: string,
  caretStart: number,
  caretEnd: number,
): boolean {
  if (caretStart !== caretEnd) return false;
  if (key === 'ArrowUp') {
    if (caretStart !== 0) return false;
    return cursor.index !== null || draft === '';
  }
  if (caretEnd !== draft.length) return false;
  return cursor.index !== null;
}
