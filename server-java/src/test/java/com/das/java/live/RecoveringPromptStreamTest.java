package com.das.java.live;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class RecoveringPromptStreamTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    static String chunk(int offset) throws Exception { return JSON.writeValueAsString(Map.of("Jsonrpc", "2.0", "RequestId", "turn",
        "Params", Map.of("sessionId", "session", "_meta", Map.of("offset", offset), "update", Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", "x"))))); }
    static String end(String id, String rid, String reason) throws Exception { return JSON.writeValueAsString(Map.of("Jsonrpc", "2.0",
        "RequestId", rid, "Id", id, "Result", Map.of("stopReason", reason))); }
    static class Source implements RecoveringPromptStream.Source {
        final List<String> rows; int i; boolean closed; Exception error;
        Source(List<String> rows) { this.rows = rows; }
        public String rpcId() { return "load"; }
        public String next(long timeout) throws Exception { if (i < rows.size()) return rows.get(i++); if (error != null) throw error; return null; }
        public void close() { closed = true; }
    }
    static List<String> collect(RecoveringPromptStream stream) throws Exception {
        try (stream) { List<String> out = new ArrayList<>(); String next; while ((next = stream.next()) != null) out.add(next); return out; }
    }
    @Test void interleavedRequestsInTheSameSessionKeepIndependentRidOffsetAndTerminals() throws Exception {
        String a1 = chunk(1).replace("\"turn\"", "\"rid-A\"");
        String a2 = chunk(2).replace("\"turn\"", "\"rid-A\"");
        String b7 = chunk(7).replace("\"turn\"", "\"rid-B\"");
        String b8 = chunk(8).replace("\"turn\"", "\"rid-B\"");
        List<Long> offsetsA = new ArrayList<>();
        List<Long> offsetsB = new ArrayList<>();
        try (var a = new RecoveringPromptStream("request-A", new Source(List.of(a1)), (offset, remaining) -> {
            offsetsA.add(offset);
            return new Source(List.of(end("request-B", "rid-B", "cancelled"), a2, end("request-A", "rid-A", "end_turn")));
        }, 1, 1000, 0);
             var b = new RecoveringPromptStream("request-B", new Source(List.of(b7)), (offset, remaining) -> {
                 offsetsB.add(offset);
                 return new Source(List.of(end("request-A", "rid-A", "cancelled"), b8, end("request-B", "rid-B", "end_turn")));
             }, 1, 1000, 0)) {
            assertEquals(a1, a.next());
            assertEquals(b7, b.next());
            assertEquals(a2, a.next());
            assertEquals(b8, b.next());
            assertEquals(end("request-A", "rid-A", "end_turn"), a.next());
            assertEquals(end("request-B", "rid-B", "end_turn"), b.next());
            assertNull(a.next()); assertNull(b.next());
            assertEquals(List.of(1L), offsetsA);
            assertEquals(List.of(7L), offsetsB);
        }
    }

    @Test void resumesWithoutDuplicatingOrAcceptingLoadTerminal() throws Exception {
        List<Long> calls = new ArrayList<>();
        var first = new Source(List.of(chunk(1)));
        var stream = new RecoveringPromptStream("prompt", first, (offset, remaining) -> {
            calls.add(offset);
            return new Source(List.of(end("load", "load-rid", "end_turn"), end("load", "turn", "end_turn"), chunk(1), chunk(2), end("prompt", "turn", "end_turn")));
        }, 3, 10000, 0);
        assertEquals(List.of(chunk(1), chunk(2), end("prompt", "turn", "end_turn")), collect(stream));
        assertEquals(List.of(1L), calls); assertTrue(first.closed);
    }
    @Test void runningBufferMayOmitRequestIdButMustMatchSession() throws Exception {
        var bufferedMap = JSON.readValue(chunk(2), java.util.LinkedHashMap.class);
        bufferedMap.remove("RequestId");
        String buffered = JSON.writeValueAsString(bufferedMap);
        var foreignMap = JSON.readValue(chunk(99), java.util.LinkedHashMap.class);
        foreignMap.remove("RequestId");
        ((Map<String, Object>)foreignMap.get("Params")).put("sessionId", "other");
        String foreign = JSON.writeValueAsString(foreignMap);
        var stream = new RecoveringPromptStream("prompt", new Source(List.of(chunk(1))),
            (offset, remaining) -> new Source(List.of(foreign, buffered, end("prompt", "turn", "end_turn"))), 3, 10000, 0);
        assertEquals(List.of(chunk(1), buffered, end("prompt", "turn", "end_turn")), collect(stream));
    }
    @Test void repeatedDisconnectsAdvanceCursorAndAreBounded() throws Exception {
        List<Long> calls = new ArrayList<>();
        var stream = new RecoveringPromptStream("prompt", new Source(List.of(chunk(1))), (offset, remaining) -> {
            calls.add(offset); return new Source(offset == 1 ? List.of(chunk(2)) : List.of());
        }, 3, 10000, 0);
        assertEquals(List.of(chunk(1), chunk(2)), collect(stream)); assertEquals(List.of(1L, 2L, 2L), calls);
    }
    @Test void cancelledTerminalNeverReconnects() throws Exception {
        var stream = new RecoveringPromptStream("prompt", new Source(List.of(chunk(1), end("prompt", "turn", "cancelled"))),
            (offset, remaining) -> { throw new AssertionError("must not Load"); });
        assertEquals(2, collect(stream).size());
    }
    @Test void missingCursorAndBusinessErrorsNeverReconnect() throws Exception {
        for (String frame : List.of("{\"Jsonrpc\":\"2.0\",\"RequestId\":\"turn\"}", "{\"Error\":{\"code\":-32603,\"message\":\"permission_required\"}}")) {
            var stream = new RecoveringPromptStream("prompt", new Source(List.of(frame)),
                (offset, remaining) -> { throw new AssertionError("must not Load"); });
            assertEquals(1, collect(stream).size());
        }
    }
    @Test void transportFailureCanResumeButForbiddenCannot() throws Exception {
        Source first = new Source(List.of(chunk(1))); first.error = new IOException("reset");
        assertEquals(2, collect(new RecoveringPromptStream("prompt", first,
            (offset, remaining) -> new Source(List.of(end("prompt", "turn", "end_turn"))), 3, 10000, 0)).size());
        List<Long> calls = new ArrayList<>();
        var stream = new RecoveringPromptStream("prompt", new Source(List.of(chunk(1))), (offset, remaining) -> {
            calls.add(offset); Source denied = new Source(List.of()); denied.error = new SdkSseStream.SseException("denied", 403); return denied;
        }, 3, 10000, 0);
        var failure = assertThrows(Normalize.DasApiException.class, () -> collect(stream));
        assertEquals(403, failure.apiError().upstreamStatus()); assertEquals(1, calls.size());
    }
    @Test void closingConsumerDoesNotReconnect() throws Exception {
        Source first = new Source(List.of(chunk(1)));
        var stream = new RecoveringPromptStream("prompt", first, (offset, remaining) -> { throw new AssertionError("must not Load"); });
        assertNotNull(stream.next()); stream.close(); assertNull(stream.next()); assertTrue(first.closed);
    }
    @Test void loadRpcFailureIsNotIgnoredAsForeignHistory() throws Exception {
        List<Long> calls = new ArrayList<>();
        var stream = new RecoveringPromptStream("prompt", new Source(List.of(chunk(1))), (offset, remaining) -> {
            calls.add(offset);
            return new Source(List.of("{\"Id\":\"load\",\"RequestId\":\"load-rid\",\"Error\":{\"code\":-32603,\"message\":\"permission_required\"}}"));
        }, 3, 10000, 0);
        var failure = assertThrows(Normalize.DasApiException.class, () -> collect(stream));
        assertTrue(failure.getMessage().contains("permission_required"));
        assertEquals(1, calls.size());
    }
    @Test void unpositionedReplayCannotReportSuccess() throws Exception {
        var unsafe = JSON.readValue(chunk(2), java.util.LinkedHashMap.class);
        ((Map<String, Object>)unsafe.get("Params")).remove("_meta");
        String replay = JSON.writeValueAsString(unsafe);
        var stream = new RecoveringPromptStream("prompt", new Source(List.of(chunk(1))),
            (offset, remaining) -> new Source(List.of(replay, end("prompt", "turn", "end_turn"))), 3, 10000, 0);
        var failure = assertThrows(Normalize.DasApiException.class, () -> collect(stream));
        assertEquals("stream_break", failure.apiError().kind());
    }
    @Test void recoveringLoadErrorUsesItsOwnAckAndPreservesExistingRecoveryPolicy() throws Exception {
        var original = new Source(List.of("{\"RequestId\":\"prompt-pop\"}", chunk(1)));
        var calls = new ArrayList<Long>();
        try (var stream = new RecoveringPromptStream("prompt", original, (offset, remaining) -> {
            calls.add(offset);
            return new Source(List.of("{\"RequestId\":\"load-pop\"}",
                "{\"Id\":\"load\",\"RequestId\":\"load-rid\",\"Error\":{\"message\":\"denied\"}}"));
        }, 3, 1000, 0)) {
            stream.next(); stream.next();
            var error = assertThrows(Normalize.DasApiException.class, stream::next);
            assertEquals("load-pop", error.apiError().requestId());
            assertEquals(List.of(1L), calls);
        }
    }


    @Test void recoveryDoesNotReusePromptIdWhenLoadHasNoPopMetadata() throws Exception {
        for (boolean eof : new boolean[]{false, true}) {
            var original = new Source(List.of("{\"RequestId\":\"prompt-pop\"}", chunk(1)));
            try (var stream = new RecoveringPromptStream("prompt", original, (offset, remaining) ->
                new Source(eof ? List.of() : List.of("{\"Id\":\"load\",\"RequestId\":\"load-rid\",\"Error\":{\"message\":\"denied\"}}")), 1, 1000, 0)) {
                stream.next(); stream.next();
                if (eof) assertNull(stream.next());
                else assertNull(assertThrows(Normalize.DasApiException.class, stream::next).apiError().requestId());
                assertNull(stream.requestId());
            }
        }
    }

    @Test void headerWinsOverExceptionMetadataAndForeignErrorsStayFiltered() throws Exception {
        var source = new Source(List.of("{\"RequestId\":\"ack-id\"}")) {
            public String requestId() { return "header-id"; }
        };
        source.error = new Normalize.DasApiException(com.das.java.core.ApiError.apiError("rpc_error", "denied").withRequestId("exception-id"));
        try (var stream = new RecoveringPromptStream("prompt", source, (o, r) -> { throw new AssertionError(); })) {
            assertNotNull(stream.next());
            assertEquals("header-id", assertThrows(Normalize.DasApiException.class, stream::next).apiError().requestId());
        }
        var stream = new RecoveringPromptStream("prompt", new Source(List.of(chunk(1))), (o, r) -> new Source(List.of(
            "{\"RequestId\":\"foreign-rid\",\"Error\":{\"message\":\"old turn failed\"}}", end("prompt", "turn", "end_turn"))), 1, 1000, 0);
        assertEquals(List.of(chunk(1), end("prompt", "turn", "end_turn")), collect(stream));
    }

    @Test void lastTransportExceptionIdSurvivesExhaustionAndResetsOnNextLoad() throws Exception {
        var calls = new ArrayList<Integer>();
        try (var stream = new RecoveringPromptStream("prompt", new Source(List.of(chunk(1))), (o, r) -> {
            calls.add(1);
            var source = new Source(List.of());
            source.error = new Normalize.DasApiException(com.das.java.core.ApiError.transport("reset").withRequestId("last-load"));
            return source;
        }, 1, 1000, 0)) {
            assertNotNull(stream.next()); assertNull(stream.next());
            assertEquals("last-load", stream.requestId()); assertEquals(1, calls.size());
        }
        calls.clear();
        try (var stream = new RecoveringPromptStream("prompt", new Source(List.of(chunk(1))), (o, r) -> {
            var source = new Source(calls.isEmpty() ? List.of("{\"RequestId\":\"old-load\"}") : List.of());
            if (!calls.isEmpty()) source.error = new Normalize.DasApiException(com.das.java.core.ApiError.apiError("rpc_error", "denied"));
            calls.add(1); return source;
        }, 2, 1000, 0)) {
            assertNotNull(stream.next());
            assertNull(assertThrows(Normalize.DasApiException.class, stream::next).apiError().requestId());
            assertNull(stream.requestId()); assertEquals(2, calls.size());
        }
    }

    @Test void pipelineCannotFallbackToEarlierLoadIdWhenNewLoadFailsWithoutMetadata() throws Exception {
        var loads = new ArrayList<Integer>();
        var initial = new Source(List.of(chunk(1))) {
            public String requestId() { return "prompt-header"; }
        };
        var pipeline = new com.das.java.web.Pipeline("session", false, 0);
        try (var stream = new RecoveringPromptStream("prompt", initial, (offset, remaining) -> {
            loads.add(1);
            if (loads.size() == 1) return new Source(List.of("{\"RequestId\":\"earlier-load\"}", chunk(2)));
            var failed = new Source(List.of());
            failed.error = new Normalize.DasApiException(com.das.java.core.ApiError.apiError("rpc_error", "new Load denied without ID"));
            return failed;
        }, 2, 1000, 0)) {
            pipeline.onFrame(JSON.readValue(stream.next(), java.util.LinkedHashMap.class));
            pipeline.requestId(stream.requestId());
            assertEquals("prompt-header", stream.requestId());
            pipeline.onFrame(JSON.readValue(stream.next(), java.util.LinkedHashMap.class));
            pipeline.requestId(stream.requestId());
            assertEquals("earlier-load", stream.requestId());
            var failure = assertThrows(Normalize.DasApiException.class, () -> {
                try { stream.next(); }
                finally { pipeline.requestId(stream.requestId()); }
            });
            assertEquals(2, loads.size());
            assertNull(failure.apiError().requestId());
            assertNull(stream.requestId());
            var event = pipeline.onError(failure, "PromptAgentSession");
            assertFalse(((Map<?, ?>) event.get("error")).containsKey("requestId"));
            assertFalse(((Map<?, ?>) pipeline.finish(List.of("earlier-load")).get("error")).containsKey("requestId"));
        }
    }
}
