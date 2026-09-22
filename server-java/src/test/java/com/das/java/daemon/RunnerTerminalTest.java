package com.das.java.daemon;

import com.das.java.web.Inflight;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class RunnerTerminalTest {
    @Test
    void exceptionMetadataKeepsCauseTypesWithoutMessages() {
        assertEquals("RuntimeException <- SocketTimeoutException", Runner.exceptionTypes(
            new RuntimeException("private prompt", new java.net.SocketTimeoutException("secret"))));
    }

    @Test
    void preTerminalResetStaysFailure() throws Exception {
        Runner runner = new Runner(null, null, new Inflight()) {
            @Override FrameSource openSource(String id, String text, List<String> acks) {
                return new FrameSource() {
                    public Map<String, Object> next() { throw new RuntimeException("connection reset"); }
                    public void close() {}
                };
            }
        };
        Registry.Record record = new Registry.Record("synthetic-reset");
        runner.admit(record, record.realId, List.of(Map.of("type", "text", "text", "synthetic")), null);
        long deadline = System.nanoTime() + 5_000_000_000L;
        while (record.journal.activePrompt && System.nanoTime() < deadline) Thread.sleep(10);
        assertFalse(record.journal.activePrompt);
        assertEquals(List.of("turn_error"), record.journal.all().stream().map(e -> e.event().get("type")).toList());
    }

    @Test
    void terminalDoesNotWaitForSocketEofOrReportLaterReset() throws Exception {
        AtomicInteger reads = new AtomicInteger();
        Runner runner = new Runner(null, null, new Inflight()) {
            @Override FrameSource openSource(String id, String text, List<String> acks) {
                return new FrameSource() {
                    public Map<String, Object> next() {
                        if (reads.incrementAndGet() == 1) return Map.of("Result", Map.of("stopReason", "end_turn"));
                        throw new RuntimeException("connection reset");
                    }
                    public void close() {}
                };
            }
        };
        Registry.Record record = new Registry.Record("synthetic-terminal");
        assertInstanceOf(Runner.Admitted.class, runner.admit(record, record.realId, List.of(Map.of("type", "text", "text", "synthetic")), null));
        long deadline = System.nanoTime() + 5_000_000_000L;
        while (record.journal.activePrompt && System.nanoTime() < deadline) Thread.sleep(10);
        assertFalse(record.journal.activePrompt);
        assertEquals(1, reads.get());
        assertEquals(List.of("turn_complete"), record.journal.all().stream().map(e -> e.event().get("type")).toList());
    }
}
