package com.das.java.live;

import static org.junit.jupiter.api.Assertions.*;

import com.aliyun.core.http.HttpHeaders;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.reactivestreams.Subscription;

class RemoteSseRelayTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Map<String, Object> DAEMON = Map.of("v", 1, "type", "session_update", "id", 9,
        "data", Map.of("sessionId", "session-A", "text", "你好🌏"));

    @Test void rawDaemonPreservesNamedEventAndRemoteCursor() throws Exception {
        var output = new ByteArrayOutputStream();
        var cursors = new ArrayList<String>();
        RemoteSseRelay.writeFrame(List.of("id: 9", "event: daemon", "data: " + JSON.writeValueAsString(DAEMON)), output, "session-A", cursors::add);
        assertTrue(output.toString(StandardCharsets.UTF_8).startsWith("id: 9\nevent: daemon\n"));
        assertEquals(List.of("9"), cursors);
    }

    @Test void acceptsPopEventAndDataStringAndObjectVariantsWithOuterCursor() throws Exception {
        String json = JSON.writeValueAsString(DAEMON);
        for (var envelope : List.of(Map.of("Id", "12", "Event", DAEMON), Map.of("Id", "12", "Event", json),
            Map.of("Id", "12", "Event", "daemon", "Data", DAEMON), Map.of("Id", "12", "Event", "daemon", "Data", json),
            Map.of("Id", "12", "Data", DAEMON), Map.of("Id", "12", "Data", json))) {
            var output = new ByteArrayOutputStream();
            var cursors = new ArrayList<String>();
            RemoteSseRelay.writeFrame(List.of("data: " + JSON.writeValueAsString(envelope)), output, "session-A", cursors::add);
            assertTrue(output.toString(StandardCharsets.UTF_8).startsWith("id: 12\n"));
            assertTrue(output.toString(StandardCharsets.UTF_8).contains("你好🌏"));
            assertEquals(List.of("12"), cursors);
        }
    }

    private static Map<?, ?> canonical(String wire) throws Exception {
        String payload = wire.lines().filter(line -> line.startsWith("data: ")).findFirst().orElseThrow().substring(6);
        return JSON.readValue(payload, Map.class);
    }

    // Synthetic protocol fixtures for the 40 types missing from the previous whitelist.
    // Pinned source: @qwen-code/sdk 0.1.13-preview.1, dist/daemon/events.d.ts.
    // No captured prompts, credentials, account labels, or real workspace/session identifiers.
    private static Stream<Arguments> sdkControlEvents() {
        return """
            model_switched|{"sessionId":"session-A","modelId":"test-model"}
            model_switch_failed|{"sessionId":"session-A","requestedModelId":"test-model","error":"synthetic failure"}
            session_closed|{"sessionId":"session-A","reason":"client_close"}
            session_recording_degraded|{"sessionId":"session-A","reason":"write_failed"}
            artifact_changed|{"sessionId":"session-A","change":{"action":"removed","artifactId":"artifact-test"}}
            source_changed|{"sessionId":"session-A","revision":1}
            mid_turn_message_injected|{"sessionId":"session-A","messages":["synthetic message"]}
            pending_prompt_added|{"sessionId":"session-A","promptId":"prompt-test","text":"synthetic message","queuedAt":1}
            pending_prompt_started|{"sessionId":"session-A","promptId":"prompt-test","text":"synthetic message"}
            pending_prompt_completed|{"sessionId":"session-A","promptId":"prompt-test","state":"completed"}
            history_truncated|{"reason":"replay_window_exceeded","truncatedEvents":1,"retainedEvents":1,"maxBytes":1024,"fullTranscriptAvailable":true}
            mcp_budget_warning|{"liveCount":3,"reservedCount":0,"budget":4,"thresholdRatio":0.75,"mode":"warn"}
            mcp_child_refused_batch|{"refusedServers":[{"name":"test-server","transport":"stdio","reason":"budget_exhausted"}],"budget":1,"liveCount":1,"reservedCount":0,"mode":"enforce"}
            memory_changed|{"scope":"workspace","filePath":"test-memory.md","mode":"append","bytesWritten":1}
            agent_changed|{"change":"updated","name":"test-agent","level":"project"}
            auth_device_flow_started|{"deviceFlowId":"flow-test","providerId":"test-provider","expiresAt":1}
            auth_device_flow_throttled|{"deviceFlowId":"flow-test","intervalMs":1000}
            auth_device_flow_authorized|{"deviceFlowId":"flow-test","providerId":"test-provider"}
            auth_device_flow_failed|{"deviceFlowId":"flow-test","errorKind":"expired_token"}
            auth_device_flow_cancelled|{"deviceFlowId":"flow-test"}
            tool_toggled|{"toolName":"test-tool","enabled":false}
            settings_changed|{"key":"test-setting","value":true}
            trust_change_requested|{"workspaceCwd":"/synthetic-workspace","desiredState":"untrusted"}
            workspace_initialized|{"path":"test-file.md","action":"noop"}
            github_setup_completed|{"releaseTag":"test-tag","readmeUrl":"https://example.invalid/readme","workflows":[],"gitignore":{"path":".gitignore","status":"unchanged"},"warnings":[]}
            mcp_server_restarted|{"serverName":"test-server","durationMs":1}
            mcp_server_restart_refused|{"serverName":"test-server","reason":"restart_failed"}
            mcp_server_changed|{"serverName":"test-server","action":"disable"}
            mcp_server_added|{"name":"test-server","transport":"stdio","replaced":false,"shadowedSettings":false,"toolCount":0,"originatorClientId":"client-test"}
            mcp_server_removed|{"name":"test-server","wasShadowingSettings":false,"originatorClientId":"client-test"}
            extensions_changed|{"refreshed":0,"failed":1,"status":"failed","error":"synthetic failure"}
            permission_partial_vote|{"requestId":"request-test","sessionId":"session-A","votesReceived":1,"votesNeeded":1,"quorum":2,"optionTallies":{"allow":1}}
            permission_forbidden|{"requestId":"request-test","sessionId":"session-A","reason":"remote_not_allowed"}
            channel_delivery_result|{"sessionId":"session-A","deliveryId":"delivery-test","status":"failed","source":"prompt","promptId":"prompt-test","code":"channel_delivery_failed","error":"synthetic failure"}
            user_shell_command|{"sessionId":"session-A","command":"echo synthetic","cwd":"/synthetic-workspace"}
            user_shell_result|{"sessionId":"session-A","exitCode":0,"aborted":false}
            session_rewound|{"sessionId":"session-A","promptId":"prompt-test","targetTurnIndex":0,"filesChanged":[],"filesFailed":[]}
            session_branched|{"sourceSessionId":"session-A","newSessionId":"session-B","displayName":"synthetic branch"}
            git_branch_changed|{"sessionId":"session-A","branch":"test-branch"}
            git_status_changed|{"sessionId":"session-A","dirty":false}
            """.lines().map(line -> line.split("\\|", 2)).map(parts -> Arguments.of(parts[0], parts[1]));
    }

    private static List<List<String>> eventEncodings(String type, Map<?, ?> data, int id) throws Exception {
        var daemon = Map.of("v", 1, "type", type, "id", id, "data", data);
        String json = JSON.writeValueAsString(data);
        return List.of(
            List.of("data:" + JSON.writeValueAsString(daemon)),
            List.of("data:" + JSON.writeValueAsString(Map.of("Id", "" + id, "Data", daemon))),
            List.of("event:" + type, "data:" + JSON.writeValueAsString(Map.of("Id", "" + id, "Data", data))),
            List.of("event:" + type, "data:" + JSON.writeValueAsString(Map.of("Id", "" + id, "Data", json))),
            List.of("data:" + JSON.writeValueAsString(Map.of("Id", "" + id, "Event", type, "Data", data))),
            List.of("event:" + type, "data:" + JSON.writeValueAsString(Map.of("Id", "" + id, "Event", json))),
            List.of("event:" + type, "id:" + id, "data:" + json));
    }

    @ParameterizedTest(name = "SDK control: {0}")
    @MethodSource("sdkControlEvents")
    void officialControlsPreservePayloadAcrossRawAndPopEncodings(String type, String json) throws Exception {
        var data = JSON.readValue(json, Map.class);
        for (var lines : eventEncodings(type, data, 41)) {
            var output = new ByteArrayOutputStream();
            var cursors = new ArrayList<String>();
            RemoteSseRelay.writeFrame(lines, output, "session-A", cursors::add);
            var result = canonical(output.toString(StandardCharsets.UTF_8));
            assertEquals(type, result.get("type"));
            assertEquals(data, result.get("data"));
            assertEquals(41, result.get("id"));
            assertEquals(List.of("41"), cursors);
        }
    }

    @ParameterizedTest(name = "SDK control guards: {0}")
    @MethodSource("sdkControlEvents")
    void officialControlsStillRejectCrossSessionAndInvalidCursor(String type, String json) throws Exception {
        Map<String, Object> data = JSON.readValue(json, Map.class);
        for (String key : List.of("sessionId", "SessionId", "sessionCode", "SessionCode")) {
            var other = new LinkedHashMap<>(data);
            other.put(key, "session-other");
            for (var lines : eventEncodings(type, other, 41)) rejectLines(lines);
        }
        for (Object id : List.of("-1", "1.5", "9007199254740992", "bad", "")) {
            rejectLines(List.of("event:" + type, "data:" + JSON.writeValueAsString(Map.of("Id", id, "Data", data))));
        }
        // session_closed is a terminal lifecycle frame, so absence is valid;
        // explicit malformed cursors above remain rejected for every control.
        if (!"session_closed".equals(type))
            rejectLines(List.of("event:" + type, "data:" + JSON.writeValueAsString(Map.of("Data", data))));
    }

    private static void rejectLines(List<String> lines) throws Exception {
        var output = new ByteArrayOutputStream();
        var cursors = new ArrayList<String>();
        assertThrows(IOException.class, () -> RemoteSseRelay.writeFrame(lines, output, "session-A", cursors::add));
        assertEquals(0, output.size(), "Rejected data must not reach browser");
        assertTrue(cursors.isEmpty(), "Rejected data must not advance cursor");
    }

    @Test void controlsReplayMessagesAndTerminalSurviveFragmentedFirstTurn() throws Exception {
        for (String terminalType : List.of("turn_complete", "turn_error", "stream_error")) {
            var expected = new ArrayList<Map<String, Object>>();
            expected.add(Map.of("type", "replay_complete", "data", Map.of("replayedCount", 0)));
            expected.add(Map.of("type", "approval_mode_changed", "data", Map.of("sessionId", "session-A", "previous", "auto", "next", "yolo", "persisted", false)));
            expected.add(Map.of("type", "session_metadata_updated", "data", Map.of("sessionId", "session-A", "prs", List.of())));
            expected.add(Map.of("type", "model_switch_failed", "data", Map.of("sessionId", "session-A", "requestedModelId", "test-model", "error", "synthetic failure")));
            expected.add(Map.of("type", "tool_toggled", "data", Map.of("toolName", "test-tool", "enabled", true)));
            for (String update : List.of("user_message_chunk", "agent_message_chunk")) {
                expected.add(Map.of("type", "session_update", "data", Map.of("sessionId", "session-A", "update",
                    Map.of("sessionUpdate", update, "content", Map.of("type", "text", "text", "synthetic 你好🌏")))));
            }
            Map<String, Object> terminal = switch (terminalType) {
                case "turn_complete" -> Map.of("sessionId", "session-A", "stopReason", "end_turn");
                case "turn_error" -> Map.of("sessionId", "session-A", "message", "synthetic failure");
                default -> Map.of("error", "synthetic failure", "errorKind", "upstream_error");
            };
            expected.add(Map.of("type", terminalType, "data", terminal));
            var wire = new StringBuilder();
            for (int i = 0; i < expected.size(); i++) {
                var envelope = new LinkedHashMap<String, Object>();
                envelope.put("Data", expected.get(i).get("data"));
                if (i > 0) envelope.put("Id", "" + i);
                wire.append("event:").append(expected.get(i).get("type")).append("\r\ndata:")
                    .append(JSON.writeValueAsString(envelope)).append("\r\n\r\n");
            }
            var output = new ByteArrayOutputStream();
            var cursors = new ArrayList<String>();
            var observed = new ArrayList<Map<String, Object>>();
            try (var remote = fragmented(wire.toString().getBytes(StandardCharsets.UTF_8))) {
                RemoteSseRelay.relay(remote, output, "session-A", cursors::add, observed::add);
            }
            var frames = output.toString(StandardCharsets.UTF_8).split("\n\n");
            assertEquals(expected.size(), frames.length);
            assertEquals(expected.size(), observed.size());
            for (int i = 0; i < expected.size(); i++) {
                var actual = canonical(frames[i]);
                assertEquals(expected.get(i).get("type"), actual.get("type"));
                assertEquals(expected.get(i).get("data"), actual.get("data"));
                assertEquals(actual, JSON.readValue(JSON.writeValueAsString(observed.get(i)), Map.class));
            }
            assertFalse(observed.get(0).containsKey("id"));
            assertEquals(List.of("1", "2", "3", "4", "5", "6", "7"), cursors);
        }
    }

    @Test void metadataAllowsOptionalDisplayNameIncludingPrOnlyUpdates() throws Exception {
        for (var data : List.of(Map.of("sessionId", "session-A"), Map.of("sessionId", "session-A", "prs", List.of()),
                Map.of("sessionId", "session-A", "prs", List.of(Map.of("number", 1, "url", "https://example.invalid/pr/1"))))) {
            for (var lines : eventEncodings("session_metadata_updated", data, 42)) {
                var output = new ByteArrayOutputStream();
                RemoteSseRelay.writeFrame(lines, output, "session-A", ignored -> {});
                assertEquals(data, canonical(output.toString(StandardCharsets.UTF_8)).get("data"));
            }
        }
        for (String json : List.of("{\"sessionId\":\"session-A\",\"displayName\":null}",
                "{\"sessionId\":\"session-A\",\"displayName\":42}", "{\"sessionId\":\"session-A\",\"prs\":{}}")) {
            rejectLines(List.of("event:session_metadata_updated", "id:42", "data:" + json));
        }
    }

    @Test void emptyReplayHasNoInventedCursorAndSuppliedCursorsRemainValidated() throws Exception {
        for (var lines : List.of(
                List.of("event:replay_complete", "data:{\"Data\":{\"replayedCount\":0}}"),
                List.of("event:replay_complete", "id:", "data:{\"Id\":\"\",\"Data\":{\"replayedCount\":0}}"),
                List.of("data:{\"v\":1,\"type\":\"replay_complete\",\"data\":{\"replayedCount\":0}}"))) {
            var output = new ByteArrayOutputStream();
            var cursors = new ArrayList<String>();
            RemoteSseRelay.writeFrame(lines, output, "session-A", cursors::add);
            var result = canonical(output.toString(StandardCharsets.UTF_8));
            assertEquals("replay_complete", result.get("type"));
            assertEquals(Map.of("replayedCount", 0), result.get("data"));
            assertFalse(result.containsKey("id"));
            assertFalse(output.toString(StandardCharsets.UTF_8).startsWith("id:"));
            assertTrue(cursors.isEmpty());
        }
        for (var data : List.of(Map.of("replayedCount", 0), Map.of("replayedCount", 0, "lastEventId", 42),
                Map.of("replayedCount", 1, "lastEventId", 42), Map.of("replayedCount", 1, "lastReplayedEventId", 42))) {
            for (var lines : eventEncodings("replay_complete", data, 42)) {
                var output = new ByteArrayOutputStream();
                var cursors = new ArrayList<String>();
                RemoteSseRelay.writeFrame(lines, output, "session-A", cursors::add);
                assertEquals(data, canonical(output.toString(StandardCharsets.UTF_8)).get("data"));
                assertEquals(List.of("42"), cursors);
            }
        }
        for (Object count : List.of(-1, 0.5, "0", 1)) {
            rejectLines(List.of("event:replay_complete", "id:42", "data:" + JSON.writeValueAsString(Map.of("Data", Map.of("replayedCount", count)))));
        }
        for (String key : List.of("lastEventId", "lastReplayedEventId")) {
            for (Object id : List.of(-1, 1.5, "bad", "", 9007199254740992L)) {
                rejectLines(List.of("event:replay_complete", "id:42", "data:" + JSON.writeValueAsString(Map.of("Data", Map.of("replayedCount", 0, key, id)))));
            }
        }
        rejectLines(List.of("event:replay_complete", "data:{\"Data\":{\"replayedCount\":1,\"lastEventId\":42}}"));
        rejectLines(List.of("event:replay_complete", "id:bad", "data:{\"Data\":{\"replayedCount\":0}}"));
        rejectLines(List.of("event:replay_complete", "data:{\"Id\":\"bad\",\"Data\":{\"replayedCount\":0}}"));
    }

    @Test void sdkErrorFieldsDoNotAllowRealPopErrorsOrUnknownFlattenedEvents() throws Exception {
        var errors = new LinkedHashMap<String, Map<String, Object>>();
        errors.put("model_switch_failed", Map.of("sessionId", "session-A", "requestedModelId", "test-model", "error", "synthetic failure"));
        errors.put("stream_error", Map.of("error", "synthetic failure"));
        errors.put("extensions_changed", Map.of("refreshed", 0, "failed", 1, "error", "synthetic failure"));
        errors.put("channel_delivery_result", Map.of("sessionId", "session-A", "deliveryId", "delivery-test", "status", "failed",
            "source", "scheduled", "taskId", "task-test", "firedAt", 1, "code", "channel_delivery_failed", "error", "synthetic failure"));
        var markers = List.of(Map.of("Error", "denied"), Map.of("error", Map.of("message", "denied")),
            Map.of("Success", false), Map.of("success", false), Map.of("Code", "Forbidden", "Message", "denied"),
            Map.of("JsonRpcResponse", Map.of("Error", "denied")), Map.of("jsonRpcResponse", Map.of("error", "denied")));
        for (var entry : errors.entrySet()) {
            for (var lines : eventEncodings(entry.getKey(), entry.getValue(), 43)) {
                var output = new ByteArrayOutputStream();
                RemoteSseRelay.writeFrame(lines, output, "session-A", ignored -> {});
                assertEquals(entry.getValue(), canonical(output.toString(StandardCharsets.UTF_8)).get("data"));
            }
            for (var marker : markers) {
                var envelope = new LinkedHashMap<String, Object>(Map.of("Id", "43", "Data", entry.getValue()));
                envelope.putAll(marker);
                rejectLines(List.of("event:" + entry.getKey(), "data:" + JSON.writeValueAsString(envelope)));
                var inner = new LinkedHashMap<>(entry.getValue());
                inner.putAll(marker);
                rejectLines(List.of("event:" + entry.getKey(), "data:" + JSON.writeValueAsString(Map.of("Id", "43", "Data", inner))));
                rejectLines(List.of("event:" + entry.getKey(), "id:43", "data:" + JSON.writeValueAsString(inner)));
            }
            // Lowercase error on the POP wrapper is not a domain payload field.
            rejectLines(List.of("event:" + entry.getKey(), "data:" + JSON.writeValueAsString(
                Map.of("Id", "43", "error", "denied", "Data", entry.getValue()))));
            rejectLines(List.of("event:unknown_control", "id:43", "data:" + JSON.writeValueAsString(entry.getValue())));
        }
        for (String type : List.of("model_switch_failed", "extensions_changed", "channel_delivery_result", "tool_toggled")) {
            rejectLines(List.of("event:" + type, "id:43", "data:{\"Data\":{\"error\":\"denied\"}}"));
        }
        rejectLines(List.of("event:unknown_control", "id:43", "data:{\"Data\":{\"update\":{}}}"));
        rejectLines(List.of("event:unknown_control", "id:43", "data:{\"Data\":{\"stopReason\":\"end_turn\"}}"));
    }

    @Test void rejectedControlStopsRelayWithoutAdvancingCursorOrForwardingLaterTerminal() throws Exception {
        String first = "event:session_update\nid:9\ndata:" + JSON.writeValueAsString(DAEMON) + "\n\n";
        String terminal = "event:turn_complete\nid:11\ndata:{\"Data\":{\"sessionId\":\"session-A\",\"stopReason\":\"end_turn\"}}\n\n";
        for (String invalid : List.of(
                "event:model_switch_failed\nid:10\ndata:{\"Data\":{\"Error\":\"denied\"}}",
                "event:stream_error\nid:10\ndata:{\"error\":\"denied\",\"Data\":{\"error\":\"synthetic failure\"}}",
                "event:tool_toggled\nid:10\ndata:{\"Data\":{\"sessionId\":\"session-other\",\"toolName\":\"test-tool\",\"enabled\":true}}",
                "event:tool_toggled\nid:9007199254740992\ndata:{\"Data\":{\"toolName\":\"test-tool\",\"enabled\":true}}",
                "event:unknown_control\nid:10\ndata:{\"Data\":{}}")) {
            var output = new ByteArrayOutputStream();
            var cursors = new ArrayList<String>();
            var observed = new ArrayList<Map<String, Object>>();
            try (var remote = fragmented((first + invalid + "\n\n" + terminal).getBytes(StandardCharsets.UTF_8))) {
                assertThrows(IOException.class, () -> RemoteSseRelay.relay(remote, output, "session-A", cursors::add, observed::add));
            }
            assertEquals(List.of("9"), cursors);
            assertEquals(1, observed.size());
            assertEquals(1, output.toString(StandardCharsets.UTF_8).split("\n\n").length);
            assertEquals("session_update", canonical(output.toString(StandardCharsets.UTF_8)).get("type"));
        }
    }

    @Test void flattenedPopPayloadsBecomeCanonicalUpdatesAndTerminalEvents() throws Exception {
        var update = Map.of("sessionId", "session-A", "update", Map.of("sessionUpdate", "agent_message_chunk",
            "content", Map.of("type", "text", "text", "你好")));
        var terminal = Map.of("sessionId", "session-A", "stopReason", "end_turn");
        for (var data : List.of(update, terminal)) {
            String type = data.containsKey("update") ? "session_update" : "turn_complete";
            for (Object wrapper : List.of(Map.of("Id", "21", "Data", data), Map.of("Id", "21", "Data", JSON.writeValueAsString(data)),
                Map.of("Id", "21", "Event", data), Map.of("Id", "21", "Event", JSON.writeValueAsString(data)),
                Map.of("Id", "21", "Event", type, "Data", data))) {
                var output = new ByteArrayOutputStream();
                var cursors = new ArrayList<String>();
                RemoteSseRelay.writeFrame(List.of("data: " + JSON.writeValueAsString(wrapper)), output, "session-A", cursors::add);
                String wire = output.toString(StandardCharsets.UTF_8);
                Map<?, ?> result = canonical(wire);
                assertTrue(wire.startsWith("id: 21\nevent: " + type + "\n"));
                assertEquals(1, result.get("v"));
                assertEquals(type, result.get("type"));
                assertEquals(21, result.get("id"));
                assertEquals(data, result.get("data"));
                assertEquals(List.of("21"), cursors);
            }
        }
    }

    @Test void namedPopDataBecomesTypedEventAndKeepsOriginMetadata() throws Exception {
        var output = new ByteArrayOutputStream();
        var inner = Map.of("type", "permission_resolved", "data", Map.of("sessionId", "session-A", "requestId", "r"),
            "originatorClientId", "client", "_meta", Map.of("source", "remote"));
        RemoteSseRelay.writeFrame(List.of("data: " + JSON.writeValueAsString(Map.of("Id", "22", "Event", inner))), output, "session-A", ignored -> {});
        var result = canonical(output.toString(StandardCharsets.UTF_8));
        assertEquals("permission_resolved", result.get("type"));
        assertEquals("client", result.get("originatorClientId"));
        assertEquals(Map.of("source", "remote"), result.get("_meta"));
        output.reset();
        RemoteSseRelay.writeFrame(List.of("data: " + JSON.writeValueAsString(Map.of("Id", "23", "Event", "permission_resolved",
            "Data", Map.of("sessionId", "session-A", "requestId", "r")))), output, "session-A", ignored -> {});
        assertEquals("permission_resolved", canonical(output.toString(StandardCharsets.UTF_8)).get("type"));
    }

    @Test void legitimateDaemonTurnErrorIsNotMistakenForPopBusinessError() throws Exception {
        var output = new ByteArrayOutputStream();
        var event = Map.of("v", 1, "type", "turn_error", "id", 24,
            "data", Map.of("sessionId", "session-A", "error", Map.of("message", "tool failed")));
        RemoteSseRelay.writeFrame(List.of("data: " + JSON.writeValueAsString(event)), output, "session-A", ignored -> {});
        assertEquals("turn_error", canonical(output.toString(StandardCharsets.UTF_8)).get("type"));
    }

    @Test void flattenedFramesStillRejectOtherSessionsAndErrors() throws Exception {
        reject(JSON.writeValueAsString(Map.of("Id", "21", "Data", Map.of("sessionId", "session-B", "update", Map.of()))));
        reject(JSON.writeValueAsString(Map.of("Id", "22", "Event", "turn_complete", "Data", Map.of("sessionId", "session-B", "stopReason", "end_turn"))));
        reject(JSON.writeValueAsString(Map.of("Id", "23", "Event", "turn_complete", "Data", Map.of("Error", Map.of("Message", "denied")))));
    }

    @Test void actualPrePopStreamOpenAcceptsEmptySseIdWithoutInventingCursor() throws Exception {
        // Observed via the real Java SDK GET against the authorized existing pre session.
        for (var envelope : List.of(Map.of("Data", Map.of()), Map.of("Id", "", "Data", Map.of()))) {
            var output = new ByteArrayOutputStream();
            var cursors = new ArrayList<String>();
            RemoteSseRelay.writeFrame(List.of("data:" + JSON.writeValueAsString(envelope), "event:stream_open", "id:"),
                output, "session-A", cursors::add);
            String wire = output.toString(StandardCharsets.UTF_8);
            assertTrue(wire.startsWith("event: stream_open\n"));
            var result = canonical(wire);
            assertEquals("stream_open", result.get("type"));
            assertEquals(Map.of(), result.get("data"));
            assertFalse(result.containsKey("id"));
            assertTrue(cursors.isEmpty());
        }
    }

    @Test void actualPreReplayMetadataAndBarrierFramesRemainTypedAndKeepTheirRemoteIds() throws Exception {
        var cases = List.of(
            Map.of("type", "session_metadata_updated", "id", 18, "data", Map.of("sessionId", "session-A", "displayName", "remote title", "titleSource", "auto")),
            Map.of("type", "followup_suggestion", "id", 32, "data", Map.of("sessionId", "session-A", "suggestion", "type /review to start", "promptId", "remote-original")),
            Map.of("type", "settings_reloaded", "id", 33, "data", Map.of("env", Map.of("updatedKeys", List.of(), "removedKeys", List.of()), "changedKeys", List.of(), "runtimeEnvironmentApplied", true)),
            Map.of("type", "replay_complete", "id", 33, "data", Map.of("lastReplayedEventId", 33, "lastEventId", 33, "replayedCount", 16)));
        for (var event : cases) {
            var output = new ByteArrayOutputStream();
            var cursors = new ArrayList<String>();
            // replay_complete's Id is the SSE barrier field, not a new fabricated content ID.
            Map<String, Object> envelope = "replay_complete".equals(event.get("type"))
                ? Map.of("Data", event.get("data")) : Map.of("Data", event.get("data"), "Id", event.get("id").toString());
            RemoteSseRelay.writeFrame(List.of("data:" + JSON.writeValueAsString(envelope), "event:" + event.get("type"), "id:" + event.get("id"), "retry:3000"),
                output, "session-A", cursors::add);
            var result = canonical(output.toString(StandardCharsets.UTF_8));
            assertEquals(event.get("type"), result.get("type"));
            assertEquals(event.get("id"), result.get("id"));
            assertEquals(event.get("data"), result.get("data"));
            assertEquals(List.of(event.get("id").toString()), cursors);
        }
    }

    @Test void approvalModeChangeDoesNotBreakFirstTurnOrCursorReplay() throws Exception {
        // POP flattens daemon data, leaving its discriminator in the SSE event field.
        // New sessions emit this before their first user/assistant message.
        var mode = Map.of("sessionId", "session-A", "previous", "auto", "next", "yolo", "persisted", false);
        var output = new ByteArrayOutputStream();
        var cursors = new ArrayList<String>();
        RemoteSseRelay.writeFrame(List.of("event:approval_mode_changed", "id:2", "retry:3000",
            "data:" + JSON.writeValueAsString(Map.of("Id", "2", "Data", mode))), output, "session-A", cursors::add);
        var event = canonical(output.toString(StandardCharsets.UTF_8));
        assertEquals("approval_mode_changed", event.get("type"));
        assertEquals(mode, event.get("data"));
        for (String type : List.of("user_message_chunk", "agent_message_chunk")) {
            int id = type.startsWith("user") ? 3 : 4;
            RemoteSseRelay.writeFrame(List.of("event:session_update", "id:" + id,
                "data:" + JSON.writeValueAsString(Map.of("Id", "" + id, "Data", Map.of("sessionId", "session-A",
                    "update", Map.of("sessionUpdate", type, "content", Map.of("type", "text", "text", type)))))),
                output, "session-A", cursors::add);
        }
        assertEquals(List.of("2", "3", "4"), cursors);
        assertTrue(output.toString(StandardCharsets.UTF_8).contains("user_message_chunk"));
        assertTrue(output.toString(StandardCharsets.UTF_8).contains("agent_message_chunk"));
        var rejected = new ByteArrayOutputStream();
        assertThrows(IOException.class, () -> RemoteSseRelay.writeFrame(List.of("event:approval_mode_changed", "id:2",
            "data:" + JSON.writeValueAsString(Map.of("Data", Map.of("sessionId", "another-session",
                "previous", "auto", "next", "yolo", "persisted", false)))), rejected, "session-A", ignored -> {}));
        assertEquals(0, rejected.size());
    }

    @Test void invalidReplayMetadataAndUnknownFlattenedTypesAreNotSilentlySwallowed() throws Exception {
        for (String type : List.of("session_metadata_updated", "followup_suggestion", "settings_reloaded", "replay_complete", "approval_mode_changed", "unknown_control")) {
            var output = new ByteArrayOutputStream();
            assertThrows(IOException.class, () -> RemoteSseRelay.writeFrame(List.of("data:{\"Data\":{}}", "event:" + type, "id:18"), output, "session-A", ignored -> {}));
            assertEquals(0, output.size());
        }
    }

    @Test void remoteRootPromptIdIsPreservedWithoutRemappingToLocalAdmission() throws Exception {
        var output = new ByteArrayOutputStream();
        var remote = Map.of("v", 1, "type", "turn_complete", "promptId", "upstream-original",
            "data", Map.of("sessionId", "session-A", "stopReason", "end_turn"));
        RemoteSseRelay.writeFrame(List.of("id: 7", "data: " + JSON.writeValueAsString(Map.of("Event", remote, "Id", "7"))),
            output, "session-A", ignored -> {});
        var event = canonical(output.toString(StandardCharsets.UTF_8));
        assertEquals("upstream-original", event.get("promptId"));
        assertFalse(((Map<?, ?>)event.get("data")).containsKey("promptId"), "Do not invent or relocate remote identity");
    }

    @Test void remoteQuestionWithoutOptionsGainsUiOnlyAnswerOption() throws Exception {
        var output = new ByteArrayOutputStream();
        var data = Map.of("sessionId", "session-A", "requestId", "q", "toolCall", Map.of("_meta", Map.of("toolName", "ask_user_question")), "options", List.of());
        RemoteSseRelay.writeFrame(List.of("id: 8", "event: permission_request", "data: " + JSON.writeValueAsString(Map.of("Data", data))),
            output, "session-A", ignored -> {});
        var permission = (Map<?, ?>)canonical(output.toString(StandardCharsets.UTF_8)).get("data");
        assertEquals(true, permission.get("openApiAnswersOnly"));
        assertEquals("__openapi_answers__", ((Map<?, ?>)((List<?>)permission.get("options")).get(0)).get("optionId"));
    }

    @Test void streamOpenAndCommentsAreAllowedWithoutCursorAndAckIsSkipped() throws Exception {
        var output = new ByteArrayOutputStream();
        var cursors = new ArrayList<String>();
        RemoteSseRelay.writeFrame(List.of("event: stream_open", "data: {\"v\":1,\"type\":\"stream_open\",\"data\":{}}"), output, "session-A", cursors::add);
        assertTrue(output.toString(StandardCharsets.UTF_8).startsWith("event: stream_open\n"));
        RemoteSseRelay.writeFrame(List.of(": heartbeat"), output, "session-A", cursors::add);
        int size = output.size();
        RemoteSseRelay.writeFrame(List.of("data: {\"ACKRequestId\":\"ack\"}"), output, "session-A", cursors::add);
        RemoteSseRelay.writeFrame(List.of("data: {\"Id\":\"99\",\"Data\":{\"ACKRequestId\":\"ack\",\"RequestId\":\"r\"}}"), output, "session-A", cursors::add);
        assertEquals(size, output.size());
        assertTrue(cursors.isEmpty());
    }

    private static void reject(String data) throws Exception {
        var output = new ByteArrayOutputStream();
        var cursors = new ArrayList<String>();
        assertThrows(IOException.class, () -> RemoteSseRelay.writeFrame(List.of("id: 9", "data: " + data), output, "session-A", cursors::add));
        assertEquals(0, output.size(), "Rejected data must not reach browser");
        assertTrue(cursors.isEmpty(), "Rejected data must not advance remote cursor");
    }

    @Test void rejectsBusinessErrorsAtEveryEnvelopeLevel() throws Exception {
        for (String data : List.of("{\"Error\":{\"Message\":\"denied\"}}", "{\"JsonRpcResponse\":{\"Error\":{\"Code\":403}}}",
            "{\"Code\":\"Forbidden\",\"Message\":\"denied\"}", "{\"success\":false}",
            "{\"Id\":\"9\",\"Data\":{\"Error\":{\"Message\":\"denied\"}}}",
            "{\"Event\":\"{\\\"Error\\\":{\\\"Code\\\":403}}\"}")) reject(data);
    }

    @Test void rejectsMalformedUnknownAndNonDaemonPayloads() throws Exception {
        for (String data : List.of("not-json", "{", "[]", "null", "42", "\"text\"", "{\"unknown\":true}",
            "{\"type\":\"session_update\",\"data\":{}}", "{\"v\":2,\"type\":\"session_update\",\"data\":{}}",
            "{\"v\":1,\"type\":\"session_update\",\"data\":\"not-an-object\"}",
            "{\"Event\":\"daemon\",\"Data\":\"not-json\"}", "{\"Event\":\"{broken\"}")) reject(data);
    }

    @Test void trailingJsonTokensCannotBypassDaemonValidation() throws Exception {
        reject(JSON.writeValueAsString(DAEMON) + " false");
        reject(JSON.writeValueAsString(Map.of("Event", JSON.writeValueAsString(DAEMON) + " garbage")));
    }

    @Test void rejectsFramesForAnotherSessionIncludingPopWrappers() throws Exception {
        var other = Map.of("v", 1, "type", "session_update", "data", Map.of("sessionId", "session-B"));
        reject(JSON.writeValueAsString(other));
        reject(JSON.writeValueAsString(Map.of("Event", other)));
        reject(JSON.writeValueAsString(Map.of("Data", other)));
        reject(JSON.writeValueAsString(Map.of("sessionId", "session-B", "Event", DAEMON)));
    }

    @Test void rejectsUnsafeCursorAndEventInjectionWithoutSwallowingExceptions() throws Exception {
        for (String cursor : List.of("-1", "9.2", "9007199254740992", "bad", "")) {
            var output = new ByteArrayOutputStream();
            assertThrows(IOException.class, () -> RemoteSseRelay.writeFrame(List.of("id: " + cursor, "data: " + JSON.writeValueAsString(DAEMON)), output, "session-A", ignored -> {}));
            assertEquals(0, output.size());
            reject(JSON.writeValueAsString(Map.of("Id", cursor, "Data", DAEMON)));
        }
        reject(JSON.writeValueAsString(Map.of("Event", "daemon\ndata: injected", "Data", DAEMON)));
        reject("{\"v\":1,\"type\":\"session_update\",\"id\":-1,\"data\":{}}");
    }

    @Test void idlessNonOpeningEventIsRejected() throws Exception {
        var output = new ByteArrayOutputStream();
        assertThrows(IOException.class, () -> RemoteSseRelay.writeFrame(List.of("data: {\"v\":1,\"type\":\"session_update\",\"data\":{}}"), output, "session-A", ignored -> {}));
        assertEquals(0, output.size());
    }

    private static Stream<Arguments> cursorlessLifecycleEvents() {
        return Stream.of(
            Arguments.of("stream_error", Map.of("error", "synthetic upstream failure", "errorKind", "upstream_error")),
            Arguments.of("session_closed", Map.of("sessionId", "session-A", "reason", "client_close")),
            Arguments.of("session_died", Map.of("sessionId", "session-A", "reason", "process_exit")),
            Arguments.of("client_evicted", Map.of("reason", "slow_consumer")),
            Arguments.of("state_resync_required", Map.of("reason", "ring_evicted", "lastDeliveredId", 9, "earliestAvailableId", 20)));
    }

    private static List<List<String>> cursorlessEncodings(String type, Map<?, ?> data) throws Exception {
        var daemon = Map.of("v", 1, "type", type, "data", data);
        String json = JSON.writeValueAsString(data);
        return List.of(
            List.of("data:" + JSON.writeValueAsString(daemon)),
            List.of("data:" + JSON.writeValueAsString(Map.of("Data", daemon))),
            List.of("event:" + type, "data:" + JSON.writeValueAsString(Map.of("Data", data))),
            List.of("event:" + type, "data:" + JSON.writeValueAsString(Map.of("Data", json))),
            List.of("data:" + JSON.writeValueAsString(Map.of("Event", type, "Data", data))),
            List.of("event:" + type, "data:" + JSON.writeValueAsString(Map.of("Event", json))),
            List.of("event:" + type, "data:" + json));
    }

    @ParameterizedTest(name = "Cursorless lifecycle: {0}")
    @MethodSource("cursorlessLifecycleEvents")
    void cursorlessLifecyclePreservesPayloadAndLastDeliveredCursor(String type, Map<String, Object> data) throws Exception {
        for (var lines : cursorlessEncodings(type, data)) {
            String first = "id:9\ndata:" + JSON.writeValueAsString(DAEMON) + "\n\n";
            // EOF in a later frame must not advance the last successfully delivered id.
            String wire = first + String.join("\n", lines) + "\n\nid:10\ndata:{";
            var output = new ByteArrayOutputStream();
            var cursors = new ArrayList<String>();
            var observed = new ArrayList<Map<String, Object>>();
            try (var remote = fragmented(wire.getBytes(StandardCharsets.UTF_8))) {
                RemoteSseRelay.relay(remote, output, "session-A", cursors::add, observed::add);
            }
            var frames = output.toString(StandardCharsets.UTF_8).split("\n\n");
            assertEquals(2, frames.length);
            var lifecycle = canonical(frames[1]);
            assertEquals(type, lifecycle.get("type"));
            assertEquals(data, lifecycle.get("data"));
            assertFalse(lifecycle.containsKey("id"));
            assertFalse(frames[1].contains("id:"));
            assertEquals(List.of("9"), cursors);
            assertEquals(2, observed.size());
            assertEquals(lifecycle, observed.get(1));
        }
        // An actual supplied cursor remains authoritative; do not discard it for these types.
        for (var lines : eventEncodings(type, data, 41)) {
            var output = new ByteArrayOutputStream();
            var cursors = new ArrayList<String>();
            RemoteSseRelay.writeFrame(lines, output, "session-A", cursors::add);
            assertEquals(41, canonical(output.toString(StandardCharsets.UTF_8)).get("id"));
            assertEquals(List.of("41"), cursors);
        }
    }

    @ParameterizedTest(name = "Cursorless lifecycle guards: {0}")
    @MethodSource("cursorlessLifecycleEvents")
    void cursorlessLifecycleDoesNotBypassSessionBusinessErrorOrCursorGuards(String type, Map<String, Object> data) throws Exception {
        for (String key : List.of("sessionId", "SessionId", "sessionCode", "SessionCode")) {
            var other = new LinkedHashMap<>(data);
            other.put(key, "session-other");
            for (var lines : cursorlessEncodings(type, other)) rejectLines(lines);
        }
        for (var marker : List.of(Map.of("Error", "denied"), Map.of("error", Map.of("message", "denied")),
                Map.of("Success", false), Map.of("success", false), Map.of("Code", "Forbidden", "Message", "denied"),
                Map.of("JsonRpcResponse", Map.of("Error", "denied")), Map.of("jsonRpcResponse", Map.of("error", "denied")))) {
            var invalid = new LinkedHashMap<>(data);
            invalid.putAll(marker);
            for (var lines : cursorlessEncodings(type, invalid)) rejectLines(lines);
            var outer = new LinkedHashMap<String, Object>(Map.of("Data", data));
            outer.putAll(marker);
            rejectLines(List.of("event:" + type, "data:" + JSON.writeValueAsString(outer)));
        }
        for (Object id : List.of("", "bad", -1, 1.5, 9007199254740992L)) {
            for (var lines : cursorlessEncodings(type, data)) {
                var withSseId = new ArrayList<>(lines);
                withSseId.add("id:" + id);
                rejectLines(withSseId);
            }
            rejectLines(List.of("event:" + type, "data:" + JSON.writeValueAsString(Map.of("Id", id, "Data", data))));
            // A valid SSE cursor must not hide a malformed inner daemon cursor.
            rejectLines(List.of("id:41", "data:" + JSON.writeValueAsString(Map.of("v", 1, "type", type, "id", id, "data", data))));
        }
        rejectLines(List.of("event:" + type, "data:" + JSON.writeValueAsString(Map.of("error", "denied", "Data", data))));
        for (var lines : cursorlessEncodings(type, Map.of())) rejectLines(lines);
    }

    @Test void cursorlessExceptionDoesNotExtendToOrderedEventsOrUnknownCloseAliases() throws Exception {
        var events = new LinkedHashMap<String, Map<String, Object>>();
        events.put("session_update", Map.of("sessionId", "session-A", "update", Map.of("sessionUpdate", "agent_message_chunk")));
        events.put("turn_complete", Map.of("sessionId", "session-A", "stopReason", "end_turn"));
        events.put("turn_error", Map.of("sessionId", "session-A", "message", "synthetic failure"));
        events.put("model_switch_failed", Map.of("sessionId", "session-A", "requestedModelId", "test-model", "error", "synthetic failure"));
        events.put("tool_toggled", Map.of("toolName", "test-tool", "enabled", true));
        events.put("permission_request", Map.of("sessionId", "session-A", "requestId", "request-test", "options", List.of()));
        events.put("history_truncated", Map.of("reason", "replay_window_exceeded", "truncatedEvents", 1,
            "retainedEvents", 1, "maxBytes", 1024, "fullTranscriptAvailable", true));
        events.put("close", Map.of("sessionId", "session-A", "reason", "client_close"));
        for (var event : events.entrySet()) {
            for (var lines : cursorlessEncodings(event.getKey(), event.getValue())) rejectLines(lines);
        }
        for (Object invalid : List.of(-1, 0.5, "9", 9007199254740992L)) {
            for (String key : List.of("lastDeliveredId", "earliestAvailableId")) {
                var data = new LinkedHashMap<String, Object>(Map.of("reason", "ring_evicted", "lastDeliveredId", 9, "earliestAvailableId", 20));
                data.put(key, invalid);
                for (var lines : cursorlessEncodings("state_resync_required", data)) rejectLines(lines);
            }
        }
    }

    private static RemoteEventStream fragmented(byte[] bytes) {
        RemoteEventStream stream = new RemoteEventStream();
        stream.onStream(subscriber -> subscriber.onSubscribe(new Subscription() {
            int offset;
            @Override public void request(long n) {
                if (offset < bytes.length) subscriber.onNext(ByteBuffer.wrap(new byte[]{bytes[offset++]}));
                else subscriber.onComplete();
            }
            @Override public void cancel() {}
        }), 200, new HttpHeaders(Map.of("Content-Type", "text/event-stream")));
        return stream;
    }

    @Test void incrementalUtf8CrlfAndPartialEofDoNotCorruptOrAdvanceIncompleteCursor() throws Exception {
        String wire = "id: 9\r\nevent: daemon\r\ndata: " + JSON.writeValueAsString(DAEMON) + "\r\n\r\nid: 10\r\ndata: {";
        try (var stream = fragmented(wire.getBytes(StandardCharsets.UTF_8))) {
            var output = new ByteArrayOutputStream();
            var cursors = new ArrayList<String>();
            RemoteSseRelay.relay(stream, output, "session-A", cursors::add);
            assertTrue(output.toString(StandardCharsets.UTF_8).contains("你好🌏"));
            assertFalse(output.toString(StandardCharsets.UTF_8).contains("id: 10"));
            assertEquals(List.of("9"), cursors);
        }
    }

    @Test void malformedUtf8IsRejected() throws Exception {
        try (var stream = fragmented(new byte[]{(byte)0xc3, 0x28})) {
            assertThrows(IOException.class, () -> RemoteSseRelay.relay(stream, new ByteArrayOutputStream(), "session-A", ignored -> {}));
        }
    }
}
