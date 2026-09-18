import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

// 当前安装的 @types/react 里 index.d.ts 缺失 inert 声明（UA 和 Chromium 都支持），
// 这里补一份类型侧补丁；将来依赖升级后这段可删。
declare module 'react' {
  interface HTMLAttributes<T> {
    inert?: boolean;
  }
}

export interface DrawerProps {
  side: 'left' | 'right';
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

/**
 * 窄屏下侧栏的抽屉形态。
 *
 * 为什么不是"把栅格列宽改成 0"：窄屏本来就没有横向空间留给三列，
 * 抽屉浮在正文之上是唯一不牺牲正文宽度的做法。
 *
 * 关闭时用 `hidden` **类**而不是条件渲染，也不是 `hidden` **属性**：
 *  · 条件渲染会把抽屉里的会话列表整个卸载，搜索框里打的字随之丢掉；
 *  · `hidden` 属性会被同一元素上的 `flex` 工具类压过（UA 的 `[hidden]{display:none}`
 *    优先级低于 utilities 层），于是"关不掉"。
 * `flex` / `hidden` 两个类互斥地切换，既保挂载又真的不显示。
 *
 * 代价是关闭时子树仍在文档里，所以同时 `inert` 掉——不 inert 的话屏幕阅读器
 * 与 Tab 键仍能进到看不见的抽屉里。
 */
export function Drawer({ side, title, open, onClose, children }: DrawerProps) {
  const panel = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  /**
   * `inert` 必须命令式设置。
   *
   * React 18 的类型里它是 `boolean`，但渲染器会把布尔值整个丢掉——实测写成
   * `inert={!open}` 之后 DOM 上根本没有这个属性（React 19 才真正支持）。
   * 不 inert 的话，关掉的抽屉虽然 `display:none` 看不见，屏幕阅读器的虚拟光标
   * 与浏览器的查找仍可能进到里面去。
   */
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    if (open) el.removeAttribute('inert');
    else el.setAttribute('inert', '');
  }, [open]);

  useEffect(() => {
    const el = panel.current;
    if (!open) {
      /**
       * 焦点归还：不还给打开它的那个元素，键盘用户关掉抽屉后焦点会掉回 body，只能从头 Tab。
       *
       * 但**不能无条件归还**：打开另一侧抽屉时本侧会被关掉（见 layoutStore.toggleDrawer），
       * 两侧 effect 按树顺序跑——新打开那侧先聚焦自己的面板，本侧再把焦点拽回自己的 opener，
       * 结果焦点停在遮罩外面的顶栏按钮上。所以只在"焦点还在我这块面板里，或者已经掉回 body
       * （面板 display:none 时浏览器会 blur 到 body）"这两种情况下归还。
       */
      const opener = openerRef.current;
      openerRef.current = null;
      if (!(opener instanceof HTMLElement) || !opener.isConnected) return;
      const active = document.activeElement;
      const mine = el !== null && (active === el || el.contains(active));
      if (mine || active === null || active === document.body) opener.focus();
      return;
    }
    /**
     * 只在焦点还不在本面板里时才记录 opener 并把焦点移进来。
     *
     * 无条件 `focus()` 是个真缺陷：这个 effect 依赖 `onClose`，而调用方传的是内联箭头函数，
     * 身份每次渲染都变 ⇒ 抽屉开着时父组件任何一次重渲染都会重跑 effect，
     * 把焦点从抽屉里的搜索框拽回面板本身（打字打到一半光标没了），
     * 顺手还把 openerRef 覆盖成"当时的焦点"，关掉时就归还错地方了。
     */
    const active = document.activeElement;
    const alreadyInside = el !== null && (active === el || el.contains(active));
    if (!alreadyInside) {
      openerRef.current = active;
      el?.focus();
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      {/* 遮罩：点击关闭。fixed 而非 absolute，避免被 main 的 overflow 裁掉。 */}
      <div
        aria-hidden
        onClick={onClose}
        className={cn('fixed inset-0 z-40 bg-black/40', open ? 'block' : 'hidden')}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'fixed inset-y-0 z-50 w-[min(86vw,22rem)] flex-col border-border bg-background shadow-xl outline-none',
          open ? 'flex' : 'hidden',
          side === 'left' ? 'left-0 border-r' : 'right-0 border-l',
        )}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={`关闭${title}`}
            title={`关闭${title}（Esc）`}
            className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </>
  );
}
