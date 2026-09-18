import { useMutation } from '@tanstack/react-query';
import type { CheckResult } from '@das/shared';

import { postJson } from '@/api/client';

/**
 * `POST /api/check` —— 三步串行自检（ListAgents / CreateAgentSession / TokenUsage）。
 *
 * 做成 mutation 而不是 query：**第②步是写操作**，LIVE 模式下会在账号下真建一个会话。
 * 挂在 query 上就会随窗口聚焦、重试、缓存失效自动跑，等于用户没点按钮也留下了会话。
 * 所以只能由用户显式点一次跑一次，结果也不进缓存共享。
 */
export function useCheck() {
  return useMutation({
    mutationFn: () => postJson<CheckResult>('/api/check', {}),
  });
}
