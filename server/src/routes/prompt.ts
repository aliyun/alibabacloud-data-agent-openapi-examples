import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';

import { apiError, generateMarker, withMarker, type AcpFrame } from '@das/shared';

import type { AppConfig } from '../config.js';
import { tryAcquire } from '../inflight.js';
import { livePromptFrames, type LiveContext } from '../live.js';
import { findScenario, readFixtureFrames } from '../mock/fixtures.js';
import { replayFrames } from '../mock/replay.js';
import { streamWire } from '../ndjson.js';
import { toWireEvents } from '../pipeline.js';
import type { SdkClient } from '../sdk.js';

interface PromptBody {
  text?: unknown;
}

/**
 * `POST /api/sessions/:id/prompt` → `application/x-ndjson`。
 *
 * 这是全工程唯一一条流式路由，也是唯一一处"写操作"：prompt 一旦送出去，服务端那一轮
 * 就开始跑了，断开连接不会停掉它，也没有可用的应答/取消接口。所以下面每一处提前返回
 * 都刻意安排在"还没碰到上游"之前；hijack 之后就只剩一条路：把流写完或如实报错。
 *
 * 顺序因此是硬的：**校验参数 → 拿在途锁 → hijack → 调上游**。
 * 把锁放在 hijack 之前，被拒的那一方还能拿到一个普通 JSON 响应；
 * 反过来就得在已经发出去的流里塞一条错误，前端要处理两种形状。
 */
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
     * marker 在服务端生成并注入到 prompt 末尾。
     *
     * 为什么不在前端注入：注入内容与真正发出去的东西之间不该隔一层网络，
     * 否则出问题时无法证明发出去的是哪一版；而且左栏要展示 SessionTitle
     * （= 首条 prompt 原文），剥离逻辑必须与注入逻辑同源。
     */
    const marker = generateMarker();
    const outbound = withMarker(text, marker);

    /**
     * 拿到帧源之后共用的那一段：上锁、hijack、把流写完、解锁。
     *
     * mock 与 live 走的是**同一个函数**，这是"mock 下验收通过"能推广到真实链路的前提。
     */
    async function pump(frames: AsyncIterable<AcpFrame>, popRequestIds: string[]): Promise<FastifyReply> {
      const acquired = tryAcquire(sessionId, marker);
      if (!acquired.ok) {
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
          { sessionId, mock: !live, marker, promptChars: outbound.length },
          !live
            ? '回放合成样例（MOCK 下回答里不含本轮校验码，所以 UI 会如实显示"归属未校验"）'
            : '发起真实 prompt（写操作：一旦送出，断开连接也不会停掉服务端那一轮）',
        );

        const outcome = await streamWire(
          reply,
          toWireEvents({
            frames,
            marker,
            sessionId,
            mock: !live,
            startedAt: Date.now(),
            apiName: 'PromptAgentSession',
            popRequestIds,
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
              acquired.entry.rid = rid;
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
        acquired.release();
      }

      // hijack 之后响应由 streamWire 自己收尾，这里不能再 send
      return reply;
    }

    if (live) {
      /**
       * 注意这里只是**构造**了异步生成器，函数体要到第一次 `next()` 才执行，
       * 所以在途锁之前调用它并不会碰到上游。
       *
       * popRequestIds 是同一个数组引用：生成器在迭代过程中往里填 POP 回执的 RequestId，
       * 管道收尾分类（零帧 ⇒ prompt_not_dispatched）时再读出来带进错误 message。
       */
      const popRequestIds: string[] = [];
      return pump(livePromptFrames(live, sessionId, outbound, popRequestIds), popRequestIds);
    }

    const scenario = findScenario(sessionId);
    if (!scenario) {
      return reply.send({ ok: false, error: apiError('rpc_error', `MOCK 模式下没有这个会话：${sessionId}`) });
    }
    /**
     * ack-only 场景没有样例文件：`promptFixture` 为 undefined 就回放一个空帧列表，
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
