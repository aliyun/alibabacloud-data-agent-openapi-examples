package com.das.java.daemon;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import com.das.java.config.AppConfig;
import com.das.java.live.LiveClient;
import com.das.java.live.LiveClientHolder;
import com.das.java.web.Inflight;

class HistoryRefreshTest {
    private Map<String, Object> frame(String kind, String text) {
        return Map.of("RequestId", "synthetic-turn", "Params", Map.of("update", Map.of(
            "sessionUpdate", kind, "content", Map.of("type", "text", "text", text))));
    }

    @Test
    @SuppressWarnings("unchecked")
    void repeatedLoadMustExposeRepliesThatArrivedAfterFirstSnapshot() throws Exception {
        var live = mock(LiveClient.class);
        var user = frame("user_message_chunk", "synthetic question");
        var answer = frame("agent_message_chunk", "synthetic answer");
        when(live.loadFrames("synthetic-session")).thenReturn(
            List.of(user), List.of(user, answer), List.of(user, answer), List.of(user));
        var controller = new DaemonController(mock(AppConfig.class), new LiveClientHolder(live), new Inflight());
        var first = (Map<String, Object>) controller.loadSession("synthetic-session").getBody();
        assertEquals(1, ((List<?>)first.get("compactedReplay")).size());
        for (int i = 0; i < 3; i++) {
            var loaded = (Map<String, Object>) controller.loadSession("synthetic-session").getBody();
            var events = (List<Map<String,Object>>)loaded.get("compactedReplay");
            assertEquals(2, events.size());
            assertTrue(events.get(1).toString().contains("synthetic answer"));
            assertEquals(first.get("eventEpoch"), loaded.get("eventEpoch"));
            assertEquals(2L, loaded.get("lastEventId"));
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void activeLoadPreservesQuestionWithoutCallingUpstream() throws Exception {
        var live = mock(LiveClient.class);
        var controller = new DaemonController(mock(AppConfig.class), new LiveClientHolder(live), new Inflight());
        var registryField = DaemonController.class.getDeclaredField("registry");
        registryField.setAccessible(true);
        var registry = (Registry) registryField.get(controller);
        var record = registry.ensure("active-load");
        Map<String, Object> data = Map.of("requestId", "question");
        Map<String, Object> question = Map.of("v", 1, "type", "permission_request", "data", data);
        record.journal.append(question);
        record.journal.activePrompt = true;
        record.pendingPermissions.put("question", data);
        var loaded = (Map<String, Object>) controller.loadSession("active-load").getBody();
        assertEquals(List.of(record.journal.live().get(0).event()), loaded.get("liveJournal"));
        assertEquals(1L, loaded.get("lastEventId"));
        assertTrue(record.pendingPermissions.containsKey("question"));
        verifyNoInteractions(live);
        record.journal.activePrompt = false;
        when(live.loadFrames("active-load")).thenReturn(List.of());
        controller.loadSession("active-load");
        verify(live).loadFrames("active-load");
    }
}
