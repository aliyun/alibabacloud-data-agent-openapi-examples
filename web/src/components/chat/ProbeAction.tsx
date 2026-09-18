import { History, Radar } from 'lucide-react';
import { PROBE_DEADLINE_MS, PROBE_INTERVAL_MS } from '@das/shared';

import { Button } from '@/components/ui/button';
import { useProbe } from '@/hooks/useProbe';
import { formatDuration } from '@/lib/format';

export interface ProbeActionProps {
  sessionId: string;
  /** 断流那一轮的 rid。没有 rid 就无从探测——那是这一轮唯一的标识。 */
  rid: string | undefined;
  /** 断流那一刻的 TotalTokens，判据 B 的基线。 */
  baselineTokens: number | undefined;
  /** 探测时限的起算点：断流被观测到的时刻，不是本轮开始时刻。 */
  deadlineSince: number | undefined;
  /** 「拉取历史接管结果」：refetch 历史并清掉在途视图。 */
  onTakeover: () => void;
}

/**
 * 断流之后唯一安全的两个动作：探测、拉历史。
 *
 * 这里**没有「重发」**，而且是刻意的：断流只关掉了回复通道，任务很可能还在服务端跑
 * （实测 SSE 连接在 218~258s 之间被掐，而那一轮 191s 的任务照跑不误）。重发等于把
 * 同一个写操作执行两遍——建表、插数、发布，第二遍要么失败要么造成重复写入。
 */
export function ProbeAction({ sessionId, rid, baselineTokens, deadlineSince, onTakeover }: ProbeActionProps) {
  const { state, probe, canProbe, cooldownMs, expired } = useProbe({
    sessionId,
    rid,
    baselineTokens,
    deadlineSince,
    active: rid !== undefined,
  });

  const title = expired
    ? `已超过 ${formatDuration(PROBE_DEADLINE_MS)} 探测时限`
    : rid === undefined
      ? '这一轮没有 rid（第一帧都没到），无从探测'
      : cooldownMs > 0
        ? `${Math.ceil(cooldownMs / 1000)}s 后可以再探一次`
        : '探测会触发一次完整 load；RUNNING 期这一步可能很慢，所以限频';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          disabled={!canProbe}
          title={title}
          onClick={probe}
        >
          <Radar className="size-3.5" />
          {state.verdict === 'probing' ? '探测中…' : '探测是否已完成'}
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={onTakeover}>
          <History className="size-3.5" />
          拉取历史接管结果
        </Button>
        {cooldownMs > 0 && !expired && (
          <span className="text-[11px] opacity-80">
            限频 {formatDuration(PROBE_INTERVAL_MS)}：每次探测都要完整 load 一遍会话
          </span>
        )}
      </div>

      <Verdict verdict={state.verdict} frames={state.result?.framesForRid} tokens={state.result?.totalTokens} baseline={baselineTokens} />

      {state.error && (
        <p className="text-[11px] leading-relaxed opacity-80">
          探测本身失败了：{state.error.message}（这不改变"任务可能仍在服务端执行"这个判断）
        </p>
      )}

      <p className="text-[11px] leading-relaxed opacity-80">
        这里不会自动重发。断流只关掉了回复通道，重发会把同一个写操作执行两遍。
      </p>
    </div>
  );
}

function Verdict({
  verdict,
  frames,
  tokens,
  baseline,
}: {
  verdict: ReturnType<typeof useProbe>['state']['verdict'];
  frames: number | undefined;
  tokens: number | undefined;
  baseline: number | undefined;
}) {
  if (verdict === 'idle' || verdict === 'probing') return null;

  const text: Record<Exclude<typeof verdict, 'idle' | 'probing'>, string> = {
    done: `判定：这一轮已经完成——该 rid 名下有 ${frames ?? '—'} 帧（> 2 说明产物已经落库）。拉一次历史即可接管结果。`,
    likely_done: `判定：很可能已完成，请拉历史确认。依据只有 TotalTokens ${baseline ?? '—'} → ${tokens ?? '—'} 的跳变；这个判据只验证过 1 次，零 token 的轮次可能压根不跳变，所以不能把话说满。`,
    undetermined: `还判不出来：该 rid 名下只有 ${frames ?? '—'} 帧，TotalTokens 也没有跳变（当前 ${tokens ?? '—'}）。可以过一分钟再探一次，或者直接拉历史看。`,
    deadline: `无法判定是否完成：已超过 ${formatDuration(PROBE_DEADLINE_MS)} 的探测时限。只能拉历史看服务端最终留下了什么。`,
  };

  return <p className="text-[11px] leading-relaxed opacity-90">{text[verdict]}</p>;
}
