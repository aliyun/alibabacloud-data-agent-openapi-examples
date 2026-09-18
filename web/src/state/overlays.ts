import { useSyncExternalStore } from 'react';

/**
 * 浮层开合状态。目前只有快捷键帮助一个浮层。
 *
 * 做成 store 而不是 App 里的 useState：触发它的地方有两个（全局 `?` 键、顶栏的
 * 键盘按钮），一个在 hook 里一个在 TopBar 里，用 props 串起来要穿过 App 两层，
 * 而这个状态跟"渲染哪棵树"无关，纯粹是开/关。
 *
 * 不持久化：帮助浮层不该在刷新后自己弹出来。
 */
let helpOpen = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export const overlayStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): boolean {
    return helpOpen;
  },
  setHelp(open: boolean): void {
    if (open === helpOpen) return;
    helpOpen = open;
    notify();
  },
  toggleHelp(): void {
    overlayStore.setHelp(!helpOpen);
  },
};

export function useHelpOpen(): boolean {
  return useSyncExternalStore(overlayStore.subscribe, overlayStore.getSnapshot, overlayStore.getSnapshot);
}
