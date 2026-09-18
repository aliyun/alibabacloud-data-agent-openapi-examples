import { readJson, writeJson } from '@/lib/persist';

/**
 * 输入框的两份本地记忆：**按会话的草稿** 与 **发过的提示词**。
 *
 * 两者都只存 localStorage。上游没有草稿概念（prompt 一旦发出就是会话历史的一部分），
 * 而"切走再切回来输入框空了"是最容易让人重打一遍长提示词的地方——这个工程里
 * 提示词往往带着一整段任务约束，重打的代价比一般聊天高得多。
 *
 * 刻意不做成 useSyncExternalStore：草稿只有输入框自己读写，箭头键翻历史也是
 * 按下那一刻才需要，读一次 localStorage（几 KB）比维护一层订阅便宜也更不容易不一致。
 * 代价是多个标签页之间不同步——两个标签页同时在同一个会话里打草稿本来就会互相覆盖，
 * 同步只会让覆盖发生得更隐蔽。
 */

const DRAFTS_KEY = 'das.drafts.v1';
const SENT_KEY = 'das.sentPrompts.v1';

/** 未选中会话时的草稿键。它不对应任何 sessionId，所以取一个上游不可能发的字面量。 */
export const NEW_SESSION_DRAFT = '__new__';

/** 提示词历史条数上限。翻历史是为了"刚才那句怎么写的"，不是存档，20 条足够。 */
export const MAX_SENT_PROMPTS = 20;

type DraftMap = Record<string, string>;

function isStringMap(value: unknown): value is DraftMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function readDrafts(): DraftMap {
  return readJson<DraftMap>(DRAFTS_KEY, {}, isStringMap);
}

export function getDraft(key: string): string {
  return readDrafts()[key] ?? '';
}

/**
 * 存草稿。空串等于删除键而不是存一个 `''`：
 * 存空串会让这张表随着用过的会话数一直长，而里面全是没内容的条目。
 */
export function setDraft(key: string, text: string): void {
  const drafts = readDrafts();
  if (text === '') {
    if (drafts[key] === undefined) return;
    delete drafts[key];
  } else {
    if (drafts[key] === text) return;
    drafts[key] = text;
  }
  writeJson(DRAFTS_KEY, drafts);
}

function readSent(): string[] {
  return readJson<string[]>(SENT_KEY, [], isStringArray);
}

/** 发过的提示词，最新在前。 */
export function sentPrompts(): string[] {
  return readSent();
}

/**
 * 记住一句发出去的提示词。
 *
 * 去重是"把旧的同名条目挪到最前"而不是"重复就不记"：连续发同一句时，
 * 它应该出现在历史的第一个位置，否则翻一次历史看到的还是更早的那条。
 */
export function rememberPrompt(text: string): void {
  const trimmed = text.trim();
  if (trimmed === '') return;
  const next = [trimmed, ...readSent().filter((item) => item !== trimmed)].slice(0, MAX_SENT_PROMPTS);
  writeJson(SENT_KEY, next);
}
