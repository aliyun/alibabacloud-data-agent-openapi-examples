import { useSyncExternalStore } from 'react';

import { turnStore, type TurnView } from '@/state/turnStore';

/**
 * 在途轮次视图。
 *
 * 在途锁是"进程级"的：turnStore 同时只跑一轮，所以别的会话也一样发不出去。
 * UI 要区分这两种情况——本会话在跑显示"停止接收"，别的会话在跑显示"另一轮未结束"，
 * 判据是 `view.phase === 'streaming'` 配上 `view.sessionId`，不需要再包一层 hook。
 */
export function useTurnStream(): TurnView {
  return useSyncExternalStore(turnStore.subscribe, turnStore.getSnapshot, turnStore.getSnapshot);
}
