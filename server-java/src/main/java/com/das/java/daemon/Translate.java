package com.das.java.daemon;

import com.das.java.core.Frames;
import com.das.java.core.Marker;
import com.das.java.core.Rid;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 上游 ACP 帧 → daemon `session_update` 事件。与 Node 实现的 server-node/daemon/translate.ts
 * 同源同语义。
 *
 * update 载荷**整包透传**（与 pipeline「帧原样透传、不重塑」同一哲学）：
 * 两边同出 ACP 血统，tool_call / tool_call_update / usage_update /
 * config_option_update 的字段名天然对得上 web-shell 的 normalizer；
 * 未知 update 类型也原样带过——normalizer 容忍未知，重塑反而会把上游新字段静默丢掉。
 */
public final class Translate {
    private Translate() {}

    /**
     * 帧 → session_update 事件；null 表示这帧不产出事件：排队通知帧（无 update）、
     * update 缺 sessionUpdate 键、以及纯终态/错误帧（它们走 turn_complete/turn_error）。
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> frameToSessionUpdate(
        Map<String, Object> frame, String sessionId, boolean stripMarker, String originatorClientId) {
        Map<String, Object> update = Frames.updateOf(frame);
        if (update == null) return null;
        String kind = Frames.sessionUpdateOf(frame);
        if (kind == null) return null;

        Map<String, Object> payload = new LinkedHashMap<>(update);
        if ("user_message_chunk".equals(kind) && stripMarker) {
            // 服务端注入的校验码说明会随上游回显一起回来，展示层必须剥掉。
            // content 重建为单文本块：回显的 content 形状一致（{type:'text',text}），重建即剥离。
            Map<String, Object> content = new LinkedHashMap<>();
            content.put("type", "text");
            content.put("text", Marker.stripMarkerInstruction(Frames.textOf(update)));
            payload.put("content", content);
        }
        /**
         * agent 思考/回答的 chunk 文本在这一层**必须原样透传**：
         * 逐 chunk 调整文 strip 会把 markdown 段落/代码块围栏的边界空白吃光——
         * marker 剥离机制已退役（2026-09-20），不再有任何剥除器。
         */
        return Events.sessionUpdate(sessionId, payload, originatorClientId);
    }

    /**
     * 历史帧过滤：与 `reduceHistory` 同源的判据——按 rid 分组后，只有名下含
     * `user_message_chunk` 的 rid 才是真实轮次。
     *
     * 丢掉的两类都不能进 journal：
     *  · rid-less 帧：原始回放污染，是同一轮内容的第二份拷贝（实测 977 帧里 900 帧），不丢则显示两遍；
     *  · 无 user_message_chunk 的 rid：典型是 load 调用自己的 rid（一个伪 end_turn 空轮次）。
     */
    public static List<Map<String, Object>> filterHistoryFrames(List<Map<String, Object>> frames) {
        Rid.Partition partition = Rid.partitionByRid(frames);
        List<Map<String, Object>> out = new ArrayList<>();
        for (List<Map<String, Object>> group : partition.byRid().values()) {
            boolean isTurn = group.stream().anyMatch(f -> "user_message_chunk".equals(Frames.sessionUpdateOf(f)));
            if (isTurn) out.addAll(group);
        }
        return out;
    }

    // ------------------------------------------------------------------
    // permission：把 `_qwen/notify` 帧翻译成 daemon 的 permission 事件。
    // 上游的通知不能当 session_update 发——它有专门的 permission 事件契约；
    // 此前这些帧被整帧丢弃（updateOf 拿不到 → return null），这就是「没有弹框」的根因。
    // ------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    public static Map<String, Object> frameToPermissionEvent(Map<String, Object> frame, String sessionId) {
        Map<String, Object> pending = Frames.pendingInteractionOf(frame);
        if (pending != null) {
            Map<String, Object> params = Frames.paramsOf(frame);
            Object data = params != null ? params.get("data") : null;
            Map<String, Object> dataMap = data instanceof Map<?, ?> m ? (Map<String, Object>) m : null;
            Map<String, Object> toolCall = dataMap != null && dataMap.get("toolCall") instanceof Map<?, ?> m
                ? (Map<String, Object>) m : null;
            Object title = pending.get("toolCallTitle");
            return Events.permissionRequest(
                sessionId,
                String.valueOf(pending.get("requestId")),
                toolCall,
                title instanceof String s ? s : null,
                (java.util.List<Map<String, Object>>) pending.get("options")
            );
        }
        Map<String, String> resolved = Frames.permissionResolvedOf(frame);
        if (resolved != null) {
            Map<String, Object> params = Frames.paramsOf(frame);
            Object data = params != null ? params.get("data") : null;
            Map<String, Object> outcome = null;
            if (data instanceof Map<?, ?> dataMap && dataMap.get("outcome") instanceof Map<?, ?> o) {
                outcome = (Map<String, Object>) o;
            }
            if (outcome == null) outcome = java.util.Map.of("outcome", "selected");
            return Events.permissionResolved(sessionId, resolved.get("requestId"), outcome);
        }
        return null;
    }

    /**
     * 历史帧 → journal 种子事件：过滤（同 reduceHistory 判据）+ 翻译 + user 回显去重。
     *
     * 去重判据与 shared reducer 同源：归档态里同一句提示词会出现两条完全相同的
     * user_message_chunk（一条 bridge-echo 拷贝），reducer 靠 `text ≠ 已累积文本`
     * 跳过整块重复；journal 不做同样的事，web-shell 就会把提示词显示两遍
     * （e2e 实测：mock-tools 历史里每个 prompt 都双份）。
     */
    @SuppressWarnings("unchecked")
    public static List<Map<String, Object>> historyFramesToEvents(List<Map<String, Object>> frames, String sessionId) {
        Rid.Partition partition = Rid.partitionByRid(frames);
        List<Map<String, Object>> out = new ArrayList<>();
        for (List<Map<String, Object>> group : partition.byRid().values()) {
            boolean isTurn = group.stream().anyMatch(f -> "user_message_chunk".equals(Frames.sessionUpdateOf(f)));
            if (!isTurn) continue;
            String userText = "";
            for (Map<String, Object> frame : group) {
                Map<String, Object> permissionEvent = frameToPermissionEvent(frame, sessionId);
                if (permissionEvent != null) {
                    out.add(permissionEvent);
                    continue;
                }
                Map<String, Object> event = frameToSessionUpdate(frame, sessionId, true, null);
                if (event == null) continue;
                Map<String, Object> update = (Map<String, Object>) ((Map<String, Object>) event.get("data")).get("update");
                String kind = update.get("sessionUpdate") instanceof String s ? s : null;
                if ("user_message_chunk".equals(kind)) {
                    String text = textOf(update);
                    if (!text.isEmpty() && text.equals(userText)) continue;
                    userText += text;
                }
                // agent 思考/回答的 chunk 文本原样透传（marker 剥离机制已退役，不再有任何剥除器）
                out.add(event);
            }
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static String textOf(Map<String, Object> update) {
        Object content = update.get("content");
        if (content instanceof Map<?, ?> map && map.get("text") instanceof String s) return s;
        if (content instanceof String s) return s;
        return "";
    }
}
