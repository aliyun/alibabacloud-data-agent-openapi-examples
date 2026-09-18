import { transportError } from '@das/shared';

import { ErrorBanner } from '@/components/chat/ErrorBanner';
import { NeedSession } from '@/components/right/NeedSession';
import { PanelLoading } from '@/components/right/PanelLoading';
import { ApiRequestError } from '@/api/client';
import { useNow } from '@/hooks/useNow';
import { useSessions } from '@/hooks/useSessions';
import { formatRelative, formatTime } from '@/lib/format';
import { useSessionMeta } from '@/state/sessionMeta';
import { useSelectedSession } from '@/state/session';

const CLOCK_TICK_MS = 30_000;

/**
 * 会话元信息 tab。
 *
 * 这里刻意把 `updatedAt` 与 `status` 连同一句"不能当运行态用"一起摆出来：
 * 实测 29/29 个会话的 SessionUpdatedAt 恒等于 SessionCreatedAt，SessionStatus 恒为 RELEASED。
 * 只给字段不给这句话，使用者会把它们读成"最后活动时间"和"已释放/空闲"，然后据此做判断。
 */
export function SessionTab() {
  const sessionId = useSelectedSession();
  const sessions = useSessions();
  const meta = useSessionMeta();
  const now = useNow(CLOCK_TICK_MS);

  if (sessionId === undefined) return <NeedSession />;

  /**
   * 拉取中必须是骨架而不是一屏「—」：这个 tab 的字段大多来自会话列表，
   * 列表没到时每个字段都是「—」，读起来是"这个会话没有数据"，
   * 而真相是"还没问到"——这两件事对用户的下一步动作完全不同。
   */
  if (sessions.isPending) return <PanelLoading api="ListAgentSessions" rows={6} />;

  const summary = sessions.data?.sessions.find((s) => s.sessionId === sessionId);
  const local = meta[sessionId];

  return (
    <div className="space-y-3">
      {sessions.isError && (
        <>
          <ErrorBanner
            error={
              sessions.error instanceof ApiRequestError
                ? sessions.error.error
                : transportError(String(sessions.error))
            }
          />
          {sessions.data !== undefined && (
            <p className="text-[10px] text-muted-foreground">下面是上一次成功取到的读数，不是当前值。</p>
          )}
        </>
      )}
      {/* 标签的规则：上游返回的字段用上游 JSON 里的原键名，我们自己造的用中文。 */}
      <dl className="space-y-1.5 text-[11px]">
        <Field label="SessionId" value={sessionId} mono />
        <Field label="SessionTitle" value={summary?.title ?? '（列表里还没有这条）'} />
        {local?.alias ? <Field label="本地别名" value={local.alias} /> : null}
        <Field
          label="SessionCreatedAt"
          value={summary === undefined ? '—' : `${formatTime(summary.createdAt)} · ${formatRelative(summary.createdAt, now)}`}
        />
        <Field
          label="SessionUpdatedAt"
          value={summary === undefined ? '—' : formatTime(summary.updatedAt)}
          note="上游恒等于创建时间，不能当最后活动时间用"
        />
        <Field label="SessionStatus" value={summary?.status ?? '—'} mono note="上游恒为 RELEASED，不代表运行态" />
        <Field label="SessionSource" value={summary?.source ?? '—'} mono />
        <Field
          label="SessionTagList"
          value={summary === undefined || summary.tags.length === 0 ? '—' : summary.tags.join(' ')}
          mono
        />
        {summary?.mockScenario ? <Field label="MOCK 场景" value={summary.mockScenario} /> : null}
      </dl>

      <div className="border-t border-border pt-2">
        <p className="text-[10px] text-muted-foreground">本地标记（只存在这台浏览器里，上游没有对应接口）</p>
        <p className="mt-1 text-[11px]">
          {local === undefined || (!local.pinned && !local.archived && !local.hidden)
            ? '无'
            : [local.pinned ? '置顶' : null, local.archived ? '归档' : null, local.hidden ? '隐藏' : null]
                .filter((x) => x !== null)
                .join(' · ')}
        </p>
      </div>
    </div>
  );
}

function Field({ label, value, note, mono }: { label: string; value: string; note?: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className={mono ? 'break-all font-mono' : 'break-words'}>{value}</dd>
      {note ? <p className="text-[10px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}
