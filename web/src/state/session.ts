import { useSyncExternalStore } from 'react';

let selected: string | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * 当前选中的会话。
 *
 * 刻意不写 localStorage：刷新后自动选中一个可能已经幽灵化（上游 422）的会话，
 * 用户第一眼看到的就是一个发不出消息的死会话，还得先弄清为什么。
 * 选一次的成本比这个困惑低。
 */
export const sessionStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): string | undefined {
    return selected;
  },
  select(sessionId: string | undefined): void {
    if (sessionId === selected) return;
    selected = sessionId;
    emit();
  },
};

export function useSelectedSession(): string | undefined {
  return useSyncExternalStore(sessionStore.subscribe, sessionStore.getSnapshot, sessionStore.getSnapshot);
}
