package com.das.java.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 前后端之间的流式 wire 协议：NDJSON，一行一个 JSON 对象。
 * 与 Node 实现的 shared/protocol.ts、Python 实现的 protocol.py 同源同语义。
 *
 * POST 响应使用 NDJSON。上游断流由后端按原轮 offset 调 LoadAgentSession 续接，
 * 不依赖浏览器 EventSource / Last-Event-ID，也不重发 Prompt。
 */
public final class Wire {
    private Wire() {}

    public static final String CONTENT_TYPE = "application/x-ndjson";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /**
     * 事件 → 一行 NDJSON（不含换行符）。
     * 与 Node 的 JSON.stringify 字节级对齐：null 字段被省略而不是输出 null
     * （只剥事件顶层；body（上游帧原样透传）里的 null 是上游数据，照常输出）。
     */
    public static String serialize(Map<String, Object> event) {
        Map<String, Object> stripped = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : event.entrySet()) {
            if (e.getValue() != null) stripped.put(e.getKey(), e.getValue());
        }
        try {
            return MAPPER.writeValueAsString(stripped);
        } catch (Exception e) {
            throw new IllegalStateException("wire 事件序列化失败：" + e.getMessage(), e);
        }
    }

    /** 心跳事件。 */
    public static Map<String, Object> heartbeat(long nowMs) {
        Map<String, Object> hb = new LinkedHashMap<>();
        hb.put("type", "hb");
        hb.put("t", nowMs);
        return hb;
    }
}
