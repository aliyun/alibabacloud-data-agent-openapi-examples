import { transportError } from '@das/shared';

import { ErrorBanner } from '@/components/chat/ErrorBanner';
import { EmptyArtifactNotice } from '@/components/right/EmptyArtifactNotice';
import { NeedSession } from '@/components/right/NeedSession';
import { PanelLoading } from '@/components/right/PanelLoading';
import { ApiRequestError } from '@/api/client';
import { useArtifacts } from '@/hooks/useArtifacts';
import { formatDuration } from '@/lib/format';
import { useSelectedSession } from '@/state/session';

/**
 * Artifact tab。
 *
 * 原样返回上游结果，**不做任何兜底填充**：实测 ListAgentSessionArtifacts 恒返回空数组。
 * 万一哪天真拿到了，这里会明说"与实测结论不符，请把这个响应留下来"——
 * 那份响应比这个样板工程值钱。
 */
export function ArtifactTab() {
  const sessionId = useSelectedSession();
  const artifacts = useArtifacts(sessionId);

  if (sessionId === undefined) return <NeedSession />;

  if (artifacts.isPending) {
    return <PanelLoading api="ListAgentSessionArtifacts" rows={3} />;
  }

  if (artifacts.isError) {
    return (
      <ErrorBanner
        error={
          artifacts.error instanceof ApiRequestError ? artifacts.error.error : transportError(String(artifacts.error))
        }
      />
    );
  }

  const list = artifacts.data?.artifacts ?? [];

  if (artifacts.data && list.length === 0) {
    return (
      <>
        <EmptyArtifactNotice />
        <p className="px-3 text-center font-mono text-[10px] text-muted-foreground">
          接口确实回了：artifacts=[] · 耗时 {formatDuration(artifacts.data.elapsedMs)}
        </p>
      </>
    );
  }

  if (artifacts.data === undefined) return <NeedSession />;

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        这次居然拿到了 {list.length} 个 artifact —— 与实测结论（恒空）不符，请把这个响应留下来。
      </p>
      <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[10px] leading-relaxed">
        {JSON.stringify(list, null, 2)}
      </pre>
    </div>
  );
}
