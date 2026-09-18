import type { ToolCallView } from '@das/shared';

/**
 * 把一轮的内容序列化成纯文本，用于「复制整轮」。
 *
 * 为什么不直接复制渲染出来的 DOM 文本：DOM 里只有当前**展开**的那些部分
 * （思考过程与工具结果默认折叠），复制出来会静默少掉一半内容，而用户看不出少了。
 * 这里一律取聚合器里的全文。
 *
 * 拆成独立文件是为了能在 node 环境下直接单测（`web/test` 不跑 jsdom）。
 */

export interface TurnText {
  rid?: string;
  userText: string;
  thoughtText: string;
  messageText: string;
  tools: ToolCallView[];
  stopReason?: string;
}

/** 参数值可能是对象或数组，一律 JSON 化；字符串原样，避免多出一层引号。 */
function valueOf(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function toolToText(tool: ToolCallView): string {
  const lines: string[] = [];
  const heading = tool.title ?? tool.name ?? tool.toolCallId;
  lines.push(`[工具 ${tool.status}] ${heading}`);
  if (tool.name && tool.name !== heading) lines.push(`name: ${tool.name}`);

  /**
   * command 已经在 rawInput 里，但单独提一行：它是这一条工具调用里唯一"能直接
   * 复制去重跑"的东西，混在参数列表里就找不着了。
   */
  if (tool.command) lines.push(`command: ${tool.command}`);

  const params = Object.entries(tool.rawInput ?? {}).filter(([key]) => key !== 'command');
  for (const [key, value] of params) lines.push(`${key}: ${valueOf(value)}`);

  for (const location of tool.locations) lines.push(`location: ${location}`);
  if (tool.resultText) lines.push(`result:\n${tool.resultText}`);
  return lines.join('\n');
}

export interface TurnBlock {
  /** 块的小标题，与界面上的分区一一对应。 */
  heading: string;
  text: string;
}

/**
 * 一轮拆成带标题的块。
 *
 * 拆出来是为了让「复制整轮」与「导出 HTML」共用同一份序列化：两边各写一遍的话，
 * 迟早会出现导出件里少一段（比如漏掉工具结果）而复制是全的，这种差异没人会发现。
 */
export function turnToBlocks(turn: TurnText): TurnBlock[] {
  const blocks: TurnBlock[] = [];
  if (turn.userText) blocks.push({ heading: '提示词', text: turn.userText });
  if (turn.thoughtText) blocks.push({ heading: '思考过程', text: turn.thoughtText });
  for (const tool of turn.tools) blocks.push({ heading: '工具调用', text: toolToText(tool) });
  if (turn.messageText) blocks.push({ heading: '回答', text: turn.messageText });
  return blocks;
}

/** 轮次尾部那一行元信息（rid / stopReason）。没有内容时返回空串。 */
export function turnTail(turn: TurnText): string {
  const tail: string[] = [];
  if (turn.rid) tail.push(`rid=${turn.rid}`);
  if (turn.stopReason) tail.push(`stopReason=${turn.stopReason}`);
  return tail.join('  ');
}

export function turnToText(turn: TurnText): string {
  const blocks: string[] = turnToBlocks(turn).map((b) => `# ${b.heading}\n${b.text}`);
  const tail = turnTail(turn);
  if (tail.length > 0) blocks.push(tail);
  return blocks.join('\n\n');
}
