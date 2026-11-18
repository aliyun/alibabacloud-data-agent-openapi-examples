package com.das.java.daemon;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletResponse;

class NativeEventEpochOutputTest {
    @Test void replayReceiptAndLiveFramesFlushWhileUpstreamRemainsOpen() throws Exception {
        var response = new MockHttpServletResponse();
        var output = new NativeEventEpochOutput(response, "native", null);
        var subscriber = new java.util.concurrent.atomic.AtomicReference<org.reactivestreams.Subscriber<? super java.nio.ByteBuffer>>();
        var demand = new java.util.concurrent.LinkedBlockingQueue<Long>();
        var delivered = new java.util.concurrent.CountDownLatch(1);
        var executor = java.util.concurrent.Executors.newSingleThreadExecutor();
        try (var remote = new com.das.java.live.RemoteEventStream()) {
            remote.onStream(value -> {
                subscriber.set(value);
                value.onSubscribe(new org.reactivestreams.Subscription() {
                    public void request(long count) { demand.offer(count); }
                    public void cancel() { }
                });
            }, 200, new com.aliyun.core.http.HttpHeaders(Map.of("Content-Type", "text/event-stream")));
            var relay = executor.submit(() -> {
                com.das.java.live.RemoteSseRelay.relay(remote, output, "session-A", cursor -> {
                    if ("5".equals(cursor)) delivered.countDown();
                }, output::observe);
                output.finish();
                return null;
            });
            for (String frame : new String[]{
                "event: stream_open\ndata: {\"Data\":{\"eventEpoch\":\"native\"}}\n\n",
                "retry:3000\n\n",
                "id: 4\nevent: session_update\ndata: {\"Id\":\"4\",\"Data\":{\"sessionId\":\"session-A\",\"update\":{}}}\n\n",
                "event: replay_complete\ndata: {\"Data\":{\"replayedCount\":1,\"lastReplayedEventId\":4}}\n\n",
                "id: 5\nevent: turn_complete\ndata: {\"Id\":\"5\",\"Data\":{\"sessionId\":\"session-A\",\"stopReason\":\"end_turn\"}}\n\n"
            }) {
                assertNotNull(demand.poll(2, java.util.concurrent.TimeUnit.SECONDS), "relay must keep requesting bytes after stream_open");
                subscriber.get().onNext(java.nio.ByteBuffer.wrap(frame.getBytes(StandardCharsets.UTF_8)));
            }
            assertTrue(delivered.await(2, java.util.concurrent.TimeUnit.SECONDS), "terminal must reach browser before upstream closes");
            assertFalse(relay.isDone(), "upstream intentionally remains open after terminal");
            assertTrue(response.getContentAsString().contains("replay_complete"));
            assertTrue(response.getContentAsString().contains("end_turn"));
            subscriber.get().onComplete();
            relay.get(2, java.util.concurrent.TimeUnit.SECONDS);
        } finally { executor.shutdownNow(); }
    }

    @Test void heartbeatCannotCommitHeadersBeforeNativeOpeningIdentity() throws Exception {
        var response = new MockHttpServletResponse();
        var output = new NativeEventEpochOutput(response, "native", null);
        output.write(": heartbeat\n\n".getBytes(StandardCharsets.UTF_8));
        output.flush();
        assertFalse(response.isCommitted());
        assertEquals("", response.getContentAsString());
        output.observe(Map.of("type", "stream_open", "data", Map.of("eventEpoch", "native")));
        output.write("data: {}\n\n".getBytes(StandardCharsets.UTF_8));
        output.flush();
        assertEquals("native", response.getHeader("X-Qwen-Event-Epoch"));
        assertEquals(": heartbeat\n\ndata: {}\n\n", response.getContentAsString());
    }

    @Test void bodyCannotContradictNativeHeaderOrClaimAnInvalidEpoch() throws Exception {
        var response = new MockHttpServletResponse();
        var output = new NativeEventEpochOutput(response, "native", "native");
        assertThrows(IllegalStateException.class, () -> output.observe(
            Map.of("type", "stream_open", "data", Map.of("eventEpoch", "different"))));
        assertFalse(response.isCommitted());
        assertThrows(java.io.IOException.class, () -> new NativeEventEpochOutput(response, "native", "different"));
        assertThrows(java.io.IOException.class, () -> new NativeEventEpochOutput(response, null, "bad\nepoch"));
    }

    @Test void missingHandshakeAndUnboundedHeartbeatDoNotBecomeSuccessfulStrictSubscriptions() throws Exception {
        var response = new MockHttpServletResponse();
        var output = new NativeEventEpochOutput(response, "native", null);
        assertThrows(java.io.IOException.class, output::finish);
        assertThrows(java.io.IOException.class, () -> output.write(new byte[65_537]));
        assertFalse(response.isCommitted());
    }
}
