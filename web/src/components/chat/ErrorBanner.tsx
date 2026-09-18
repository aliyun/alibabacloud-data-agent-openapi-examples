import type { ReactNode } from 'react';
import type { ApiError, ErrorTone } from '@das/shared';
import { copyFor } from '@das/shared';

import { cn } from '@/lib/utils';

/**
 * 色相只落在**边框、底色与标题**上，正文默认 text-foreground。
 *
 * 正文是 11~12px 的排查凭据（kind / code / message），给它上彩色的话，
 * 暗色下 `text-warning` 这类中明度色在深底上的对比度不够，反而更难读。
 * muted 那档是例外：并发被拒本来就不该抢注意力，整条一起压灰。
 */
const TONE_CLASS: Record<ErrorTone, { box: string; title: string; body: string }> = {
  /**
   * 断流用琥珀色而不是红色：断流只关掉回复通道，任务很可能还在服务端跑，
   * 红色会被读成"任务失败了"，用户接着就会去重发——而重发等于把写操作执行两遍。
   */
  amber: { box: 'border-warning/40 bg-warning/10', title: 'text-warning', body: 'text-foreground' },
  red: { box: 'border-destructive/40 bg-destructive/10', title: 'text-destructive', body: 'text-foreground' },
  muted: { box: 'border-border bg-muted/40', title: 'text-muted-foreground', body: 'text-muted-foreground' },
};

export interface ErrorBannerProps {
  error: ApiError;
  /** 这个处境下用户实际能做的动作。刻意不给"重试"。 */
  actions?: ReactNode;
}

/**
 * 错误横幅：文案由 shared 的 `copyFor(kind)` 一处定义，前后端同源。
 *
 * 除了人话之外还把 code / errorCode / message 原样列出来：这三样是拿去对照
 * 排查文档的凭据。注意 -32603 在实测里对应三种完全不同的处境
 * （断流 / 会话幽灵化 / 并发被拒，且幽灵化与断流的 errorCode 也一模一样），
 * 只有 message 文本能分开——所以 message 必须给用户看见，不能只给一个码。
 */
export function ErrorBanner({ error, actions }: ErrorBannerProps) {
  const copy = copyFor(error.kind);
  const tone = TONE_CLASS[copy.tone];

  return (
    /**
     * 读屏播报层级跟着色调走：red / amber 是要立刻听见的（`alert` 会打断当前朗读），
     * muted 那档是"并发被拒"这类不该抢注意力的处境，降级成 `status`（等空闲时播报）。
     * 一处改，五个复用点同时生效。
     */
    <div
      role={copy.tone === 'muted' ? 'status' : 'alert'}
      className={cn('rounded-md border px-3 py-2.5 text-xs leading-relaxed', tone.box, tone.body)}
    >
      <p className={cn('text-sm font-semibold', tone.title)}>{copy.title}</p>
      <p className="mt-1">{copy.detail}</p>

      <dl className="mt-2 space-y-0.5 font-mono text-[11px] opacity-80">
        <div className="flex gap-2">
          <dt className="shrink-0">kind</dt>
          <dd className="break-all">{error.kind}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0">code</dt>
          <dd className="break-all">{error.code ?? '—'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0">errorCode</dt>
          <dd className="break-all">{error.errorCode ?? '（这一帧没有 errorCode 字段）'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0">message</dt>
          <dd className="break-all">{error.message}</dd>
        </div>
      </dl>

      {actions && <div className="mt-2.5 flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
