package com.das.java.daemon;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.aliyun.core.http.HttpHeaders;
import com.das.java.config.AppConfig;
import com.das.java.config.SessionOptions;
import com.das.java.live.LiveClient;
import com.das.java.live.LiveClientHolder;
import com.das.java.live.RemoteEventStream;
import com.das.java.web.Inflight;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.reactivestreams.Subscription;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class OpenapiRoutesTest {
    private LiveClient live;
    private DaemonController controller;
    private MockMvc mvc;
    private AppConfig cfg;

    @BeforeEach void setup() {
        cfg = mock(AppConfig.class);
        when(cfg.regionId()).thenReturn("cn-hangzhou");
        when(cfg.agentName()).thenReturn("custom-agent");
        when(cfg.model()).thenReturn("env-model");
        when(cfg.approvalMode()).thenReturn("yolo");
        when(cfg.reasoningEffort()).thenReturn("medium");
        when(cfg.models()).thenReturn(List.of("env-model", "other-model"));
        live = mock(LiveClient.class);
        controller = freshController();
        mvc = MockMvcBuilders.standaloneSetup(controller).build();
    }
    private DaemonController freshController() { return new DaemonController(cfg, new LiveClientHolder(live), new Inflight()); }
    private static void stateless(DaemonController controller) throws Exception {
        for (String name : List.of("registry", "runner")) {
            var field = DaemonController.class.getDeclaredField(name);
            field.setAccessible(true);
            assertNull(field.get(controller), "LIVE must not allocate " + name);
        }
    }
    private static Map<String, Object> summary(String title) { return Map.of("sessionId", "session-A", "title", title, "createdAt", 1L, "updatedAt", 2L); }

    @Test void optionsAdvertiseHttpStreamAndCreationDoesNotRegisterState() throws Exception {
        mvc.perform(get("/d/openapi/session-options")).andExpect(status().isOk())
            .andExpect(jsonPath("$.promptTransport").value("http-stream"))
            .andExpect(jsonPath("$.agentName").value("custom-agent"));
        when(live.createSessionWithOptions(any())).thenReturn(Map.of("sessionId", "new-id"));
        mvc.perform(post("/d/standalone/sessions").contentType("application/json")
            .content("{\"modelServiceId\":\"other-model\",\"approvalMode\":\"plan\",\"reasoningEffort\":\"high\"}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.sessionId").value("new-id"))
            .andExpect(jsonPath("$.clientId").isNotEmpty())
            .andExpect(jsonPath("$.attached").value(false))
            .andExpect(jsonPath("$.workspaceCwd").value("/data-agent"))
            .andExpect(jsonPath("$.sourceType").value("standalone"))
            .andExpect(jsonPath("$.context.kind").value("standalone"))
            .andExpect(jsonPath("$.projectlessOutputDirectory").value("/data-agent/out/new-id"))
            .andExpect(jsonPath("$.workingDirectory.state").value("ready"));
        verify(live).createSessionWithOptions(new SessionOptions("other-model", "plan", "high"));
        mvc.perform(post("/d/standalone/sessions").contentType("application/json").content("{\"modelServiceId\":42}"))
            .andExpect(status().isBadRequest());
        stateless(controller);
        var mockMvc = MockMvcBuilders.standaloneSetup(new DaemonController(cfg, new LiveClientHolder(null), new Inflight())).build();
        mockMvc.perform(get("/d/openapi/session-options")).andExpect(jsonPath("$.promptTransport").value("daemon"));
    }
    @Test void selectorsKeepCreationDefaultsWithoutAssertingRemoteAppliedConfiguration() throws Exception {
        mvc.perform(get("/d/standalone/session-options")).andExpect(status().isOk())
            .andExpect(jsonPath("$.approvalMode").value("yolo"))
            .andExpect(jsonPath("$.providers[0].models[0].isCurrent").value(true));
        for (String path : List.of("model", "mode", "config", "config-option", "reasoning", "reasoning-effort"))
            mvc.perform(post("/d/session/existing/" + path)).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("requires-new-session"));
        verifyNoInteractions(live);
    }
    @Test void liveLegacyPromptReceiptAndSidlessPermissionAreRetired() throws Exception {
        mvc.perform(post("/d/session/session-A/prompt").contentType("application/json").content("{\"prompt\":[]}"))
            .andExpect(status().isGone());
        mvc.perform(post("/d/session/session-A/openapi-prompt/any/receipt")).andExpect(status().isGone());
        mvc.perform(post("/d/permission/unknown").contentType("application/json").content("{}"))
            .andExpect(status().isNotFound());
        verifyNoInteractions(live);
        stateless(controller);
    }
    @Test void statusIsUnknownAndHeartbeatDoesNotProbeOrStartAnything() throws Exception {
        mvc.perform(get("/d/session/session-A/status")).andExpect(status().isNotFound())
            .andExpect(jsonPath("$.hasActivePrompt").doesNotExist());
        mvc.perform(post("/d/session/session-A/heartbeat")).andExpect(status().isNoContent());
        mvc.perform(get("/d/daemon/status")).andExpect(status().isNotFound())
            .andExpect(jsonPath("$.runtime.sessions").doesNotExist());
        verifyNoInteractions(live);
    }
    @Test void lookupAndRenameReadRemoteTitlesOnFreshProcessesWithoutCachedOverrides() throws Exception {
        when(live.sessionSummary("session-A")).thenReturn(summary("old remote"), summary("old remote"), summary("confirmed new"));
        mvc.perform(get("/d/standalone/sessions/session-A")).andExpect(jsonPath("$.displayName").value("old remote"));
        mvc.perform(patch("/d/session/session-A/metadata").contentType("application/json").content("{\"displayName\":\"requested\"}"))
            .andExpect(status().isOk());
        mvc.perform(get("/d/standalone/sessions/session-A")).andExpect(jsonPath("$.displayName").value("old remote"));
        var other = MockMvcBuilders.standaloneSetup(freshController()).build();
        other.perform(get("/d/standalone/sessions/session-A")).andExpect(jsonPath("$.displayName").value("confirmed new"));
        verify(live).renameSession("session-A", "requested");
        stateless(controller);
    }
    @Test void deleteCannotCreateLocalTombstoneAndMutationFailuresRemainFailures() throws Exception {
        when(live.sessionSummary("session-A")).thenReturn(summary("still remote"));
        mvc.perform(delete("/d/session/session-A")).andExpect(status().is2xxSuccessful());
        mvc.perform(get("/d/standalone/sessions/session-A")).andExpect(status().isOk());
        when(live.sessionSummary("session-A")).thenReturn(null);
        mvc.perform(get("/d/standalone/sessions/session-A")).andExpect(status().isNotFound());
        doThrow(new RuntimeException("denied")).when(live).deleteSession("session-A");
        mvc.perform(delete("/d/session/session-A")).andExpect(status().isBadGateway());
        doThrow(new RuntimeException("denied")).when(live).renameSession("session-A", "new");
        mvc.perform(patch("/d/session/session-A/metadata").contentType("application/json").content("{\"displayName\":\"new\"}"))
            .andExpect(status().isBadGateway());
        stateless(controller);
    }
    @Test void archiveListAndBatchUseRemoteStateAndExactIdsAcrossControllers() throws Exception {
        when(live.listSessions(true)).thenReturn(Map.of("sessions", List.of(summary("archived remote"))));
        mvc.perform(get("/d/standalone/sessions?archiveState=archived")).andExpect(jsonPath("$.sessions[0].displayName").value("archived remote"))
            .andExpect(jsonPath("$.sessions[0].hasActivePrompt").doesNotExist());
        doThrow(new RuntimeException("denied")).when(live).archiveSession("session-A", true);
        mvc.perform(post("/d/standalone/sessions/archive").contentType("application/json").content("{\"sessionIds\":[\"session-A\",\"session-B\"]}"))
            .andExpect(jsonPath("$.archived[0]").value("session-B")).andExpect(jsonPath("$.errors[0].sessionId").value("session-A"));
        freshController().unarchive(Map.of("sessionIds", List.of("session-B")));
        verify(live).archiveSession("session-B", false);
        stateless(controller);
    }
    @Test void permissionRepliesAreRemoteAuthoritativeEvenAfterSuccessOnAnotherProcess() throws Exception {
        String body = "{\"outcome\":{\"outcome\":\"selected\",\"optionId\":\"proceed_once\"}}";
        when(live.reply(eq("session-A"), anyMap())).thenReturn(Map.of("accepted", true), Map.of("accepted", false), Map.of("accepted", true));
        mvc.perform(post("/d/session/session-A/permission/not-cached").contentType("application/json").content(body)).andExpect(status().isOk());
        mvc.perform(post("/d/session/session-A/permission/not-cached").contentType("application/json").content(body)).andExpect(status().isNotFound());
        var other = MockMvcBuilders.standaloneSetup(freshController()).build();
        other.perform(post("/d/session/session-A/permission/not-cached").contentType("application/json").content(body)).andExpect(status().isOk());
        verify(live, times(3)).reply(eq("session-A"), anyMap());
        stateless(controller);
    }
    @Test void permissionAnswersValidateAndStripOnlyTheUiSentinelWithoutPendingCache() throws Exception {
        when(live.reply(eq("session-A"), anyMap())).thenReturn(Map.of("accepted", true));
        mvc.perform(post("/d/session/session-A/permission/question").contentType("application/json")
            .content("{\"outcome\":{\"outcome\":\"selected\",\"optionId\":\"__openapi_answers__\"},\"answers\":{\"0\":\"你好\"}}"))
            .andExpect(status().isOk());
        verify(live).reply(eq("session-A"), argThat(value -> value.containsKey("answers") && !value.containsKey("optionId")));
        mvc.perform(post("/d/session/session-A/permission/question").contentType("application/json")
            .content("{\"answers\":{\"0\":42}}")).andExpect(status().isBadRequest());
        mvc.perform(post("/d/session/session-A/permission/question").contentType("application/json")
            .content("{\"outcome\":{\"outcome\":\"selected\",\"optionId\":\"__openapi_answers__\"}}"))
            .andExpect(status().isBadRequest());
    }
    @Test void cancelKeepsLegacyAcceptanceAndRejectsFalseFalseWithoutLocalTerminal() throws Exception {
        for (Map<String, Object> accepted : List.<Map<String, Object>>of(Map.of("delivered", true), Map.of("noop", true),
            Map.of("accepted", true, "delivered", false, "warning", "cancel-accepted-legacy"))) {
            doReturn(accepted).when(live).cancel("session-A");
            mvc.perform(post("/d/session/session-A/cancel")).andExpect(status().isNoContent());
        }
        doReturn(Map.of("accepted", false, "delivered", false, "noop", false)).when(live).cancel("session-A");
        mvc.perform(post("/d/session/session-A/cancel")).andExpect(status().isBadGateway());
        doThrow(new RuntimeException("transport")).when(live).cancel("session-A");
        mvc.perform(post("/d/session/session-A/cancel")).andExpect(status().isBadGateway());
        stateless(controller);
    }
    static RemoteEventStream remote(String wire) {
        var stream = new RemoteEventStream();
        stream.onStream(subscriber -> subscriber.onSubscribe(new Subscription() {
            boolean sent;
            public void request(long n) { if (!sent) { sent = true; subscriber.onNext(ByteBuffer.wrap(wire.getBytes(StandardCharsets.UTF_8))); subscriber.onComplete(); } }
            public void cancel() {}
        }), 200, new HttpHeaders(Map.of("Content-Type", "text/event-stream")));
        return stream;
    }
    @Test void eventsUseOnlyHeaderCursorAndNeverEmitControlsOrAdvanceACachedCursor() throws Exception {
        String wire = "id: 91\nevent: turn_complete\ndata: {\"v\":1,\"type\":\"turn_complete\",\"data\":{\"sessionId\":\"session-A\",\"promptId\":\"remote-external\",\"stopReason\":\"end_turn\"}}\n\n";
        for (String cursor : new String[]{"0", null, "7"}) {
            when(live.events("session-A", cursor)).thenReturn(remote(wire));
            var response = new MockHttpServletResponse();
            freshController().events("session-A", "1", cursor, response);
            assertEquals(200, response.getStatus());
            assertTrue(response.getContentAsString().contains("remote-external"));
            assertFalse(response.getContentAsString().contains("workbench_prompt_result"));
            verify(live).events("session-A", cursor);
        }
        stateless(controller);
    }
    @Test void badEventsCannotBecomeSuccessfulFrames() throws Exception {
        for (String wire : List.of("data: {\"Error\":{\"Message\":\"denied\"}}\n\n",
            "data: {\"v\":1,\"type\":\"turn_complete\",\"data\":{\"sessionId\":\"other\",\"stopReason\":\"end_turn\"}}\n\n")) {
            when(live.events("session-A", null)).thenReturn(remote(wire));
            var response = new MockHttpServletResponse();
            controller.events("session-A", null, null, response);
            assertEquals(502, response.getStatus());
            assertFalse(response.getContentAsString().contains("data:"));
        }
        var invalid = new MockHttpServletResponse();
        controller.events("session-A", null, "-1", invalid);
        assertEquals(400, invalid.getStatus());
        verify(live, never()).events("session-A", "-1");
    }
    @Test void apiInvalidModePreservesTheBusinessEnvelope() throws Exception {
        var api = MockMvcBuilders.standaloneSetup(new com.das.java.web.RestApiController(cfg, new LiveClientHolder(live))).build();
        api.perform(post("/api/sessions").contentType("application/json").content("{\"mode\":\"bogus\"}"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.ok").value(false));
        verifyNoInteractions(live);
    }
    @Test void requestAgentFlowsThroughCreationListAndLookupWithoutState() throws Exception {
        when(live.createSessionWithOptions(any())).thenReturn(Map.of("sessionId", "created"));
        mvc.perform(post("/d/standalone/sessions").contentType("application/json")
            .content("{\"agentName\":\" ui-agent \"}")).andExpect(status().isOk());
        verify(live).createSessionWithOptions(new SessionOptions("env-model", "yolo", "medium", "ui-agent"));
        when(live.listSessions(true, "ui-agent")).thenReturn(Map.of("sessions", List.of(summary("remote"))));
        mvc.perform(get("/d/standalone/sessions").param("archiveState", "archived").param("agentName", " ui-agent "))
            .andExpect(status().isOk()).andExpect(jsonPath("$.sessions[0].displayName").value("remote"));
        when(live.sessionSummary("session-A", "ui-agent")).thenReturn(summary("lookup"));
        mvc.perform(get("/d/standalone/sessions/session-A").param("agentName", " ui-agent "))
            .andExpect(status().isOk()).andExpect(jsonPath("$.displayName").value("lookup"));
        verify(live).listSessions(true, "ui-agent");
        verify(live).sessionSummary("session-A", "ui-agent");
        assertEquals("custom-agent", cfg.agentName());
        stateless(controller);
    }

    @Test void invalidAgentIsRejectedBeforeAnyUpstreamCall() throws Exception {
        for (String name : List.of(" ", "a".repeat(129), "a\nb")) {
            mvc.perform(get("/d/standalone/sessions").param("agentName", name)).andExpect(status().isBadRequest());
            mvc.perform(get("/d/standalone/sessions/session-A").param("agentName", name)).andExpect(status().isBadRequest());
            mvc.perform(post("/d/standalone/sessions").contentType("application/json")
                .content(new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(Map.of("agentName", name))))
                .andExpect(status().isBadRequest());
        }
        verifyNoInteractions(live);
    }

    @Test void apiListForwardsAgentAndPreservesBusinessEnvelopeForInvalidInput() throws Exception {
        var api = MockMvcBuilders.standaloneSetup(new com.das.java.web.RestApiController(cfg, new LiveClientHolder(live))).build();
        when(live.listSessions(false, "ui-agent")).thenReturn(Map.of("sessions", List.of()));
        api.perform(get("/api/sessions").param("agentName", " ui-agent "))
            .andExpect(status().isOk()).andExpect(jsonPath("$.ok").value(true));
        verify(live).listSessions(false, "ui-agent");
        api.perform(get("/api/sessions").param("agentName", " "))
            .andExpect(status().isOk()).andExpect(jsonPath("$.ok").value(false));
        verifyNoMoreInteractions(live);
    }

}
