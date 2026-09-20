package com.das.java.core;

/**
 * 实测常量。与 Node 实现的 shared/constants.ts、Python 实现的 constants.py 同源同语义。
 * 任何一个值在 Node 侧变更，这里必须跟着改——三个 server 服务的都是同一个前端。
 */
public final class Constants {
    private Constants() {}

    // Agent 发现
    /** 实测：ListAgents 恒只返回 2 个 chatbi 系 agent，但用这个名字建会话照样成功。 */
    public static final String DEFAULT_AGENT_NAME = "dataworks_data_agent";

    // 时序（毫秒）
    public static final int HEARTBEAT_MS = 15_000;
    /** 实测 17 轮里 SSE 在 218.3~257.8s 被掐断；到点主动收尾成 stream_break。 */
    public static final int STREAM_HARD_LIMIT_MS = 330_000;
    public static final int DEFAULT_READ_TIMEOUT_MS = 600_000;
    /** load 专用：RUNNING 期 load 有 2/4 概率阻塞到轮次结束，快速失败好过挂死。 */
    public static final int HISTORY_READ_TIMEOUT_MS = 30_000;
    public static final int PROBE_DEADLINE_MS = 300_000;
    public static final int PROBE_INTERVAL_MS = 60_000;

    // Mock 回放
    public static final int MOCK_MAX_GAP_MS = 400;
    public static final double MOCK_DEFAULT_SPEED = 4;

    // 轮次终态（已观测到的 Result.stopReason 取值；不是封闭集合，未知值要如实透传）
    public static final String[] STOP_REASONS = {
        "end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"
    };

    // 已观测到的 sessionUpdate 取值（不是封闭集合；reducer 必须容忍未知类型与缺失 update）
    public static final String[] OBSERVED_SESSION_UPDATES = {
        "user_message_chunk", "agent_thought_chunk", "agent_message_chunk",
        "tool_call", "tool_call_update", "usage_update", "config_option_update"
    };
    public static final String[] OBSERVED_TOOL_STATUSES = {
        "pending", "in_progress", "completed", "failed"
    };

    // 错误
    public static final int UPSTREAM_STATUS_GHOST = 422;
    public static final String CONCURRENT_REJECTED_TEXT = "session_concurrent_operation_in_progress";
    public static final String STREAM_ENDED_TEXT = "session stream ended without turn terminal";
    public static final String PROMPT_NOT_DISPATCHED_TEXT = "prompt accepted but never dispatched to an executor";

    // marker（回答归属校验 · 已退役，2026-09-20）：不再注入，仅保留前缀给 legacy 清洗助手
    public static final String MARKER_PREFIX = "DAS";

    // 会话归属标记默认值
    public static final String DEFAULT_SESSION_SOURCE = "data-agent-openapi-demo";

    // wire 协议
    public static final String WIRE_CONTENT_TYPE = "application/x-ndjson";

    public static boolean isKnownStopReason(String raw) {
        for (String r : STOP_REASONS) {
            if (r.equals(raw)) return true;
        }
        return false;
    }

    public static boolean isKnownUpdate(String kind) {
        for (String k : OBSERVED_SESSION_UPDATES) {
            if (k.equals(kind)) return true;
        }
        return false;
    }
}
