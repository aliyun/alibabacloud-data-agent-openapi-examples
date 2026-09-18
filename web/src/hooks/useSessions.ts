import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateSessionResult, SessionsResult } from '@das/shared';

import { getJson, postJson } from '@/api/client';
import { sessionStore } from '@/state/session';

export const SESSIONS_KEY = ['sessions'] as const;

/**
 * 会话列表。
 *
 * 后端已强制带上 AgentName + SessionSourceList 过滤，并且**不提供 q 参数**：
 * 上游的 SessionTitle 过滤器实测被静默忽略（传了不报错也不生效），
 * 所以标题搜索只能在前端做，做成后端参数等于给一个看着能用其实没用的输入框。
 */
export function useSessions() {
  return useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: ({ signal }) => getJson<SessionsResult>('/api/sessions', signal),
  });
}

/**
 * 新建会话。
 *
 * 成功判据只有"拿到非空 SessionId"这一条：上游建会话失败时是 HTTP 200 + 空响应体，
 * 没有任何错误码可看（实测最常见原因是账号下没有运行中的实例，或需要 ResourceGroupId 而没配）。
 * 后端把这种情况归一成 kind='create_empty_body'，前端照实显示。
 *
 * mode 默认 `default`（【LIVE 09-17】对齐 Web Shell：会触发审批的工具调用停下等人，
 * 由 InteractionCard 收集回覆）。yolo 仅用于无人值守路径。
 */
export function useCreateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { title: string; mode?: 'yolo' | 'default' }) =>
      postJson<CreateSessionResult>('/api/sessions', { title: vars.title, mode: vars.mode ?? 'default' }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
      sessionStore.select(result.sessionId);
    },
  });
}
