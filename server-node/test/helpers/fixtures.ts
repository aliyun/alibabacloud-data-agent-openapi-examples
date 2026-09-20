import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AcpFrame } from '@das/shared';
import { parseRecordedLine } from '@das/shared';

/**
 * 读一份录制件（每行 `{"data":{…帧…}}`）成帧数组。
 *
 * 走 shared 的 parseRecordedLine ⇒ 剥信封这一步与单测断言的是同一份代码，
 * 测试不会绕过它。
 */
export function loadFixture(name: string): AcpFrame[] {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  const raw = readFileSync(path, 'utf8');
  const frames: AcpFrame[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const frame = parseRecordedLine(line);
    if (!frame) throw new Error(`${name}: 有一行解析不出帧，fixture 已损坏`);
    frames.push(frame);
  }
  return frames;
}

/** 原始行数（含无法解析的行），用于"行数保真"断言。 */
export function countFixtureLines(name: string): number {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0).length;
}

export function fixtureRaw(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');
}

/** 按 rid 取一组帧，用于对单个轮次做细粒度断言。 */
export function framesOfRid(frames: AcpFrame[], rid: string): AcpFrame[] {
  return frames.filter((f) => f.RequestId === rid);
}

export const FIXTURES = {
  promptShort: 'prompt-short.jsonl',
  promptTools: 'prompt-tools.jsonl',
  promptLong: 'prompt-long.jsonl',
  loadPolluted: 'load-polluted.jsonl',
  loadClean: 'load-clean.jsonl',
  errorStreamBreak: 'error-stream-break.jsonl',
  errorSessionGhost: 'error-session-ghost.jsonl',
  errorConcurrentRejected: 'error-concurrent-rejected.jsonl',
} as const;

/**
 * fixtures 目录下的全部录制件（不含 README）。
 *
 * 脱敏守卫要扫全集：FIXTURES 只登记了流式录制件，四份 `rest-*.json` 不在其中，
 * 只遍历 FIXTURES 会给非流式录制件留一个无人看守的口子。
 */
export function allFixtureFiles(): string[] {
  const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') || f.endsWith('.json'))
    .sort();
}

/**
 * 按码点数长度，而不是 JS 默认的 UTF-16 码元数。
 *
 * 期望值来自 Python oracle，`len()` 数的是码点；真实工具结果里有 '📌' 这类
 * 增补平面字符（占 2 个码元），两边会差 1。凡是与 oracle 对账的字符串长度都走这里，
 * 否则会出现"实现没错、断言恒红"的假失败。
 */
export function cpLen(text: string | undefined): number {
  return text === undefined ? 0 : [...text].length;
}
