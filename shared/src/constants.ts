/**
 * 实测常量。这里每个数字/字符串都来自真实抓包或源码，不是估的；改之前先读注释里的证据。
 */

// ---------------------------------------------------------------------------
// Agent 发现
// ---------------------------------------------------------------------------

/**
 * 默认 agent 名。
 *
 * 实测：ListAgents 恒只返回 2 个 chatbi agent，返回里没有 data agent（服务端硬编码），
 * 但用这个名字建会话照样成功。所以不要靠列表接口去发现 agent，直接写死。
 */
export const DEFAULT_AGENT_NAME = 'dataworks_data_agent';

// ---------------------------------------------------------------------------
// 时序（毫秒）
// ---------------------------------------------------------------------------

/** 心跳间隔：防中间层空闲回收连接，同时给前端一个判活信号。 */
export const HEARTBEAT_MS = 15_000;

/**
 * 单轮流式响应的硬上限。
 *
 * 实测 17 轮里 SSE 连接在 218.3~257.8s 之间被服务端掐断，超过这个时长拿不到终态。
 * 到点主动收尾成 stream_break，比让连接吊死好——静默截断不能当成功。
 */
export const STREAM_HARD_LIMIT_MS = 330_000;

/**
 * 普通接口调用的 readTimeout。
 *
 * prompt 一轮实测最长 191s，要给足余量；同时必须显式关掉 SDK 自动重试，
 * 否则超时重发 prompt = 同一个写操作执行两遍。
 */
export const DEFAULT_READ_TIMEOUT_MS = 600_000;

/**
 * load（拉历史）专用 readTimeout，比普通调用短一个数量级。
 *
 * 实测在会话 RUNNING 期间调 load，4 次里有 2 次会阻塞到那一轮跑完才返回
 * （178s、81.6s），另外 2 次 0.1s 返回但内容是假的 end_turn。
 * 阻塞不可预测，所以这里选择快速失败，让用户重试，而不是把界面挂死。
 */
export const HISTORY_READ_TIMEOUT_MS = 30_000;

/**
 * 断流之后判"这一轮到底跑完没有"的总时长上限。
 *
 * 两个探测器都只能给"完成"信号、给不了"进度"信号，也区分不了"还在跑"和"卡死"，
 * 所以必须有上限；到点就如实说"无法判定"，绝不自动重发。
 */
export const PROBE_DEADLINE_MS = 300_000;

/** 探测轮询间隔。每次探测都会触发一次 load，RUNNING 期高频轮询会撞上面的阻塞概率。 */
export const PROBE_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Mock 回放
// ---------------------------------------------------------------------------

/**
 * 回放时单帧最大间隔。
 *
 * fixture 带真实 Timestamp，长轮那一份跨度 191s。原样等的话没人受得了，
 * 所以超过这个值的间隔一律压平。只影响观感，帧序、帧数、帧内容全部保真。
 * 想看真实节奏就把 MOCK_REALTIME=1。
 */
export const MOCK_MAX_GAP_MS = 400;

/**
 * 压平之后的播放倍速。
 *
 * 压平只解决"单帧间隔过长"，解决不了"帧太多"：长轮 901 帧压平后仍要 87s、
 * 断流那份 1201 帧要 118s，当演示等不起。所以再叠一个倍速（默认 4 ⇒ 约 22s / 29s）。
 * 同样只影响观感：帧序、帧数、帧内容、相对顺序全部保真。MOCK_REALTIME=1 时不生效。
 */
export const MOCK_DEFAULT_SPEED = 4;

// ---------------------------------------------------------------------------
// 轮次终态
// ---------------------------------------------------------------------------

/** 已观测到的 Result.stopReason 取值。 */
export const STOP_REASONS = [
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
] as const;

export type StopReason = (typeof STOP_REASONS)[number];

/** 终态的人类可读说明。只有 end_turn 是"正常说完了"，其余四种都要单独交代。 */
export const STOP_REASON_TEXT: Record<StopReason, string> = {
  end_turn: '本轮正常结束。',
  max_tokens: '本轮因触达 token 上限被截断，回答不完整。',
  max_turn_requests: '本轮因触达单轮请求次数上限被截断，回答不完整。',
  refusal: '本轮被模型拒绝，没有产出回答。',
  cancelled: '本轮在服务端被取消。',
};

// ---------------------------------------------------------------------------
// 帧里的 update 类型
// ---------------------------------------------------------------------------

/**
 * 已观测到的 Params.update.sessionUpdate 取值。
 *
 * 注意这**不是封闭集合**，只是抓到过的这些。reducer 必须容忍未知类型，也必须容忍
 * update 整个缺失（排队通知帧 Method="_qwen/notify" 就没有 update，实测存在），
 * 否则上游多一种帧型就表现为"内容凭空少了一段"，而不是一个能看见的错误。
 */
export const OBSERVED_SESSION_UPDATES = [
  'user_message_chunk',
  'agent_thought_chunk',
  'agent_message_chunk',
  'tool_call',
  'tool_call_update',
  'usage_update',
  // 只在 load（拉历史）回放里出现，是首帧，带 4 个配置项
  // （execution_lane / mode / skills / web_search）；实时 prompt 流里没见过。
  'config_option_update',
] as const;

export type ObservedSessionUpdate = (typeof OBSERVED_SESSION_UPDATES)[number];

/** tool_call / tool_call_update 的 status 取值（已观测）。 */
export const OBSERVED_TOOL_STATUSES = ['pending', 'in_progress', 'completed', 'failed'] as const;

// ---------------------------------------------------------------------------
// 错误识别
// ---------------------------------------------------------------------------

/**
 * JSON-RPC internal error 码。
 *
 * 同一个 -32603 实测对应三种完全不同的处境（断流 / 会话幽灵化 / 并发被拒），
 * 必须靠 message 文本与 upstream 状态码再分一次，不能只看 code。
 */
export const JSONRPC_INTERNAL_ERROR = -32603;

/** 会话已失效（幽灵化）时的 upstream HTTP 状态码，约 1s 返回单帧。 */
export const UPSTREAM_STATUS_GHOST = 422;

/** 同会话并发第二轮被拒时 message 里的特征串。 */
export const CONCURRENT_REJECTED_TEXT = 'session_concurrent_operation_in_progress';

/**
 * 本工程自己定义的错误分类。这个集合是封闭的——分类权在我们手里。
 *
 * `prompt_not_dispatched` 与 `stream_break` 必须分开：后者是"跑了一阵才被掐断，
 * 任务可能仍在服务端执行"；前者是**根本没开始**。实测（2026-09-15，cn-hangzhou）：
 * prompt 被上游以 HTTP 200 收下，SSE 只回一个纯 POP 回执事件 `{"RequestId":"…"}`
 * 就在 0.1~0.7s 内关流；随后 `LoadAgentSession` 回看，历史里只有一个
 * `config_option_update` 帧加一个 `Result.stopReason:"end_turn"` 的空轮次，
 * **没有 user_message_chunk 回显、没有任何 agent 输出**。
 * 对不存在的 SessionId 也是同一个响应（文档承诺的 400 error 帧并没有出现），
 * 且换 CLI/换 wire 形状/换 User-Agent 结果逐字相同 ⇒ 与调用方无关。
 * 把这一类混进 stream_break 会给出错误指引：让用户去"探测是否已完成"，
 * 而真相是这一轮从未派发给执行端。
 */
export const ERROR_KINDS = [
  'stream_break',
  'prompt_not_dispatched',
  'session_ghost',
  'concurrent_rejected',
  'rpc_error',
  'transport',
  'create_empty_body',
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

// ---------------------------------------------------------------------------
// marker（回答归属校验）
// ---------------------------------------------------------------------------

/**
 * marker 前缀。
 *
 * 服务端存在跨会话串答案的历史问题（实测 5 个会话并发时隔离率只有 1/5），
 * 所以每条 prompt 注入一个唯一 marker，并校验回答里确实含它——
 * 这是唯一能自证"这段回答属于我这一轮"的手段。
 */
export const MARKER_PREFIX = 'DAS';

/** 会话归属标记的环境变量默认值。 */
export const DEFAULT_SESSION_SOURCE = 'data-agent-openapi-example';
