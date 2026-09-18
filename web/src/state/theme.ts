import { useSyncExternalStore } from 'react';

/**
 * 亮 / 暗主题。
 *
 * 走 shadcn 的 class 策略（`.dark` 祖先类）而不是 `prefers-color-scheme`：
 * 媒介查询没法被用户覆盖，而样板工程的使用者常常要在截图/投屏时强制亮色。
 * **刻意不做 "跟随系统" 第三态**——那要同时监听 matchMedia 与用户选择，
 * 两处状态一旦不一致就说不清当前该显示什么，而收益只是省一次点击。
 */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'das.theme';

function read(): Theme {
  if (typeof localStorage === 'undefined') return 'light';
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

let current: Theme = read();
const listeners = new Set<() => void>();

/**
 * 把主题落到 `<html>` 上。
 *
 * 同时写 `color-scheme`：不写的话暗色下的原生滚动条、表单控件、`::selection`
 * 仍是亮色，界面会出现"内容暗了、滚动条还是白的"这种半截效果。
 */
function apply(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', current === 'dark');
  root.style.colorScheme = current;
}

function emit(): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, current);
    } catch {
      // 存不下就不存：主题偏好丢一次没有实质影响，不值得为它报错
    }
  }
  apply();
  for (const listener of listeners) listener();
}

apply();

/** 别的标签页改了主题时同步过来。storage 事件不会在写入方自己这里触发。 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || event.newValue === null) return;
    const next: Theme = event.newValue === 'dark' ? 'dark' : 'light';
    if (next === current) return;
    current = next;
    apply();
    for (const listener of listeners) listener();
  });
}

export const themeStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): Theme {
    return current;
  },
  toggle(): void {
    current = current === 'dark' ? 'light' : 'dark';
    emit();
  },
  set(theme: Theme): void {
    if (theme === current) return;
    current = theme;
    emit();
  },
};

export function useTheme(): Theme {
  return useSyncExternalStore(themeStore.subscribe, themeStore.getSnapshot, themeStore.getSnapshot);
}
