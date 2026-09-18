import { useEffect, useRef, type CSSProperties } from 'react';

import { ChatPanel } from '@/components/chat/ChatPanel';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Drawer } from '@/components/layout/Drawer';
import { ShortcutHelp } from '@/components/layout/ShortcutHelp';
import { Splitter } from '@/components/layout/Splitter';
import { TopBar } from '@/components/layout/TopBar';
import { SessionList } from '@/components/left/SessionList';
import { ArtifactPanel } from '@/components/right/ArtifactPanel';
import { Toaster } from '@/components/ui/Toaster';
import { useDeepLink } from '@/hooks/useDeepLink';
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts';
import { useSelectedSession } from '@/state/session';
import { overlayStore, useHelpOpen } from '@/state/overlays';
import {
  LEFT_DEFAULT,
  LEFT_MAX,
  LEFT_MIN,
  RIGHT_DEFAULT,
  RIGHT_MAX,
  RIGHT_MIN,
  layoutStore,
  useLayout,
} from '@/state/layout';

/**
 * 外壳：顶栏 + 工作区。工作区（三栏）是 flex-1，直接占满到视口最底部——
 * 刻意没有底部状态栏：流式相位/耗时/帧数在顶栏徽章与每轮尾部已有，常驻底栏
 * 只是多占一行并堆出一句空闲时的"未在收流"。
 *
 * 工作区有两种形态，由视口宽度决定（`layoutStore` 里的 `narrow`，断点与 index.css
 * 的 `lg` 一致）：
 *  · 宽屏 —— 五列栅格：左栏 / 分隔条 / 中栏 / 分隔条 / 右栏，栏宽可拖；
 *  · 窄屏 —— 单列只放中栏，左右两栏变成浮层抽屉。
 * 窄屏保留三列是行不通的：280+360 就已经吃掉 640px，正文会被挤成一条缝，
 * 实测 511px 宽的窗口就是这样横向溢出的。
 */
export default function App() {
  const { leftCollapsed, rightCollapsed, leftWidth, rightWidth, narrow, leftDrawer, rightDrawer } = useLayout();
  const sessionId = useSelectedSession();
  const helpOpen = useHelpOpen();
  const workspace = useRef<HTMLElement>(null);

  useGlobalShortcuts();
  useDeepLink();

  /**
   * 窗口变小时把两条栏压回可用宽度，保住中栏的最小可读宽度。
   *
   * 用 ResizeObserver 而不是 window.resize：真正决定可用宽度的是这个元素的
   * content box，滚动条出现/消失、浏览器缩放都会改它而不一定触发 window.resize。
   */
  useEffect(() => {
    const el = workspace.current;
    if (!el || narrow) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) layoutStore.fitTo(box.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [narrow]);

  /**
   * 折叠只换栅格列宽，transition 也只动 grid-template-columns。
   * 动 width 会连带触发中栏整块重排，长对话下明显掉帧。
   */
  const gridStyle = {
    '--left-col': leftCollapsed ? 'var(--rail-col)' : `${leftWidth}px`,
    '--right-col': rightCollapsed ? 'var(--rail-col)' : `${rightWidth}px`,
  } as CSSProperties;

  const closeLeft = (): void => layoutStore.closeDrawer('left');
  const closeRight = (): void => layoutStore.closeDrawer('right');

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <a
        href="#chat"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[80] focus:rounded-md focus:bg-primary focus:px-3 focus:py-1.5 focus:text-sm focus:text-primary-foreground"
      >
        跳到对话区
      </a>
      <TopBar />

      {narrow ? (
        <>
          <main ref={workspace} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ErrorBoundary label="对话区" resetKeys={[sessionId]}>
              <ChatPanel />
            </ErrorBoundary>
          </main>
          <Drawer side="left" title="会话" open={leftDrawer} onClose={closeLeft}>
            <ErrorBoundary label="会话列表">
              <SessionList variant="drawer" onPick={closeLeft} />
            </ErrorBoundary>
          </Drawer>
          <Drawer side="right" title="扩展区" open={rightDrawer} onClose={closeRight}>
            <ErrorBoundary label="扩展区">
              <ArtifactPanel variant="drawer" onRequestClose={closeRight} />
            </ErrorBoundary>
          </Drawer>
        </>
      ) : (
        <main
          ref={workspace}
          style={gridStyle}
          className="grid min-h-0 flex-1 grid-cols-workspace grid-rows-[minmax(0,1fr)] overflow-x-auto overflow-y-hidden transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none"
        >
          <ErrorBoundary label="会话列表">
            <SessionList />
          </ErrorBoundary>
          <Splitter
            side="left"
            width={leftWidth}
            min={LEFT_MIN}
            max={LEFT_MAX}
            reset={LEFT_DEFAULT}
            active={!leftCollapsed}
          />
          <ErrorBoundary label="对话区" resetKeys={[sessionId]}>
            <ChatPanel />
          </ErrorBoundary>
          <Splitter
            side="right"
            width={rightWidth}
            min={RIGHT_MIN}
            max={RIGHT_MAX}
            reset={RIGHT_DEFAULT}
            active={!rightCollapsed}
          />
          <ErrorBoundary label="扩展区">
            <ArtifactPanel />
          </ErrorBoundary>
        </main>
      )}

      <Toaster />
      <ShortcutHelp open={helpOpen} onClose={() => overlayStore.setHelp(false)} />
    </div>
  );
}
