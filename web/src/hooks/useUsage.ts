import { useQuery } from '@tanstack/react-query';
import type { UsageResult } from '@das/shared';

import { getJson } from '@/api/client';

export function usageKey(sessionId: string | undefined) {
  return ['usage', sessionId] as const;
}

/**
 * 轮询间隔。
 *
 * 用量是**会话累计值**，只在一轮跑完之后才变，所以不需要秒级刷新；30s 的意义是
 * "开着这个 tab 等一轮跑完，数字会自己跟上"，不用用户去点刷新。
 *
 * 这个接口实测约 0.3s 返回，是右栏五个 tab 里最便宜的一个，所以轮询它而不轮询
 * LoadAgentSession（那个在会话 RUNNING 期实测能阻塞到 178s）。
 */
export const USAGE_REFRESH_MS = 30_000;

/**
 * 轮询间隔的可见性门控。
 *
 * 标签页在后台时返回 `false` 停掉轮询：一个开了一整天的页面不该白打上千次上游
 * 调用。抽成纯函数是为了能在 node 环境里直接钉住这条判据——它是"省不省上游调用"
 * 的唯一开关，改错了测试要能红。
 */
export function usageRefetchInterval(hidden: boolean): number | false {
  return hidden ? false : USAGE_REFRESH_MS;
}

/**
 * GetAgentSessionTokenUsage —— 唯一可靠的度量接口（实测约 0.3s 返回）。
 *
 * 想知道"这个会话到底烧了多少 token"只能问它：运行态问不出来（SessionStatus 恒
 * RELEASED），artifacts 恒空，而流里那个 usage 片段在断流时可能压根没送到。
 *
 * 一个反直觉的实测事实：只发一句话，PromptTokens 也可能是 5.8 万——那是 agent 的
 * system prompt，不是你的输入。所以这里展示的是会话累计值，不能读成"这一轮的量"。
 */
export function useUsage(sessionId: string | undefined) {
  return useQuery({
    queryKey: usageKey(sessionId),
    queryFn: ({ signal }) =>
      getJson<UsageResult>(`/api/sessions/${encodeURIComponent(sessionId!)}/usage`, signal),
    enabled: sessionId !== undefined,
    // 必须是函数：react-query 每次轮询都会调用它，从而在标签页切到后台的**那一刻**
    // 就停掉轮询；传预计算好的数字会把可见性判断冻结在渲染时，切后台也停不下来。
    refetchInterval: () => usageRefetchInterval(document.hidden),
  });
}
