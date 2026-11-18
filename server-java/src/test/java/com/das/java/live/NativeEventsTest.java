package com.das.java.live;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class NativeEventsTest {
    static final ObjectMapper JSON = new ObjectMapper();
    static final Map<String, Object> OPEN = Map.of("type", "stream_open", "data", Map.of(
        "sessionId", "business", "nativeSessionId", "native", "eventEpoch", "epoch"));
    static Map<String, Object> event(long id, String type) { return Map.of("id", id, "type", type, "promptId", "p",
        "originatorClientId", "mobile", "data", Map.of("sessionId", "native", "promptId", "p", "stopReason", "end_turn",
            "update", Map.of("rawOutput", Map.of("sessionId", "tool-content")))); }
    static Map<String, Object> receipt(int count) { return Map.of("type", "replay_complete", "data", Map.of("replayedCount", count, "lastEventId", 6)); }
    static String wire(Map<String, Object> event) throws Exception { return (event.containsKey("id") ? "id: "+event.get("id")+"\n" : "")
        +"event: "+event.get("type")+"\ndata: "+JSON.writeValueAsString(event)+"\n\n"; }
    static class Stream {
        final RemoteEventStream remote = org.mockito.Mockito.mock(RemoteEventStream.class);
        final byte[] body; int position; boolean closed;
        Stream(String wire) {
            body = wire.getBytes(StandardCharsets.UTF_8);
            try {
                org.mockito.Mockito.when(remote.metadata(org.mockito.ArgumentMatchers.anyLong())).thenAnswer(call -> metadata());
                org.mockito.Mockito.when(remote.next(org.mockito.ArgumentMatchers.anyLong())).thenAnswer(call -> next(call.getArgument(0)));
                org.mockito.Mockito.doAnswer(call -> { closed = true; return null; }).when(remote).close();
            } catch (Exception failure) { throw new AssertionError(failure); }
        }
        public RemoteEventStream.Metadata metadata() { return new RemoteEventStream.Metadata(200, Map.of("content-type", "text/event-stream", "x-acs-request-id", "events-request")); }
        public RemoteEventStream.Metadata metadata(long timeout) { return metadata(); }
        public byte[] next(long timeout) { return position == body.length ? null : new byte[]{body[position++]}; }
        public void close() { closed = true; }
    }
    @Test void liveOnlyHasNoReceiptAndPreservesIdentityAndToolContent() throws Exception {
        var stream = new Stream(wire(OPEN)+wire(event(5, "session_update"))+wire(event(6, "turn_complete")));
        try (var events = new NativeEvents(stream.remote, "business", null, null)) {
            assertEquals("stream_open", events.next(1000).get("type")); assertEquals("epoch", events.epoch());
            var update = events.next(1000);
            assertEquals("mobile", update.get("originatorClientId"));
            var data = (Map<?, ?>) update.get("data"); assertEquals("business", data.get("sessionId"));
            assertEquals(Map.of("rawOutput", Map.of("sessionId", "tool-content")), data.get("update"));
            assertEquals("turn_complete", events.next(1000).get("type")); assertNull(events.next(1000));
        }
        assertTrue(stream.closed);
    }
    @Test void actualPopDataOnlyOpeningAllowsEmptySseIdReset() throws Exception {
        var stream = new Stream("id: \nevent: stream_open\ndata: "+JSON.writeValueAsString(Map.of("Data", OPEN.get("data")))+"\n\n");
        try (var events = new NativeEvents(stream.remote, "business", null, null)) {
            assertEquals("stream_open", events.next(1000).get("type"));
            assertEquals("epoch", events.epoch()); assertNull(events.next(1000));
        }
    }
    @Test void replayTerminalRequiresVerifiedReceiptBeforeItCanBeDelivered() throws Exception {
        for (String variant : List.of("valid", "missing", "bad")) {
            var stream = new Stream(wire(OPEN)+wire(event(5, "session_update"))+wire(event(6, "turn_complete"))
                +(variant.equals("missing") ? "" : wire(receipt(variant.equals("valid") ? 2 : 1))));
            try (var events = new NativeEvents(stream.remote, "business", "4", "epoch")) {
                events.next(1000); events.next(1000);
                if (variant.equals("valid")) { assertEquals("turn_complete", events.next(1000).get("type"));
                    assertEquals("replay_complete", events.next(1000).get("type")); assertNull(events.next(1000)); }
                else assertThrows(Normalize.DasApiException.class, () -> events.next(1000));
            }
            assertTrue(stream.closed);
        }
    }
    @Test void rejectsGlobalFailureEpochGapPromptConflictAndMismatchedIds() throws Exception {
        List<String> damaged = List.of(
            wire(event(6, "session_update")),
            wire(Map.of("id", 5, "type", "state_resync_required", "data", Map.of())),
            wire(Map.of("id", 5, "type", "turn_complete", "promptId", "p", "data", Map.of("promptId", "other"))),
            "id: 6\nevent: session_update\ndata: "+JSON.writeValueAsString(event(5, "session_update"))+"\n\n",
            "event: session_update\ndata: {broken}\n\n",
            wire(Map.of("id", 5, "type", "session_update", "data", Map.of("sessionId", "foreign"))));
        for (String bad : damaged) try (var events = new NativeEvents(new Stream(wire(OPEN)+bad).remote, "business", "4", "epoch")) {
            events.next(1000); assertThrows(Normalize.DasApiException.class, () -> events.next(1000));
        }
        try (var events = new NativeEvents(new Stream(wire(OPEN)).remote, "business", "4", "wrong")) {
            assertThrows(Normalize.DasApiException.class, () -> events.next(1000));
        }
    }
    @Test void stickyPopControlIdDoesNotConsumeAnotherBusinessSequence() throws Exception {
        String end = "id: 6\ndata: "+JSON.writeValueAsString(Map.of("Id", "6", "Event", JSON.writeValueAsString(receipt(2))))+"\n\n";
        try (var events = new NativeEvents(new Stream(wire(OPEN)+wire(event(5, "session_update"))+wire(event(6, "turn_complete"))+end).remote, "business", "4", "epoch")) {
            assertNotNull(events.next(1000)); assertNotNull(events.next(1000)); assertNotNull(events.next(1000));
            assertFalse(events.next(1000).containsKey("id")); assertNull(events.next(1000));
        }
    }
    @Test void promptCannotPublishTerminalWhenSamePromptAddsContentBeforeReceipt() throws Exception {
        var cursor = new EventCursor("business", "epoch", "4", "p", "session_update");
        var events = new NativeEvents(new Stream(wire(OPEN)+wire(event(5, "turn_complete"))+wire(event(6, "session_update"))+wire(receipt(2))).remote, "business", "4", "epoch");
        try (var source = LiveClient.resumeSource(events, "business", "rpc", cursor)) {
            assertThrows(Normalize.DasApiException.class, () -> source.next(1000));
        }
    }
    @Test void pendingQueueCompletionDoesNotReplaceTheOriginalTerminalCursor() throws Exception {
        var cursor = new EventCursor("business", "epoch", "4", "p", "session_update");
        var events = new NativeEvents(new Stream(wire(OPEN)+wire(event(5, "turn_complete"))+wire(event(6, "pending_prompt_completed"))+wire(receipt(2))).remote, "business", "4", "epoch");
        try (var source = LiveClient.resumeSource(events, "business", "rpc", cursor)) {
            var result = JSON.readTree(source.next(1000));
            assertEquals("rpc", result.path("Id").asText());
            assertEquals("5", result.path("_meta").path("eventCursor").path("eventId").asText());
        }
    }
    @Test void heartbeatsAndSlowPartialFramesCannotRenewTheOriginalReadDeadline() throws Exception {
        for (String chunk : List.of(": heartbeat\n\n", "d")) {
            var stream = new Stream("") {
                public byte[] next(long timeout) {
                    try { Thread.sleep(5); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                    return chunk.getBytes(StandardCharsets.UTF_8);
                }
            };
            assertTimeoutPreemptively(java.time.Duration.ofMillis(500), () -> {
                try (var input = new RawSse(stream.remote)) {
                    assertThrows(java.io.IOException.class, () -> input.next(20));
                }
            });
            assertTrue(stream.closed);
        }
    }
    @Test void metadataWaitIsBoundedByTheRecoveryBudget() {
        var stream = new RemoteEventStream();
        assertTimeoutPreemptively(java.time.Duration.ofMillis(500), () ->
            assertThrows(java.util.concurrent.TimeoutException.class, () -> new NativeEvents(stream, "business", "4", "epoch", 20)));
    }
    @Test void filteringOtherPromptsCannotExtendTheReadBudget() throws Exception {
        var stream = new Stream("") {
            int frame;
            public byte[] next(long timeout) {
                try {
                    Thread.sleep(5);
                    if (frame++ == 0) return wire(OPEN).getBytes(StandardCharsets.UTF_8);
                    if (frame == 2) return wire(Map.of("type", "replay_complete", "data", Map.of("replayedCount", 0))).getBytes(StandardCharsets.UTF_8);
                    return wire(Map.of("id", frame+2, "type", "session_update", "promptId", "other", "data", Map.of())).getBytes(StandardCharsets.UTF_8);
                } catch (Exception failure) { throw new AssertionError(failure); }
            }
        };
        assertTimeoutPreemptively(java.time.Duration.ofMillis(500), () -> {
            try (var source = LiveClient.resumeSource(new NativeEvents(stream.remote, "business", "4", "epoch"),
                    "business", "rpc", new EventCursor("business", "epoch", "4", "p", "session_update"))) {
                assertThrows(java.io.IOException.class, () -> source.next(20));
            }
        });
        assertTrue(stream.closed);
    }
}
