package com.das.java.live;

import com.das.java.live.Normalize.DasApiException;
import java.io.IOException;
import java.util.List;
import java.util.ArrayList;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class LoadSnapshotReaderTest {
    static final String CHUNK = "{\"Jsonrpc\":\"2.0\",\"Params\":{\"update\":{\"sessionUpdate\":\"agent_message_chunk\",\"content\":{\"type\":\"text\",\"text\":\"x\"}}}}";
    static String end(String id) { return "{\"Jsonrpc\":\"2.0\",\"Id\":\"" + id + "\",\"Result\":{\"stopReason\":\"end_turn\"}}"; }
    static class Source implements RecoveringPromptStream.Source {
        List<String> rows; int index; boolean closed; Exception error;
        Source(List<String> rows) { this.rows = rows; }
        public String rpcId() { return "load"; }
        public String next(long timeout) throws Exception {
            if (index < rows.size()) return rows.get(index++);
            if (error != null) throw error;
            return null;
        }
        public void close() { closed = true; }
    }
    @Test void restartsSnapshotWithoutMergingPartialOrHistoricalTerminal() throws Exception {
        List<Source> calls = new ArrayList<>();
        var result = LoadSnapshotReader.read(remaining -> {
            Source s = new Source(calls.isEmpty() ? List.of(CHUNK, end("old")) : List.of(CHUNK, end("load")));
            calls.add(s); return s;
        }, 1000, 3, 0);
        assertEquals(2, calls.size()); assertEquals(2, result.size());
        assertTrue(calls.stream().allMatch(s -> s.closed));
    }
    @Test void boundedEofDoesNotReturnPartialHistory() {
        List<Source> calls = new ArrayList<>();
        var failure = assertThrows(DasApiException.class, () -> LoadSnapshotReader.read(remaining -> {
            Source s = new Source(List.of(CHUNK)); calls.add(s); return s;
        }, 1000, 3, 0));
        assertEquals("stream_break", failure.apiError().kind()); assertEquals(3, calls.size());
    }
    @Test void transportFailureRetriesAndDoesNotDuplicate() throws Exception {
        List<Source> calls = new ArrayList<>();
        var result = LoadSnapshotReader.read(remaining -> {
            Source s = new Source(calls.isEmpty() ? List.of(CHUNK) : List.of(end("load")));
            if (calls.isEmpty()) s.error = new IOException("reset");
            calls.add(s); return s;
        }, 1000, 3, 0);
        assertEquals(1, result.size()); assertEquals(2, calls.size());
    }
    @Test void loadBusinessErrorDoesNotRetry() {
        List<Source> calls = new ArrayList<>();
        assertThrows(DasApiException.class, () -> LoadSnapshotReader.read(remaining -> {
            Source s = new Source(List.of("{\"Id\":\"load\",\"Error\":{\"code\":-32603,\"message\":\"permission_required\"}}"));
            calls.add(s); return s;
        }, 1000, 3, 0));
        assertEquals(1, calls.size());
    }
    @Test void idleReadUsesRemainingBudgetAndCloses() {
        List<Source> calls = new ArrayList<>();
        assertThrows(DasApiException.class, () -> LoadSnapshotReader.read(remaining -> {
            Source s = new Source(List.of()) {
                public String next(long timeout) throws Exception {
                    assertTrue(timeout <= 30); Thread.sleep(timeout + 2); throw new IOException("timeout");
                }
            };
            calls.add(s); return s;
        }, 30, 3, 0));
        assertEquals(1, calls.size()); assertTrue(calls.get(0).closed);
    }
}
