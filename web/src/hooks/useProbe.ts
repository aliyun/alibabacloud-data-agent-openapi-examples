import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PROBE_DEADLINE_MS,
  PROBE_INTERVAL_MS,
  transportError,
  type ApiError,
  type ProbeResult,
} from '@das/shared';

import { ApiRequestError, getJson } from '@/api/client';

/** 让"冷却中/已超时"这两个随时间变化的结论能自己刷新。 */
const TICK_MS = 5_000;

/**
 * 探测结论。
 *
 * `done` 与 `likely_done` 的区分是有实测依据的，不是措辞讲究：
 * 判据 A（该 rid 的帧数 > 2）直接看到了这一轮的产物；判据 B（TotalTokens 相比断流时
 * 跳变）只说明"这个会话后来又烧了 token"，而 B 只验证过 1 次、零 token 的轮次可能
 * 压根不跳变。所以 B 只能加强 A，不能单独把话说满。
 */
export type ProbeVerdict = 'idle' | 'probing' | 'undetermined' | 'likely_done' | 'done' | 'deadline';

export interface ProbeState {
  verdict: ProbeVerdict;
  result: ProbeResult | undefined;
  error: ApiError | undefined;
  attempts: number;
  lastAt: number | undefined;
}

const IDLE: ProbeState = { verdict: 'idle', result: undefined, error: undefined, attempts: 0, lastAt: undefined };

export interface ProbeControls {
  state: ProbeState;
  probe: () => void;
  canProbe: boolean;
  /** 距离下一次可探测还有多久；0 表示不受冷却限制。 */
  cooldownMs: number;
  /** 超过 PROBE_DEADLINE_MS：不再探测，只给「拉取历史」。 */
  expired: boolean;
}

function verdictFor(result: ProbeResult): ProbeVerdict {
  if (result.by.includes('frames')) return 'done';
  if (result.by.includes('tokens')) return 'likely_done';
  return 'undetermined';
}

export function useProbe(options: {
  sessionId: string | undefined;
  rid: string | undefined;
  /** 断流那一刻的 TotalTokens，用作判据 B 的基线；没有就不传，B 自动失效。 */
  baselineTokens: number | undefined;
  /**
   * 探测时限的起算点 —— 传**断流被观测到的时刻**，不是本轮开始时刻。
   * 长轮实测 191s 才被掐断，从 startedAt 起算的话 300s 窗口只剩不到 2 分钟。
   */
  deadlineSince: number | undefined;
  /** 只有断流态才需要 ticking；其余时候不挂定时器。 */
  active: boolean;
}): ProbeControls {
  const { sessionId, rid, baselineTokens, deadlineSince, active } = options;
  const [state, setState] = useState<ProbeState>(IDLE);
  const [, tick] = useState(0);
  const inFlight = useRef(false);

  // 换了会话或换了轮次，上一轮的探测结论就不再属于这里
  useEffect(() => {
    setState(IDLE);
    inFlight.current = false;
  }, [sessionId, rid]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);

  const now = Date.now();
  const expired = deadlineSince !== undefined && now - deadlineSince > PROBE_DEADLINE_MS;
  const cooldownMs = state.lastAt === undefined ? 0 : Math.max(0, PROBE_INTERVAL_MS - (now - state.lastAt));
  const probing = state.verdict === 'probing';
  const canProbe =
    sessionId !== undefined && rid !== undefined && !probing && !expired && cooldownMs === 0;

  const probe = useCallback(() => {
    if (sessionId === undefined || rid === undefined || inFlight.current) return;
    inFlight.current = true;
    setState((prev) => ({ ...prev, verdict: 'probing', error: undefined }));

    const query = new URLSearchParams({ rid });
    // 没有基线就不传 tokens：传一个假的 0 会让 B 永远命中，把"很可能"说成"是"
    if (baselineTokens !== undefined) query.set('tokens', String(baselineTokens));

    getJson<ProbeResult>(`/api/sessions/${encodeURIComponent(sessionId)}/probe?${query.toString()}`)
      .then((result) => {
        setState((prev) => ({
          verdict: verdictFor(result),
          result,
          error: undefined,
          attempts: prev.attempts + 1,
          lastAt: Date.now(),
        }));
      })
      .catch((err: unknown) => {
        setState((prev) => ({
          // 探测失败不等于"没完成"：保留上一次的结论，只把错误摆出来
          verdict: prev.result ? verdictFor(prev.result) : 'idle',
          result: prev.result,
          error:
            err instanceof ApiRequestError
              ? err.error
              : transportError(err instanceof Error ? err.message : String(err)),
          attempts: prev.attempts + 1,
          lastAt: Date.now(),
        }));
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [sessionId, rid, baselineTokens]);

  /**
   * 超时只覆盖"还没判出来"的结论。
   *
   * 已经拿到 done / likely_done 的话，时限到了也不能把它抹成"无法判定"——
   * 那是把已经到手的证据扔掉，用户会再去拉一次历史、甚至怀疑之前的判定。
   */
  const conclusive = state.verdict === 'done' || state.verdict === 'likely_done';
  const shown = expired && !conclusive ? { ...state, verdict: 'deadline' as const } : state;

  return { state: shown, probe, canProbe, cooldownMs, expired };
}
