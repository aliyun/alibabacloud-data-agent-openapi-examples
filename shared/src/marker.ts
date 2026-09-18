import { MARKER_PREFIX } from './constants.js';

/**
 * marker：回答归属校验。
 *
 * 服务端存在跨会话串答案的历史问题（实测 5 个会话并发时隔离率只有 1/5），
 * 光看"这段回答是从我的连接里流出来的"不足以证明它属于我这一轮。
 * 所以每条 prompt 末尾注入一个唯一校验码，要求 agent 在回答第一行原样输出，
 * 再在收到的 message 里找它——找到才算归属已校验。
 */

const MARKER_BODY_LENGTH = 6;
const HEX_UPPER = '0123456789ABCDEF';

/**
 * shared 包不引 DOM lib 也不引 @types/node（前后端都要用同一份源码），
 * 所以这里对 globalThis.crypto 做一次最小接口收窄：Node 20+ 与浏览器都提供它。
 */
interface RandomSource {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

const randomSource = (globalThis as unknown as { crypto: RandomSource }).crypto;

export function generateMarker(): string {
  const bytes = new Uint8Array(MARKER_BODY_LENGTH);
  randomSource.getRandomValues(bytes);
  let body = '';
  for (const b of bytes) body += HEX_UPPER[b % HEX_UPPER.length];
  return `${MARKER_PREFIX}-${body}`;
}

/** 注入到 prompt 末尾的原文。模板与下面的剥离正则必须同步改。 */
export function markerInstruction(marker: string): string {
  return `\n\n（本轮校验码 ${marker}：请在回答的第一行原样输出这个校验码，不要改写、不要翻译、不要解释它。）`;
}

export function withMarker(text: string, marker: string): string {
  return `${text}${markerInstruction(marker)}`;
}

// 前缀只在 MARKER_PREFIX 一处定义：下面两条正则由它构造，改前缀不会静默失效。
const MARKER_INSTRUCTION_RE = new RegExp(`\\n*（本轮校验码 ${MARKER_PREFIX}-[0-9A-F]{6}：[^\\n]*）\\s*$`, 'u');
const MARKER_RE = new RegExp(`${MARKER_PREFIX}-[0-9A-F]{6}`, 'u');

/**
 * 把注入的校验码说明从提示词里去掉，用于展示历史轮次。
 *
 * 只对"确实是本工程注入的那一段"生效；匹配不上就原样返回，
 * 宁可显示一段多余的文字，也不要静默删掉用户自己写的内容。
 */
export function stripMarkerInstruction(text: string): string {
  return text.replace(MARKER_INSTRUCTION_RE, '');
}

export function extractMarker(text: string): string | undefined {
  const found = text.match(MARKER_RE);
  return found ? found[0] : undefined;
}

/** 回答里有没有这一轮的校验码。 */
export function markerVerified(messageText: string, marker: string | undefined): boolean {
  return marker !== undefined && marker !== '' && messageText.includes(marker);
}
