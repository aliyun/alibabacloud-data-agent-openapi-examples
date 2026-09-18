import { useQuery } from '@tanstack/react-query';
import type { HistoryResult } from '@das/shared';

import { getJson } from '@/api/client';

export function historyKey(sessionId: string | undefined) {
  return ['history', sessionId] as const;
}

/**
 * 拉历史（LoadAgentSession + Meta.IsReload）。
 *
 * 后端已经用 shared reducer 还原成轮次再返回，所以 rid-less 污染过滤、
 * load 自身 rid 的伪 end_turn 排除这些判据前后端同源。
 *
 * `retry: 0` 且不做窗口聚焦重取（见 main.tsx）：真实模式下 load 在会话 RUNNING 期
 * 有约一半概率阻塞到那一轮跑完（实测 178s），误触或自动重试一次界面就卡死一次。
 * 后端那条请求另有独立的 30s readTimeout，宁可快速失败也不挂死。
 */
export function useSessionHistory(sessionId: string | undefined) {
  return useQuery({
    queryKey: historyKey(sessionId),
    queryFn: ({ signal }) =>
      getJson<HistoryResult>(`/api/sessions/${encodeURIComponent(sessionId!)}/history`, signal),
    enabled: sessionId !== undefined,
    retry: 0,
  });
}
