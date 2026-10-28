package com.das.java.daemon;

import com.das.java.config.AppConfig;
import com.das.java.config.SessionOptions;
import com.das.java.live.LiveClient;
import com.das.java.live.Normalize;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;

/** Stateless protocol conversion. All session facts and mutations belong to POP. */
final class LiveDaemon {
    private static final String WORKSPACE = "/data-agent"; // UI protocol placeholder, not a remote filesystem observation.
    private final AppConfig cfg;
    private final LiveClient live;

    LiveDaemon(AppConfig cfg, LiveClient live) { this.cfg = cfg; this.live = live; }

    static Map<String, Object> error(String message, String code) { return Map.of("error", message, "code", code); }
    static ResponseEntity<?> failure(Exception error, String action) {
        var api = Normalize.toApiError(error, action);
        return ResponseEntity.status(502).body(error(api.message(), "upstream_error"));
    }
    private Map<String, Object> session(String id) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sessionId", id);
        out.put("workspaceCwd", WORKSPACE);
        out.put("sourceType", "standalone");
        out.put("context", Map.of("kind", "standalone"));
        return out;
    }
    private Map<String, Object> summary(Map<String, Object> remote) {
        var out = session((String)remote.get("sessionId"));
        if (remote.get("title") instanceof String title) out.put("displayName", title);
        for (String key : List.of("createdAt", "updatedAt"))
            if (remote.get(key) instanceof Number n && n.longValue() > 0) out.put(key, Instant.ofEpochMilli(n.longValue()).toString());
        // No clientCount/hasActivePrompt/isWaitingForPermission guesses from process-local state.
        return out;
    }
    /** WebShell protocol fields, not observed remote filesystem or cached ownership. */
    private Map<String, Object> attachment(String id) {
        var out = session(id);
        out.put("clientId", java.util.UUID.randomUUID().toString());
        out.put("attached", false);
        out.put("projectlessOutputDirectory", WORKSPACE + "/out/" + id);
        out.put("workingDirectory", Map.of("state", "ready"));
        return out;
    }
    Map<String, Object> list(boolean archived, String agentName) throws Exception {
        @SuppressWarnings("unchecked")
        var rows = (List<Map<String, Object>>)(agentName == null ? live.listSessions(archived) : live.listSessions(archived, agentName)).getOrDefault("sessions", List.of());
        return Map.of("sessions", rows.stream().map(this::summary).toList());
    }
    ResponseEntity<?> get(String id, String agentName) {
        try {
            var remote = agentName == null ? live.sessionSummary(id) : live.sessionSummary(id, agentName);
            return remote == null ? ResponseEntity.status(404).body(error("Session not found", "standalone_session_not_found"))
                : ResponseEntity.ok(summary(remote));
        } catch (Exception error) { return failure(error, "ListAgentSessions"); }
    }
    ResponseEntity<?> create(SessionOptions options) {
        try {
            var remote = live.createSessionWithOptions(options);
            var out = attachment((String)remote.get("sessionId"));
            return ResponseEntity.ok(out);
        } catch (Exception error) { return failure(error, "CreateAgentSession"); }
    }
    private List<Map<String, Object>> history(String id) throws Exception {
        return Translate.historyFramesToEvents(live.loadFrames(id), id).stream().map(event -> {
            Map<String, Object> copy = new LinkedHashMap<>(event);
            copy.remove("id");
            return copy;
        }).toList();
    }
    ResponseEntity<?> load(String id) {
        try {
            var events = history(id);
            var out = attachment(id);
            Map<String, Object> models = new LinkedHashMap<>();
            models.put("currentModelId", null);
            models.put("availableModels", List.of());
            Map<String, Object> state = new LinkedHashMap<>();
            state.put("models", models);
            state.put("modes", Map.of());
            state.put("configOptions", null);
            out.put("state", state);
            out.put("compactedReplay", events);
            out.put("liveJournal", List.of());
            out.put("eventEpoch", "openapi:" + cfg.regionId() + ":" + id);
            out.put("historyHasMore", false);
            // No verified remote Load watermark: omit lastEventId, including after restart.
            return ResponseEntity.ok(out);
        } catch (Exception error) { return failure(error, "LoadAgentSession"); }
    }
    ResponseEntity<?> transcript(String id) {
        try { return ResponseEntity.ok(Map.of("v", 1, "sessionId", id, "events", history(id), "hasMore", false)); }
        catch (Exception error) { return failure(error, "LoadAgentSession"); }
    }
    ResponseEntity<?> rename(String id, String title) {
        try { live.renameSession(id, title); return ResponseEntity.ok(Map.of("sessionId", id, "displayName", title)); }
        catch (Exception error) { return failure(error, "UpdateAgentSessionTitle"); }
    }
    ResponseEntity<?> delete(String id) {
        try { live.deleteSession(id); return ResponseEntity.ok(Map.of("sessionId", id, "removed", true)); }
        catch (Exception error) { return failure(error, "DeleteAgentSession"); }
    }
    ResponseEntity<?> cancel(String id) {
        try {
            var result = live.cancel(id);
            if (!Boolean.TRUE.equals(result.get("accepted")) && !Boolean.TRUE.equals(result.get("delivered"))
                && !Boolean.TRUE.equals(result.get("noop")))
                return ResponseEntity.status(502).body(error(String.valueOf(result.getOrDefault("detail", "Cancel not accepted")), "cancel_failed"));
            return ResponseEntity.noContent().build(); // Neither acceptance nor delivery fabricates a terminal.
        } catch (Exception error) { return failure(error, "CancelAgentSession"); }
    }
    ResponseEntity<Map<String, Object>> permission(String id, String requestId, Map<String, Object> body) {
        Map<?, ?> outcome = body != null && body.get("outcome") instanceof Map<?, ?> value ? value : Map.of();
        String kind = "cancelled".equals(outcome.get("outcome")) ? "cancelled" : "selected";
        String option = outcome.get("optionId") instanceof String value && !value.isBlank() ? value.trim() : null;
        Map<String, String> answers = new LinkedHashMap<>();
        if (body != null && body.containsKey("answers")) {
            if (!(body.get("answers") instanceof Map<?, ?> values)) return ResponseEntity.badRequest().body(error("answers must be an object", "invalid_permission_response"));
            for (var entry : values.entrySet()) {
                if (!(entry.getKey() instanceof String key) || !(entry.getValue() instanceof String value))
                    return ResponseEntity.badRequest().body(error("answers must contain string values", "invalid_permission_response"));
                answers.put(key, value);
            }
        }
        if (Events.OPENAPI_ANSWERS_OPTION.equals(option)) {
            if (!"selected".equals(kind) || answers.isEmpty()) return ResponseEntity.badRequest().body(error("Question reply requires answers", "invalid_permission_response"));
            option = null; // UI-only sentinel is not a POP option ID.
        }
        if ("selected".equals(kind) && option == null && answers.isEmpty())
            return ResponseEntity.badRequest().body(error("Selected reply requires optionId or answers", "invalid_permission_response"));
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("permissionRequestId", requestId);
        input.put("outcome", kind);
        if (option != null) input.put("optionId", option);
        if (!answers.isEmpty()) input.put("answers", answers);
        try {
            var result = live.reply(id, input);
            return Boolean.TRUE.equals(result.get("accepted")) ? ResponseEntity.ok(Map.of())
                : ResponseEntity.status(404).body(error("Remote reply not accepted", "permission_not_accepted"));
        } catch (Exception error) {
            return ResponseEntity.status(502).body(error(Normalize.toApiError(error, "ReplyAgentSession").message(), "permission_upstream_error"));
        }
    }
    Map<String, Object> batch(String action, Object rawIds) {
        List<String> done = new ArrayList<>();
        List<Object> errors = new ArrayList<>();
        if (rawIds instanceof List<?> ids) for (Object raw : ids) {
            if (!(raw instanceof String id)) continue;
            try {
                if ("delete".equals(action)) live.deleteSession(id);
                else live.archiveSession(id, "archive".equals(action));
                done.add(id);
            } catch (Exception error) { errors.add(Map.of("sessionId", id, "error", Normalize.toApiError(error, action).message())); }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("archive".equals(action) ? "archived" : "unarchive".equals(action) ? "unarchived" : "removed", done);
        out.put("notFound", List.of());
        out.put("errors", errors);
        if ("delete".equals(action)) out.put("fileCleanupPending", List.of());
        else out.put("archive".equals(action) ? "alreadyArchived" : "alreadyActive", List.of());
        return out;
    }
}
