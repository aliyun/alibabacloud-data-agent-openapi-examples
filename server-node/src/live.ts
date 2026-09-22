import {
  CancelAgentSessionRequest,
  CancelAgentSessionRequestParams,
  CreateAgentSessionRequest,
  CreateAgentSessionRequestParams,
  CreateAgentSessionRequestParamsMeta,
  CreateAgentSessionRequestParamsMetaAgent,
  CreateAgentSessionRequestParamsMetaConfig,
  CreateAgentSessionRequestParamsMetaConfigSessionTags,
  CreateAgentSessionRequestParamsMetaInitialConfigOptions,
  GetAgentSessionTokenUsageRequest,
  GetAgentSessionTokenUsageRequestParams,
  ListAgentSessionArtifactsRequest,
  ListAgentSessionArtifactsRequestParams,
  ListAgentSessionsRequest,
  ListAgentSessionsRequestParams,
  ListAgentsRequest,
  ListAgentsRequestParams,
  LoadAgentSessionRequest,
  LoadAgentSessionRequestParams,
  LoadAgentSessionRequestParamsMeta,
  PromptAgentSessionRequest,
  PromptAgentSessionRequestParams,
  PromptAgentSessionRequestParamsPrompt,
  ReplyAgentSessionRequest,
  ReplyAgentSessionRequestParams,
  ReplyAgentSessionRequestParamsOutcome,
} from '@alicloud/dataworks-public20240518';
import type { FastifyBaseLogger } from 'fastify';

import {
  HISTORY_READ_TIMEOUT_MS,
  apiError,
  countFramesForRid,
  createEmptyBodyError,
  frameFromSdkBody,
  popAckRequestId,
  reduceHistory,
  type AcpFrame,
  type ApiResult,
  type ArtifactsResult,
  type CancelResult,
  type CreateSessionResult,
  type HistoryResult,
  type ProbeResult,
  type ReplyResult,
  type SessionMode,
  type SessionSummary,
  type SessionsResult,
  type UsageResult,
} from '@das/shared';

import type { AppConfig } from './config.js';
import { missingResultError, readNonStreamBody, toApiError } from './normalize.js';
import { SdkError, runtimeFor, runtimeForSse, type SdkClient } from './sdk.js';

/**
 * 真实上游调用。**所有 LIVE 路径都在这里，一处也不散到路由里**——
 * 路由只负责"mock 还是 live"的分派与 HTTP 语义，这样两种模式共用同一份响应契约。
 *
 * 贯穿全文件的两条约定：
 *  1. 每个函数都自己 try/catch 并返回 `ApiResult`，业务错误一律 HTTP 200 承载。
 *  2. 拿不到的东西就说拿不到，绝不编造（见 normalize.ts 里"非流式响应模型没有
 *     error 字段"那段）。
 */
export interface LiveContext {
  client: SdkClient;
  cfg: AppConfig;
  log?: FastifyBaseLogger;
}

const JSONRPC_VERSION = '2.0';

/** 上游要求 Id 存在；它是 JSON-RPC 的请求标识，与 RequestId（rid）不是一回事。 */
let rpcIdCounter = 0;
function nextRpcId(): string {
  rpcIdCounter += 1;
  return String(rpcIdCounter);
}

/** 列表分页的硬上限。上游没承诺页数收敛，不设上限等于把死循环的可能留给线上。 */
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

/** 只被自检用（不对外暴露路由）：它的价值是"验证网络 + AK/SK + 签名"，不是发现 agent。 */
export interface AgentsResult {
  agents: string[];
  totalCount: number | undefined;
  requestId: string | undefined;
}

/**
 * ListAgents。
 *
 * **实测：返回里恒只有 2 个 chatbi 系 agent，找不到 `dataworks_data_agent`**
 * （服务端硬编码的枚举），但用这个名字调 CreateAgentSession 照样成功。
 * 所以千万别把"列表里没有"当成"没权限"或"名字写错了"——
 * 这一步在自检里的作用只是证明请求签名正确、网络可达、上游愿意应答。
 */
export async function liveListAgents(ctx: LiveContext): Promise<ApiResult<AgentsResult>> {
  const api = 'ListAgents';
  try {
    const resp = await ctx.client.listAgentsWithOptions(
      new ListAgentsRequest({
        id: nextRpcId(),
        jsonrpc: JSONRPC_VERSION,
        params: new ListAgentsRequestParams({ maxResults: PAGE_SIZE }),
      }),
      runtimeFor(),
    );
    const body = readNonStreamBody(resp);
    if (!body.result) return { ok: false, error: missingResultError(api, body) };

    const agents: string[] = [];
    const rows = body.result.agents;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const name = str((row as { agentName?: unknown } | null)?.agentName);
        if (name) agents.push(name);
      }
    }
    return {
      ok: true,
      result: { agents, totalCount: num(body.result.totalCount), requestId: body.requestId },
    };
  } catch (err) {
    return { ok: false, error: toApiError(err, api) };
  }
}

/**
 * CreateAgentSession 的请求构造，单独抽出来给 wire 级测试对账
 * （server-node/test/live-create.test.ts）。
 *
 * 嵌套关系是血泪教训：`initialConfigOptions` 只存在于 `meta` 之下，
 * agentName 只存在于 `meta.agent` 之下——直接往 `params` 上塞同名字段，
 * `toMap()` 会按 names() 声明静默丢弃（`tea.Model` 基类带索引签名，
 * tsc 一声不吭），wire 上就是 `"Params": {}` 的全空请求。
 *
 * mode 参数化（【LIVE 09-17】）：
 *  · `yolo`（默认）——工具授权自动放行，自检与无人值守路径用；
 *  · `default`——会触发审批的工具调用停下等人，配 ReplyAgentSession 回覆。
 *    老注释里"必须锁 yolo，否则人卡卡死"的理由已失效：ReplyAgentSession
 *    就是当年缺失的回覆通道（09-17 实测 accepted + 流继续 + agent 按答案执行）。
 *    注意 ask_user_question（提问类）在两种模式下都会出现——它不是授权，yolo 不会
 *    自动答掉它（实测 tool_call 停在 pending），没人回覆它轮次照样会等。
 */
export function buildCreateSessionRequest(cfg: AppConfig, mode: SessionMode = 'yolo'): CreateAgentSessionRequest {
  return new CreateAgentSessionRequest({
    id: nextRpcId(),
    jsonrpc: JSONRPC_VERSION,
    params: new CreateAgentSessionRequestParams({
      meta: new CreateAgentSessionRequestParamsMeta({
        // AgentName 只认这一个位置；不要靠 ListAgents 去发现它（恒查不到 data agent）
        agent: new CreateAgentSessionRequestParamsMetaAgent({ agentName: cfg.agentName }),
        config: new CreateAgentSessionRequestParamsMetaConfig({
          sessionSource: cfg.sessionSource,
          // 类型是 Array<{SessionTagCode}> 而不是 string[]：传字符串数组不会被拒，
          // 只会被静默忽略，然后左栏的过滤就少了一列可用的判据。
          sessionTags: [new CreateAgentSessionRequestParamsMetaConfigSessionTags({ sessionTagCode: cfg.sessionSource })],
        }),
        /**
         * ResourceGroupId 走 `InitialConfigOptions`。
         * 注意上游**不校验有效性**：填一个不存在的 ID 照样建会话成功，
         * 所以它不能当排错信号用；反过来，账号下零运行实例又不填它，
         * 得到的就是下面那个空响应体。
         *
         * mode：`yolo` 放行全部工具授权；`default` 停下等人（人卡，配 /reply 回覆）。
         */
        initialConfigOptions: new CreateAgentSessionRequestParamsMetaInitialConfigOptions({
          resourceGroupId: cfg.resourceGroupId,
          mode,
        }),
      }),
    }),
  });
}

export async function liveCreateSession(ctx: LiveContext, mode: SessionMode = 'yolo'): Promise<ApiResult<CreateSessionResult>> {
  const api = 'CreateAgentSession';
  try {
    const resp = await ctx.client.createAgentSessionWithOptions(
      buildCreateSessionRequest(ctx.cfg, mode),
      runtimeFor(),
    );

    const body = readNonStreamBody(resp);
    if (!body.result) {
      // 空响应体是这条接口最常见的失败形态，单独归一类：它的处置方式
      // （查实例 / 配资源组）与其它 rpc_error 完全不同。
      return {
        ok: false,
        error: createEmptyBodyError(
          `${api} 返回 HTTP ${body.statusCode ?? '?'} 但没有 JsonRpcResponse.Result，拿不到 SessionId` +
            (body.requestId ? `（RequestId ${body.requestId}）` : '') +
            '。实测最常见的原因是账号下没有运行中的 DataWorks 实例，或者该账号需要 RESOURCE_GROUP_ID 而没配。',
        ),
      };
    }

    const sessionId = str(body.result.sessionId);
    // **成功判据只有 SessionId 非空**。HTTP 200 + 有 Result 但 SessionId 为空，
    // 仍然是失败，且同样归 create_empty_body。
    if (!sessionId) {
      return { ok: false, error: createEmptyBodyError(`${api} 返回了 Result 但 SessionId 为空`) };
    }
    return { ok: true, result: { sessionId, requestId: body.requestId } };
  } catch (err) {
    return { ok: false, error: toApiError(err, api) };
  }
}

export async function liveListSessions(ctx: LiveContext): Promise<ApiResult<SessionsResult>> {
  const api = 'ListAgentSessions';
  try {
    const collected: SessionSummary[] = [];
    let nextToken: string | undefined;
    let totalCount: number | undefined;
    let truncated = false;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const resp = await ctx.client.listAgentSessionsWithOptions(
        new ListAgentSessionsRequest({
          id: nextRpcId(),
          jsonrpc: JSONRPC_VERSION,
          params: new ListAgentSessionsRequestParams({
            /**
             * AgentName 实测**必填**：不传会拿到一个与预期无关的结果集。
             * SessionSourceList 是生效的过滤器——这正是"只列本工程建的会话"能成立的原因。
             * 反过来 SessionTitle 过滤器被**静默忽略**（传了也返回全量），
             * 所以本端点不提供 q 参数，标题搜索一律前端做。
             */
            agentName: ctx.cfg.agentName,
            sessionSourceList: [ctx.cfg.sessionSource],
            maxResults: PAGE_SIZE,
            nextToken,
          }),
        }),
        runtimeFor(),
      );

      const body = readNonStreamBody(resp);
      if (!body.result) return { ok: false, error: missingResultError(api, body) };

      totalCount ??= num(body.result.totalCount);
      const rows = body.result.agentSessions;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const summary = toSessionSummary(row);
          if (summary) collected.push(summary);
        }
      }

      nextToken = str(body.result.nextToken);
      if (!nextToken) break;
      if (page === MAX_PAGES - 1) {
        truncated = true;
        ctx.log?.warn({ pages: MAX_PAGES, collected: collected.length }, '会话列表达到分页上限，结果可能不完整');
      }
    }

    return {
      ok: true,
      result: {
        sessions: collected,
        /**
         * TotalCount 与已收集条数之差。上游把过滤做在了服务端，本地无从复算，
         * 所以这个数只能来自 TotalCount——**但它的归因不唯一**：达到分页上限时，
         * 差额里既有"别的来源被过滤掉的"，也有"根本没去取的页"。
         * 这就是为什么要一并返回 truncated：不带上它，前端只能把这个数说成"被过滤掉 N 条"，
         * 那是在编造归因。
         */
        filteredOut: Math.max(0, (totalCount ?? collected.length) - collected.length),
        total: totalCount ?? collected.length,
        truncated,
      },
    };
  } catch (err) {
    return { ok: false, error: toApiError(err, api) };
  }
}

function toSessionSummary(row: unknown): SessionSummary | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const r = row as {
    sessionId?: unknown;
    sessionTitle?: unknown;
    sessionDescription?: unknown;
    sessionCreatedAt?: unknown;
    sessionUpdatedAt?: unknown;
    meta?: { sessionSource?: unknown; sessionStatus?: unknown; sessionTagList?: unknown };
  };
  const sessionId = str(r.sessionId);
  if (!sessionId) return undefined;

  const createdAt = num(r.sessionCreatedAt) ?? 0;
  const tags: string[] = [];
  if (Array.isArray(r.meta?.sessionTagList)) {
    for (const tag of r.meta.sessionTagList) {
      const code = str((tag as { sessionTagCode?: unknown } | null)?.sessionTagCode);
      if (code) tags.push(code);
    }
  }

  return {
    sessionId,
    /**
     * SessionTitle = 首条 prompt 原文。旧录制内容里可能残留校验码说明，
     * 由 `stripMarkerInstruction` 做 legacy 清洗（机制已退役，共享一个文件）。
     * 标题为空时退到 SessionDescription，两者都空就显示 sessionId 前缀——
     * 空标题是真实存在的（录制件里就有）。
     */
    title: str(r.sessionTitle) || str(r.sessionDescription) || '',
    createdAt,
    /**
     * 恒等于 createdAt（实测 29/29）。照原样透传，让读代码的人自己看见这条约束；
     * 运行态一律以前端流为准。
     */
    updatedAt: num(r.sessionUpdatedAt) ?? createdAt,
    /** 恒为 RELEASED，同样不能当运行态用。 */
    status: str(r.meta?.sessionStatus) || 'UNKNOWN',
    source: str(r.meta?.sessionSource),
    tags,
  };
}

// ---------------------------------------------------------------------------
// 历史（LoadAgentSession）
// ---------------------------------------------------------------------------

/**
 * 拉一整份历史帧。
 *
 * 用**独立的 30s readTimeout**：实测在会话 RUNNING 期间调 load，4 次里有 2 次会阻塞到
 * 那一轮跑完才返回（178s、81.6s），另外 2 次 0.1s 返回但内容是假的 end_turn。
 * 阻塞不可预测，快速失败让用户重试，好过把界面挂死三分钟。
 *
 * `Meta.BeginLogOffset` 是**死参数**：传任何值都返回全量，服务端没有增量续传。
 * 所以这里不传它，也不在任何地方暴露它——这也是本工程选 NDJSON 而不是 SSE 的原因
 * （SSE 的 `Last-Event-ID` 语义会暗示"可以续传"，那是撒谎）。
 */
export async function liveLoadFrames(ctx: LiveContext, sessionId: string): Promise<AcpFrame[]> {
  const frames: AcpFrame[] = [];
  const stream = ctx.client.loadAgentSessionWithSSE(
    new LoadAgentSessionRequest({
      id: nextRpcId(),
      jsonrpc: JSONRPC_VERSION,
      params: new LoadAgentSessionRequestParams({
        sessionId,
        meta: new LoadAgentSessionRequestParamsMeta({ isReload: true }),
      }),
    }),
    runtimeForSse(HISTORY_READ_TIMEOUT_MS),
  );

  for await (const resp of guardAsyncIterable(stream, 'LoadAgentSession')) {
    const frame = frameFromSdkBody((resp as { body?: unknown }).body);
    if (frame) frames.push(frame);
  }
  return frames;
}

export async function liveHistory(ctx: LiveContext, sessionId: string): Promise<ApiResult<HistoryResult>> {
  const api = 'LoadAgentSession';
  const started = Date.now();
  try {
    const frames = await liveLoadFrames(ctx, sessionId);
    const reduced = reduceHistory(frames);
    return {
      ok: true,
      result: {
        turns: reduced.turns,
        droppedRidLess: reduced.droppedRidLess,
        nonTurnRids: reduced.nonTurnRids,
        totalFrames: reduced.totalFrames,
        elapsedMs: Date.now() - started,
      },
    };
  } catch (err) {
    return { ok: false, error: toApiError(err, api) };
  }
}

// ---------------------------------------------------------------------------
// 度量 / 产物 / 取消
// ---------------------------------------------------------------------------

export async function liveUsage(ctx: LiveContext, sessionId: string): Promise<ApiResult<UsageResult>> {
  const api = 'GetAgentSessionTokenUsage';
  const started = Date.now();
  try {
    const resp = await ctx.client.getAgentSessionTokenUsageWithOptions(
      new GetAgentSessionTokenUsageRequest({
        id: nextRpcId(),
        jsonrpc: JSONRPC_VERSION,
        params: new GetAgentSessionTokenUsageRequestParams({ sessionId }),
      }),
      runtimeFor(),
    );
    const body = readNonStreamBody(resp);
    if (!body.result) return { ok: false, error: missingResultError(api, body) };
    const r = body.result;
    return {
      ok: true,
      result: {
        promptTokens: num(r.promptTokens),
        completionTokens: num(r.completionTokens),
        totalTokens: num(r.totalTokens),
        cachedTokens: num(r.cachedTokens),
        thoughtsTokens: num(r.thoughtsTokens),
        elapsedMs: Date.now() - started,
        requestId: body.requestId,
      },
    };
  } catch (err) {
    return { ok: false, error: toApiError(err, api) };
  }
}

/**
 * artifacts。**原样返回，不做兜底填充**：实测两个 artifact 接口恒返回空数组。
 * 用假数据把它填上等于掩盖这条约束，用户会以为"产物功能坏了"而不是"接口就没实现"。
 */
export async function liveArtifacts(ctx: LiveContext, sessionId: string): Promise<ApiResult<ArtifactsResult>> {
  const api = 'ListAgentSessionArtifacts';
  const started = Date.now();
  try {
    const resp = await ctx.client.listAgentSessionArtifactsWithOptions(
      new ListAgentSessionArtifactsRequest({
        id: nextRpcId(),
        jsonrpc: JSONRPC_VERSION,
        params: new ListAgentSessionArtifactsRequestParams({ sessionId }),
      }),
      runtimeFor(),
    );
    const body = readNonStreamBody(resp);
    if (!body.result) return { ok: false, error: missingResultError(api, body) };
    const artifacts = Array.isArray(body.result.artifacts) ? body.result.artifacts : [];
    return { ok: true, result: { artifacts, elapsedMs: Date.now() - started } };
  } catch (err) {
    return { ok: false, error: toApiError(err, api) };
  }
}

/**
 * cancel。【LIVE 09-18】已会真正取消：上游 HTTP 200，执行中的轮次随后以
 * `stopReason=cancelled` 终态收场（1200 字长文在 432 字处被截断，2/2 复现；
 * 09-15 的"执行期 503 ×3/3"不再出现）。
 *
 * `delivered` = 上游接受了取消请求（HTTP 200）。两个口径写进 detail：
 * 空闲会话上的 cancel 同样 200（no-op）；cancelled 终态目前不落库——
 * LoadAgentSession 里那一轮 `terminated=false`、无 stopReason（上游缺口，
 * 历史侧无法区分"已取消"与"断流"）。
 */
export async function liveCancel(ctx: LiveContext, sessionId: string): Promise<ApiResult<CancelResult>> {
  const api = 'CancelAgentSession';
  let upstream = '调用未返回';
  let status: number | undefined;
  try {
    const resp = await ctx.client.cancelAgentSessionWithOptions(
      new CancelAgentSessionRequest({
        id: nextRpcId(),
        jsonrpc: JSONRPC_VERSION,
        params: new CancelAgentSessionRequestParams({ sessionId }),
      }),
      runtimeFor(),
    );
    const body = readNonStreamBody(resp);
    status = body.statusCode;
    upstream = `HTTP ${status ?? '?'}`;
  } catch (err) {
    // 非 2xx / 网络层失败都记进 detail 透给前端，不当异常抛——取消失败
    // 的正确处置是让调用方知道"没取消成"，而不是收到一个 5xx。
    upstream = toApiError(err, api).message;
  }

  const delivered = status === 200;
  return {
    ok: true,
    result: {
      delivered,
      warning: delivered ? 'cancel-accepted' : 'cancel-upstream-error',
      detail: delivered
        ? `已向上游发出 ${api}（${upstream}），取消请求已被接受。` +
          '若当时有执行中的轮次，流会以 `stopReason=cancelled` 终态收场' +
          '（实测 3/3：1200 字长文在 432 字处被截断；空闲会话上取消是 no-op）。' +
          '注意：cancelled 终态目前不落库——稍后 LoadAgentSession 里那一轮 ' +
          '`terminated=false`、无 stopReason，属上游已知缺口，不代表取消失败。'
        : `已向上游发出 ${api} 但未获 200（本次结果：${upstream}）。` +
          '取消未确认生效：那一轮可能仍在执行，结果稍后拉历史确认。',
    },
  };
}

// ---------------------------------------------------------------------------
// 人卡回覆（ReplyAgentSession）
// ---------------------------------------------------------------------------

/** `POST /api/sessions/:id/reply` 的入参（路由层已做过形状校验）。 */
export interface ReplyInput {
  permissionRequestId: string;
  /** ask_user_question 的答案（索引键 → 选项 label / 自定义文本）。 */
  answers?: Record<string, string>;
  /** 工具授权类的选项 id（如 proceed_once / proceed_always / cancel）。 */
  optionId?: string;
  outcome: 'selected' | 'cancelled';
}

/**
 * 回覆人卡交互。【LIVE 09-17】实测：accepted=true 后原 PromptAgentSession 流继续，
 * agent 会按 answers/optionId 执行；回覆本身不产生新的流，也绝不能重发 prompt。
 *
 * 与其它非流式调用不同：**ReplyAgentSession 的响应模型声明了 Error 字段**，
 * 所以业务错误（code/errorCode/message）能穿过 SDK 的 cast 被原样读出——
 * 不用像 create 那样只能给"Result 缺失 + RequestId"。
 */
export async function liveReply(ctx: LiveContext, sessionId: string, input: ReplyInput): Promise<ApiResult<ReplyResult>> {
  const api = 'ReplyAgentSession';
  try {
    const resp = await ctx.client.replyAgentSessionWithOptions(
      new ReplyAgentSessionRequest({
        id: nextRpcId(),
        jsonrpc: JSONRPC_VERSION,
        params: new ReplyAgentSessionRequestParams({
          sessionId,
          permissionRequestId: input.permissionRequestId,
          ...(input.answers && Object.keys(input.answers).length > 0 ? { answers: input.answers } : {}),
          outcome: new ReplyAgentSessionRequestParamsOutcome({
            ...(input.optionId ? { optionId: input.optionId } : {}),
            outcome: input.outcome,
          }),
        }),
      }),
      runtimeFor(),
    );

    const body = (resp as {
      body?: {
        requestId?: string;
        jsonRpcResponse?: {
          result?: { accepted?: boolean };
          error?: { code?: number; errorCode?: string; message?: string };
        };
      };
    }).body;
    const rpc = body?.jsonRpcResponse;
    const requestId = typeof body?.requestId === 'string' ? body.requestId : undefined;

    if (rpc?.error) {
      const e = rpc.error;
      return {
        ok: false,
        error: apiError(
          'rpc_error',
          `${api} 被上游拒绝：${e.message ?? '无 message'}` +
            (e.errorCode ? ` [${e.errorCode}]` : '') +
            (e.code !== undefined ? ` (code=${e.code})` : '') +
            (requestId ? `，RequestId ${requestId}` : ''),
        ),
      };
    }
    if (!rpc?.result || typeof rpc.result.accepted !== 'boolean') {
      return {
        ok: false,
        error: apiError(
          'rpc_error',
          `${api} 返回 HTTP ${body ? '200' : '?'} 但没有 JsonRpcResponse.Result.accepted` +
            (requestId ? `（RequestId ${requestId}）` : ''),
        ),
      };
    }
    return {
      ok: true,
      result: {
        accepted: rpc.result.accepted,
        requestId,
        detail:
          rpc.result.accepted
            ? '上游已接受回覆。后续执行事件从原 PromptAgentSession 流上继续收，不要重发 prompt。'
            : '上游明确返回 accepted=false：回覆未被采纳（requestId 可能已过期或已被他人回覆）。',
      },
    };
  } catch (err) {
    return { ok: false, error: toApiError(err, api) };
  }
}

// ---------------------------------------------------------------------------
// 断流后的完成探测器
// ---------------------------------------------------------------------------

/**
 * 探测"断流的那一轮到底跑完了没有"。
 *
 * 两个判据，都只能给"完成"信号、给不了"进度"信号：
 *  - **A（帧数）**：重新 load 一遍，数这个 rid 名下有多少帧。>2 说明服务端已经写入了
 *    实质内容（终态帧 + 少量收尾帧不算）。A 每次都要触发一次完整 load，
 *    所以**别在 RUNNING 期高频轮询**——那正好撞上 load 的阻塞概率。
 *  - **B（token 跳变）**：TotalTokens 相比断流时增加了，说明模型又算了东西。
 *    B 只验证过 1 次，且零 token 的轮次可能压根不跳变，所以 **B 只能加强 A 的结论、
 *    不能单独否定 A**：`by` 里只有 `tokens` 时，前端必须说"很可能已完成，请拉历史确认"，
 *    不能说"已完成"。
 *
 * 探测不到就如实说探测不到。**绝不自动重发 prompt**——重发等于把同一个写操作执行两遍。
 */
export async function liveProbe(
  ctx: LiveContext,
  sessionId: string,
  rid: string,
  baselineTokens: number | undefined,
): Promise<ApiResult<ProbeResult>> {
  const started = Date.now();
  let loadsIssued = 0;
  let framesForRid = 0;
  let totalTokens: number | undefined;
  const by: ProbeResult['by'] = [];

  try {
    const frames = await liveLoadFrames(ctx, sessionId);
    loadsIssued = 1;
    framesForRid = countFramesForRid(frames, rid);
  } catch (err) {
    return { ok: false, error: toApiError(err, 'LoadAgentSession(probe)') };
  }

  /**
   * 探测器 B 失败要**记下来**，而不是静默退化。
   *
   * 注意不能用 try/catch：`liveUsage` 自己吞掉异常并返回 `ApiResult`，从不抛——
   * 挂在它外面的 catch 是死代码，B 失效时日志里一个字都不会有。
   */
  const usage = await liveUsage(ctx, sessionId);
  if (usage.ok) {
    totalTokens = usage.result.totalTokens;
  } else {
    ctx.log?.warn({ error: usage.error.message }, '探测 B（token 跳变）不可用，只按帧数判定');
  }

  const framesSay = framesForRid > 2;
  const tokensSay = baselineTokens !== undefined && totalTokens !== undefined && totalTokens > baselineTokens;
  if (framesSay) by.push('frames');
  if (tokensSay) by.push('tokens');

  return {
    ok: true,
    result: {
      done: by.length > 0,
      by,
      framesForRid,
      totalTokens,
      loadsIssued,
      elapsedMs: Date.now() - started,
    },
  };
}

// ---------------------------------------------------------------------------
// 流式 prompt
// ---------------------------------------------------------------------------

/**
 * 发一轮 prompt，返回**线格式帧**的异步流。
 *
 * 三件事在这里定死：
 *  1. **必须走 `promptAgentSessionWithSSE`**。普通的 `promptAgentSessionWithOptions`
 *     走 `callApi` + `bodyType:'json'`，会整体 buffer：一轮 7~220s 的调用期间一帧也
 *     拿不到，最后必然超时。
 *  2. **每帧过 `frameFromSdkBody`**。SDK 的 `$dara.cast` 把顶层键转成了 camelCase，
 *     不转回线格式，下游 reducer 读到的 `frame.Params` 恒为 undefined ⇒
 *     一整轮什么都不显示且不报任何错。
 *  3. **抛出的异常不在这里吞**。交给 `streamWire`/路由层归一化：hijack 之后
 *     响应已经由流管道接管，这里 return 一个错误对象反而没人收。
 *
 * `outboundText` 即 prompt 原文：marker 归属校验已退役（2026-09-20），不再注入校验码。
 */
export async function* livePromptFrames(
  ctx: LiveContext,
  sessionId: string,
  outboundText: string,
  acks?: string[],
): AsyncGenerator<AcpFrame, void, unknown> {
  const stream = ctx.client.promptAgentSessionWithSSE(
    new PromptAgentSessionRequest({
      id: nextRpcId(),
      jsonrpc: JSONRPC_VERSION,
      params: new PromptAgentSessionRequestParams({
        sessionId,
        prompt: [new PromptAgentSessionRequestParamsPrompt({ type: 'text', text: outboundText })],
      }),
    }),
    runtimeForSse(),
  );

  let unrecognized = 0;
  try {
    for await (const resp of guardAsyncIterable(stream, 'PromptAgentSession')) {
      const body = (resp as { body?: unknown }).body;
      const frame = frameFromSdkBody(body);
      if (frame) {
        yield frame;
        continue;
      }
      /**
       * 不是帧的载荷有两种，必须分开对待：
       *  · **POP 回执**（只有 RequestId）。实测 2026-09-15：上游以 HTTP 200 收下 prompt，
       *    SSE 只回这一个事件就在 0.1~0.7s 内关流，随后 load 回看历史里只有一个
       *    end_turn 空轮次——这一轮从未派发给执行端。这个 RequestId 是零帧场景下
       *    唯一还能拿去查的线索，所以捞出来交给调用方，不能随载荷一起丢掉。
       *    注意它**不是 rid**：ACP 帧上的 rid 是 UUID，拿 POP 回执去过滤历史一无所获。
       *  · **真认不出来的形状**：上游改了载荷，或 SDK 的 cast 把字段吃了。这才是要 warn 的。
       */
      const ack = popAckRequestId(body);
      if (ack) {
        acks?.push(ack);
        continue;
      }
      unrecognized += 1;
    }
  } finally {
    /**
     * 放 finally 是因为这条生成器最常见的结束方式不是"迭代完"，而是被外层 `return()` 掉
     * （客户端断开 / 撞 330s 硬上限）。写在循环之后的话，最需要这条日志的场合
     * ——上游改了载荷形状、同时流又被提前掐断——恰好一个字都不会留下。
     */
    if (unrecognized > 0) {
      ctx.log?.warn({ sessionId, unrecognized }, 'SSE 里有认不出来的载荷，已跳过（上游形状可能变了）');
    }
  }
}

/**
 * `*WithSSE` 的返回类型在 .d.ts 里偏宽松，真拿到 undefined / 非可迭代对象时
 * `for await` 会抛 TypeError 把进程带走。这里换成一条能读懂的 transport 错误。
 */
function guardAsyncIterable<T>(value: unknown, apiName: string): AsyncIterable<T> {
  const iterable = value as AsyncIterable<T> | null | undefined;
  if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') {
    throw new SdkError(
      apiError('transport', `${apiName} 没有返回可迭代的 SSE 流（拿到 ${typeof value}）；SDK 版本或上游形态可能不匹配`),
    );
  }
  return iterable;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
