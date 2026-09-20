import type { FastifyBaseLogger } from 'fastify';

import {
  apiError,
  type ApiError,
  type CheckResult,
  type CheckStep,
} from '@das/shared';

import type { AppConfig } from './config.js';
import { liveCreateSession, liveListAgents, liveListSessions, liveUsage, type LiveContext } from './live.js';
import { readFixtureEnvelope } from './mock/fixtures.js';
import type { SdkClient } from './sdk.js';

/**
 * 三步自检。`npm run check` 与 `POST /api/check` 跑的是同一个函数，
 * 所以两个入口的判据与文案不会分叉。
 *
 * 如实交代一点：前端目前**没有**自检面板，`web/` 里没有任何地方调 `/api/check`；
 * 那个端点是给脚本与 curl 用的（例如 CI 里跑一次真实链路预检）。
 * 所以"命令行说通了"能推广到"HTTP 调用方说通了"，但不能推广到"界面上说通了"。
 *
 * 为什么是这三步、这个顺序：它们各自定位**一类互不相同**的配置问题，
 * 前一步过了才能把后一步的失败范围收窄。
 *   ① ListAgents            → 网络可达 + AK/SK 有效 + 签名正确
 *   ② CreateAgentSession    → DataWorks 已开通 + 有可用实例/资源组
 *   ③ GetAgentSessionTokenUsage → 这个会话真的能用（唯一可靠的度量接口，约 0.3s）
 *
 * **失败不中断后续可诊断步**：①挂了②③照样跑（它们会以自己的方式失败，
 * 而两种失败文本不同，能帮你分清是"签名不对"还是"没开通"）；
 * 只有③依赖②产出的 SessionId，②失败时③如实标成"无法执行"。
 *
 * `log` 是可选参数，但两个调用方都该传：live.ts 里那几条 warn（会话列表达到分页上限、
 * 探测 B 不可用、SSE 里出现认不出的载荷）都走 `ctx.log?.warn`，不给 log 就被静默丢掉，
 * 而 `npm run check` 恰恰是最需要看到它们的地方。
 */
export async function runCheck(
  cfg: AppConfig,
  client: SdkClient | undefined,
  log?: FastifyBaseLogger,
): Promise<CheckResult> {
  const startedAt = Date.now();
  const ctx: LiveContext | undefined = client ? { client, cfg, log } : undefined;
  const steps: CheckStep[] = [];

  const agents = await stepListAgents(cfg, ctx);
  steps.push(agents.step);

  const created = await stepCreateSession(cfg, ctx, agents.step);
  steps.push(created.step);

  steps.push(await stepTokenUsage(cfg, ctx, created.sessionId));

  return {
    mock: cfg.mock,
    steps,
    ok: steps.every((s) => s.ok),
    elapsedMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// ① ListAgents
// ---------------------------------------------------------------------------

async function stepListAgents(
  cfg: AppConfig,
  ctx: LiveContext | undefined,
): Promise<{ step: CheckStep }> {
  const api = 'ListAgents';
  const started = Date.now();

  if (cfg.mock) {
    const env = readFixtureEnvelope<{ Agents?: { AgentName?: string }[]; TotalCount?: number }>('rest-list-agents.json');
    const names = (env.result?.Agents ?? []).map((a) => a.AgentName).filter((n): n is string => typeof n === 'string');
    return {
      step: done('list-agents', api, started, true, env.requestId, undefined, mockNote(
        `回放录制件：返回 ${names.length} 个 agent（${names.join(', ')}）。`,
        api,
      )),
    };
  }

  if (!ctx) return { step: noClient('list-agents', api, started) };

  const outcome = await liveListAgents(ctx);
  if (!outcome.ok) {
    const status = outcome.error.upstreamStatus;
    const hint =
      status === 401 || status === 403
        ? `${outcome.error.message}\n    ↳ 这不是签名错。网关能把 Deny 连同 AK 与来源 IP 一起报出来，说明签名已经验过、身份已经认出来了，` +
          '被拒的是**授权**或**身份级安全管控**——所以改 region、改 RESOURCE_GROUP_ID、重装依赖都不会有用。' +
          '\n      报文里若点名"联系安全团队"并带来源 IP，通常是这对 AK 被管控策略拦下（例如受管账号的 AK 不允许从该公网 IP 调用），' +
          '挂 RAM 策略也不解决，要换身份或解除管控；若只是普通的缺权限，就挂下面②里列的那 8 个 action。' +
          '\n      真正的签名错会长成 SignatureDoesNotMatch / InvalidAccessKeyId.NotFound 这类码，而不是这个形态。'
        : `${outcome.error.message}\n    ↳ 这一步失败说明问题出在网络、AK/SK 或签名，与 DataWorks 是否开通无关。` +
          '先确认 region 填的是实例所在 region，再确认这对 AK/SK 属于已授权 DataWorks 的 RAM 用户。';
    return {
      step: done('list-agents', api, started, false, undefined, outcome.error, hint),
    };
  }

  const names = outcome.result.agents;
  const hasDataAgent = names.includes(cfg.agentName);
  return {
    step: done('list-agents', api, started, true, outcome.result.requestId, undefined,
      `返回 ${names.length} 个 agent（${names.join(', ') || '空'}），TotalCount=${outcome.result.totalCount ?? '?'}。` +
      (hasDataAgent
        ? `这次居然包含了 ${cfg.agentName}。`
        : `**返回里没有 ${cfg.agentName}，这属于正常现象**：服务端硬编码只枚举 chatbi 系 agent，` +
          '但用这个名字调 CreateAgentSession 照样成功。别把"列表里没有"当成没权限或名字写错。'),
    ),
  };
}

// ---------------------------------------------------------------------------
// ② CreateAgentSession
// ---------------------------------------------------------------------------

async function stepCreateSession(
  cfg: AppConfig,
  ctx: LiveContext | undefined,
  listAgents: CheckStep,
): Promise<{ step: CheckStep; sessionId: string | undefined }> {
  const api = 'CreateAgentSession';
  const started = Date.now();

  if (cfg.mock) {
    const env = readFixtureEnvelope<{ SessionId?: string }>('rest-create-session.json');
    const sessionId = env.result?.SessionId;
    return {
      step: done('create-session', api, started, Boolean(sessionId), env.requestId, undefined, mockNote(
        `回放录制件：SessionId=${sessionId ?? '(空)'}。` +
        `真实模式下的成功判据只有"SessionId 非空"这一条；ResourceGroupId=${cfg.resourceGroupId ?? '(未配置)'}。`,
        api,
      )),
      sessionId,
    };
  }

  if (!ctx) return { step: noClient('create-session', api, started), sessionId: undefined };

  const outcome = await liveCreateSession(ctx);
  if (!outcome.ok) {
    const agentsDenied =
      !listAgents.ok && (listAgents.error?.upstreamStatus === 401 || listAgents.error?.upstreamStatus === 403);

    const hint = agentsDenied
      ? `${outcome.error.message}\n    ↳ **这和①是同一个拒绝，不是两个独立问题**。①已经被授权层挡在门外（见上面那条指引），` +
        '②只是同一个身份撞上同一道门。先按①处理授权/安全管控，别去动实例或 RESOURCE_GROUP_ID。'
      : outcome.error.kind === 'create_empty_body'
        ? `${outcome.error.message}\n    ↳ 空响应体是这条接口最常见的失败形态。下一步：① 确认账号下有**运行中**的 DataWorks 实例；` +
          '② 零实例账号必须在 .env 里配 RESOURCE_GROUP_ID（Serverless 资源组）。' +
          '注意上游**不校验** ResourceGroupId 的有效性，填错不会报错，只会继续空响应，所以别把它当排错信号。' +
          'HTTP 200 + 空 body 指向"未开通/无实例"，4xx 指向权限或参数——先看上面那个状态码再动手。'
        : `${outcome.error.message}\n    ↳ 这一步失败与①的失败含义不同：①证明签名没问题，所以这里更可能是未开通、无实例或权限策略不含 DataWorks。`;
    // ①已经被授权层拒掉时不再打探针：只会得到第三个一模一样的 401，没有信息增量，
    // 而在疑似按调用模式触发的身份级安全管控上多留一条拒绝记录是反效果的。
    const probe = agentsDenied ? '' : await probeAuthorization(ctx);
    return {
      step: done('create-session', api, started, false, undefined, outcome.error, hint + probe),
      sessionId: undefined,
    };
  }

  return {
    step: done('create-session', api, started, true, outcome.result.requestId, undefined,
      `建会话成功，SessionId=${outcome.result.sessionId}。` +
      `这一步验证的是 DataWorks 已开通且有可用实例/资源组（AgentName=${cfg.agentName}，` +
      `SessionSource=${cfg.sessionSource}，ResourceGroupId=${cfg.resourceGroupId ?? '未配置'}）。`,
    ),
    sessionId: outcome.result.sessionId,
  };
}

// ---------------------------------------------------------------------------
// ②的失败判别探针
// ---------------------------------------------------------------------------

/**
 * ②失败时追跑一次**只读**的 `ListAgentSessions`，用来分开两种互斥的根因。
 *
 * 为什么这个探针有判别力：`CreateAgentSession` 失败时上游只回一个空
 * `JsonRpcResponse`（HTTP 200，既无 Result 也无 Error），"没有运行中的实例"与
 * "这对 AK/SK 根本没被授权"在响应里长得一模一样，光看②分不出来。
 * 而 `ListAgentSessions` 与它同属官方那 8 个 Data Agent 动作、走同一个网关：
 *  - 它也 4xx/Unauthorized ⇒ 授权或身份级安全管控的问题，改 .env 里的实例/资源组配置没用；
 *  - 它 200 ⇒ 身份与授权没问题，空响应才真的指向未开通 / 无可用实例。
 *
 * 只在失败路径上跑，且全程只读——不建会话、不写任何东西，所以不会在用户账号上
 * 因为一次自检失败而多留垃圾。
 */
async function probeAuthorization(ctx: LiveContext): Promise<string> {
  const probe = await liveListSessions(ctx);

  if (probe.ok) {
    return `\n    ↳ 判别探针（只读 ListAgentSessions）**通了**：拿到 ${probe.result.sessions.length} 个会话` +
      `（过滤掉 ${probe.result.filteredOut} 个，Total=${probe.result.total}）。` +
      '身份与授权没问题，所以②的空响应更可能是账号下没有**运行中**的 DataWorks 实例、或该 region 未开通 Data Agent。';
  }

  const status = probe.error.upstreamStatus;
  return `\n    ↳ 判别探针（只读 ListAgentSessions）**也被拒了**：${probe.error.message}` +
    `\n      这条比②本身更有诊断价值——ListAgentSessions 与 CreateAgentSession 同属官方那 8 个 Data Agent 动作、` +
    '走同一个网关。它拿不到授权，说明问题在**身份/授权层**，不在实例或资源组配置：' +
    '改 .env 里的 RESOURCE_GROUP_ID 不会有用。' +
    '\n      要挂的 RAM 策略是这 8 个动作（Resource 写 `acs:dataworks:{#regionId}:{#accountId}:*`）：' +
    'CreateAgentSession / PromptAgentSession / LoadAgentSession / ListAgentSessions / ' +
    'ListAgentSessionArtifacts / GetAgentSessionArtifactMeta / GetAgentSessionTokenUsage / CancelAgentSession。' +
    (status === 401
      ? '\n      注意 401 且报文里点名"联系安全团队"+ 带来源 IP 的形态，通常不是普通的 RAM 缺权限，' +
        '而是这对 AK 被身份级安全管控拦下（例如受管账号的 AK 不允许从该公网 IP 调用）——' +
        '这种情况挂策略也不解决，要换身份或解除管控。'
      : '');
}

// ---------------------------------------------------------------------------
// ③ GetAgentSessionTokenUsage
// ---------------------------------------------------------------------------

async function stepTokenUsage(
  cfg: AppConfig,
  ctx: LiveContext | undefined,
  sessionId: string | undefined,
): Promise<CheckStep> {
  const api = 'GetAgentSessionTokenUsage';
  const started = Date.now();

  if (cfg.mock) {
    const env = readFixtureEnvelope<{ TotalTokens?: number; PromptTokens?: number }>('rest-token-usage.json');
    return done('token-usage', api, started, env.result !== undefined, env.requestId, undefined, mockNote(
      `回放录制件：TotalTokens=${env.result?.TotalTokens ?? '?'}，PromptTokens=${env.result?.PromptTokens ?? '?'}。` +
        '这份录制件里只发了一句话却有 5.8 万 PromptTokens——那是 agent 的 system prompt 与技能上下文，不是你的输入。' +
        '别把这个数字当规律：2026-09-15 在另一个账号上实测新建空会话是 0。',
      api,
    ));
  }

  if (!ctx) return noClient('token-usage', api, started);

  if (!sessionId) {
    return done('token-usage', api, started, false, undefined, apiError('rpc_error', '前置步骤未产出 SessionId'),
      '无法执行：②没有拿到 SessionId，所以这一步没有可查的会话。先把②修好。');
  }

  const outcome = await liveUsage(ctx, sessionId);
  if (!outcome.ok) {
    return done('token-usage', api, started, false, undefined, outcome.error,
      `${outcome.error.message}\n    ↳ 会话建出来了但度量查不到，通常是会话已经失效（幽灵化）。` +
      '在 UI 里表现为：发 prompt 约 1s 就回一帧 upstream_status=422。');
  }

  const r = outcome.result;
  /**
   * 这里刻意不写死"空会话就有五万级 PromptTokens"：那是 2026-09-10 在另一个会话上
   * 观测到的值，而 2026-09-15 真实链路实测**新建空会话是 0**。
   * 把一次观测写成规律，等于让自检在别的账号上说假话。按本次实际值说话。
   */
  const promptTokens = r.promptTokens ?? 0;
  const tokenNote =
    promptTokens >= 10_000
      ? 'PromptTokens 已经是这个量级而你一句话都还没发——那是 agent 的 system prompt 与技能上下文，不是你的输入。'
      : `这次 PromptTokens=${promptTokens}。别把它当常量：2026-09-10 在另一个会话上实测过新建空会话就有 5.8 万` +
        '（agent 的 system prompt 与技能上下文），2026-09-15 这个账号上是 0。两种都不是你的输入。';
  return done('token-usage', api, started, true, r.requestId, undefined,
    `约 ${r.elapsedMs}ms 返回：TotalTokens=${r.totalTokens ?? '?'}，PromptTokens=${r.promptTokens ?? '?'}，` +
    `CompletionTokens=${r.completionTokens ?? '?'}，CachedTokens=${r.cachedTokens ?? '?'}。` +
    '这是**唯一可靠**的度量接口（运行态问不出来、artifacts 恒空）。' + tokenNote);
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

function done(
  name: CheckStep['name'],
  api: string,
  started: number,
  ok: boolean,
  requestId: string | undefined,
  error: ApiError | undefined,
  detail: string,
): CheckStep {
  return { name, api, ok, elapsedMs: Date.now() - started, requestId, detail, error };
}

/** MOCK 分支的措辞必须让人一眼看出"这不是真调用"，否则等于自欺。 */
function mockNote(detail: string, api: string): string {
  return `[MOCK] 未调用真实 ${api}。${detail}`;
}

function noClient(name: CheckStep['name'], api: string, started: number): CheckStep {
  return done(name, api, started, false, undefined, apiError('transport', '没有可用的 SDK Client'),
    '未构造 SDK Client：LIVE 模式需要 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET。' +
    '只想验证工程本身装对了，就跑 `npm run check -- --mock`。');
}
