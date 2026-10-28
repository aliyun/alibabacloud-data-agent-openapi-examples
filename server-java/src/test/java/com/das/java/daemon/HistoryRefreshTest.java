package com.das.java.daemon;

import com.das.java.config.AppConfig;
import com.das.java.live.LiveClient;
import com.das.java.live.LiveClientHolder;
import com.das.java.web.Inflight;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class HistoryRefreshTest {
    private static Map<String, Object> frame(String kind, String text) {
        return Map.of("Jsonrpc", "2.0", "RequestId", "remote-turn", "Params", Map.of("sessionId", "session-A",
            "update", Map.of("sessionUpdate", kind, "content", Map.of("type", "text", "text", text))));
    }
    @Test void loadResumeAndTranscriptAlwaysReadTheCurrentRemoteSnapshotAcrossInstances() throws Exception {
        var cfg = mock(AppConfig.class);
        var live = mock(LiveClient.class);
        when(live.loadFrames("session-A")).thenReturn(List.of(frame("user_message_chunk", "first snapshot")),
            List.of(frame("user_message_chunk", "new question"), frame("agent_message_chunk", "new remote answer")),
            List.of(frame("user_message_chunk", "restart question"), frame("agent_message_chunk", "after restart")));
        var first = new DaemonController(cfg, new LiveClientHolder(live), new Inflight());
        var second = new DaemonController(cfg, new LiveClientHolder(live), new Inflight());
        var initial = (Map<?, ?>) first.loadSession("session-A").getBody();
        var resumed = (Map<?, ?>) second.resumeSession("session-A").getBody();
        for (var response : List.of(initial, resumed)) {
            assertDoesNotThrow(() -> java.util.UUID.fromString((String)response.get("clientId")));
            assertEquals(false, response.get("attached"));
            assertEquals("/data-agent/out/session-A", response.get("projectlessOutputDirectory"));
            assertEquals(Map.of("state", "ready"), response.get("workingDirectory"));
        }
        assertNotEquals(initial.get("clientId"), resumed.get("clientId"));
        assertTrue(initial.toString().contains("first snapshot"));
        assertTrue(resumed.toString().contains("new remote answer"));
        assertFalse(resumed.toString().contains("first snapshot"));
        assertFalse(resumed.containsKey("lastEventId"));
        assertEquals(List.of(), resumed.get("liveJournal"));
        var models = (Map<?, ?>)((Map<?, ?>)resumed.get("state")).get("models");
        assertNull(models.get("currentModelId"));
        assertTrue(second.transcript("session-A").getBody().toString().contains("after restart"));
        verify(live, times(3)).loadFrames("session-A");
    }
    @Test void blockedLoadCannotGatePermissionAndItsSnapshotDoesNotCreateResolvedState() throws Exception {
        var live = mock(LiveClient.class);
        var cfg = mock(AppConfig.class);
        var started = new java.util.concurrent.CountDownLatch(1);
        var finish = new java.util.concurrent.CountDownLatch(1);
        when(live.loadFrames("session-A")).thenAnswer(call -> {
            started.countDown();
            assertTrue(finish.await(3, java.util.concurrent.TimeUnit.SECONDS));
            return List.of(frame("user_message_chunk", "current question"), frame("agent_message_chunk", "fresh snapshot"));
        });
        when(live.reply(eq("session-A"), anyMap())).thenReturn(Map.of("accepted", true));
        var controller = new DaemonController(cfg, new LiveClientHolder(live), new Inflight());
        var loading = java.util.concurrent.CompletableFuture.supplyAsync(() -> controller.loadSession("session-A"));
        try {
            assertTrue(started.await(2, java.util.concurrent.TimeUnit.SECONDS));
            assertEquals(200, controller.permissionOnSession("session-A", "not-in-snapshot",
                Map.of("outcome", Map.of("outcome", "selected", "optionId", "proceed_once"))).getStatusCode().value());
        } finally { finish.countDown(); }
        assertTrue(loading.get(3, java.util.concurrent.TimeUnit.SECONDS).getBody().toString().contains("fresh snapshot"));
        assertEquals(200, controller.permissionOnSession("session-A", "not-in-snapshot",
            Map.of("outcome", Map.of("outcome", "selected", "optionId", "proceed_once"))).getStatusCode().value());
        verify(live, times(2)).reply(eq("session-A"), anyMap());
    }
}
