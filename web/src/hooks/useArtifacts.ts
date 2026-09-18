import { useQuery } from '@tanstack/react-query';
import type { ArtifactsResult } from '@das/shared';

import { getJson } from '@/api/client';

export function artifactsKey(sessionId: string | undefined) {
  return ['artifacts', sessionId] as const;
}

/**
 * ListAgentSessionArtifacts。
 *
 * `retry: 0`：这个接口实测恒返回空数组，重试只会把"确实是空的"这件事多确认几遍，
 * 顺带让用户以为是在加载。拿到空结果由 UI 渲染成明确的说明，不做任何兜底填充——
 * 用假数据把空数组填上等于掩盖这条约束，而这个工程的全部价值就在于不掩盖它。
 */
export function useArtifacts(sessionId: string | undefined) {
  return useQuery({
    queryKey: artifactsKey(sessionId),
    queryFn: ({ signal }) =>
      getJson<ArtifactsResult>(`/api/sessions/${encodeURIComponent(sessionId!)}/artifacts`, signal),
    enabled: sessionId !== undefined,
    retry: 0,
  });
}
