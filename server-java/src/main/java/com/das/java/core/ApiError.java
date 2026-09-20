package com.das.java.core;

import java.util.Map;

/**
 * 归一化后的错误。与 Node 实现的 shared/errors.ts 同源同语义：
 * 上游业务错误恒以 HTTP 200 返回，真正的错误在响应体的 JsonRpcResponse.Error 里；
 * 同一个 -32603 实测对应三种完全不同的处境，只有 message 文本能区分。
 */
public record ApiError(
    String kind,
    Integer code,
    String errorCode,
    String message,
    boolean retryable,
    boolean fatalForSession,
    Integer upstreamStatus
) {
    private static final Map<String, boolean[]> RETRY_POLICY = Map.of(
        "stream_break", new boolean[]{false, false},
        // retryable=false 的理由不是"怕重复写入"（实测这一轮压根没落地），
        // 而是原样重发只会再得到一次同样的 POP 回执：5/5 次实测同形，没有信息增量。
        "prompt_not_dispatched", new boolean[]{false, false},
        "session_ghost", new boolean[]{false, true},
        "concurrent_rejected", new boolean[]{true, false},
        "rpc_error", new boolean[]{false, false},
        "transport", new boolean[]{true, false},
        "create_empty_body", new boolean[]{false, false}
    );

    /** 与 Node JSON.stringify 对齐：null 字段整个省略，不输出 null 值；Map.entry 对 null 会 NPE，不能用。 */
    public Map<String, Object> toMap() {
        Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("kind", kind);
        if (code != null) out.put("code", code);
        if (errorCode != null) out.put("errorCode", errorCode);
        out.put("message", message);
        out.put("retryable", retryable);
        out.put("fatalForSession", fatalForSession);
        if (upstreamStatus != null) out.put("upstreamStatus", upstreamStatus);
        return out;
    }

    private static boolean[] policy(String kind) {
        boolean[] p = RETRY_POLICY.get(kind);
        if (p == null) throw new IllegalArgumentException("未知错误 kind：" + kind);
        return p;
    }

    public static ApiError of(String kind, String message) {
        return of(kind, message, null, null, null);
    }

    public static ApiError of(String kind, String message, Integer code, String errorCode, Integer upstreamStatus) {
        boolean[] p = policy(kind);
        return new ApiError(kind, code, errorCode, message, p[0], p[1], upstreamStatus);
    }

    /** 手工造一个归一化错误（重试语义仍由 kind 决定）。 */
    public static ApiError apiError(String kind, String message) {
        return of(kind, message);
    }

    /** 把帧内 / JsonRpcResponse 里的 Error 分成六类。不能只看 code：断流、幽灵化、并发被拒的 code 全是 -32603。 */
    public static ApiError classify(String message, Integer code, String errorCode, Integer upstreamStatus) {
        String msg = message == null ? "" : message;
        if (upstreamStatus != null && upstreamStatus == Constants.UPSTREAM_STATUS_GHOST
            || msg.contains("upstream_status=" + Constants.UPSTREAM_STATUS_GHOST)) {
            return of("session_ghost", msg.isEmpty() ? "upstream returned 422" : msg, code, errorCode, upstreamStatus);
        }
        if (msg.contains(Constants.CONCURRENT_REJECTED_TEXT)) {
            return of("concurrent_rejected", msg, code, errorCode, upstreamStatus);
        }
        if (msg.contains(Constants.STREAM_ENDED_TEXT)) {
            return of("stream_break", msg, code, errorCode, upstreamStatus);
        }
        return of("rpc_error", msg.isEmpty() ? "upstream returned an error without message" : msg, code, errorCode, upstreamStatus);
    }

    public static ApiError streamBreakWithoutTerminal(int frameCount) {
        return of("stream_break",
            Constants.STREAM_ENDED_TEXT + " (received " + frameCount + " frames, no Result.stopReason)",
            null, null, null);
    }

    public static ApiError promptNotDispatched(String popRequestId, Long elapsedMs) {
        String clues = (elapsedMs != null ? elapsedMs + "ms" : null) + "，"
            + (popRequestId != null ? "POP RequestId " + popRequestId : "上游未给出 RequestId");
        return of("prompt_not_dispatched",
            Constants.PROMPT_NOT_DISPATCHED_TEXT + "（" + clues + "）。整轮没有收到任何 ACP 帧，也没有 Result.stopReason。",
            null, null, null);
    }

    public static ApiError transport(String message) {
        return of("transport", message);
    }

    public static ApiError createEmptyBody(String detail) {
        return of("create_empty_body", detail == null ? "empty response body" : detail);
    }

    private static final java.util.regex.Pattern ACCESS_KEY_ID =
        java.util.regex.Pattern.compile("(?:LTAI|STS\\.)[A-Za-z0-9]+");

    /** 上游鉴权类报文会把 AccessKeyId 原文回显，统一在这里脱敏（保留 Deny/source-ip 语义）。 */
    public static ApiError redact(ApiError error) {
        String message = ACCESS_KEY_ID.matcher(error.message).replaceAll("<AccessKeyId 已隐去>");
        return message.equals(error.message) ? error : new ApiError(
            error.kind, error.code, error.errorCode, message,
            error.retryable, error.fatalForSession, error.upstreamStatus
        );
    }
}
