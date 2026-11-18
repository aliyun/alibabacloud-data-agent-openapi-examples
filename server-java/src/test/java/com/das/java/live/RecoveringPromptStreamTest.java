package com.das.java.live;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class RecoveringPromptStreamTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    static Map<String, Object> cursor(int id, String type) { return new LinkedHashMap<>(Map.of("sessionId", "session", "eventEpoch", "epoch",
        "eventId", String.valueOf(id), "promptId", "native-prompt", "eventType", type)); }
    static String chunk(int id) throws Exception { return JSON.writeValueAsString(Map.of("Jsonrpc", "2.0", "Params",
        Map.of("sessionId", "session", "update", Map.of("sessionUpdate", "agent_message_chunk")), "_meta", Map.of("eventCursor", cursor(id, "session_update")))); }
    static String end(int id) throws Exception { return JSON.writeValueAsString(Map.of("Jsonrpc", "2.0", "Id", "prompt",
        "Result", Map.of("stopReason", "end_turn"), "_meta", Map.of("eventCursor", cursor(id, "turn_complete")))); }
    static class Source implements RecoveringPromptStream.Source {
        final List<String> rows; int i; boolean closed; Exception error; String requestId;
        Source(List<String> rows) { this.rows = rows; }
        public String next(long timeout) throws Exception { if (i < rows.size()) return rows.get(i++); if (error != null) throw error; return null; }
        public String requestId() { return requestId; }
        public void close() { closed = true; }
    }
    static List<String> collect(RecoveringPromptStream stream) throws Exception {
        try (stream) { List<String> out = new ArrayList<>(); String next; while ((next = stream.next()) != null) out.add(next); return out; }
    }
    @Test void resumesOnlyFromNativeCursorWithoutReissuingPrompt() throws Exception {
        List<String> calls = new ArrayList<>(); Source first = new Source(List.of(chunk(4))); first.error = new IOException("reset");
        var result = collect(new RecoveringPromptStream("prompt", "session", first, (cursor, remaining) -> {
            calls.add(cursor.eventId()); assertEquals("epoch", cursor.eventEpoch()); assertEquals("native-prompt", cursor.promptId());
            return new Source(List.of(chunk(5), end(6)));
        }, 3, 1000, 0));
        assertEquals(List.of(chunk(4), chunk(5), end(6)), result); assertEquals(List.of("4"), calls); assertTrue(first.closed);
    }
    @Test void advancesAcrossRepeatedEofsAndStopsAtTheOriginalTerminal() throws Exception {
        List<String> calls = new ArrayList<>();
        var result = collect(new RecoveringPromptStream("prompt", new Source(List.of(chunk(4))), (cursor, remaining) -> {
            calls.add(cursor.eventId()); return new Source(cursor.eventId().equals("4") ? List.of(chunk(5)) : List.of(end(6)));
        }, 3, 1000, 0));
        assertEquals(List.of(chunk(4), chunk(5), end(6)), result); assertEquals(List.of("4", "5"), calls);
    }
    @Test void rejectsChangedSessionEpochPromptAndDuplicateId() throws Exception {
        for (String field : List.of("sessionId", "eventEpoch", "promptId", "eventId")) {
            Map<String, Object> bad = JSON.readValue(chunk(5), Map.class);
            Map<String, Object> value = (Map<String, Object>) ((Map<?, ?>) bad.get("_meta")).get("eventCursor");
            value.put(field, field.equals("eventId") ? "4" : "other");
            assertThrows(Normalize.DasApiException.class, () -> collect(new RecoveringPromptStream("prompt", "session",
                new Source(List.of(chunk(4))), (cursor, remaining) -> new Source(List.of(JSON.writeValueAsString(bad))), 3, 1000, 0)));
        }
    }
    @Test void legacyOffsetsAndAdmissionErrorsDoNotAuthorizeRecovery() throws Exception {
        for (String frame : List.of("{\"Jsonrpc\":\"2.0\",\"Params\":{\"sessionId\":\"session\",\"_meta\":{\"offset\":900}}}",
                "{\"Error\":{\"code\":403,\"message\":\"denied\"}}")) {
            assertEquals(List.of(frame), collect(new RecoveringPromptStream("prompt", new Source(List.of(frame)), (cursor, remaining) -> {
                fail("unexpected Events"); return null;
            }, 3, 1000, 0)));
        }
    }
    @Test void subscriptionErrorsAfterAdmissionCheckEventsWithoutPublishingFakeTerminal() throws Exception {
        var rows = collect(new RecoveringPromptStream("prompt", new Source(List.of(chunk(4), "{\"Error\":{\"errorCode\":\"DAEMON_STREAM_ENDED\"}}")),
            (cursor, remaining) -> new Source(List.of(end(6))), 3, 1000, 0));
        assertEquals(List.of(chunk(4), end(6)), rows);
    }
    @Test void protocolDamageCannotBeRetriedAsTransport() throws Exception {
        assertThrows(Normalize.DasApiException.class, () -> collect(new RecoveringPromptStream("prompt",
            new Source(List.of(chunk(4), "{bad-json")), (cursor, remaining) -> { fail("unexpected GET"); return null; }, 3, 1000, 0)));
    }
    @Test void retriesAreBoundedAndAuthenticationIsNotRetried() throws Exception {
        int[] calls = {0};
        assertEquals(List.of(chunk(4)), collect(new RecoveringPromptStream("prompt", new Source(List.of(chunk(4))),
            (cursor, remaining) -> { calls[0]++; return new Source(List.of()); }, 3, 1000, 0)));
        assertEquals(3, calls[0]); calls[0] = 0;
        assertThrows(Normalize.DasApiException.class, () -> collect(new RecoveringPromptStream("prompt", new Source(List.of(chunk(4))),
            (cursor, remaining) -> { calls[0]++; Source denied = new Source(List.of());
                denied.error = new SdkSseStream.SseException("denied", 403); return denied; }, 3, 1000, 0)));
        assertEquals(1, calls[0]);
    }
    @Test void localDisposalClosesOnlyItsOwnedReader() throws Exception {
        Source source = new Source(List.of(chunk(4), chunk(5)));
        var stream = new RecoveringPromptStream("prompt", source, (cursor, remaining) -> { fail("unexpected GET"); return null; });
        assertEquals(chunk(4), stream.next()); stream.close(); assertTrue(source.closed); assertNull(stream.next());
    }
}
