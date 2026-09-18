import { Loader2, RefreshCw } from 'lucide-react';
import { transportError } from '@das/shared';

import { ErrorBanner } from '@/components/chat/ErrorBanner';
import { NeedSession } from '@/components/right/NeedSession';
import { PanelLoading } from '@/components/right/PanelLoading';
import { Button } from '@/components/ui/button';
import { ApiRequestError } from '@/api/client';
import { USAGE_REFRESH_MS, useUsage } from '@/hooks/useUsage';
import { formatClock, formatCompact, formatCount, formatDuration } from '@/lib/format';
import { cachedPct, usageSegments } from '@/lib/usageBars';
import { cn } from '@/lib/utils';
import { useSelectedSession } from '@/state/session';

/**
 * 用量 tab：GetAgentSessionTokenUsage 的结果 + 一张堆叠条。
 *
 * 条形图的分段规则见 `lib/usageBars.ts`：cached 不进堆叠（它与 prompt 重叠），
 * 三项之和与 total 对不上的差额画成「未归类」。这两条都是为了让图不撒谎——
 * 上游从没承诺过这几个字段之间有什么加减关系。
 */
const SEGMENT_COLORS: Record<string, string> = {
  prompt: 'bg-primary',
  completion: 'bg-info',
  thoughts: 'bg-warning',
  unaccounted: 'bg-muted-foreground/40',
};

export function UsageTab() {
  const sessionId = useSelectedSession();
  const usage = useUsage(sessionId);

  if (sessionId === undefined) {
    return <NeedSession />;
  }

  if (usage.isPending) {
    return <PanelLoading api="GetAgentSessionTokenUsage" rows={3} />;
  }

  const data = usage.data;
  /**
   * 出错分两种：首次就没拿到（没有读数可留，只能给横幅），
   * 和后台轮询失败（手上还有上一次成功的读数——这时候把数字抹掉是净损失，
   * 用户会以为"用量归零了"，所以留着读数、只在上面加一条错误说明）。
   */
  if (data === undefined) {
    return (
      <ErrorBanner
        error={usage.error instanceof ApiRequestError ? usage.error.error : transportError(String(usage.error))}
      />
    );
  }

  const segments = usageSegments(data);
  const cached = cachedPct(data);

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] text-muted-foreground">累计 tokens（会话级，不是单轮）</p>
          {/**
            * hero 用 `tabular-nums`：这个数字每 30s 会变一次，比例字宽下每变一次
            * 整行宽度就跳一下，旁边的刷新按钮会跟着左右晃。
            */}
          <p className="font-mono text-[28px] font-bold leading-none tabular-nums">
            {formatCompact(data.totalTokens)}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 gap-1 px-2 text-[11px]"
          disabled={usage.isFetching}
          title={`重新调用一次 GetAgentSessionTokenUsage（平时每 ${USAGE_REFRESH_MS / 1000}s 自动刷新，标签页在后台时暂停）`}
          onClick={() => void usage.refetch()}
        >
          {usage.isFetching ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          刷新
        </Button>
      </div>

      {usage.isError && (
        <ErrorBanner
          error={usage.error instanceof ApiRequestError ? usage.error.error : transportError(String(usage.error))}
        />
      )}
      {usage.isError && (
        <p className="text-[10px] text-muted-foreground">下面是上一次成功取到的读数，不是当前值。</p>
      )}

      {segments.length > 0 && (
        <div>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={barLabel(segments)}>
            {segments.map((segment) => (
              <div
                key={segment.key}
                className={cn('h-full', SEGMENT_COLORS[segment.key])}
                style={{ width: `${segment.pct}%` }}
              />
            ))}
          </div>
          <ul className="mt-2 space-y-1">
            {segments.map((segment) => (
              <li key={segment.key} className="flex items-center gap-2 font-mono text-[11px]">
                <span className={cn('size-2 shrink-0 rounded-full', SEGMENT_COLORS[segment.key])} />
                <span className="w-20 shrink-0 text-muted-foreground">{segment.label}</span>
                <span className="ml-auto">{formatCount(segment.tokens)}</span>
                <span className="w-12 text-right text-muted-foreground">{segment.pct.toFixed(1)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="space-y-1 border-t border-border pt-2 font-mono text-[11px]">
        <Row label="cached" value={formatCount(data.cachedTokens)} hint={cached === undefined ? undefined : `占总量 ${cached.toFixed(1)}%`} />
        <Row label="total" value={formatCount(data.totalTokens)} emphasis />
      </dl>

      <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
        读数取自 {formatClock(usage.dataUpdatedAt)} · 每 {USAGE_REFRESH_MS / 1000}s 自动刷新（标签页在后台时暂停）
        <br />
        耗时 {formatDuration(data.elapsedMs)}
        {data.requestId ? ` · requestId=${data.requestId}` : ''}
      </p>
    </div>
  );
}

function barLabel(segments: ReturnType<typeof usageSegments>): string {
  return `Token 构成：${segments.map((s) => `${s.label} ${s.pct.toFixed(1)}%`).join('，')}`;
}

function Row({ label, value, emphasis, hint }: { label: string; value: string; emphasis?: boolean; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('flex items-baseline gap-2', emphasis && 'font-semibold')}>
        {hint ? <span className="text-[10px] font-normal text-muted-foreground">{hint}</span> : null}
        {value}
      </dd>
    </div>
  );
}
