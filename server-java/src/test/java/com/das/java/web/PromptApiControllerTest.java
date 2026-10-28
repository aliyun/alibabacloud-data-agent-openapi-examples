package com.das.java.web;

import com.das.java.config.AppConfig;
import com.das.java.live.LiveClient;
import com.das.java.live.LiveClientHolder;
import com.das.java.live.RecoveringPromptStream;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.WriteListener;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletResponse;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class PromptApiControllerTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static String chunk(String rid, String text) throws Exception {
        return JSON.writeValueAsString(Map.of("RequestId", rid, "Params", Map.of("sessionId", "same-session", "_meta", Map.of("offset", 1),
            "update", Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", text)))));
    }
    @Test void sameSessionLiveRequestsFlushBeforeFirstFrameAndDoNotUseGlobalAdmission() throws Exception {
        var live = mock(LiveClient.class);
        var inflight = mock(Inflight.class);
        var entered = new CountDownLatch(2);
        var release = new CountDownLatch(1);
        var controller = new PromptApiController(mock(AppConfig.class), new LiveClientHolder(live), inflight);
        var first = new MockHttpServletResponse();
        var second = new MockHttpServletResponse();
        for (String text : List.of("first", "second")) {
            var stream = mock(RecoveringPromptStream.class);
            AtomicInteger frames = new AtomicInteger();
            when(stream.next()).thenAnswer(call -> {
                int index = frames.getAndIncrement();
                if (index == 0) { entered.countDown(); assertTrue(release.await(3, TimeUnit.SECONDS)); return chunk(text, text + " 😀"); }
                return index == 1 ? "{\"Result\":{\"stopReason\":\"end_turn\"}}" : null;
            });
            when(live.openPromptStream(eq("same-session"), eq(text), anyList())).thenAnswer(call -> {
                var response = "first".equals(text) ? first : second;
                assertTrue(response.isCommitted(), "Headers must be flushed before issuing PromptAgentSession");
                return stream;
            });
        }
        var executor = Executors.newFixedThreadPool(2);
        try {
            var one = executor.submit(() -> controller.prompt("same-session", Map.of("text", "first"), first));
            var two = executor.submit(() -> controller.prompt("same-session", Map.of("text", "second"), second));
            assertTrue(entered.await(2, TimeUnit.SECONDS));
            assertTrue(first.isCommitted()); assertTrue(second.isCommitted());
            assertEquals("application/x-ndjson;charset=utf-8", first.getContentType().replace(" ", ""));
            release.countDown();
            one.get(3, TimeUnit.SECONDS); two.get(3, TimeUnit.SECONDS);
            assertTrue(first.getContentAsString().contains("first 😀"));
            assertFalse(first.getContentAsString().contains("second"));
            assertTrue(second.getContentAsString().contains("second 😀"));
            for (var response : List.of(first, second)) {
                var events = response.getContentAsString().lines().map(line -> { try { return JSON.readTree(line); } catch (Exception e) { throw new RuntimeException(e); } }).toList();
                assertEquals(1L, events.stream().filter(event -> "done".equals(event.path("type").asText())).count());
                assertEquals("end_turn", events.get(events.size() - 1).path("stopReason").asText());
            }
            verifyNoInteractions(inflight);
            verify(live, never()).cancel(anyString());
        } finally { release.countDown(); executor.shutdownNow(); assertTrue(executor.awaitTermination(3, TimeUnit.SECONDS)); }
    }
    @Test void eofWithoutTerminalIsUnknownEvenWithZeroFramesAndNeverCausesRePrompt() throws Exception {
        for (boolean empty : new boolean[]{false, true}) {
            var live = mock(LiveClient.class);
            var stream = mock(RecoveringPromptStream.class);
            if (empty) when(stream.next()).thenReturn(null);
            else when(stream.next()).thenReturn(chunk("own-rid", "partial"), null);
            when(live.openPromptStream(anyString(), anyString(), anyList())).thenReturn(stream);
            var response = new MockHttpServletResponse();
            new PromptApiController(mock(AppConfig.class), new LiveClientHolder(live), mock(Inflight.class))
                .prompt("same-session", Map.of("text", "question"), response);
            String wire = response.getContentAsString();
            assertTrue(wire.contains("\"type\":\"error\""));
            assertTrue(wire.contains("stream_break"));
            assertFalse(wire.contains("\"type\":\"done\""));
            verify(live, times(1)).openPromptStream(eq("same-session"), eq("question"), anyList());
            verify(live, never()).cancel(anyString());
            verify(stream, atLeastOnce()).close();
        }
    }
    @Test void unknownStopReasonIsAnErrorInsteadOfSuccessfulDone() throws Exception {
        var live = mock(LiveClient.class);
        var stream = mock(RecoveringPromptStream.class);
        when(stream.next()).thenReturn("{\"Result\":{\"stopReason\":\"unrecognized\"}}", null);
        when(live.openPromptStream(anyString(), anyString(), anyList())).thenReturn(stream);
        var response = new MockHttpServletResponse();
        new PromptApiController(mock(AppConfig.class), new LiveClientHolder(live), mock(Inflight.class))
            .prompt("same-session", Map.of("text", "question"), response);
        assertTrue(response.getContentAsString().contains("\"type\":\"error\""));
        assertFalse(response.getContentAsString().contains("\"type\":\"done\""));
        verify(live, never()).cancel(anyString());
    }

    @Test void downstreamDisconnectClosesReadingButDoesNotCancelOrRetryPrompt() throws Exception {
        var live = mock(LiveClient.class);
        var stream = mock(RecoveringPromptStream.class);
        when(stream.next()).thenReturn(chunk("own-rid", "partial"), null);
        when(live.openPromptStream(anyString(), anyString(), anyList())).thenReturn(stream);
        var response = new MockHttpServletResponse() {
            private final ServletOutputStream broken = new ServletOutputStream() {
                public boolean isReady() { return true; }
                public void setWriteListener(WriteListener value) {}
                public void write(int value) throws IOException { throw new IOException("browser disconnected"); }
            };
            @Override public ServletOutputStream getOutputStream() { return broken; }
        };
        new PromptApiController(mock(AppConfig.class), new LiveClientHolder(live), mock(Inflight.class))
            .prompt("same-session", Map.of("text", "question"), response);
        verify(stream, atLeastOnce()).close();
        verify(live, times(1)).openPromptStream(eq("same-session"), eq("question"), anyList());
        verify(live, never()).cancel(anyString());
    }
}
