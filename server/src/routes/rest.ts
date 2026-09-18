import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  apiError,
  countFramesForRid,
  reduceHistory,
  stripMarkerInstruction,
  type ApiResult,
  type ArtifactsResult,
  type CancelResult,
  type CheckResult,
  type CreateSessionResult,
  type HealthResult,
  type HistoryResult,
  type ProbeResult,
  type ReplyResult,
  type SessionsResult,
  type UsageResult,
} from '@das/shared';

import type { AppConfig } from '../config.js';
import {
  liveArtifacts,
  liveCancel,
  liveCreateSession,
  liveHistory,
  liveListSessions,
  liveProbe,
  liveReply,
  liveUsage,
  type LiveContext,
} from '../live.js';
import { findScenario, mockCreateSession, mockSessions, readFixtureEnvelope, readFixtureFrames, readFixtureResult } from '../mock/fixtures.js';
import { runCheck } from '../selfcheck.js';
import type { SdkClient } from '../sdk.js';

/**
 * 非流式 REST 端点。
 *
 * 一条贯穿全文件的约定：**业务错误也用 HTTP 200 承载**，响应体是
 * `{ok:false, error:{...}}`；只有传输层故障（后端连不上上游）才用 5xx。
 * 这不是风格偏好——上游 OpenAPI 本身就是这样：业务报错恒返回 HTTP 200，
 * 真正的错误藏在响应体的 `JsonRpcResponse.Error` 里。前端如果按状态码分支，
 * 会把所有业务错误当成成功。
 *
 * `client` 只在 LIVE 模式下存在。MOCK 模式**绝不**构造 Client：
 * 那样一来"以为在测真实链路、其实在看录像"这类自欺就没有任何屏障了。
 */
export async function registerRestRoutes(
  app: FastifyInstance,
  cfg: AppConfig,
  client: SdkClient | undefined,
): Promise<void> {
  const live: LiveContext | undefined = client ? { client, cfg, log: app.log } : undefined;

  app.get('/api/health', async () => {
    const result: HealthResult = {
      mock: cfg.mock,
      region: cfg.regionId,
      agent: cfg.agentName,
      sessionSource: cfg.sessionSource,
      resourceGroupIdConfigured: cfg.resourceGroupId !== undefined,
      // 只说"有没有"，不说"是什么"：health 是前端启动时第一个请求，
      // 内容会进浏览器 network 面板、日志和截图。
      credentials: cfg.accessKeyId && cfg.accessKeySecret ? 'present' : 'missing',
    };
    if (cfg.mock) {
      result.mockReplay = cfg.mockRealtime ? '真实时间间隔' : `压平 + ${cfg.mockSpeed}x 倍速`;
    }
    return { ok: true, result };
  });

  /**
   * 三步自检。与 `npm run check` 跑同一个 `runCheck`，
   * 所以命令行与 HTTP 调用方（脚本 / curl / CI）给出的是同一份判据。
   * 前端目前没有自检面板，不调这个端点。
   *
   * **用 POST 而不是 GET，是安全考量不是风格**：第②步会真实调用 `CreateAgentSession`
   * （写操作，会在账号下留下一个会话）。GET 属于 CORS 的"简单请求"，任意网页都能
   * 跨源发一次——攻击者读不到响应，但那次写操作已经发生了。POST + `application/json`
   * 会强制预检，被上面的 CORS 策略挡在门外。
   */
  app.post('/api/check', async (_request, reply) => {
    const result: CheckResult = await runCheck(cfg, client, app.log);
    // 自检的失败是"配置没配对"，属于业务事实而不是传输故障，一律 200 承载。
    return reply.send({ ok: true, result } satisfies ApiResult<CheckResult>);
  });

  /**
   * 会话列表。
   *
   * 不提供 `q` 参数：上游的 `SessionTitle` 过滤器实测被**静默忽略**（传了也不生效，
   * 返回全量），做成后端搜索等于给用户一个看起来能用其实没用的输入框。搜索一律前端做。
   */
  app.get('/api/sessions', async (_request, reply) => {
    if (live) return send(reply, await liveListSessions(live));
    return send<SessionsResult>(reply, { ok: true, result: mockSessions(cfg) });
  });

  /**
   * 建会话。
   *
   * `body.title` 是 **MOCK 专用**的：上游 `CreateAgentSession` 没有任何标题参数，
   * `SessionTitle` 是首条 prompt 的原文（实测），所以 LIVE 分支刻意忽略它——
   * 建出来的会话标题就是空的，要等第一轮 prompt 之后才有。
   * MOCK 拿它当标题只是为了让左栏列表可读，别把这个样板抄成"建会话时可以设标题"。
   *
   * `body.mode`（【LIVE 09-17】可选，默认 yolo）：`default` = 会触发审批的工具调用
   * 停下等人（人卡，配下面的 /reply）；`yolo` = 全部自动放行。前端 UI 传 default
   * 对齐 Web Shell 的行为；自检与无人值守路径保持 yolo。
   */
  app.post<{ Body: { title?: unknown; mode?: unknown } }>('/api/sessions', async (request, reply) => {
    const rawMode = typeof request.body?.mode === 'string' ? request.body.mode : undefined;
    const mode = rawMode === 'default' || rawMode === 'yolo' ? rawMode : undefined;
    if (rawMode !== undefined && mode === undefined) {
      return send<CreateSessionResult>(reply, {
        ok: false,
        error: apiError('rpc_error', `mode 只接受 'yolo' | 'default'，收到：${rawMode}`),
      });
    }
    if (live) return send(reply, await liveCreateSession(live, mode ?? 'yolo'));
    const title = typeof request.body?.title === 'string' ? request.body.title : '新建会话';
    const result: CreateSessionResult = mockCreateSession(stripMarkerInstruction(title) || title);
    return send<CreateSessionResult>(reply, { ok: true, result });
  });

  /**
   * 回覆人卡交互（ReplyAgentSession）。【LIVE 09-17】
   *
   * **用 POST 不只是风格**：回覆会真实改变服务端那一轮的执行走向（放行/拒绝/选答案），
   * GET 属于 CORS 简单请求，任意网页都能跨源打一发。
   *
   * 请求体两选一（都能只带部分字段）：
   *  · ask_user_question → `{ permissionRequestId, answers: {'0': '<选项label或自定义文本>'} }`
   *  · 工具授权 → `{ permissionRequestId, optionId: 'proceed_once'|…, outcome: 'selected' }`
   *    取消当前交互 → `{ permissionRequestId, outcome: 'cancelled' }`
   *
   * 回覆成功后**不要重发 prompt**：原 PromptAgentSession 流还在，后续帧从那里继续。
   * MOCK 分支没有可回覆的真实交互，如实拒绝。
   */
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/sessions/:id/reply', async (request, reply) => {
    const sessionId = request.params.id;
    const body = request.body ?? {};
    const permissionRequestId = typeof body.permissionRequestId === 'string' ? body.permissionRequestId.trim() : '';
    if (!permissionRequestId) {
      return send<ReplyResult>(reply, {
        ok: false,
        error: apiError('rpc_error', 'reply 需要 permissionRequestId（来自流上 _qwen/notify permission_request 帧的 data.requestId）'),
      });
    }
    const outcome = body.outcome === 'cancelled' ? 'cancelled' : 'selected';
    const optionId = typeof body.optionId === 'string' && body.optionId.trim() ? body.optionId.trim() : undefined;
    let answers: Record<string, string> | undefined;
    if (body.answers !== undefined) {
      if (typeof body.answers !== 'object' || body.answers === null || Array.isArray(body.answers)) {
        return send<ReplyResult>(reply, {
          ok: false,
          error: apiError('rpc_error', 'answers 必须是 { "0": "答案文本" } 形状的对象（索引键 → 答案）'),
        });
      }
      answers = {};
      for (const [k, v] of Object.entries(body.answers as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          return send<ReplyResult>(reply, {
            ok: false,
            error: apiError('rpc_error', `answers["${k}"] 必须是字符串`),
          });
        }
        answers[k] = v;
      }
    }
    if (outcome === 'selected' && !optionId && !answers) {
      return send<ReplyResult>(reply, {
        ok: false,
        error: apiError(
          'rpc_error',
          'outcome=selected 时必须带 optionId（工具授权）或 answers（ask_user_question）；' +
            '只回 selected 会以 proceed_once 解除阻塞但 agent 收不到答案',
        ),
      });
    }

    if (live) {
      return send(reply, await liveReply(live, sessionId, { permissionRequestId, answers, optionId, outcome }));
    }
    return send<ReplyResult>(reply, {
      ok: false,
      error: apiError('rpc_error', 'MOCK 模式回放的是录制件，没有可回覆的真实交互；人卡请切 LIVE 模式'),
    });
  });

  /**
   * 拉历史（LoadAgentSession + Meta.IsReload）。
   *
   * 返回的是**已经用 shared reducer 还原过的轮次**，不是原始帧：rid-less 污染过滤、
   * load 自身 rid 的伪 end_turn 排除，这些判据前后端必须同源，所以在后端做完再给前端。
   */
  app.get<{ Params: { id: string } }>('/api/sessions/:id/history', async (request, reply) => {
    if (live) return send(reply, await liveHistory(live, request.params.id));

    const started = Date.now();
    const scenario = findScenario(request.params.id);
    if (!scenario) {
      return send<HistoryResult>(reply, {
        ok: false,
        error: apiError('rpc_error', `MOCK 模式下没有这个会话：${request.params.id}`),
      });
    }
    const frames = scenario.historyFixture ? readFixtureFrames(scenario.historyFixture) : [];
    const reduced = reduceHistory(frames);
    const result: HistoryResult = {
      turns: reduced.turns,
      droppedRidLess: reduced.droppedRidLess,
      nonTurnRids: reduced.nonTurnRids,
      totalFrames: reduced.totalFrames,
      elapsedMs: Date.now() - started,
    };
    return send<HistoryResult>(reply, { ok: true, result });
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/usage', async (request, reply) => {
    if (live) return send(reply, await liveUsage(live, request.params.id));

    const started = Date.now();
    // MOCK 也要校验会话存在：不校验的话任意 id 都返回同一份录制数据，
    // 而 LIVE 下这个 id 会真报错——那样"MOCK 下验收通过"就推广不到真实链路。
    if (!findScenario(request.params.id)) {
      return send<UsageResult>(reply, {
        ok: false,
        error: apiError('rpc_error', `MOCK 模式下没有这个会话：${request.params.id}`),
      });
    }
    const recorded = readFixtureResult<{
      PromptTokens?: number;
      CompletionTokens?: number;
      TotalTokens?: number;
      CachedTokens?: number;
      ThoughtsTokens?: number;
    }>('rest-token-usage.json');
    const result: UsageResult = {
      promptTokens: recorded.PromptTokens,
      completionTokens: recorded.CompletionTokens,
      totalTokens: recorded.TotalTokens,
      cachedTokens: recorded.CachedTokens,
      thoughtsTokens: recorded.ThoughtsTokens,
      elapsedMs: Date.now() - started,
    };
    return send<UsageResult>(reply, { ok: true, result });
  });

  /**
   * artifacts。**原样返回空数组，不做兜底填充**：实测恒空，填假数据等于掩盖约束。
   */
  app.get<{ Params: { id: string } }>('/api/sessions/:id/artifacts', async (request, reply) => {
    if (live) return send(reply, await liveArtifacts(live, request.params.id));

    if (!findScenario(request.params.id)) {
      return send<ArtifactsResult>(reply, {
        ok: false,
        error: apiError('rpc_error', `MOCK 模式下没有这个会话：${request.params.id}`),
      });
    }
    // elapsedMs 恒为 0 是真的：MOCK 下这一路不发任何请求。
    const result: ArtifactsResult = { artifacts: [], elapsedMs: 0 };
    return send<ArtifactsResult>(reply, { ok: true, result });
  });

  /**
   * cancel。【LIVE 09-18】上游已会真取消：HTTP 200 + 流以 `stopReason=cancelled`
   * 终态收场（实测 3/3，形态细节见 shared 里 `CancelResult` 的注释）。
   * `delivered` 现在如实反映"上游是否接受（HTTP 200）"。
   *
   * MOCK 分支仍是 no-op：回放没有可取消的执行，`delivered:false` 在 MOCK 下
   * 是准确的。前端已接入这个端点（Stop 按钮 = 取消本轮）。
   */
  app.post<{ Params: { id: string } }>('/api/sessions/:id/cancel', async (request, reply) => {
    if (live) return send(reply, await liveCancel(live, request.params.id));

    const result: CancelResult = {
      delivered: false,
      warning: 'mock-replay-uncancellable',
      detail:
        'MOCK 模式回放的是录制件，没有可取消的执行——`delivered:false` 在 MOCK 下是准确的。' +
        '真实模式下 cancel 已生效（2026-09-18 实测 3/3：HTTP 200 + 流以 ' +
        "`stopReason=cancelled` 终态收场；空闲会话上是 no-op）。",
    };
    return send<CancelResult>(reply, { ok: true, result });
  });

  /**
   * 断流之后的完成探测器。
   *
   * `rid` 必填：探测的对象是"断流的那一轮"，而轮次的唯一标识就是上游给的 RequestId。
   * `tokens` 是断流时刻的 TotalTokens 基线，前端从流里的 usage_update 帧或上一次
   * /usage 拿到；不传就只用探测器 A（帧数）。
   *
   * **每次探测都会触发一次完整的 load**，而 load 在会话 RUNNING 期有 2/4 概率阻塞到
   * 那一轮跑完（实测 178s）。所以前端必须按 PROBE_INTERVAL_MS 限频，别做成 1s 轮询。
   */
  app.get<{ Params: { id: string }; Querystring: { rid?: string; tokens?: string } }>(
    '/api/sessions/:id/probe',
    async (request, reply) => {
      const rid = request.query.rid?.trim();
      if (!rid) {
        return send<ProbeResult>(reply, {
          ok: false,
          error: apiError('rpc_error', 'probe 需要 rid 参数：探测的对象是断流的那一轮，rid 是它唯一的标识'),
        });
      }
      const rawTokens = request.query.tokens?.trim();
      const baseline = rawTokens ? Number.parseFloat(rawTokens) : Number.NaN;
      const baselineTokens = Number.isFinite(baseline) ? baseline : undefined;

      if (live) return send(reply, await liveProbe(live, request.params.id, rid, baselineTokens));

      const started = Date.now();
      const scenario = findScenario(request.params.id);
      if (!scenario?.historyFixture) {
        return send<ProbeResult>(reply, {
          ok: false,
          error: apiError('rpc_error', `MOCK 模式下这个会话没有可回放的历史：${request.params.id}`),
        });
      }
      const frames = readFixtureFrames(scenario.historyFixture);
      const framesForRid = countFramesForRid(frames, rid);
      const usage = readFixtureEnvelope<{ TotalTokens?: number }>('rest-token-usage.json');
      const totalTokens = usage.result?.TotalTokens;
      const by: ProbeResult['by'] = [];
      if (framesForRid > 2) by.push('frames');
      if (baselineTokens !== undefined && totalTokens !== undefined && totalTokens > baselineTokens) by.push('tokens');
      const result: ProbeResult = {
        done: by.length > 0,
        by,
        framesForRid,
        totalTokens,
        // loadsIssued 是"向上游发起了几次 load"的成本信号（RUNNING 期 load 可能阻塞 178s）。
        // MOCK 只读本地 fixture，一次上游调用都没有，所以是 0——写成 1 会让这个数字失去意义。
        loadsIssued: 0,
        elapsedMs: Date.now() - started,
      };
      return send<ProbeResult>(reply, { ok: true, result });
    },
  );
}

/**
 * 统一的响应出口。
 *
 * 传输层故障（后端连不上上游）用 502，其余一律 200 —— 前端只按 `error.kind` 分支，
 * 状态码只用于区分"是我这边到上游的链路断了"和"上游给出了一个业务结论"。
 */
function send<T>(reply: FastifyReply, result: ApiResult<T>): FastifyReply {
  if (result.ok) return reply.send(result);
  return reply.code(result.error.kind === 'transport' ? 502 : 200).send(result);
}
