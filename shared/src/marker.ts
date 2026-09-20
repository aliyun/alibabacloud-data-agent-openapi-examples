import { MARKER_PREFIX } from './constants.js';

/**
 * marker 归属校验已退役（2026-09-20 用户拍板）：注入/生成/流式 Scrubber/verified 判定
 * 全部移除；考核码机制（DAS-XXXXXX）不再出现在任何 prompt 上。
 *
 * 这个文件**只保留一个历史清洗助手**：`stripMarkerInstruction`，用来把
 * fixtures（真实抓包时代录制）里的「（本轮校验码 DAS-XXXXXX：…）」从
 * 历史轮次的标题/提示词中剥掉——那仍是录制内容的残留现实，不是当前轮的机制。
 */

const MARKER_INSTRUCTION_RE = new RegExp(`\\n*（本轮校验码 ${MARKER_PREFIX}-[0-9A-F]{6}：[^\\n]*）\\s*$`, 'u');

/**
 * 剥掉历史录制内容里残留的校验码说明。只对"确实是本工程曾注入的那一段"生效；
 * 匹配不上就原样返回（宁可显示多余文字，也不静默删用户内容）。
 */
export function stripMarkerInstruction(text: string): string {
  return text.replace(MARKER_INSTRUCTION_RE, '');
}
