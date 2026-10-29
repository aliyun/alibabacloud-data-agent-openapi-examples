import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';

import { apiError, type AcpFrame } from '@das/shared';

import type { AppConfig } from '../config.js';
import { tryAcquire } from '../inflight.js';
import { livePromptFrames, type LiveContext } from '../live.js';
import { findScenario, readFixtureFrames } from '../mock/fixtures.js';
import { replayFrames } from '../mock/replay.js';
import { streamWire } from '../ndjson.js';
import { toWireEvents } from '../pipeline.js';
import type { SdkClient } from '../sdk.js';
import type { StreamTraceScope } from '../stream-diagnostics.js';

interface PromptBody {
  text?: unknown;
}

/** Connection-owned NDJSON: LIVE concurrency belongs to POP; only MOCK uses the local admission lock. */
export async function registerPromptRoutes(
  app: FastifyInstance,
  cfg: AppConfig,
  client: SdkClient | undefined,
): Promise<void> {
  const live: LiveContext | undefined = client ? { client, cfg, log: app.log } : undefined;

  app.post<{ Params: { id: string }; Body: PromptBody }>('/api/sessions/:id/prompt', async (request, reply) => {
    const sessionId = request.params.id;
    const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';

    if (!text) {
      return reply.send({ ok: false, error: apiError('rpc_error', 'prompt 文本为空') });
    }

    /**
     * marker 归属校验已退役（2026-09-20）：不再注入校验码，
     * prompt 原文即真正发出的东西。
     */
    const outbound = text;

    /**
     * 共用的连接内流管道；只有 MOCK 使用并释放本地准入锁。
     *
     * LIVE 不使用进程级会话锁；每个连接独立拥有 rid、恢复游标及终态。
     */
    async function pump(frames: AsyncIterable<AcpFrame>, popRequestIds: string[], trace?: StreamTraceScope): Promise<FastifyReply> {
      const acquired = live ? undefined : tryAcquire(sessionId);
      if (acquired && !acquired.ok) {
        app.log.info(
          {
            sessionId,
            heldByRid: acquired.heldBy.rid,
            heldForMs: Date.now() - acquired.heldBy.startedAt,
          },
          '在途锁拒绝：上一轮还没结束，本次请求未发往上游',
        );
        return reply.send({ ok: false, error: acquired.error });
      }

      try {
        app.log.info(
          { sessionId, mock: !live, promptChars: outbound.length },
          !live ? '回放录制件（MOCK）' : '发起真实 prompt（写操作：一旦送出，断开连接也不会停掉服务端那一轮）',
        );

        const outcome = await streamWire(
          reply,
          toWireEvents({
            frames,
            sessionId,
            mock: !live,
            startedAt: Date.now(),
            apiName: 'PromptAgentSession',
            popRequestIds,
            trace,
          }),
          {
            log: app.log as FastifyBaseLogger,
            sessionId,
            /**
             * 回填 rid 必须在流进行中，不能等流结束。
             *
             * 读它的是"第二个请求撞上在途锁"那条日志（heldByRid）：长轮能跑 190s，
             * 期间用户完全可能再点一次发送，而那时这一轮的 rid 是去历史里找它的唯一线索。
             * 等 streamWire 返回再赋值，锁条目在整个运行期都是 undefined。
             */
            onRid: (rid) => {
              if (acquired?.ok) acquired.entry.rid = rid;
            },
          },
        );

        app.log.info(
          {
            sessionId,
            rid: outcome.rid,
            framesWritten: outcome.framesWritten,
            popRequestIds,
            stopReason: outcome.stopReason,
            errorKind: outcome.error?.kind,
            endedBy: outcome.endedBy,
            elapsedMs: outcome.elapsedMs,
          },
          'prompt 流结束',
        );
      } finally {
        if (acquired?.ok) acquired.release();
      }

      // hijack 之后响应由 streamWire 自己收尾，这里不能再 send
      return reply;
    }

    if (live) {
      /**
       * 注意这里只是**构造**了异步生成器，函数体要到第一次 `next()` 才执行，
       * 因此 streamWire 可先发出并 flush 响应头，再开始上游调用。
       *
       * popRequestIds 是同一个数组引用：生成器在迭代过程中往里填 POP 回执的 RequestId，
       * 管道收尾分类（零帧 ⇒ prompt_not_dispatched）时再读出来带进错误 message。
       */
      const popRequestIds: string[] = [];
      const trace: StreamTraceScope = {};
      return pump(livePromptFrames(live, sessionId, outbound, popRequestIds, trace), popRequestIds, trace);
    }

    const scenario = findScenario(sessionId);
    if (!scenario) {
      return reply.send({ ok: false, error: apiError('rpc_error', `MOCK 模式下没有这个会话：${sessionId}`) });
    }
    /**
     * ack-only 场景没有录制件：`promptFixture` 为 undefined 就回放一个空帧列表，
     * 再把 `popAck` 交给管道 ⇒ 与 live 走**同一条**收尾分类（零帧 + 有回执 ⇒
     * `prompt_not_dispatched`）。否则这个 kind 在 mock 下永远出不来，
     * 而它恰好是真实链路上最常撞到的那种。
     */
    return pump(
      replayFrames(scenario.promptFixture ? readFixtureFrames(scenario.promptFixture) : [], {
        realtime: cfg.mockRealtime,
        speed: cfg.mockSpeed,
      }),
      scenario.popAck ? [scenario.popAck] : [],
    );
  });
}
