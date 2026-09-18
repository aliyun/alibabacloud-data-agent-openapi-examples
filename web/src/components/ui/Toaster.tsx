import { X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toastStore, useToasts, type ToastTone } from '@/state/toast';

const TONE_CLASS: Record<ToastTone, string> = {
  info: 'border-border',
  warning: 'border-warning/50',
  destructive: 'border-destructive/50',
};

const TONE_TEXT: Record<ToastTone, string | undefined> = {
  info: undefined,
  warning: 'text-warning',
  destructive: 'text-destructive',
};

/**
 * 瞬时提示的渲染位置：右下角，浮在输入区之上。
 *
 * z-index 必须高于抽屉（z-50）与它的遮罩（z-40）：窄屏下抽屉是盖在正文上的，
 * 提示如果被压在遮罩底下，恰好是"抽屉里操作失败了"这一最需要看见的场景看不见。
 *
 * `aria-live` 挂在**每一条**上而不是容器上：容器常驻且为空，读屏软件对
 * 常驻容器的后续变化播报并不可靠，逐条带 live region 才会被念出来。
 * 错误用 assertive（打断当前播报），其余用 polite。
 */
export function Toaster() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-9 right-3 z-[60] flex w-[min(20rem,calc(100vw-1.5rem))] flex-col gap-1.5">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          aria-live={toast.tone === 'destructive' ? 'assertive' : 'polite'}
          className={cn(
            'pointer-events-auto flex items-start gap-2 rounded-md border bg-card px-2.5 py-2 text-xs leading-relaxed shadow-md',
            TONE_CLASS[toast.tone],
          )}
        >
          <span className={cn('min-w-0 flex-1 break-words', TONE_TEXT[toast.tone])}>{toast.text}</span>
          <button
            type="button"
            onClick={() => toastStore.dismiss(toast.id)}
            className="-mr-1 -mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="关闭这条提示"
          >
            <X className="size-3" />
            <span className="sr-only">关闭提示</span>
          </button>
        </div>
      ))}
    </div>
  );
}
