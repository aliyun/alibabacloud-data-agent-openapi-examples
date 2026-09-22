package com.das.java.live;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.aliyun.sdk.service.dataworks_public20240518.models.PromptAgentSessionResponseBody;
import com.das.java.live.SdkSseStream.SseException;
import com.fasterxml.jackson.databind.ObjectMapper;
import darabonba.core.TeaModel;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * SdkSseStream 的队列骨架与载荷保真测试。模型一律用官方 SDK 的真实类构造照抄
 * 上游线格式（PascalCase 键）；不准手搓假 TeaModel 子类——反射 toMap 的行为
 * 只有在真实生成类上才和线上等价。
 */
class SdkSseStreamTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static PromptAgentSessionResponseBody frame(String method, String text, String requestId, long timestamp) {
        Map<String, Object> update = text == null
            ? Map.of("_meta", Map.of("offset", 1))
            : Map.of("content", Map.of("text", text, "type", "text"), "sessionUpdate", "agent_message_chunk");
        return PromptAgentSessionResponseBody.builder()
            .jsonrpc("2.0")
            .method(method)
            .params(Map.of("sessionId", "sess-1", "update", update))
            .requestId(requestId)
            .timestamp(timestamp)
            .build();
    }

    @Test
    void yieldsWireEquivalentPayloadsInOrder() throws Exception {
        List<TeaModel> items = List.of(
            frame("session/update", "The", "rid-1", 1789026613210L),
            frame("session/update", " answer", "rid-1", 1789026615598L));
        SdkSseStream stream = new SdkSseStream("PromptAgentSession", items.iterator(), () -> 200);

        Map<?, ?> first = MAPPER.readValue(stream.next(), Map.class);
        Map<?, ?> second = MAPPER.readValue(stream.next(), Map.class);
        assertNull(stream.next());

        assertEquals("2.0", first.get("Jsonrpc"));
        assertEquals("session/update", first.get("Method"));
        assertEquals("rid-1", first.get("RequestId"));
        assertEquals(1789026613210L, ((Number) first.get("Timestamp")).longValue());
        @SuppressWarnings("unchecked")
        Map<String, Object> params = (Map<String, Object>) first.get("Params");
        assertEquals("sess-1", params.get("sessionId"));

        @SuppressWarnings("unchecked")
        Map<String, Object> update = (Map<String, Object>) ((Map<String, Object>) second.get("Params")).get("update");
        @SuppressWarnings("unchecked")
        Map<String, Object> content = (Map<String, Object>) update.get("content");
        assertEquals(" answer", content.get("text"));

        // 上游 JSON 省略 null 键；SdkSseStream 剥过顶层 null 后也必须没有 Id/Result/Error
        assertFalse(first.containsKey("Id"));
        assertFalse(first.containsKey("Result"));
        assertFalse(first.containsKey("Error"));
    }

    @Test
    void popAckPayloadKeepsOnlyRequestId() throws Exception {
        SdkSseStream stream = new SdkSseStream("PromptAgentSession",
            List.of(PromptAgentSessionResponseBody.builder().requestId("pop-rid").build()).iterator(), () -> 200);
        Map<?, ?> payload = MAPPER.readValue(stream.next(), Map.class);
        assertEquals(Map.of("RequestId", "pop-rid"), payload);
        assertNull(stream.next());
    }

    @Test
    void iteratorFailureSurfacesAsSseExceptionWithStatus() {
        Iterator<TeaModel> broken = new Iterator<>() {
            private boolean first = true;

            @Override
            public boolean hasNext() {
                if (first) {
                    first = false;
                    return true;
                }
                throw new IllegalStateException("boom");
            }

            @Override
            public TeaModel next() {
                return frame("session/update", "x", "rid", 1L);
            }
        };
        SdkSseStream stream = new SdkSseStream("LoadAgentSession", broken, () -> 502);
        try {
            MAPPER.readValue(stream.next(), Map.class); // 第一帧先到
            SseException e = assertThrows(SseException.class, stream::next);
            assertTrue(e.getMessage().contains("LoadAgentSession"));
            assertTrue(e.getMessage().contains("boom"));
            assertEquals(502, e.statusCode());
        } catch (Exception e) {
            throw new AssertionError(e);
        } finally {
            stream.close();
        }
    }

    @Test
    void stalledStreamFailsFastWithTimeout() {
        Iterator<TeaModel> stalled = new Iterator<>() {
            @Override
            public boolean hasNext() {
                try {
                    Thread.sleep(300);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return false;
            }

            @Override
            public TeaModel next() {
                return null;
            }
        };
        SdkSseStream stream = new SdkSseStream("LoadAgentSession", stalled, () -> 200);
        SseException e = assertThrows(SseException.class, () -> stream.next(50));
        assertTrue(e.getMessage().contains("读停滞超过 50ms"));
        assertNull(e.statusCode());
        stream.close();
    }

    @Test
    void closeTurnsBlockingNextIntoNull() throws Exception {
        List<TeaModel> items = new ArrayList<>();
        items.add(frame("session/update", "only", "rid", 1L));
        SdkSseStream stream = new SdkSseStream("PromptAgentSession", items.iterator(), () -> 200);
        stream.close();
        assertNull(stream.next(3000));
    }
}
