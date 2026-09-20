import type { ApiError } from './errors.js';
import type { TurnAggregate } from './turn.js';

/**
 * 后端 REST 端点的响应契约。
 *
 * 一条贯穿全工程的约定：**业务错误也用 HTTP 200 承载**，形状是下面这个
 * `ApiResult`；只有传输层故障（后端自己挂了、连不上上游）才用 5xx。
 * 这不是风格偏好——上游 OpenAPI 本身就是这样：业务报错恒返回 HTTP 200，
 * 真正的错误藏在响应体的 `JsonRpcResponse.Error` 里。前端若按状态码分支，
 * 会把所有业务错误当成功。
 */
export type ApiResult<T> = { ok: true; result: T } | { ok: false; error: ApiError };

/** `GET /api/health` */
export interface HealthResult {
  mock: boolean;
  region: string;
  agent: string;
  sessionSource: string;
  resourceGroupIdConfigured: boolean;
  /** 只说"有没有"，不说"是什么"。 */
  credentials: 'present' | 'missing';
  /** MOCK 模式下前端会多显示回放说明；LIVE 模式为 undefined。 */
  mockReplay?: string;
}

/** `GET /api/sessions` 的一条。字段名贴着上游，但不照抄上游的空值语义。 */
export interface SessionSummary {
  sessionId: string;
  /** 上游 `SessionTitle` = 首条 prompt 原文，所以里面可能带着注入的校验码说明。 */
  title: string;
  createdAt: number;
  /**
   * 上游这个字段恒等于 createdAt（实测 29/29），**不能当"最后活动时间"用**。
   * 保留它只是为了让读代码的人看见这个事实，运行态一律以前端流为准。
   */
  updatedAt: number;
  /** 上游恒为 RELEASED，同样不能当运行态用。 */
  status: string;
  source: string | undefined;
  tags: string[];
  /** MOCK 模式下这条会话绑定哪份录制件；LIVE 模式为 undefined。 */
  mockScenario?: string;
}

export interface SessionsResult {
  sessions: SessionSummary[];
  /**
   * 被 SessionSource 过滤掉的条数——用于说明"为什么少了几个会话"。
   * 但 `truncated` 为 true 时这个归因不成立：差额里还混着"达到分页上限、根本没去取的页"。
   */
  filteredOut: number;
  total: number;
  /** 是否因为分页上限（10 页 × 100 条）而没取完。 */
  truncated?: boolean;
}

/** `GET /api/sessions/:id/history` */
export interface HistoryResult {
  turns: TurnAggregate[];
  /** 被丢弃的无 rid 帧数（原始回放污染，同一轮内容的第二份拷贝）。 */
  droppedRidLess: number;
  /** 有帧但不构成轮次的 rid（典型是 load 调用自己那个 rid 的伪 end_turn）。 */
  nonTurnRids: string[];
  totalFrames: number;
  /** 这次 load 花了多久；RUNNING 期实测有 2/4 概率阻塞到 178s。 */
  elapsedMs: number;
}

/** `POST /api/sessions` */
export interface CreateSessionResult {
  sessionId: string;
  /**
   * POP 层 RequestId。非流式响应的业务错误详情会被 SDK 的 cast 丢弃
   * （响应模型没声明 error 字段），这个 id 是事后唯一还能拿去查的线索。
   * MOCK 模式下为 undefined。
   */
  requestId?: string;
}

/**
 * `GET /api/sessions/:id/usage`
 *
 * 这是唯一可靠的度量接口（约 0.3s 返回）。运行态问不出来、artifacts 恒空，
 * 想知道"这一轮到底烧了多少 token"只能靠它。
 */
export interface UsageResult {
  promptTokens: number | undefined;
  completionTokens: number | undefined;
  totalTokens: number | undefined;
  cachedTokens: number | undefined;
  thoughtsTokens: number | undefined;
  elapsedMs: number;
  /** POP 层 RequestId，理由同 CreateSessionResult.requestId。MOCK 模式下为 undefined。 */
  requestId?: string;
}

/**
 * `GET /api/sessions/:id/artifacts`
 *
 * 原样返回上游结果，**不做任何兜底填充**：实测两个 artifact 接口恒返回空数组，
 * 用假数据把它填上等于掩盖这条约束。空结果由前端渲染成明确的说明。
 */
export interface ArtifactsResult {
  artifacts: unknown[];
  elapsedMs: number;
}

/**
 * `POST /api/sessions/:id/cancel`
 *
 * 【LIVE 09-18】CancelAgentSession 已会真正取消执行中的轮次：上游 HTTP 200，
 * 随后流以 `stopReason=cancelled` 终态收场（1200 字长文在 432 字处被截断，
 * 2/2 复现；09-15 的"执行期 503 ×3/3"不再出现）。
 *
 * 两个已知口径，写进 detail 供调用方自查：
 *  - **空闲会话**上的 cancel 同样 200——no-op，本来就没东西可取消；
 *  - **cancelled 终态目前不落库**（上游缺口）：LoadAgentSession 里那一轮
 *    `terminated=false`、无 stopReason，历史侧无法区分"已取消"与"断流"。
 */
export interface CancelResult {
  /** 上游是否接受了取消请求（HTTP 200）。执行中轮次的实际终止以流上 `stopReason=cancelled` 为准。 */
  delivered: boolean;
  warning?: 'cancel-accepted' | 'cancel-upstream-error' | 'mock-replay-uncancellable';
  detail: string;
}

/** `GET /api/sessions/:id/probe?rid=` —— 断流后的完成探测器（阶段 6）。 */
export interface ProbeResult {
  /** 是否判定这一轮已经完成。 */
  done: boolean;
  /** 判定依据：A=该 rid 帧数 > 2，B=TotalTokens 相比断流时跳变。 */
  by: ('frames' | 'tokens')[];
  framesForRid: number;
  totalTokens: number | undefined;
  /** 探测本身触发了几次 load（A 每次都要 load 一遍，别高频轮询）。 */
  loadsIssued: number;
  elapsedMs: number;
}

/**
 * 建会话模式。`yolo` = 工具授权全部自动放行（无审批帧）；`default` = 会触发审批的
 * 工具调用停下来等人（人卡）。ask_user_question（agent 向用户提问）在两种模式下
 * 都会出现，且都走同一条 permission_request 通道。
 */
export type SessionMode = 'yolo' | 'default';

/**
 * `POST /api/sessions/:id/reply` —— 回覆人卡交互。【LIVE 09-17】
 *
 * 对上游 ReplyAgentSession 的透传：permissionRequestId 来自 PromptAgentSession 流上
 * `_qwen/notify` 帧（`params.kind='permission_request'`）的 `params.data.requestId`。
 * 回覆**只返回是否被接受**；后续执行事件仍从原 PromptAgentSession SSE 流上收，
 * 不要重复提交同一轮 prompt。
 *
 * 两种交互的回覆载荷（实测）：
 *  · ask_user_question（agent 提问）→ `answers: {'0': '<选项label>'}` **加**
 *    `outcome.optionId = options 里 kind==='allow_once' 的那个`（Web Shell 同款，两者一起发）；
 *    【LIVE 09-17 金融云】**缺 optionId 会被上游 400 拒收（参数不匹配）**——金融云强制
 *    执行完整契约；北京预发 09-17 的旧版本宽容地接受了裸 selected（以 proceed_once
 *    解除阻塞，但 agent 收不到答案），两种行为不一致，按金融云的严格版对齐。
 *    options 里 kind==='reject_once'|'reject_always' 的选项是"取消本次交互"的正路。
 *  · 工具授权 → `outcome: {optionId: '<proceed_once|proceed_always|cancel|…>'}`。
 */
export interface ReplyResult {
  /** 上游是否接受了回覆（`JsonRpcResponse.Result.accepted`）。缺失说明响应体异常。 */
  accepted: boolean | undefined;
  /** POP 层 RequestId。 */
  requestId?: string;
  detail: string;
}

/**
 * `POST /api/check` 与 `npm run check` 共用的一步自检结果。
 *
 * 用 POST 是因为第②步会真实建一个会话（写操作），而 GET 属于 CORS 的"简单请求"，
 * 任意网页都能跨源发一次——读不到响应也照样写成了。
 *
 * 三步是**串行且互不中断**的：后一步失败不影响前一步的结论，
 * 因为每一步各自定位一类不同的配置问题（网络与签名 / 开通与资源组 / 会话可用性）。
 */
export interface CheckStep {
  /** 稳定标识，用于表格对齐与断言。 */
  name: 'list-agents' | 'create-session' | 'token-usage';
  /** 上游接口名，便于对照排查文档。 */
  api: string;
  ok: boolean;
  elapsedMs: number;
  /** POP 层 RequestId，若可见。业务错误详情被 SDK 丢弃时这是唯一线索。 */
  requestId: string | undefined;
  /** 这一步到底在验证什么、结果说明什么。失败时给可执行的下一步。 */
  detail: string;
  error: ApiError | undefined;
}

export interface CheckResult {
  mock: boolean;
  steps: CheckStep[];
  /** 全部步骤都过；退出码由它决定。 */
  ok: boolean;
  elapsedMs: number;
}
