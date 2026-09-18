import { useQuery } from '@tanstack/react-query';
import type { HealthResult } from '@das/shared';

import { getJson } from '@/api/client';

/**
 * 后端是否在跑、跑在 MOCK 还是 LIVE。
 *
 * 顶栏要先回答"我现在看到的画面是真接口还是回放"，否则 mock 下的一切绿灯都会被误读。
 */
export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => getJson<HealthResult>('/api/health', signal),
    // 后端进程不会自己变卦，改了 .env 必然重启；重启后前端刷新页面即可
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
}
