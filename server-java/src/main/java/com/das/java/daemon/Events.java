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

    // ------------------------------------------------------------------
    // permission：上游 `_qwen/notify` 帧 → daemon `permission_request` / `permission_resolved`
    // （事件类型名与 data 键名以 @qwen-code/sdk 的事件契约为准；toolCall 原样透传含
    //  _meta.toolName / rawInput，options 映射成 web-shell 期望的 {optionId,label,kind}（SDK 归一化后才成为 option.raw.kind））。
    // ------------------------------------------------------------------

    /**
     * 合成线协议 kind（web-shell 提交按钮只认 allow_once/allow_always/reject_once/reject_always）。
     * 上游 DataAgent 选项不带 kind 字段，只能按 optionId 文本语义合成：
     * cancel/reject/deny → reject_once；含 always → allow_always；其它一律 allow_once
     * （没它"提交"按钮恒 disabled——「提交选项不可用」的真正根因）。
     */
    private static String pickOptionKind(String optionId, String kind) {
        if (kind != null && !kind.isEmpty()) return kind;
        String id = optionId.toLowerCase();
        if (id.matches(".*(cancel|reject|deny).*$")) return "reject_once";
        if (id.contains("always")) return "allow_always";
        return "allow_once";
    }

    public static final String OPENAPI_ANSWERS_OPTION = "__openapi_answers__";

    public static Map<String, Object> permissionRequest(
        String sessionId,
        String requestId,
        Map<String, Object> toolCall,
        String title,
        java.util.List<Map<String, Object>> options
    ) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("requestId", requestId);
        data.put("sessionId", sessionId);
        data.put("toolCall", toolCall);
        java.util.List<Map<String, Object>> mappedOptions = new java.util.ArrayList<>();
        for (Map<String, Object> option : options) {
            Object optionId = option.get("optionId");
            if (optionId == null || String.valueOf(optionId).isEmpty()) continue;
            Map<String, Object> mapped = new LinkedHashMap<>();
            mapped.put("optionId", String.valueOf(optionId));
            Object name = option.get("name");
            mapped.put("label", name != null && !String.valueOf(name).isEmpty()
                ? String.valueOf(name) : String.valueOf(optionId));
            String kindStr = String.valueOf(optionId);
            Object kind = option.get("kind");
            mapped.put("kind", pickOptionKind(kindStr, kind instanceof String s ? s : ""));
            mappedOptions.add(mapped);
        }
        Object meta = toolCall != null ? toolCall.get("_meta") : null;
        boolean isQuestion = meta instanceof Map<?, ?> m &&
            ("user_question".equals(m.get("qwenInteractionKind")) || "ask_user_question".equals(m.get("toolName")));
        if (isQuestion && mappedOptions.stream().noneMatch(o ->
                "allow_once".equals(o.get("kind")))) {
            mappedOptions.add(Map.of("optionId", OPENAPI_ANSWERS_OPTION, "label", "提交回答", "kind", "allow_once"));
            data.put("openApiAnswersOnly", true);
        }
        data.put("options", mappedOptions);
        if (title != null) data.put("title", title);
        return event("permission_request", data, null);
    }

    public static Map<String, Object> permissionResolved(String sessionId, String requestId, Map<String, Object> outcome) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("requestId", requestId);
        data.put("sessionId", sessionId);
        data.put("outcome", outcome);
        return event("permission_resolved", data, null);
    }
}
