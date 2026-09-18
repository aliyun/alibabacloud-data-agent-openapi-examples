import { transportError } from '@das/shared';

import { ErrorBanner } from '@/components/chat/ErrorBanner';
import { NeedSession } from '@/components/right/NeedSession';
import { PanelLoading } from '@/components/right/PanelLoading';
import { ApiRequestError } from '@/api/client';
import { useSessionHistory } from '@/hooks/useSessionHistory';
import { formatClock, formatDuration } from '@/lib/format';
import { useSelectedSession } from '@/state/session';

/**
 * 对账 tab：把 LoadAgentSession 的原始帧数与聚合出来的轮次摆在一起。
 *
 * 存在理由是这一条实测事实：RUNNING 期录的那份历史里 977 帧有 900 帧没有 RequestId 键，
 * 是同一轮内容的第二份拷贝，不过滤就会把每轮显示两遍。所以"轮次对不对"不能靠肉眼数气泡，
 * 得看得见被丢掉了多少帧、哪些 rid 没构成轮次。
 *
 * 数据与中栏共用同一次 load（同一个 react-query key），开这个 tab 不会多打一次上游——
 * 真实模式下 load 在会话 RUNNING 期有约一半概率阻塞到 178s，多打一次是实打实的代价。
 */
export function ReconcileTab() {
  const sessionId = useSelectedSession();
  const history = useSessionHistory(sessionId);

  if (sessionId === undefined) return <NeedSession />;

  if (history.isPending) {
    return (
      <PanelLoading
        api="LoadAgentSession"
        note="会话仍在运行时这一步实测可能长等（录到过 178s）"
        rows={5}
      />
    );
  }

  if (history.isError) {
    return (
      <ErrorBanner
        error={history.error instanceof ApiRequestError ? history.error.error : transportError(String(history.error))}
      />
    );
  }

  const data = history.data;
  if (data === undefined) return <NeedSession />;

  const turns = data.turns;
  const accounted = turns.reduce((acc, turn) => acc + turn.frameCount, 0);
  /**
   * 有 rid、但那个 rid 没构成轮次的帧数。上游只给了这些 rid 的**个数**
   * （`nonTurnRids`），帧数得用减法拿：原始帧 − 成轮次的帧 − 无 rid 的帧。
   * 补上它四项才正好加回原始帧数，否则界面自己就对不平。
   */
  const orphanFrames = data.totalFrames - accounted - data.droppedRidLess;

  return (
    <div className="space-y-3">
      <table className="w-full font-mono text-[11px]">
        <caption className="mb-1 text-left text-[10px] text-muted-foreground">
          load 回放的帧去哪了（耗时 {formatDuration(data.elapsedMs)}）
        </caption>
        <tbody>
          <Row label="原始帧" value={String(data.totalFrames)} />
          <Row label="成轮次的帧" value={String(accounted)} />
          <Row label="丢弃：无 rid" value={String(data.droppedRidLess)} />
          <Row
            label="有 rid 但没成轮次的帧"
            value={String(orphanFrames)}
            hint={data.nonTurnRids.length > 0 ? data.nonTurnRids.map((rid) => rid.slice(0, 8)).join(' ') : undefined}
          />
          <Row label="轮次" value={String(turns.length)} />
        </tbody>
      </table>

      {turns.length > 0 && (
        <table className="w-full text-[11px]">
          <caption className="mb-1 text-left text-[10px] text-muted-foreground">逐轮</caption>
          <thead>
            <tr className="text-left text-[10px] text-muted-foreground">
              <th scope="col" className="font-normal">rid</th>
              <th scope="col" className="font-normal">帧</th>
              <th scope="col" className="font-normal">收尾</th>
              <th scope="col" className="font-normal">起</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {turns.map((turn) => (
              <tr key={turn.rid ?? 'no-rid'} className="border-t border-border/60">
                <td className="py-0.5 pr-2">{turn.rid === undefined ? '—' : turn.rid.slice(0, 8)}</td>
                <td className="py-0.5 pr-2 text-right">{turn.frameCount}</td>
                <td className="py-0.5 pr-2">{turn.stopReason ?? '—'}</td>
                <td className="py-0.5 text-right text-muted-foreground">{formatClock(turn.firstTimestamp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <tr className="border-t border-border/60 first:border-t-0">
      <th scope="row" className="py-0.5 pr-2 text-left font-normal text-muted-foreground">
        {label}
      </th>
      <td className="py-0.5 text-right">{value}</td>
      <td className="py-0.5 pl-2 text-[10px] text-muted-foreground">{hint ?? ''}</td>
    </tr>
  );
}
