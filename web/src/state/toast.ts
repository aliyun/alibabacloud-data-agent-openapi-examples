import { useSyncExternalStore } from 'react';

/**
 * 瞬时提示。
 *
 * 只用于**界面上没有位置可画**的那一类消息。已经画在原地的（轮次错误横幅、
 * 工具卡片的失败态、复制按钮的「已复制/复制失败」）一律不走这里——同一条消息
 * 出现两次，用户会以为是两件不同的事。
 *
 * 目前唯一的接入点是 react-query 的后台重取失败：查询已经有数据时，
 * `isError` 是 false、ErrorBanner 不画，界面上安安静静地显示着上一次的数据，
 * 没人知道它已经过期了。
 */
export type ToastTone = 'info' | 'warning' | 'destructive';

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
}

/** 停留时长。要够读完一句话，又不能长到挡住右下角的输入区。 */
const TOAST_MS = 6_000;
/** 同时最多几条。超出就挤掉最老的那条——堆一列提示等于没有提示。 */
const MAX_TOASTS = 3;

let items: readonly Toast[] = [];
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function dismiss(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  if (!items.some((t) => t.id === id)) return;
  items = items.filter((t) => t.id !== id);
  notify();
}

export const toastStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): readonly Toast[] {
    return items;
  },
  push(text: string, tone: ToastTone = 'info'): void {
    const id = nextId++;
    timers.set(id, setTimeout(() => dismiss(id), TOAST_MS));
    items = [...items, { id, text, tone }];
    // 超额就从头部挤掉。这里不走 dismiss()：它会顺带 notify 一次，
    // 一次 push 变成两次渲染，而挤掉与新加本来就该是同一个原子变化。
    while (items.length > MAX_TOASTS) {
      const oldest = items[0];
      if (oldest === undefined) break;
      const timer = timers.get(oldest.id);
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(oldest.id);
      }
      items = items.slice(1);
    }
    notify();
  },
  dismiss,
};

export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot, toastStore.getSnapshot);
}
