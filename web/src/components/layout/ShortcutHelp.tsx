import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

import { SHORTCUTS, renderKeys } from '@/lib/shortcuts';

/** 平台判定只用来决定帮助里显示 ⌘ 还是 Ctrl，不参与按键匹配（匹配时两者都接受）。 */
function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

export interface ShortcutHelpProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 快捷键帮助浮层。
 *
 * 内容直接读 `lib/shortcuts.ts` 里那张表——表是绑定的事实源，帮助只是它的投影。
 * 下面「输入框内」那几行是例外：它们是 Composer 的局部绑定，不在这张表里，
 * 所以**改 Composer 的键位时必须同步这里**（那边有对应的注释指回来）。
 * 之所以还是列出来，是因为这个浮层是界面上唯一会被读到按键说明的地方，
 * 少列一半等于没有。
 */
export function ShortcutHelp({ open, onClose }: ShortcutHelpProps) {
  const panel = useRef<HTMLDivElement>(null);
  const mac = isMac();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // 挡住冒泡：抽屉也听 Esc，帮助浮层开在抽屉之上时，一次 Esc 只该关掉最上面那层。
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div aria-hidden onClick={onClose} className="fixed inset-0 z-[65] bg-black/40" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="键盘快捷键"
        tabIndex={-1}
        className="fixed left-1/2 top-1/2 z-[70] flex max-h-[80vh] w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-background shadow-xl outline-none"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <h2 className="text-sm font-semibold">键盘快捷键</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭快捷键列表"
            title="关闭（Esc）"
            className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <ul className="space-y-1.5">
            {SHORTCUTS.map((s) => (
              <li key={s.id} className="flex items-baseline gap-3 text-xs">
                <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                  {renderKeys(s.keys, mac)}
                </kbd>
                <span className="text-muted-foreground">{s.label}</span>
              </li>
            ))}
          </ul>

          <h3 className="mt-4 border-t border-border pt-3 text-xs font-semibold">输入框内</h3>
          <ul className="mt-1.5 space-y-1.5">
            {[
              ['Enter', '发送'],
              ['Shift + Enter', '换行'],
              ['Esc', '取消服务端的这一轮（流以 cancelled 终态收场）'],
              ['↑ / ↓', '翻发过的提示词（光标在框首 / 框尾时）'],
            ].map(([keys, label]) => (
              <li key={keys} className="flex items-baseline gap-3 text-xs">
                <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                  {keys}
                </kbd>
                <span className="text-muted-foreground">{label}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
