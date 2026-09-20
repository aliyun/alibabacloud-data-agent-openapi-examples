import { CONCURRENT_REJECTED_TEXT, apiError, type ApiError } from '@das/shared';

/**
 * 进程级"单轮在途"锁。
 *
 * 为什么放在后端而不是前端：同一个会话同时只能跑一轮，第二次请求会被服务端直接拒绝
 * （`session_concurrent_operation_in_progress`）。前端的软锁只能挡住同一个标签页，
 * 而用户开两个标签页指向同一个后端是很常见的；把锁放在持有连接的那一层，
 * 跨标签页也生效，而且能在**碰到上游之前**就返回——prompt 是写操作，
 * 一旦送出去就收不回来，所以任何能提前拦下的重复请求都值得提前拦。
 *
 * 注意这不是分布式锁：多进程部署时每个进程各有一份。样板工程只跑一个后端进程，
 * 真要横向扩容得换成 Redis 之类的共享存储，那时"锁在谁手里"这件事要重新设计。
 */
export interface InflightEntry {
  sessionId: string;
  startedAt: number;
  /** 上游给的 rid，第一帧到达才知道；认出即回填（不是等流结束），见 routes/prompt.ts 的 onRid。 */
  rid: string | undefined;
}

export type AcquireResult =
  | { ok: true; entry: InflightEntry; release: () => void }
  | { ok: false; error: ApiError; heldBy: InflightEntry };

const inflight = new Map<string, InflightEntry>();

export function tryAcquire(sessionId: string): AcquireResult {
  const existing = inflight.get(sessionId);
  if (existing) {
    const heldForMs = Date.now() - existing.startedAt;
    return {
      ok: false,
      heldBy: existing,
      /**
       * message 里刻意带上上游那个特征串：这样即便这条错误是本地锁产生的，
       * 它经过 `classifyError` 也会得到与上游真实拒绝**完全相同**的 kind，
       * 前端不需要区分"谁拒绝的"。
       */
      error: apiError(
        'concurrent_rejected',
        `${CONCURRENT_REJECTED_TEXT}, session_id=${sessionId}（本地在途锁拦截，未发往上游；` +
          `上一轮已进行 ${Math.round(heldForMs / 1000)}s）`,
      ),
    };
  }

  const entry: InflightEntry = { sessionId, startedAt: Date.now(), rid: undefined };
  inflight.set(sessionId, entry);

  let released = false;
  return {
    ok: true,
    entry,
    release: () => {
      // 幂等：streamWire 的 finally 与路由的 finally 都可能走到这里。
      if (released) return;
      released = true;
      if (inflight.get(sessionId) === entry) inflight.delete(sessionId);
    },
  };
}
