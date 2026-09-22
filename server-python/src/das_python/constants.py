"""实测常量。每个数字/字符串都来自真实抓包或源码，与 Node 实现的 shared/constants.ts 同源。

移植纪律：Node 侧改了这里的任何一个值，Python 侧必须跟着改——
两边服务的都是同一个前端，契约不一致就是 bug。
"""

# ---------------------------------------------------------------------------
# Agent 发现
# ---------------------------------------------------------------------------

# 实测：ListAgents 恒只返回 2 个 chatbi 系 agent，返回里没有 data agent（服务端硬编码），
# 但用这个名字建会话照样成功。所以不要靠列表接口去发现 agent，直接写死。
DEFAULT_AGENT_NAME = "dataworks_data_agent"

# ---------------------------------------------------------------------------
# 时序（毫秒）
# ---------------------------------------------------------------------------

HEARTBEAT_MS = 15_000  # 心跳间隔：防中间层空闲回收连接，同时给前端一个判活信号

# 实测 17 轮里 SSE 连接在 218.3~257.8s 之间被服务端掐断，超过这个时长拿不到终态。
# 到点主动收尾成 stream_break，比让连接吊死好——静默截断不能当成功。
STREAM_HARD_LIMIT_MS = 0  # No whole-turn deadline, including human confirmation waits.

# 普通 API 调用的 readTimeout。prompt 一轮实测最长 191s，要给足余量。
DEFAULT_READ_TIMEOUT_MS = 600_000

# load（拉历史）专用 readTimeout，比普通调用短一个数量级。
# 实测在会话 RUNNING 期间调 load，4 次里 2 次阻塞到那一轮跑完（178s、81.6s），
# 另外 2 次 0.1s 返回但内容是假的 end_turn。阻塞不可预测，快速失败好过挂死。
HISTORY_READ_TIMEOUT_MS = 30_000

# 断流之后判"这一轮到底跑完没有"的总时长上限。两个探测器都只能给"完成"信号。
PROBE_DEADLINE_MS = 300_000

# 探测轮询间隔。每次探测都会触发一次 load，RUNNING 期高频轮询会撞阻塞概率。
PROBE_INTERVAL_MS = 60_000

# ---------------------------------------------------------------------------
# Mock 回放
# ---------------------------------------------------------------------------

MOCK_MAX_GAP_MS = 400  # 回放时单帧最大间隔，超过一律压平（只影响观感）
MOCK_DEFAULT_SPEED = 4  # 压平之后再叠的倍速（901 帧压平后仍要 87s）

# ---------------------------------------------------------------------------
# 轮次终态
# ---------------------------------------------------------------------------

# 已观测到的 Result.stopReason 取值。不是封闭集合，未知值要如实透传。
STOP_REASONS = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]

STOP_REASON_TEXT = {
    "end_turn": "本轮正常结束。",
    "max_tokens": "本轮因触达 token 上限被截断，回答不完整。",
    "max_turn_requests": "本轮因触达单轮请求次数上限被截断，回答不完整。",
    "refusal": "本轮被模型拒绝，没有产出回答。",
    "cancelled": "本轮在服务端被取消。",
}

# 已观测到的 Params.update.sessionUpdate 取值。**不是封闭集合**：reducer 必须容忍
# 未知类型，也必须容忍 update 整个缺失（排队通知帧 Method="_qwen/notify" 就没有）。
OBSERVED_SESSION_UPDATES = [
    "user_message_chunk",
    "agent_thought_chunk",
    "agent_message_chunk",
    "tool_call",
    "tool_call_update",
    "usage_update",
    # 只在 load（拉历史）回放里出现，是首帧，带 4 个配置项
    "config_option_update",
]

OBSERVED_TOOL_STATUSES = ["pending", "in_progress", "completed", "failed"]

# ---------------------------------------------------------------------------
# 错误
# ---------------------------------------------------------------------------

# 错误分类。这个集合是封闭的——分类权在我们手里。
ERROR_KINDS = [
    "stream_break",
    "prompt_not_dispatched",
    "session_ghost",
    "concurrent_rejected",
    "rpc_error",
    "transport",
    "create_empty_body",
]

# 会话幽灵化的上游状态码：约 1s 返回，这个会话不能再用，唯一动作是新建。
UPSTREAM_STATUS_GHOST = 422

# 同会话并发第二轮被拒时 message 里的特征串。
CONCURRENT_REJECTED_TEXT = "session_concurrent_operation_in_progress"

# ---------------------------------------------------------------------------
# marker（回答归属校验 · 已退役，2026-09-20）
# ---------------------------------------------------------------------------

# 归属校验机制已退役：不再注入、不做 verified 判定；
# 只保留前缀给 legacy 清洗助手用来识别录制内容里残留的说明。
MARKER_PREFIX = "DAS"

# ---------------------------------------------------------------------------
# 会话归属标记的默认值（示例工程用自己的 source；部署时从 .env 覆盖）
# ---------------------------------------------------------------------------

DEFAULT_SESSION_SOURCE = "data-agent-openapi-demo"
