import { useSyncExternalStore } from 'react';

import { readJson, writeJson } from '@/lib/persist';
import type { LocalSessionFlags } from '@/lib/sessionGroups';

/**
 * 会话的**本地**元数据：别名、置顶、归档、隐藏。
 *
 * 全部只存 localStorage，一个字节都不发给上游——OpenAPI 里没有重命名会话的接口
 * （CreateAgentSession 之后 SessionTitle 就定死了，它等于首条 prompt 原文），
 * 也没有标签/分组/删除。所以这些操作只能是本地的，界面上也不假装它们是会话属性。
 *
 * 代价要说清楚：换浏览器、换机器、清缓存，别名与分组就没了。这是上游能力决定的，
 * 不是这里偷懒——README 的「本地存了什么」一节列了全部键。
 */
export interface SessionMeta extends LocalSessionFlags {
  /** 本地起的名字，覆盖 SessionTitle 显示。 */
  alias?: string;
}

export type SessionMetaMap = Readonly<Record<string, SessionMeta>>;

const STORAGE_KEY = 'das.sessionMeta.v1';
const EMPTY: SessionMetaMap = Object.freeze({});

function isMeta(value: unknown): value is SessionMeta {
  // 数组也要挡掉：它同样"所有字段都是 undefined"，不挡就会被当成一条合法的空记录留下来。
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  return (
    (m.alias === undefined || typeof m.alias === 'string') &&
    (m.pinned === undefined || typeof m.pinned === 'boolean') &&
    (m.archived === undefined || typeof m.archived === 'boolean') &&
    (m.hidden === undefined || typeof m.hidden === 'boolean')
  );
}

/** 整张表过一遍形状校验：坏一条就丢一条，不因为一条脏数据把整个列表的本地标记清空。 */
function sanitize(raw: unknown): SessionMetaMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY;
  const out: Record<string, SessionMeta> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isMeta(value)) out[id] = value;
  }
  return Object.keys(out).length === 0 ? EMPTY : out;
}

let current: SessionMetaMap = sanitize(readJson<unknown>(STORAGE_KEY, null, (v): v is unknown => true));
const listeners = new Set<() => void>();

function commit(next: SessionMetaMap): void {
  current = next;
  writeJson(STORAGE_KEY, next);
  for (const listener of listeners) listener();
}

/**
 * 合并后只保留真正生效的字段：`false` 与 `undefined` 一律丢掉。
 *
 * 不归一化的话，"置顶再归档再取消归档"会在存储里留下 `{pinned:true,archived:false}`——
 * 行为上没错，但这份东西是要被读回来、被测试断言、也可能被用户自己打开看的，
 * 留一堆 `false` 只会让人以为它有意义。
 */
function normalize(meta: SessionMeta): SessionMeta {
  const cleaned: SessionMeta = {};
  if (meta.alias !== undefined && meta.alias !== '') cleaned.alias = meta.alias;
  if (meta.pinned === true) cleaned.pinned = true;
  if (meta.archived === true) cleaned.archived = true;
  if (meta.hidden === true) cleaned.hidden = true;
  return cleaned;
}

function patch(sessionId: string, delta: SessionMeta): void {
  if (sessionId === '') return;
  const merged = normalize({ ...(current[sessionId] ?? {}), ...delta });
  const next: Record<string, SessionMeta> = { ...current };
  // 归一化之后什么都没有 ⇒ 整条记录删掉，不在 localStorage 里留空壳。
  if (Object.keys(merged).length === 0) delete next[sessionId];
  else next[sessionId] = merged;
  commit(next);
}

export const sessionMetaStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** 引用稳定：没变化时必须是同一个对象，否则 useSyncExternalStore 会无限重渲染。 */
  getSnapshot(): SessionMetaMap {
    return current;
  },
  /** 空串等于清除别名（回落显示 SessionTitle）。 */
  setAlias(sessionId: string, alias: string): void {
    const trimmed = alias.trim();
    patch(sessionId, trimmed === '' ? { alias: undefined } : { alias: trimmed });
  },
  togglePinned(sessionId: string): void {
    patch(sessionId, { pinned: current[sessionId]?.pinned !== true });
  },
  toggleArchived(sessionId: string): void {
    patch(sessionId, { archived: current[sessionId]?.archived !== true });
  },
  setHidden(sessionId: string, hidden: boolean): void {
    patch(sessionId, { hidden });
  },
  /** 一次性把隐藏的会话放回列表，返回放回了几个（0 个时调用方不该动界面）。 */
  revealHidden(): number {
    const ids = Object.keys(current).filter((id) => current[id]?.hidden === true);
    if (ids.length === 0) return 0;
    const next: Record<string, SessionMeta> = { ...current };
    for (const id of ids) {
      const meta = normalize({ ...(next[id] ?? {}), hidden: false });
      if (Object.keys(meta).length === 0) delete next[id];
      else next[id] = meta;
    }
    commit(next);
    return ids.length;
  },
};

export function useSessionMeta(): SessionMetaMap {
  return useSyncExternalStore(sessionMetaStore.subscribe, sessionMetaStore.getSnapshot, sessionMetaStore.getSnapshot);
}
