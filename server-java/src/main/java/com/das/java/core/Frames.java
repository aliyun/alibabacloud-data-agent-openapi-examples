package com.das.java.core;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 上游 ACP JSON-RPC 帧：解析、归一化、访问器。与 Node 实现的 shared/frames.ts 同源同语义。
 *
 * 刻意用宽松 Map（键可选）：真实帧里键会缺、会多、形状会分叉。
 * 严格类型只会带来假安全感——所有取值都走这里的静态 helper，helper 里做运行时判断。
 */
public final class Frames {
    private Frames() {}

    // SDK 响应体与线格式不同名：两种大小写都认（Python 的 to_map 直接吐线格式键，无需转换）。
    private static final String[][] SDK_TO_WIRE = {
        {"Jsonrpc", "jsonrpc"}, {"Method", "method"}, {"Id", "id"}, {"Params", "params"},
        {"Result", "result"}, {"Error", "error"}, {"RequestId", "requestId"}, {"Timestamp", "timestamp"}
    };

    /** 只有这些键不足以构成一个 ACP 帧（实测 POP 层回执只有 RequestId）。 */
    private static final java.util.Set<String> POP_ONLY_KEYS =
        java.util.Set.of("RequestId", "requestId", "Timestamp", "timestamp", "Id", "id");

    @SuppressWarnings("unchecked")
    public static Map<String, Object> asMap(Object value) {
        return value instanceof Map<?, ?> map ? (Map<String, Object>) map : null;
    }

    public static boolean isObject(Object value) {
        return value instanceof Map<?, ?>;
    }

    /** 剥掉录制件外层的 data 信封（fixture 每行形如 {"data":{…帧…}}）。 */
    public static Object unwrapEnvelope(Object value) {
        if (value instanceof Map<?, ?> map && map.size() == 1 && map.containsKey("data")) {
            return map.get("data");
        }
        return value;
    }

    /** SDK 响应体 → 线格式帧。返回 null 表示"这不是一个帧"（缺的键不写；两种大小写都认）。 */
    public static Map<String, Object> frameFromSdkBody(Object body) {
        Object inner = unwrapEnvelope(body);
        if (!(inner instanceof Map<?, ?> innerMap)) return null;

        Map<String, Object> frame = new LinkedHashMap<>();
        int acpKeys = 0;
        for (String[] pair : SDK_TO_WIRE) {
            String wire = pair[0], sdk = pair[1];
            if (innerMap.containsKey(wire)) {
                frame.put(wire, innerMap.get(wire));
                if (!POP_ONLY_KEYS.contains(wire)) acpKeys += 1;
            } else if (innerMap.containsKey(sdk)) {
                frame.put(wire, innerMap.get(sdk));
                if (!POP_ONLY_KEYS.contains(wire)) acpKeys += 1;
            }
        }
        // 一个 ACP 层键都没有 ⇒ 不是帧：只有 RequestId 的 POP 回执，或信封反解后字段全丢。
        if (acpKeys == 0) return null;

        for (Map.Entry<?, ?> entry : innerMap.entrySet()) {
            String key = String.valueOf(entry.getKey());
            if (frame.containsKey(key)) continue;
            frame.put(key, entry.getValue());
        }
        return frame;
    }

    /** 从"只有 POP 回执"的载荷里把 RequestId 捞出来（零帧场景唯一可查的线索，不是 rid）。 */
    public static String popAckRequestId(Object body) {
        Object inner = unwrapEnvelope(body);
        if (!(inner instanceof Map<?, ?> map)) return null;
        Object value = map.containsKey("RequestId") ? map.get("RequestId") : map.get("requestId");
        return value instanceof String s && !s.isEmpty() ? s : null;
    }

    /** 解析一行录制件（带信封）为帧；无法解析时返回 null。 */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseRecordedLine(String line) {
        if (line == null || line.trim().isEmpty()) return null;
        try {
            Object parsed = new com.fasterxml.jackson.databind.ObjectMapper().readValue(line, Map.class);
            Object inner = unwrapEnvelope(parsed);
            return inner instanceof Map<?, ?> map ? (Map<String, Object>) map : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** 判据必须是键是否存在：实测 977 行里 900 行压根没有 RequestId 键，而 "" 命中 0 行。 */
    public static boolean hasRequestId(Map<String, Object> frame) {
        return frame.containsKey("RequestId");
    }

    public static String requestIdOf(Map<String, Object> frame) {
        if (hasRequestId(frame) && frame.get("RequestId") instanceof String s) return s;
        return null;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> paramsOf(Map<String, Object> frame) {
        return frame.get("Params") instanceof Map<?, ?> m ? (Map<String, Object>) m : null;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> updateOf(Map<String, Object> frame) {
        Map<String, Object> params = paramsOf(frame);
        if (params == null) return null;
        return params.get("update") instanceof Map<?, ?> m ? (Map<String, Object>) m : null;
    }

    public static String sessionUpdateOf(Map<String, Object> frame) {
        Map<String, Object> update = updateOf(frame);
        if (update == null) return null;
        return update.get("sessionUpdate") instanceof String s ? s : null;
    }

    /** 帧序号。不可持久化：空闲约 5 分钟后服务端计数器会重置（实测从 391 回到 1）。 */
    public static Integer offsetOf(Map<String, Object> frame) {
        Map<String, Object> params = paramsOf(frame);
        if (params == null) return null;
        if (params.get("_meta") instanceof Map<?, ?> meta && meta.get("offset") instanceof Number n) return n.intValue();
        return null;
    }

    /** 毫秒时间戳。Jackson 解析大整数给 Long（epoch ms 超 Integer 上限），必须按 Number 接。 */
    public static Long timestampOf(Map<String, Object> frame) {
        return frame.get("Timestamp") instanceof Number n ? n.longValue() : null;
    }

    public static String sessionIdOf(Map<String, Object> frame) {
        Map<String, Object> params = paramsOf(frame);
        if (params == null) return null;
        return params.get("sessionId") instanceof String s ? s : null;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> errorOf(Map<String, Object> frame) {
        return frame.get("Error") instanceof Map<?, ?> m ? (Map<String, Object>) m : null;
    }

    /** 轮次终态。只看顶层 Result.stopReason；空壳不算终态（静默截断不能当成功）。 */
    public static TerminalInfo terminalOf(Map<String, Object> frame) {
        if (!(frame.get("Result") instanceof Map<?, ?> result)) return null;
        if (!(result.get("stopReason") instanceof String raw) || raw.isEmpty()) return null;
        String known = null;
        for (String r : Constants.STOP_REASONS) {
            if (r.equals(raw)) {
                known = r;
                break;
            }
        }
        return new TerminalInfo(known, raw);
    }

    public record TerminalInfo(String stopReason, String rawStopReason) {}

    /** 取文本内容，同时处理两种真实形状（tool_call_update 完成帧的 content 是双层嵌套数组）。 */
    public static String textOf(Map<String, Object> update) {
        if (update == null) return "";
        Object content = update.get("content");
        if (content instanceof String s) return s;
        if (content instanceof Map<?, ?> map) {
            return map.get("text") instanceof String s ? s : "";
        }
        if (content instanceof List<?> list) {
            StringBuilder parts = new StringBuilder();
            for (Object item : list) {
                if (item instanceof String s) {
                    parts.append(s);
                    continue;
                }
                if (item instanceof Map<?, ?> map) {
                    Map<String, Object> nested = asMap(map.get("content"));
                    if (nested == null) nested = asMap(map);
                    if (nested != null && nested.get("text") instanceof String s) parts.append(s);
                }
            }
            return parts.toString();
        }
        return "";
    }

    /** 工具执行结果文本：优先双层嵌套，退同级 rawOutput。 */
    public static String toolResultText(Map<String, Object> update) {
        String fromContent = textOf(update);
        if (!fromContent.isEmpty()) return fromContent;
        if (update == null) return null;
        Object raw = update.get("rawOutput");
        if (raw instanceof String s && !s.isEmpty()) return s;
        if (raw instanceof Map<?, ?> map && map.get("text") instanceof String s && !s.isEmpty()) return s;
        return null;
    }

    public static Map<String, Object> tokenUsageOf(Map<String, Object> update) {
        if (update == null) return null;
        if (update.get("_meta") instanceof Map<?, ?> meta && meta.get("usage") instanceof Map<?, ?> usage) {
            return (Map<String, Object>) usage;
        }
        return null;
    }

    public static String toolNameOf(Map<String, Object> update) {
        if (update == null) return null;
        if (update.get("_meta") instanceof Map<?, ?> meta && meta.get("toolName") instanceof String s && !s.isEmpty()) {
            return s;
        }
        return null;
    }

    /** 工具操作的对象位置。全部录制件里恒为空数组；宽松解析，上游填上就直接显示。 */
    public static List<String> locationsOf(Map<String, Object> update) {
        if (update == null || !(update.get("locations") instanceof List<?> raw)) return new ArrayList<>();
        List<String> out = new ArrayList<>();
        for (Object item : raw) {
            if (item instanceof String s) {
                if (!s.isEmpty()) out.add(s);
                continue;
            }
            if (!(item instanceof Map<?, ?> map)) continue;
            for (String key : new String[]{"path", "pathname", "uri", "name"}) {
                if (map.get(key) instanceof String s && !s.isEmpty()) {
                    out.add(s);
                    break;
                }
            }
        }
        return out;
    }

    // ------------------------------------------------------------------
    // 人卡交互（permission_request / permission_resolved）
    // ------------------------------------------------------------------

    /** 从 _qwen/notify 帧里解析人卡请求；不是权限请求帧时返回 null。 */
    public static Map<String, Object> pendingInteractionOf(Map<String, Object> frame) {
        Map<String, Object> params = paramsOf(frame);
        if (params == null || !"permission_request".equals(params.get("kind"))) return null;
        if (!(params.get("data") instanceof Map<?, ?> dataMap)) return null;
        String requestId = dataMap.get("requestId") instanceof String s && !s.isEmpty() ? s : null;
        if (requestId == null) return null;

        Map<String, Object> toolCall = asMap(dataMap.get("toolCall"));
        Map<String, Object> meta = toolCall == null ? null : asMap(toolCall.get("_meta"));
        String toolName = meta != null && meta.get("toolName") instanceof String s && !s.isEmpty() ? s : null;
        String interactionKind = meta != null && "user_question".equals(meta.get("qwenInteractionKind"))
            ? "user_question" : "permission";

        List<Map<String, Object>> questions = new ArrayList<>();
        List<?> rawQuestions = null;
        if (toolCall != null && toolCall.get("rawInput") instanceof Map<?, ?> rawInput
            && rawInput.get("questions") instanceof List<?> q) {
            rawQuestions = q;
        } else if (meta != null && meta.get("qwenQuestions") instanceof List<?> q) {
            rawQuestions = q;
        }
        if (rawQuestions != null) {
            for (Object qo : rawQuestions) {
                if (!(qo instanceof Map<?, ?> q) || !(q.get("question") instanceof String question)) continue;
                List<Map<String, Object>> opts = new ArrayList<>();
                if (q.get("options") instanceof List<?> optList) {
                    for (Object oo : optList) {
                        if (oo instanceof Map<?, ?> o && o.get("label") instanceof String label) {
                            Map<String, Object> opt = new LinkedHashMap<>();
                            opt.put("label", label);
                            if (o.get("description") instanceof String d) opt.put("description", d);
                            opts.add(opt);
                        }
                    }
                }
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("question", question);
                if (q.get("header") instanceof String header) entry.put("header", header);
                entry.put("options", opts);
                questions.add(entry);
            }
        }

        List<Map<String, Object>> options = new ArrayList<>();
        if (dataMap.get("options") instanceof List<?> optList) {
            for (Object oo : optList) {
                if (oo instanceof Map<?, ?> o && o.get("optionId") instanceof String optionId && !optionId.isEmpty()) {
                    Map<String, Object> opt = new LinkedHashMap<>();
                    opt.put("optionId", optionId);
                    if (o.get("name") instanceof String name) opt.put("name", name);
                    if (o.get("kind") instanceof String kind) opt.put("kind", kind);
                    options.add(opt);
                }
            }
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("requestId", requestId);
        out.put("sessionId", dataMap.get("sessionId") instanceof String s ? s : null);
        out.put("toolName", toolName);
        out.put("interactionKind", interactionKind);
        out.put("toolCallTitle", toolCall != null && toolCall.get("title") instanceof String t ? t : null);
        out.put("toolCallId", toolCall != null && toolCall.get("toolCallId") instanceof String t ? t : null);
        out.put("questions", questions);
        out.put("options", options);
        return out;
    }

    public static Map<String, String> permissionResolvedOf(Map<String, Object> frame) {
        Map<String, Object> params = paramsOf(frame);
        if (params == null || !"permission_resolved".equals(params.get("kind"))) return null;
        if (!(params.get("data") instanceof Map<?, ?> dataMap)) return null;
        if (dataMap.get("requestId") instanceof String requestId && !requestId.isEmpty()) {
            return Map.of("requestId", requestId);
        }
        return null;
    }
}
