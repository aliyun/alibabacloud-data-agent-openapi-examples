import { Loader2, Play } from 'lucide-react';
import { transportError, type ApiError } from '@das/shared';

import { ErrorBanner } from '@/components/chat/ErrorBanner';
import { Button } from '@/components/ui/button';
import { ApiRequestError } from '@/api/client';
import { useCheck } from '@/hooks/useCheck';
import { useHealth } from '@/hooks/useHealth';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * 自检 tab：`POST /api/check` 的三步（ListAgents / CreateAgentSession / TokenUsage）。
 *
 * 刻意不自动跑：第②步在 LIVE 模式下会**真建一个会话**，写操作不能挂在渲染上。
 * 按钮文案把这个后果写在脸上，而不是先跑再解释。
 *
 * 三步串行且互不中断——后一步失败不影响前一步的结论，因为每步各定位一类配置问题
 * （网络与签名 / 开通与资源组 / 会话可用性）。所以这里给表格，不给一个总红绿灯。
 */
export function CheckTab() {
  const health = useHealth();
  const check = useCheck();
  const mock = health.data?.mock ?? false;

  const result = check.data;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 text-xs"
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
          {mock ? '运行自检' : '运行自检（会新建一个会话）'}
        </Button>
        {result ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            {result.ok ? '三步全过' : '有步骤没过'} · {formatDuration(result.elapsedMs)}
          </span>
        ) : null}
      </div>

      {check.isError && <ErrorBanner error={toError(check.error)} />}

      {result && (
        <table className="w-full text-[11px]">
          <caption className="mb-1 text-left text-[10px] text-muted-foreground">
            {result.mock ? 'MOCK：三步都打在合成样例上，过与不过都不代表真实账号可用' : '三步各自定位一类配置问题'}
          </caption>
          <thead>
            <tr className="text-left text-[10px] text-muted-foreground">
              <th scope="col" className="font-normal">步骤</th>
              <th scope="col" className="font-normal">结果</th>
              <th scope="col" className="font-normal">耗时</th>
            </tr>
          </thead>
          <tbody>
            {result.steps.map((step) => (
              <tr key={step.name} className="border-t border-border/60 align-top">
                <th scope="row" className="py-1 pr-2 text-left font-normal">
                  <span className="font-mono">{step.api}</span>
                  {/* detail 与 CLI 自检输出共用一份文案，MOCK 下能长达三四句：夹三行，原文放 title。 */}
                  <span
                    className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground line-clamp-3"
                    title={step.detail}
                  >
                    {step.detail}
                  </span>
                  {step.requestId ? (
                    <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
                      requestId={step.requestId}
                    </span>
                  ) : null}
                  {step.error ? (
                    <span className="mt-0.5 block font-mono text-[10px] text-destructive">
                      {step.error.kind} · {step.error.message}
                    </span>
                  ) : null}
                </th>
                <td className={cn('py-1 pr-2 text-center', step.ok ? 'text-ok' : 'text-destructive')}>
                  {step.ok ? '过' : '没过'}
                </td>
                <td className="py-1 text-right font-mono text-muted-foreground">{formatDuration(step.elapsedMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function toError(error: unknown): ApiError {
  return error instanceof ApiRequestError ? error.error : transportError(String(error));
}
