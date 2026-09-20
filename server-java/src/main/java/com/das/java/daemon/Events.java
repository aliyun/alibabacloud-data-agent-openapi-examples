package com.das.java.daemon;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * daemon 兼容层的事件信封与构造器。与 Node 实现的 server-node/daemon/events.ts 同源同语义。
 *
 * 形状对齐 qwen-code 的 daemon REST API 契约（EventEnvelope）：`{v:1, type, data, id?,
 * originatorClientId?, _meta?}`。消费方是 @qwen-code/web-shell（经 @qwen-code/sdk 的
 * RestSseTransport 解析），它按 type 分发 normalize、容忍未知字段，所以这里只保证
 * 已知事件类型的 data 必填字段，其余原样带过。
 */
public final class Events {
    private Events() {}

    public static Map<String, Object> event(String type, Map<String, Object> data, String originatorClientId) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("v", 1);
        out.put("type", type);
        out.put("data", data);
        if (originatorClientId != null) out.put("originatorClientId", originatorClientId);
        return out;
    }

    /**
     * session_update：`data.update` 里是 ACP update 载荷（整包透传，不重塑）。
     *
     * data 形状对齐真 daemon：`{sessionId, update:{...}}`——web-shell 的
     * `getSessionUpdatePayload` 优先读 `data.update`，读不到才退回 data 本体；
     * 若把 update 挂在别的键上，`data.sessionUpdate` 会被当成判别器读出对象而非
     * 字符串，整个事件退化成"未知块"渲染原始 JSON（e2e 实测过这个坑）。
     */
    public static Map<String, Object> sessionUpdate(String sessionId, Map<String, Object> update, String originatorClientId) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("sessionId", sessionId);
        data.put("update", update);
        return event("session_update", data, originatorClientId);
    }

    public static Map<String, Object> turnComplete(String sessionId, String stopReason, String promptId) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("sessionId", sessionId);
        data.put("stopReason", stopReason);
        data.put("promptId", promptId);
        return event("turn_complete", data, null);
    }

    public static Map<String, Object> turnError(String sessionId, String message, String promptId, String code, String errorKind) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("sessionId", sessionId);
        data.put("message", message);
        if (promptId != null) data.put("promptId", promptId);
        if (code != null) data.put("code", code);
        if (errorKind != null) data.put("errorKind", errorKind);
        return event("turn_error", data, null);
    }

    public static Map<String, Object> promptCancelled(String sessionId, String promptId) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("sessionId", sessionId);
        data.put("promptId", promptId);
        return event("prompt_cancelled", data, null);
    }

    /** SSE `?snapshot=1` 时连接即附的快照（合成事件，不入 journal、不带 id）。 */
    public static Map<String, Object> sessionSnapshot(String sessionId) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("sessionId", sessionId);
        data.put("currentModelId", "data-agent");
        data.put("currentApprovalMode", null);
        return event("session_snapshot", data, null);
    }

    /** 返回事件的副本并盖上 journal 序号（不可变语义：journal.id 是唯一注入 id 的地方）。 */
    public static Map<String, Object> withId(Map<String, Object> event, long id) {
        Map<String, Object> out = new LinkedHashMap<>(event);
        out.put("id", id);
        return out;
    }
}
