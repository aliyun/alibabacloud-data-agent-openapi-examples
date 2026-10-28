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
        Runner runner = new Runner(null, new Inflight()) {
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
    void nextAdmissionStartedInsideReleaseKeepsItsActiveIdAndReceipt() throws Exception {
        var record = new Registry.Record("handoff-session");
        var runnerRef = new java.util.concurrent.atomic.AtomicReference<Runner>();
        var next = new java.util.concurrent.atomic.AtomicReference<Runner.Admitted>();
        var firstThread = new java.util.concurrent.atomic.AtomicReference<Thread>();
        var releaseCalled = new java.util.concurrent.CountDownLatch(1);
        var secondEntered = new java.util.concurrent.CountDownLatch(1);
        var finishSecond = new java.util.concurrent.CountDownLatch(1);
        var firstAcquire = new java.util.concurrent.atomic.AtomicBoolean(true);
        Inflight inflight = new Inflight() {
            @Override public AcquireResult tryAcquire(String id) {
                AcquireResult result = super.tryAcquire(id);
                if (result instanceof Acquired acquired && firstAcquire.compareAndSet(true, false))
                    return new Acquired(acquired.entry(), () -> {
                        acquired.release().run();
                        next.set((Runner.Admitted)runnerRef.get().admit(record, id, List.of(Map.of("type", "text", "text", "second")), null));
                        releaseCalled.countDown();
                    });
                return result;
            }
        };
        Runner runner = new Runner(null, inflight) {
            @Override FrameSource openSource(String id, String text, List<String> acks) {
                if ("first".equals(text)) firstThread.set(Thread.currentThread());
                return new FrameSource() {
                    @Override public Map<String, Object> next() {
                        if ("second".equals(text)) {
                            secondEntered.countDown();
                            try { if (!finishSecond.await(5, java.util.concurrent.TimeUnit.SECONDS)) throw new RuntimeException("test timeout"); }
                            catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new RuntimeException(error); }
                        }
                        return Map.of("Result", Map.of("stopReason", "end_turn"));
                    }
                    @Override public void close() {}
                };
            }
        };
        runnerRef.set(runner);
        runner.admit(record, record.realId, List.of(Map.of("type", "text", "text", "first")), null);
        try {
            assertTrue(releaseCalled.await(3, java.util.concurrent.TimeUnit.SECONDS));
            assertTrue(secondEntered.await(3, java.util.concurrent.TimeUnit.SECONDS));
            long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(2);
            while (java.util.Arrays.stream(firstThread.get().getStackTrace()).anyMatch(frame -> frame.getMethodName().equals("runTurn"))
                    && System.nanoTime() < deadline) Thread.sleep(5);
            assertNotNull(next.get());
            assertTrue(record.journal.activePrompt);
            assertEquals(next.get().promptId(), record.journal.activePromptId);
            assertEquals(next.get().promptId(), record.journal.activePromptId);
        } finally { finishSecond.countDown(); }
    }

    @Test
    void simultaneousAdmissionsAcquireOnlyOneSessionLock() throws Exception {
        var pool = java.util.concurrent.Executors.newFixedThreadPool(12);
        try {
            for (int round = 0; round < 20; round++) {
                var lock = new Inflight();
                var start = new java.util.concurrent.CountDownLatch(1);
                var candidates = new java.util.ArrayList<java.util.concurrent.Future<Inflight.AcquireResult>>();
                for (int i = 0; i < 12; i++) candidates.add(pool.submit(() -> { start.await(); return lock.tryAcquire("same-session"); }));
                start.countDown();
                int acquired = 0;
                for (var candidate : candidates) if (candidate.get(2, java.util.concurrent.TimeUnit.SECONDS) instanceof Inflight.Acquired) acquired++;
                assertEquals(1, acquired);
            }
        } finally { pool.shutdownNow(); }
    }

    @Test
    void terminalDoesNotWaitForSocketEofOrReportLaterReset() throws Exception {
        AtomicInteger reads = new AtomicInteger();
        Runner runner = new Runner(null, new Inflight()) {
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
