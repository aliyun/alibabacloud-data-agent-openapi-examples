import { useEffect } from 'react';

import { isInEditable, matchShortcut } from '@/lib/shortcuts';
import { layoutStore } from '@/state/layout';
import { overlayStore } from '@/state/overlays';

/** 会话过滤框的 DOM id。`/` 快捷键靠它定位——见下面 focusFilter 那条分支。 */
export const SESSION_FILTER_ID = 'das-session-filter';

/**
 * 全局快捷键。判据表在 `lib/shortcuts.ts`（纯函数，逐条钉住），这里只负责接到 window 上。
 *
 * 监听器只在挂载时绑一次，所以当前布局状态一律用 `layoutStore.getSnapshot()` 现取：
 * 把 `narrow` 写进依赖数组会让监听器在每次跨过断点时解绑再重绑，而这中间按下的键就丢了。
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = matchShortcut(event, isInEditable(event.target));
      if (action === undefined) return;
      event.preventDefault();
      const layout = layoutStore.getSnapshot();

      switch (action) {
        case 'toggleLeft':
          // 宽屏收栅格列，窄屏开合抽屉：同一个键在两种形态下指的是同一件事（"把会话栏调出来/收回去"）。
          if (layout.narrow) layoutStore.toggleDrawer('left');
          else layoutStore.toggleLeft();
          return;
        case 'toggleRight':
          if (layout.narrow) layoutStore.toggleDrawer('right');
          else layoutStore.toggleRight();
          return;
        case 'focusFilter':
          revealSessionFilter();
          return;
        case 'toggleHelp':
          overlayStore.toggleHelp();
          return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/**
 * 让会话过滤框可聚焦，必要时先把装它的那一栏调出来。
 *
 * 两种形态下过滤框都可能"存在但看不见"：窄屏是抽屉用 `hidden` 类关掉（子树仍挂载），
 * 宽屏是折叠后整棵 SessionList 被换成竖条 Rail（此时输入框压根不在 DOM 里）。
 * 对 `display:none` 的节点调 focus() 静默无效，所以必须先开栏；
 * 开栏是同步改状态，但 DOM 要等 React 提交完才有，聚焦推到宏任务里。
 */
function revealSessionFilter(): void {
  const layout = layoutStore.getSnapshot();
  if (layout.narrow) {
    if (!layout.leftDrawer) {
      layoutStore.toggleDrawer('left');
      setTimeout(focusSessionFilter, 0);
      return;
    }
  } else if (layout.leftCollapsed) {
    layoutStore.toggleLeft();
    setTimeout(focusSessionFilter, 0);
    return;
  }
  focusSessionFilter();
}

function focusSessionFilter(): void {
  const el = document.getElementById(SESSION_FILTER_ID);
  if (el === null) return;
  el.focus();
  // 顺手全选：过滤通常是"换个关键词"，不是"在上一个关键词后面接着打"。
  if (el instanceof HTMLInputElement) el.select();
}
