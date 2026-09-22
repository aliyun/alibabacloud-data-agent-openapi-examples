package com.das.java.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** 核心契约模块的单测：错误分类 / 帧解析 / 轮次归约（marker 机制已退役，仅 legacy 清洗另有断言覆盖）。 */
class CoreTest {

    // ------------------------------------------------------------------
    // 错误分类
    // ------------------------------------------------------------------

    @Test
    void errorClassificationSameCodeThreeKinds() {
        // 实测断流、会话幽灵化、并发被拒三种处境的 code 全是 -32603，只有 message 能区分
        ApiError ghost = ApiError.classify("prompt forward failed, upstream_status=422", -32603, "0x48833000000000d1", null);
        assertEquals("session_ghost", ghost.kind());
        assertTrue(ghost.fatalForSession());

        ApiError concurrent = ApiError.classify("session_concurrent_operation_in_progress, tenant_id=x", -32603, null, null);
        assertEquals("concurrent_rejected", concurrent.kind());
        assertTrue(concurrent.retryable());

        ApiError brk = ApiError.classify(Constants.STREAM_ENDED_TEXT, -32603, "0x48833000000000d1", null);
        assertEquals("stream_break", brk.kind());
        assertFalse(brk.retryable());
    }

    @Test
    void errorRedactionHidesAccessKeyId() {
        ApiError error = ApiError.of("transport", "Deny: LTAIabcd1234efgh5678|source ip: 203.0.113.7");
        ApiError redacted = ApiError.redact(error);
        assertFalse(redacted.message().contains("LTAIabcd1234"));
        assertTrue(redacted.message().contains("<AccessKeyId 已隐去>"));
        assertTrue(redacted.message().contains("source ip"));
    }

    // ------------------------------------------------------------------
    // 帧解析
    // ------------------------------------------------------------------

    @Test
    void popAckHandledPerPath() {
        // 实测：上游以 HTTP 200 收下 prompt，SSE 只回一个 {"RequestId":…} 的 POP 回执就关流。
        // 契约：parseRecordedLine（fixture 回放路径）宽松照收；frameFromSdkBody（live 路径）拒收。
        String line = "{\"RequestId\":\"0dd3b146c75bf132a65efa7a3080e7cd\"}";
        Map<String, Object> lenient = Frames.parseRecordedLine(line);
        assertTrue(lenient != null && lenient.containsKey("RequestId"), "回放路径宽松照收");
        assertNull(Frames.frameFromSdkBody(line), "live 路径拒收 POP-only 载荷");
    }

    @Test
    void recordedLineUnwrappedAndParsed() {
        String line = "{\"data\":{\"Jsonrpc\":\"2.0\",\"Params\":{\"_meta\":{\"offset\":7},\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"你好\"}}},\"Result\":{\"stopReason\":\"end_turn\"}}}";
        Map<String, Object> frame = Frames.parseRecordedLine(line);
        assertEquals("2.0", frame.get("Jsonrpc"));
        assertEquals(7, Frames.offsetOf(frame));
        assertEquals("agent_message_chunk", Frames.sessionUpdateOf(frame));
        assertEquals("你好", Frames.textOf(Frames.updateOf(frame)));
        Frames.TerminalInfo terminal = Frames.terminalOf(frame);
        assertEquals("end_turn", terminal.stopReason());
        assertEquals("end_turn", terminal.rawStopReason());
    }

    @Test
    void sdkCamelCaseBodyAccepted() {
        // SDK cast 之后的 camelCase 形状也要认：live 与 mock 才能共用同一个 reducer。
        Map<String, Object> frame = Frames.frameFromSdkBody(Map.of(
            "jsonrpc", "2.0",
            "params", Map.of("update", Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", "你好"))),
            "result", Map.of("stopReason", "end_turn")
        ));
        assertEquals("agent_message_chunk", Frames.sessionUpdateOf(frame));
        assertEquals("end_turn", Frames.terminalOf(frame).stopReason());
    }

    // ------------------------------------------------------------------
    // 轮次归约
    // ------------------------------------------------------------------

    @Test
    void historyReductionTurnCriterion() {
        // 轮次判据：该 rid 名下至少有一条 user_message_chunk。
        // load 自己的 rid（只有 config_option_update + end_turn）不构成轮次。
        List<Map<String, Object>> frames = List.of(
            frameOf("rid-A", "config_option_update", null),
            frameOf("rid-A", "user_message_chunk", "你好"),
            frameOf("rid-A", "agent_message_chunk", "回答"),
            frameOf("load-own-rid", "config_option_update", null)
        );
        Map<String, Object> reduced = Turn.reduceHistory(frames);
        assertEquals(1, ((List<?>) reduced.get("turns")).size());
        assertEquals(1, ((List<?>) reduced.get("nonTurnRids")).size());
        assertTrue(((List<?>) reduced.get("nonTurnRids")).contains("load-own-rid"));
    }

    @Test
    void ridLessFramesAreDropped() {
        // 实测 977 帧里有 900 帧没有 RequestId 键（原始回放污染），不隔离就会每轮显示两遍。
        List<Map<String, Object>> frames = List.of(
            Map.of("Jsonrpc", "2.0", "Params", Map.of("update", Map.of("sessionUpdate", "agent_message_chunk", "content", "污染拷贝"))),
            frameOf("rid-A", "user_message_chunk", "你好")
        );
        Map<String, Object> reduced = Turn.reduceHistory(frames);
        assertEquals(1, reduced.get("droppedRidLess"));
        assertEquals(1, ((List<?>) reduced.get("turns")).size());
    }

    private Map<String, Object> frameOf(String rid, String updateKind, String text) {
        var update = new java.util.LinkedHashMap<String, Object>();
        update.put("sessionUpdate", updateKind);
        if (text != null) update.put("content", Map.of("type", "text", "text", text));
        return Map.of(
            "Jsonrpc", "2.0",
            "RequestId", rid,
            "Params", Map.of("_meta", Map.of("offset", 1), "update", update)
        );
    }
}
