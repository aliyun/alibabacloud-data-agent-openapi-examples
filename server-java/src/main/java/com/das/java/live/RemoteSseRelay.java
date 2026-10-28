package com.das.java.live;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/** Handles raw daemon SSE and POP envelopes without losing remote cursor or Unicode. */
public final class RemoteSseRelay {
    private static final ObjectMapper JSON = new ObjectMapper()
        .enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    // @qwen-code/sdk 0.1.13-preview.1: DAEMON_KNOWN_EVENT_TYPE_VALUES in daemon/events.d.ts,
    // plus the existing transport/admission events below.
    private static final java.util.Set<String> EVENT_TYPES = java.util.Set.of(
        "stream_open", "session_update", "turn_complete", "turn_error", "prompt_cancelled",
        "permission_request", "permission_resolved", "permission_already_resolved", "session_snapshot",
        "prompt_accepted", "prompt_started", "resync_required", "state_resync_required", "session_died",
        "stream_error", "client_evicted", "slow_client_warning", "session_metadata_updated", "followup_suggestion",
        "settings_reloaded", "replay_complete", "approval_mode_changed",
        "model_switched", "model_switch_failed", "session_closed", "session_recording_degraded",
        "artifact_changed", "source_changed", "mid_turn_message_injected", "pending_prompt_added",
        "pending_prompt_started", "pending_prompt_completed", "history_truncated", "mcp_budget_warning",
        "mcp_child_refused_batch", "memory_changed", "agent_changed", "auth_device_flow_started",
        "auth_device_flow_throttled", "auth_device_flow_authorized", "auth_device_flow_failed",
        "auth_device_flow_cancelled", "tool_toggled", "settings_changed", "trust_change_requested",
        "workspace_initialized", "github_setup_completed", "mcp_server_restarted", "mcp_server_restart_refused",
        "mcp_server_changed", "mcp_server_added", "mcp_server_removed", "extensions_changed",
        "permission_partial_vote", "permission_forbidden", "channel_delivery_result", "user_shell_command",
        "user_shell_result", "session_rewound", "session_branched", "git_branch_changed", "git_status_changed");
    private static final int MAX_FRAME = 4 * 1024 * 1024;
    private RemoteSseRelay() {}

    public static void relay(RemoteEventStream remote, OutputStream output, String sessionId, Consumer<String> cursor) throws IOException {
        relay(remote, output, sessionId, cursor, event -> {});
    }

    public static void relay(RemoteEventStream remote, OutputStream output, String sessionId, Consumer<String> cursor,
            Consumer<Map<String, Object>> observer) throws IOException {
        if (sessionId == null || sessionId.isBlank()) throw new IllegalArgumentException("Expected session ID is required");
        InputStream chunks = new InputStream() {
            byte[] current = new byte[0];
            int offset;
            @Override public int read() throws IOException {
                while (offset == current.length) {
                    current = remote.next();
                    offset = 0;
                    if (current == null) return -1;
                }
                return current[offset++] & 255;
            }
            @Override public int read(byte[] bytes, int off, int len) throws IOException {
                if (len == 0) return 0;
                int first = read();
                if (first == -1) return -1;
                bytes[off] = (byte) first;
                int count = Math.min(len - 1, current.length - offset);
                System.arraycopy(current, offset, bytes, off + 1, count);
                offset += count;
                return count + 1;
            }
        };
        // BufferedReader reads UTF-8 across arbitrary byte boundaries, including CRLF.
        BufferedReader reader = new BufferedReader(new InputStreamReader(chunks, StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)));
        List<String> lines = new ArrayList<>();
        int size = 0;
        StringBuilder line = new StringBuilder();
        int ch;
        while ((ch = reader.read()) != -1) {
            if (++size > MAX_FRAME) throw new IOException("GetAgentSessionEvents frame exceeds 4 MiB");
            if (ch != '\n') { line.append((char) ch); continue; }
            String value = line.toString();
            if (value.endsWith("\r")) value = value.substring(0, value.length() - 1);
            line.setLength(0);
            if (!value.isEmpty()) lines.add(value);
            else {
                writeFrame(lines, output, sessionId, cursor, observer);
                lines.clear();
                size = 0;
            }
        }
        // A partial event at EOF must never advance the cursor.
    }

    public static boolean safeCursor(String value) {
        if (value == null || !value.matches("[0-9]+")) return false;
        try { return Long.parseLong(value) <= 9_007_199_254_740_991L; }
        catch (NumberFormatException error) { return false; }
    }

    private static String cursor(Object value) throws IOException {
        if (value == null) return null;
        String text = value.toString();
        if (!safeCursor(text)) throw new IOException("Invalid remote SSE cursor");
        return text;
    }

    private static Map<?, ?> object(Object value) throws IOException {
        if (value instanceof String text) {
            try { value = JSON.readValue(text, Object.class); }
            catch (com.fasterxml.jackson.core.JsonProcessingException error) {
                throw new IOException("GetAgentSessionEvents returned invalid JSON", error);
            }
        }
        if (!(value instanceof Map<?, ?> map)) throw new IOException("GetAgentSessionEvents returned a non-object payload");
        return map;
    }

    private static void rejectError(Map<?, ?> map) throws IOException {
        rejectError(map, false);
    }

    private static void rejectError(Map<?, ?> map, boolean sdkErrorField) throws IOException {
        Object rpc = map.get("JsonRpcResponse");
        if (rpc == null) rpc = map.get("jsonRpcResponse");
        if (map.get("Error") != null || !sdkErrorField && map.get("error") != null
            || Boolean.FALSE.equals(map.get("Success")) || Boolean.FALSE.equals(map.get("success"))
            || rpc instanceof Map<?, ?> nested && (nested.get("Error") != null || nested.get("error") != null)
            || map.containsKey("Code") && map.containsKey("Message"))
            throw new IOException("GetAgentSessionEvents returned a POP business error");
    }

    /** Only these SDK payloads give a top-level lowercase error field domain meaning.
     * This exception never applies to a POP or daemon envelope, or other error markers. */
    private static boolean sdkErrorPayload(String type, Map<?, ?> data) {
        if (!(data.get("error") instanceof String)) return false;
        return switch (type) {
            case "model_switch_failed" -> data.get("sessionId") instanceof String
                && data.get("requestedModelId") instanceof String;
            case "stream_error" -> !data.containsKey("errorKind") || data.get("errorKind") instanceof String;
            case "extensions_changed" -> data.get("refreshed") instanceof Number
                && data.get("failed") instanceof Number;
            case "channel_delivery_result" -> data.get("sessionId") instanceof String
                && data.get("deliveryId") instanceof String && "failed".equals(data.get("status"))
                && java.util.Set.of("channel_worker_unavailable", "channel_delivery_timeout", "channel_delivery_invalid",
                    "channel_delivery_rejected", "channel_delivery_queue_full", "channel_delivery_failed")
                    .contains(data.get("code") instanceof String code ? code : "")
                && ("prompt".equals(data.get("source")) && data.get("promptId") instanceof String
                    || "scheduled".equals(data.get("source")) && data.get("taskId") instanceof String
                        && data.get("firedAt") instanceof Number);
            default -> false;
        };
    }

    private static boolean ackOnly(Map<?, ?> map) {
        return map.containsKey("ACKRequestId") && map.keySet().stream()
            .allMatch(key -> "ACKRequestId".equals(key) || "RequestId".equals(key));
    }

    /** SDK 0.1.13-preview.1 types.d.ts: DaemonEvent.id is optional for terminal/synthetic
     * frames. events.d.ts names these four terminalEvent variants and describes
     * state_resync_required as synthetic. Do not extend this to ordinary ordered
     * controls, turn_complete/turn_error, or snapshot-only history markers. */
    private static boolean cursorlessLifecyclePayload(String type, Map<?, ?> data) {
        return switch (type) {
            case "stream_error" -> sdkErrorPayload(type, data);
            case "session_closed", "session_died" -> data.get("sessionId") instanceof String
                && data.get("reason") instanceof String;
            case "client_evicted" -> data.get("reason") instanceof String;
            case "state_resync_required" -> data.get("reason") instanceof String
                && safeCursorNumber(data.get("lastDeliveredId")) && safeCursorNumber(data.get("earliestAvailableId"));
            default -> false;
        };
    }

    private static boolean safeCursorNumber(Object value) {
        return value instanceof Number number && Double.isFinite(number.doubleValue())
            && number.doubleValue() >= 0 && number.doubleValue() <= 9_007_199_254_740_991L
            && number.doubleValue() == Math.rint(number.doubleValue());
    }

    private static void checkSession(Map<?, ?> map, String expected) throws IOException {
        for (String key : List.of("sessionId", "SessionId", "sessionCode", "SessionCode")) {
            Object value = map.get(key);
            if (value != null && !expected.equals(value)) throw new IOException("Remote SSE frame belongs to another session");
        }
    }

    /** Explicit schemas observed on the real POP replay path; unknown flattened types still fail. */
    private static void validateReplayMetadata(String type, Map<?, ?> data) throws IOException {
        switch (type) {
            case "approval_mode_changed" -> {
                if (!(data.get("sessionId") instanceof String) || !(data.get("previous") instanceof String)
                    || !(data.get("next") instanceof String) || !(data.get("persisted") instanceof Boolean))
                    throw new IOException("Invalid approval mode event");
            }
            case "session_metadata_updated" -> {
                if (!(data.get("sessionId") instanceof String)
                    || data.containsKey("displayName") && !(data.get("displayName") instanceof String)
                    || data.containsKey("prs") && !(data.get("prs") instanceof List<?>))
                    throw new IOException("Invalid session metadata event");
            }
            case "followup_suggestion" -> {
                if (!(data.get("sessionId") instanceof String) || !(data.get("suggestion") instanceof String))
                    throw new IOException("Invalid follow-up suggestion event");
            }
            case "settings_reloaded" -> {
                if (!(data.get("env") instanceof Map<?, ?>) || !(data.get("changedKeys") instanceof List<?>))
                    throw new IOException("Invalid settings reload event");
            }
            case "replay_complete" -> {
                String lastReplayed = cursor(data.get("lastReplayedEventId"));
                String lastEvent = cursor(data.get("lastEventId"));
                if (data.containsKey("lastReplayedEventId") && lastReplayed == null
                    || data.containsKey("lastEventId") && lastEvent == null
                    || !(data.get("replayedCount") instanceof Number count) || !Double.isFinite(count.doubleValue())
                    || count.doubleValue() < 0 || count.doubleValue() != Math.rint(count.doubleValue()))
                    throw new IOException("Invalid replay completion event");
                if (count.doubleValue() > 0 && lastReplayed == null && lastEvent == null)
                    throw new IOException("Replay completion is missing its replay cursor");
            }
            default -> { }
        }
    }

    static void writeFrame(List<String> lines, OutputStream output, String sessionId, Consumer<String> onCursor) throws IOException {
        writeFrame(lines, output, sessionId, onCursor, event -> {});
    }

    private static void writeFrame(List<String> lines, OutputStream output, String sessionId, Consumer<String> onCursor,
            Consumer<Map<String, Object>> observer) throws IOException {
        if (lines.isEmpty()) return;
        String id = null;
        boolean emptyCursor = false;
        String event = null;
        List<String> data = new ArrayList<>();
        for (String line : lines) {
            int colon = line.indexOf(':');
            String key = colon < 0 ? line : line.substring(0, colon);
            String value = colon < 0 ? "" : line.substring(colon + 1);
            if (value.startsWith(" ")) value = value.substring(1);
            switch (key) {
                case "id" -> {
                    if (value.isEmpty()) { emptyCursor = true; id = null; }
                    else { id = cursor(value); emptyCursor = false; }
                }
                case "event" -> event = value;
                case "data" -> data.add(value);
                default -> { }
            }
        }
        // Comments/heartbeats contain no event payload and never advance a cursor.
        if (data.isEmpty()) {
            if (lines.stream().anyMatch(line -> !line.startsWith(":")))
                throw new IOException("Remote SSE frame has fields without daemon data");
            output.write((String.join("\n", lines) + "\n\n").getBytes(StandardCharsets.UTF_8));
            output.flush();
            return;
        }
        String payload = String.join("\n", data);
        Map<?, ?> decoded = object(payload);
        checkSession(decoded, sessionId);
        if (ackOnly(decoded)) return;
        boolean wrapped = decoded.containsKey("Event") || decoded.containsKey("Data");
        if (wrapped) {
            rejectError(decoded);
            Object rawOuterId = decoded.get("Id");
            String outerId;
            if ("".equals(rawOuterId)) { emptyCursor = true; outerId = null; }
            else outerId = cursor(rawOuterId);
            if (outerId != null) id = outerId;
            Object inner = decoded.get("Event");
            if (inner instanceof String text) {
                // Event is either JSON daemon data, or a named SSE event with a Data payload.
                if (text.stripLeading().startsWith("{")) inner = object(text);
                else {
                    if (text.isBlank() || text.indexOf('\r') >= 0 || text.indexOf('\n') >= 0 || text.indexOf('\0') >= 0)
                        throw new IOException("Invalid POP SSE event name");
                    if (event == null) event = text;
                    inner = decoded.get("Data");
                }
            }
            if (inner == null) inner = decoded.get("Data");
            decoded = object(inner);
            checkSession(decoded, sessionId);
            if (ackOnly(decoded)) return;
            payload = JSON.writeValueAsString(decoded);
        }
        Object version = decoded.get("v");
        if (version != null && (!(version instanceof Number number) || number.doubleValue() != 1))
            throw new IOException("Invalid remote daemon protocol version");
        String type = decoded.get("type") instanceof String text ? text
            : decoded.get("Type") instanceof String text ? text : null;
        Object dataValue = decoded.containsKey("data") ? decoded.get("data") : decoded.get("Data");
        boolean flattened = false;
        // POP may flatten the daemon data and omit its discriminator entirely.
        if (type == null && decoded.get("update") instanceof Map<?, ?>) {
            type = "session_update";
            dataValue = decoded;
            flattened = true;
        } else if (type == null && decoded.get("stopReason") instanceof String) {
            type = "turn_complete";
            dataValue = decoded;
            flattened = true;
        } else if (type == null && event != null && EVENT_TYPES.contains(event)) {
            type = event;
            dataValue = dataValue == null ? decoded : dataValue;
            flattened = true;
        }
        if (type == null || type.isBlank() || version == null && !wrapped && !flattened)
            throw new IOException("GetAgentSessionEvents returned a non-daemon payload");
        Map<?, ?> eventData = object(dataValue);
        if (flattened && event != null && !EVENT_TYPES.contains(event))
            throw new IOException("Unknown flattened remote SSE event type");
        // Classify the daemon payload before inspecting its error field. POP wrappers
        // remain strict; only a recognized flattened SDK payload can use the exception.
        rejectError(decoded, flattened && dataValue == decoded && sdkErrorPayload(type, eventData));
        if (flattened && dataValue != decoded) rejectError(eventData, sdkErrorPayload(type, eventData));
        checkSession(eventData, sessionId);
        validateReplayMetadata(type, eventData);
        boolean emptyCursorAllowed = "stream_open".equals(type)
            || "replay_complete".equals(type) && ((Number) eventData.get("replayedCount")).doubleValue() == 0;
        boolean cursorOptional = emptyCursorAllowed || cursorlessLifecyclePayload(type, eventData);
        // Missing id is legitimate for a synthetic frame; an explicit empty/invalid
        // id is not. Preserve only the existing opening/empty-replay reset exception.
        if (emptyCursor && !emptyCursorAllowed) throw new IOException("Empty cursor on non-opening remote event");
        Object rawDaemonId = decoded.get("id");
        if (rawDaemonId == null) rawDaemonId = decoded.get("Id");
        String daemonId = emptyCursorAllowed && "".equals(rawDaemonId) ? null : cursor(rawDaemonId);
        if (id == null) id = daemonId;
        if (id == null && !cursorOptional)
            throw new IOException("Remote daemon event is missing its cursor");
        if (id == null && !emptyCursorAllowed) rejectError(eventData, sdkErrorPayload(type, eventData));
        if (event != null && (event.indexOf('\r') >= 0 || event.indexOf('\n') >= 0 || event.indexOf('\0') >= 0))
            throw new IOException("Invalid remote SSE event name");
        // Browser consumers need the canonical JSON envelope, including the outer POP cursor.
        Map<String, Object> canonical = new java.util.LinkedHashMap<>();
        canonical.put("v", 1);
        canonical.put("type", type);
        if ("permission_request".equals(type) && eventData.get("requestId") instanceof String requestId
                && eventData.get("options") instanceof List<?> options) {
            List<Map<String, Object>> mapped = new ArrayList<>();
            for (Object raw : options) {
                if (!(raw instanceof Map<?, ?> option)) throw new IOException("Invalid permission option");
                Map<String, Object> copy = new java.util.LinkedHashMap<>();
                for (var entry : option.entrySet()) if (entry.getKey() instanceof String key) copy.put(key, entry.getValue());
                if (copy.get("name") == null && copy.get("label") instanceof String label) copy.put("name", label);
                mapped.add(copy);
            }
            Map<String, Object> tool = new java.util.LinkedHashMap<>();
            if (eventData.get("toolCall") instanceof Map<?, ?> raw) for (var entry : raw.entrySet())
                if (entry.getKey() instanceof String key) tool.put(key, entry.getValue());
            var permission = com.das.java.daemon.Events.permissionRequest(sessionId, requestId, tool,
                eventData.get("title") instanceof String title ? title : null, mapped);
            Map<String, Object> merged = new java.util.LinkedHashMap<>();
            for (var entry : eventData.entrySet()) if (entry.getKey() instanceof String key) merged.put(key, entry.getValue());
            if (permission.get("data") instanceof Map<?, ?> normalized) for (var entry : normalized.entrySet())
                if (entry.getKey() instanceof String key) merged.put(key, entry.getValue());
            eventData = merged;
        }
        canonical.put("data", eventData);
        if (decoded.get("promptId") instanceof String remotePromptId) canonical.put("promptId", remotePromptId);
        if (id != null) canonical.put("id", Long.parseLong(id));
        if (decoded.get("originatorClientId") instanceof String origin) canonical.put("originatorClientId", origin);
        if (decoded.get("_meta") instanceof Map<?, ?> meta) canonical.put("_meta", meta);
        if (flattened || event == null) event = type;
        payload = JSON.writeValueAsString(canonical);
        String wire = (id == null ? "" : "id: " + id + "\n") + "event: " + event + "\n"
            + "data: " + payload + "\n\n";
        observer.accept(canonical); // Register permission state before its frame can reach the browser.
        output.write(wire.getBytes(StandardCharsets.UTF_8));
        output.flush();
        if (id != null) onCursor.accept(id);
    }
}
