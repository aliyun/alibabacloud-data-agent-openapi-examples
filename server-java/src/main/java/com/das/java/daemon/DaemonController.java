package com.das.java.daemon;

import com.das.java.config.AppConfig;
import com.das.java.config.SessionOptions;
import com.das.java.live.RemoteSseRelay;
import com.das.java.core.Constants;
import com.das.java.live.LiveClient;
import com.das.java.live.LiveClientHolder;
import com.das.java.mock.MockFixtures;
import com.das.java.web.Inflight;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * daemon 兼容层：把 @qwen-code/web-shell 说的话翻译成 data agent OpenAPI 的上游调用。
 * 与 Node 实现的 server-node/daemon/routes.ts 同源同语义。
 *
 * 挂在 `/d` 前缀下——DaemonClient 是 `baseUrl + path` 字符串拼接，所以前端把
 * baseUrl 指到 `<origin>/d` 即可，与 `/api/*`、SPA 回退互不干扰。
 */
@RestController
@RequestMapping("/d")
public class DaemonController {
    private static final Logger log = LoggerFactory.getLogger(DaemonController.class);

    private final AppConfig cfg;
    private final LiveClient live;
    private final Registry registry;
    private final LiveDaemon remote;
    private final Runner runner;
    /** 进程级事件纪元：重启即变；客户端凭它判断游标属于"上一个进程"并触发 resync。 */
    private final String epoch = UUID.randomUUID().toString();

    public DaemonController(AppConfig cfg, LiveClientHolder holder, Inflight inflight) {
        this.cfg = cfg;
        this.live = holder.client();
        this.registry = live == null ? new Registry() : null;
        this.runner = live == null ? new Runner(cfg, inflight) : null;
        this.remote = live == null ? null : new LiveDaemon(cfg, live);
    }

    /**
     * 解析 MOCK 演示会话，必须是已知场景（与 /api 的行为对齐：不认的 id 明确 404）。
     */
    private Registry.Record resolveSession(String id) {
        Registry.Record known = registry.resolve(id);
        if (known != null) return known;
        return MockFixtures.findScenario(id) != null ? registry.ensure(id) : null;
    }

    private static ResponseEntity<Map<String, Object>> notFound(String id) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", "没有这个会话：" + id);
        body.put("code", "standalone_session_not_found");
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(body);
    }

    private static Map<String, Object> errorBody(String error, String code) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", error);
        body.put("code", code);
        return body;
    }

    // ------------------------------------------------------------------
    // 发现
    // ------------------------------------------------------------------

    @GetMapping("/health")
    public Map<String, Object> health() {
        return Map.of("status", "ok");
    }

    @GetMapping("/capabilities")
    public Map<String, Object> capabilities() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("v", 1);
        out.put("mode", "standalone");
        out.put("features", List.of("standalone_sessions_v1", "standalone_session_options_v1", "session_permission_vote"));
        out.put("modelServices", List.of("data-agent"));
        out.put("workspaces", List.of());
        out.put("policy", Map.of());
        // web-shell 按这个间隔轮询会话目录 live-state；每次轮询在 LIVE 下都是一次
        // 真实 ListAgentSessions（约 0.4s、上游无增量游标）——30s 是负载与新鲜度的折中
        out.put("sessionLiveStatePollIntervalMs", 30_000);
        return out;
    }

    private final long processStartedAt = System.currentTimeMillis();

    /** daemon 状态报告（web-shell 的「Daemon 状态」面板）。全部字段是**本地真实状态**（不依赖上游）。 */
    @GetMapping("/daemon/status")
    public ResponseEntity<?> daemonStatus(@RequestParam(name = "detail", required = false) String detailParam) {
        if (live != null) return ResponseEntity.status(404).body(errorBody("Remote daemon status is unavailable", "status_unavailable"));
        String detail = "full".equals(detailParam) ? "full" : "summary";
        Map<String, Object> stats = registry.stats();

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("v", 1);
        out.put("detail", detail);
        out.put("generatedAt", java.time.Instant.now().toString());
        out.put("status", "ok");
        out.put("issues", List.of());

        Map<String, Object> daemon = new LinkedHashMap<>();
        daemon.put("pid", ProcessHandle.current().pid());
        daemon.put("uptimeMs", System.currentTimeMillis() - processStartedAt);
        daemon.put("mode", "standalone");
        daemon.put("workspaceCwd", Registry.WORKSPACE_CWD);
        out.put("daemon", daemon);

        Map<String, Object> security = new LinkedHashMap<>();
        security.put("tokenConfigured", false);
        security.put("requireAuth", false);
        security.put("loopbackBind", cfg.serverHost().equals("127.0.0.1"));
        security.put("allowOriginConfigured", !cfg.corsOrigin().isEmpty());
        security.put("allowOriginMode", String.join(",", cfg.corsOrigin()));
        security.put("sessionShellCommandEnabled", false);
        out.put("security", security);

        Map<String, Object> limits = new LinkedHashMap<>();
        limits.put("maxSessions", null);
        limits.put("maxTotalSessions", null);
        // 上游在途锁：同一会话同时只能一轮（session_concurrent_operation_in_progress）
        limits.put("maxPendingPromptsPerSession", 1);
        limits.put("listenerMaxConnections", null);
        limits.put("eventRingSize", Journal.MAX_EVENTS);
        limits.put("promptDeadlineMs", Constants.STREAM_HARD_LIMIT_MS);
        limits.put("writerIdleTimeoutMs", null);
        limits.put("channelIdleTimeoutMs", 0);
        limits.put("sessionIdleTimeoutMs", 0);
        limits.put("acpConnectionCap", null);
        limits.put("compactedReplayMaxBytes", 0);
        limits.put("maxJournalEvents", Journal.MAX_EVENTS);
        limits.put("maxJournalBytes", 0);
        out.put("limits", limits);

        Map<String, Object> capabilities = new LinkedHashMap<>();
        capabilities.put("protocolVersions", Map.of("current", "1", "supported", List.of("1")));
        capabilities.put("features", List.of("standalone_sessions_v1", "standalone_session_options_v1", "session_permission_vote"));
        out.put("capabilities", capabilities);

        Map<String, Object> runtime = new LinkedHashMap<>();
        runtime.put("sessions", Map.of("active", stats.get("sessions")));
        runtime.put("permissions", Map.of("pending", 0, "policy", "upstream-none"));
        runtime.put("channel", Map.of("live", false));
        runtime.put("channelWorker", Map.of("enabled", false, "state", "disabled", "channels", List.of()));
        Runtime jvm = Runtime.getRuntime();
        // 状态面板无条件读 rss/heapUsed（内存行）；JVM 只有 heapUsed，rss 拿不到就给 -1
        runtime.put("process", Map.of("rss", -1, "heapUsed", jvm.totalMemory() - jvm.freeMemory()));
        Map<String, Object> transport = new LinkedHashMap<>();
        transport.put("restSseActive", 0);
        transport.put("acp", Map.of(
            "enabled", false, "connections", 0, "connectionStreams", 0,
            "sessionStreams", 0, "sseStreams", 0, "wsStreams", 0, "pendingClientRequests", 0));
        runtime.put("transport", transport);
        runtime.put("rateLimit", Map.of("enabled", false, "rejectedSinceStart", Map.of()));
        out.put("runtime", runtime);

        return ResponseEntity.ok(out);
    }

    @GetMapping("/openapi/session-options")
    public Map<String, Object> openapiSessionOptions() {
        Map<String, Object> out = new LinkedHashMap<>(SessionOptions.describe(cfg));
        out.put("promptTransport", live == null ? "daemon" : "http-stream");
        return out;
    }

    @PostMapping({"/session/{id}/model", "/session/{id}/mode", "/session/{id}/config", "/session/{id}/config-option",
        "/session/{id}/reasoning", "/session/{id}/reasoning-effort", "/session/{id}/approval-mode"})
    public ResponseEntity<?> configureExisting(@PathVariable("id") String id) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(errorBody(
            "POP supports configuration only at creation; create a new session to change model, mode or reasoning effort.",
            "requires-new-session"));
    }

    private String eventEpoch(String id) {
        return live == null ? epoch : "openapi:" + cfg.regionId() + ":" + id;
    }

    @GetMapping("/standalone/session-options")
    public Map<String, Object> sessionOptions() {
        SessionOptions defaults = SessionOptions.resolve(cfg, null);
        String selected = defaults.model() == null ? "data-agent" : defaults.model();
        var ids = new java.util.LinkedHashSet<String>();
        ids.add(selected);
        if (cfg.models() != null) ids.addAll(cfg.models());
        List<Map<String, Object>> models = new ArrayList<>();
        for (String id : ids) {
            Map<String, Object> model = new LinkedHashMap<>();
            model.put("modelId", id);
            model.put("baseModelId", id);
            model.put("name", "data-agent".equals(id) ? "默认模型" : id);
            model.put("isCurrent", selected.equals(id));
            model.put("isRuntime", false);
            models.add(model);
        }

        Map<String, Object> provider = new LinkedHashMap<>();
        provider.put("kind", "model_provider");
        provider.put("status", "ok");
        provider.put("authType", "none");
        provider.put("current", true);
        provider.put("models", models);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("approvalMode", defaults.approvalMode());
        out.put("v", 1);
        out.put("initialized", true);
        out.put("providers", List.of(provider));
        out.put("errors", List.of());
        return out;
    }

    // ------------------------------------------------------------------
    // standalone 会话目录
    // ------------------------------------------------------------------

    private static String queryAgentName(String agentName) {
        try { return SessionOptions.validateAgentName(agentName); }
        catch (IllegalArgumentException error) {
            throw new org.springframework.web.server.ResponseStatusException(HttpStatus.BAD_REQUEST, error.getMessage());
        }
    }

    @GetMapping("/standalone/sessions")
    public ResponseEntity<?> listSessions(@RequestParam(name = "archiveState", required = false) String archiveState,
        @RequestParam(name = "agentName", required = false) String agentName) {
        agentName = queryAgentName(agentName);
        boolean archived = "archived".equals(archiveState);
        if (remote != null) {
            try { return ResponseEntity.ok(remote.list(archived, agentName)); }
            catch (Exception error) { return LiveDaemon.failure(error, "ListAgentSessions"); }
        }
        return ResponseEntity.ok(Map.of("sessions", archived ? registry.archivedSummaries() : registry.listSummaries(cfg)));
    }

    @PostMapping("/standalone/sessions")
    public ResponseEntity<?> createSession(@RequestBody(required = false) Map<String, Object> body) {
        SessionOptions options;
        try { options = SessionOptions.resolve(cfg, body); }
        catch (IllegalArgumentException error) { return ResponseEntity.badRequest().body(errorBody(error.getMessage(), "invalid_session_options")); }
        if (remote != null) return remote.create(options);
        String id = (String) MockFixtures.mockCreateSession("新建会话").get("sessionId");
        return ResponseEntity.ok(standaloneSessionBody(registry.ensure(id), id));
    }

    @GetMapping("/standalone/sessions/{id}")
    public ResponseEntity<?> getSession(@PathVariable("id") String id,
        @RequestParam(name = "agentName", required = false) String agentName) {
        agentName = queryAgentName(agentName);
        if (remote != null) return remote.get(id, agentName);
        Registry.Record record = resolveSession(id);
        if (record == null || record.deleted) return notFound(id);
        return ResponseEntity.ok(registry.summaryFor(record, id));
    }

    @PostMapping("/standalone/sessions/{id}/load")
    public ResponseEntity<?> loadSession(@PathVariable("id") String id) {
        return loadSessionImpl(id, "load");
    }

    @PostMapping("/standalone/sessions/{id}/resume")
    public ResponseEntity<?> resumeSession(@PathVariable("id") String id) {
        return loadSessionImpl(id, "resume");
    }

    @PatchMapping("/standalone/sessions/{id}/metadata")
    public ResponseEntity<?> renameStandalone(@PathVariable("id") String id, @RequestBody(required = false) Map<String, Object> body) {
        return renameSession(id, body == null ? null : body.get("displayName"));
    }

    @PostMapping("/standalone/sessions/archive")
    public Map<String, Object> archive(@RequestBody(required = false) Map<String, Object> body) {
        return batchMutate("archive", body == null ? null : body.get("sessionIds"));
    }

    @PostMapping("/standalone/sessions/unarchive")
    public Map<String, Object> unarchive(@RequestBody(required = false) Map<String, Object> body) {
        return batchMutate("unarchive", body == null ? null : body.get("sessionIds"));
    }

    @PostMapping("/standalone/sessions/delete")
    public Map<String, Object> delete(@RequestBody(required = false) Map<String, Object> body) {
        return batchMutate("delete", body == null ? null : body.get("sessionIds"));
    }

    // ------------------------------------------------------------------
    // 会话内：prompt / 事件流 / 生命周期
    // ------------------------------------------------------------------

    @PostMapping("/session/{id}/prompt")
    public ResponseEntity<?> prompt(
        @PathVariable("id") String id,
        @RequestBody(required = false) Map<String, Object> body,
        @RequestHeader(name = "x-qwen-client-id", required = false) String clientId) {
        if (live != null) return ResponseEntity.status(HttpStatus.GONE).body(errorBody("Use POST /api/sessions/:id/prompt", "prompt_transport_retired"));

        Registry.Record record = resolveSession(id);
        if (record == null) return notFound(id);
        Runner.Admission admission = runner.admit(record, id, body == null ? null : body.get("prompt"), clientId);
        if (admission instanceof Runner.Rejected rejected) {
            return ResponseEntity.status(rejected.status())
                .body(errorBody(rejected.error(), rejected.code()));
        }
        Runner.Admitted admitted = (Runner.Admitted) admission;
        // 202 严格契约（additionalProperties:false）：只有这三个键
        Map<String, Object> accepted = new LinkedHashMap<>();
        accepted.put("promptId", admitted.promptId());
        accepted.put("lastEventId", admitted.lastEventId());
        accepted.put("eventEpoch", eventEpoch(record.realId));
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(accepted);
    }

    @PostMapping("/session/{id}/openapi-prompt/{promptId}/receipt")
    public ResponseEntity<?> promptReceipt(@PathVariable("id") String id, @PathVariable("promptId") String promptId) {
        return live == null ? ResponseEntity.noContent().build()
            : ResponseEntity.status(HttpStatus.GONE).body(errorBody("Local prompt receipts are retired", "prompt_transport_retired"));
    }

    @PostMapping("/session/{id}/cancel")
    public ResponseEntity<?> cancel(@PathVariable("id") String id) {
        if (remote != null) return remote.cancel(id);
        Registry.Record record = resolveSession(id);
        if (record == null) return notFound(id);

        String activePromptId = record.journal.activePromptId;
        if (activePromptId != null) {
            // 上游流随后会以 stopReason=cancelled 终态收场 → turn_complete(cancelled) 也会到
            record.journal.append(Events.promptCancelled(id, activePromptId));
        }
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/session/{id}/events")
    public void events(
        @PathVariable("id") String id,
        @RequestParam(name = "snapshot", required = false) String snapshotParam,
        @RequestHeader(name = "last-event-id", required = false) String lastRaw,
        HttpServletResponse response) throws IOException {
        if (live != null) {
            if (lastRaw != null && !RemoteSseRelay.safeCursor(lastRaw)) {
                response.setStatus(400);
                response.setContentType("application/json");
                response.getWriter().write("{\"error\":\"Invalid remote cursor\",\"code\":\"invalid_cursor\"}");
                return;
            }
            String remoteCursor = lastRaw;
            Integer upstreamStatus = null;
            String upstreamRequestId = null;
            try (var stream = live.events(id, remoteCursor)) {
                var metadata = stream.metadata();
                upstreamStatus = metadata.status();
                upstreamRequestId = metadata.headers().entrySet().stream()
                    .filter(header -> header.getKey().equalsIgnoreCase("x-acs-request-id"))
                    .map(Map.Entry::getValue).findFirst().orElse(null);
                upstreamRequestId = com.das.java.core.ApiError.validRequestId(upstreamRequestId);
                if (upstreamRequestId != null) response.setHeader("x-acs-request-id", upstreamRequestId);
                String contentType = metadata.headers().entrySet().stream()
                    .filter(header -> header.getKey().equalsIgnoreCase("Content-Type"))
                    .map(Map.Entry::getValue).findFirst().orElse("");
                if (metadata.status() / 100 != 2) {
                    // Before committing JSON, extract only a bounded scalar POP ID;
                    // raw SDK/POP failure bodies may contain credentials or headers.
                    if (upstreamRequestId == null) {
                        var bytes = new java.io.ByteArrayOutputStream();
                        byte[] chunk;
                        while ((chunk = stream.next()) != null && bytes.size() + chunk.length <= 65_536)
                            bytes.write(chunk);
                        try {
                            var body = new com.fasterxml.jackson.databind.ObjectMapper().readTree(bytes.toByteArray());
                            var rawId = body.has("RequestId") ? body.get("RequestId") : body.get("requestId");
                            if (rawId != null && rawId.isTextual())
                                upstreamRequestId = com.das.java.core.ApiError.validRequestId(rawId.textValue());
                        } catch (Exception ignored) { /* Keep the safe public failure below. */ }
                    }
                    throw new IOException("GetAgentSessionEvents returned a non-success response");
                }
                if (metadata.status() / 100 == 2 && !contentType.split(";", 2)[0].trim().equalsIgnoreCase("text/event-stream"))
                    throw new IOException("GetAgentSessionEvents returned a non-SSE response");
                response.setStatus(metadata.status());
                response.setContentType(metadata.status() / 100 == 2 ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8");
                response.setHeader("Cache-Control", "no-store, no-transform");
                response.setHeader("X-Accel-Buffering", "no");
                response.setHeader("X-Qwen-Event-Epoch", eventEpoch(id));
                for (var header : metadata.headers().entrySet()) {
                    if (header.getKey().equalsIgnoreCase("X-Qwen-Sse-Stream-Id")) response.setHeader(header.getKey(), header.getValue());
                }
                if (metadata.status() / 100 == 2) {
                    RemoteSseRelay.relay(stream, response.getOutputStream(), id, ignored -> {});
                } else {
                    byte[] chunk;
                    while ((chunk = stream.next()) != null) response.getOutputStream().write(chunk);
                }
            } catch (Exception error) {
                Throwable cause = error;
                for (int depth = 0; depth < 8; depth++) {
                    if (cause instanceof com.aliyun.sdk.gateway.pop.exception.PopClientException pop) {
                        if (upstreamStatus == null) upstreamStatus = pop.getStatusCode();
                        if (upstreamRequestId == null) upstreamRequestId = pop.getRequestId();
                    } else if (cause instanceof com.aliyun.sdk.gateway.pop.exception.PopServerException pop) {
                        if (upstreamStatus == null) upstreamStatus = pop.getStatusCode();
                        if (upstreamRequestId == null) upstreamRequestId = pop.getRequestId();
                    }
                    if (cause.getCause() == null || cause.getCause() == cause) break;
                    cause = cause.getCause();
                }
                // Structured diagnostics only: never log messages, request headers, body, config or credentials.
                upstreamRequestId = com.das.java.core.ApiError.validRequestId(upstreamRequestId);
                log.warn("openapi_events_failure code=events_failed status={} requestId={} exceptionType={}",
                    upstreamStatus, upstreamRequestId, cause.getClass().getSimpleName());
                if (!response.isCommitted()) {
                    response.reset();
                    response.setStatus(502);
                    response.setContentType("application/json; charset=utf-8");
                    var failure = errorBody("GetAgentSessionEvents failed", "events_failed");
                    if (upstreamStatus != null) failure.put("upstreamStatus", upstreamStatus);
                    if (upstreamRequestId != null) {
                        failure.put("requestId", upstreamRequestId);
                        response.setHeader("x-acs-request-id", upstreamRequestId);
                    }
                    response.getWriter().write(new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(failure));
                } else if (error instanceof IOException io) throw io;
                else throw new IOException("GetAgentSessionEvents failed", error);
            }
            return;
        }
        Registry.Record record = resolveSession(id);
        if (record == null) {
            response.setStatus(404);
            response.setContentType("application/json; charset=utf-8");
            response.getWriter().write(new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(errorBody("Session not found", "standalone_session_not_found")));
            return;
        }

        Long lastEventId = null;
        if (lastRaw != null) {
            try {
                lastEventId = Long.parseLong(lastRaw);
            } catch (NumberFormatException ignored) {
            }
        }
        boolean snapshot = "1".equals(snapshotParam) || "true".equalsIgnoreCase(snapshotParam);

        response.setStatus(HttpServletResponse.SC_OK);
        response.setContentType("text/event-stream; charset=utf-8");
        response.setHeader("Cache-Control", "no-store, no-transform");
        response.setHeader("X-Accel-Buffering", "no");
        response.setHeader("X-Qwen-Event-Epoch", epoch);
        response.setHeader("X-Qwen-Sse-Stream-Id", UUID.randomUUID().toString());

        // 在请求线程上跑 SSE 循环（与 prompt ndjson 泵同构）：客户端断开在写帧失败时探测
        SseStream.stream(response.getOutputStream(), record.journal, id, lastEventId, snapshot);
    }

    @PostMapping("/session/{id}/heartbeat")
    public ResponseEntity<?> heartbeat(@PathVariable("id") String id) {
        if (live != null) return ResponseEntity.noContent().build();
        Registry.Record record = resolveSession(id);
        if (record == null) return notFound(id);
        // 上游没有心跳接口；会话亲和是临时的，这里只回 204 维持客户端记账，不做任何上游调用。
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/session/{id}/transcript")
    public ResponseEntity<?> transcript(@PathVariable("id") String id) {
        if (remote != null) return remote.transcript(id);
        Registry.Record record = resolveSession(id);
        if (record == null) return notFound(id);
        // 此历史端点返回完整快照；在途 Prompt 的增量恢复由帧源单独处理
        List<Object> events = new ArrayList<>();
        for (Journal.Entry entry : record.journal.all()) events.add(entry.event());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("v", 1);
        out.put("sessionId", id);
        out.put("events", events);
        out.put("hasMore", false);
        return ResponseEntity.ok(out);
    }

    @GetMapping("/session/{id}/status")
    public ResponseEntity<?> status(@PathVariable("id") String id) {
        if (live != null) return ResponseEntity.status(404).body(errorBody("Remote prompt status is unavailable", "status_unavailable"));
        Registry.Record record = resolveSession(id);
        if (record == null) return notFound(id);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sessionId", id);
        out.put("attached", false);
        out.put("hasActivePrompt", record.journal.activePrompt);
        out.put("clientCount", 0);
        return ResponseEntity.ok(out);
    }

    @PatchMapping("/session/{id}/metadata")
    public ResponseEntity<?> renameSessionRoute(@PathVariable("id") String id, @RequestBody(required = false) Map<String, Object> body) {
        return renameSession(id, body == null ? null : body.get("displayName"));
    }

    @DeleteMapping("/session/{id}")
    public ResponseEntity<?> deleteSession(@PathVariable("id") String id) {
        if (remote != null) return remote.delete(id);
        Registry.Record record = resolveSession(id);
        if (record == null) return notFound(id);

        record.deleted = true;
        return ResponseEntity.noContent().build();
    }

    // ------------------------------------------------------------------
    // permission：弹卡的回覆通道（与 /api/sessions/:id/reply 同一上游 ReplyAgentSession）。
    // 契约：200 = 已受理；404 = 未知/已被处理（SDK 按赛跑语义分发）。
    // ------------------------------------------------------------------

    @PostMapping("/session/{id}/permission/{requestId}")
    public ResponseEntity<Map<String, Object>> permissionOnSession(
        @PathVariable("id") String id,
        @PathVariable("requestId") String requestId,
        @RequestBody(required = false) Map<String, Object> body) {
        if (remote != null) return remote.permission(id, requestId, body);
        Registry.Record record = resolveSession(id);
        if (record == null) return notFound(id);
        Map<String, Object> pending = record.pendingPermissions.get(requestId);
        if (pending == null) {
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(errorBody(
                "没有这个待处理的人卡请求（requestId=" + requestId + "，未知/已被处理）", "permission_not_found"));
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> outcomeRaw = body != null && body.get("outcome") instanceof Map<?, ?> m
            ? (Map<String, Object>) m : null;
        String outcomeKind = outcomeRaw != null && "cancelled".equals(outcomeRaw.get("outcome")) ? "cancelled" : "selected";
        String optionId = outcomeRaw != null && outcomeRaw.get("optionId") instanceof String s && !s.trim().isEmpty()
            ? s.trim() : null;
        @SuppressWarnings("unchecked")
        Map<String, String> answers = body != null && body.get("answers") instanceof Map<?, ?> a && !a.isEmpty()
            ? (Map<String, String>) a : null;
        if (Events.OPENAPI_ANSWERS_OPTION.equals(optionId)) {
            Object pendingData = pending == null ? null : pending.get("data");
            boolean knownQuestion = pendingData instanceof Map<?, ?> data && Boolean.TRUE.equals(data.get("openApiAnswersOnly"));
            if (!knownQuestion || !"selected".equals(outcomeKind) || answers == null) {
                return ResponseEntity.badRequest().body(errorBody("问答提交必须包含 answers", "invalid_permission_response"));
            }
            optionId = null; // UI-only option must never reach OpenAPI.
        }
        if ("selected".equals(outcomeKind) && optionId == null && answers == null) {
            return ResponseEntity.badRequest().body(errorBody(
                "outcome=selected 时必须带 optionId 或 answers（与 /api/sessions/:id/reply 同一契约）",
                "invalid_permission_response"));
        }

        String clientFacingId = record.realId;


        // MOCK：回覆是本地教学闭环——录制件可能在后续轮次复用相同 requestId。
        record.pendingPermissions.remove(requestId);
        Map<String, Object> outcomeEvent = new LinkedHashMap<>();
        outcomeEvent.put("outcome", outcomeKind);
        if (optionId != null) outcomeEvent.put("optionId", optionId);
        record.journal.append(Events.permissionResolved(clientFacingId, requestId, outcomeEvent));
        return ResponseEntity.ok(Map.of());
    }

    @PostMapping("/permission/{requestId}")
    public ResponseEntity<Map<String, Object>> permissionDirect(
        @PathVariable("requestId") String requestId,
        @RequestBody(required = false) Map<String, Object> body) {
        if (live != null) return ResponseEntity.status(404).body(errorBody("Session ID is required", "permission_not_found"));
        // 历史兼容路由：requestId 在全注册表里反查会话
        for (Registry.Record record : registry.allRecords()) {
            if (record.pendingPermissions.containsKey(requestId)) {
                return permissionOnSession(record.realId, requestId, body);
            }
        }
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(errorBody(
            "没有这个待处理的人卡请求（requestId=" + requestId + "，未知/已被处理）", "permission_not_found"));
    }

    // ------------------------------------------------------------------
    // 降级端点
    // ------------------------------------------------------------------

    @GetMapping("/workspace/tools")
    public Map<String, Object> workspaceTools() {
        return Map.of("tools", List.of());
    }

    /**
     * 兜底 404：**记日志**。web-shell 打到这里的就是 daemon 有、而我们（因为上游
     * OpenAPI 缺接口或尚未实现）给不了的端点——日志用于定位未提供的能力。
     */
    @RequestMapping("/{*path}")
    public ResponseEntity<Map<String, Object>> notImplementedFallback(jakarta.servlet.http.HttpServletRequest request) {
        log.info("daemon-compat 未实现端点（缺口候选）：{} {}", request.getMethod(), request.getRequestURI());
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(errorBody(
            "daemon 兼容层未实现该端点：" + request.getMethod() + " " + request.getRequestURI(),
            "not_implemented"));
    }

    // ------------------------------------------------------------------
    // 内部实现
    // ------------------------------------------------------------------

    private ResponseEntity<?> loadSessionImpl(String id, String mode) {
        if (remote != null) return remote.load(id); // Resume also reads fresh remote history.
        Registry.Record record = resolveSession(id);
        if (record == null || record.deleted) return notFound(id);
        if ("load".equals(mode)) {
            MockFixtures.MockScenario scenario = MockFixtures.findScenario(record.realId);
            var frames = scenario != null && scenario.historyFixture() != null
                ? MockFixtures.readFixtureFrames(cfg.repoRoot(), scenario.historyFixture()) : List.<Map<String, Object>>of();
            record.journal.seed(Translate.historyFramesToEvents(frames, id));
            Registry.rebuildPendingPermissions(record);
        }
        Map<String, Object> out = new LinkedHashMap<>(standaloneSessionBody(record, id));
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("models", Map.of("currentModelId", "data-agent", "availableModels", List.of(Map.of("modelId", "data-agent",
            "baseModelId", "data-agent", "name", "DataWorks Data Agent", "isCurrent", true, "isRuntime", false))));
        state.put("modes", Map.of());
        state.put("configOptions", null);
        out.put("state", state);
        out.put("compactedReplay", record.journal.compacted().stream().map(Journal.Entry::event).toList());
        out.put("liveJournal", record.journal.live().stream().map(Journal.Entry::event).toList());
        out.put("lastEventId", record.journal.lastId());
        out.put("eventEpoch", epoch);
        out.put("historyHasMore", false);
        return ResponseEntity.ok(out);
    }

    private ResponseEntity<?> renameSession(String id, Object displayName) {
        String name = displayName instanceof String s ? s.trim() : "";
        if (name.isEmpty()) {
            return ResponseEntity.badRequest().body(errorBody("displayName 不能为空", "invalid_metadata"));
        }
        if (name.length() > 512) return ResponseEntity.badRequest().body(errorBody("Title exceeds 512 characters", "invalid_metadata"));
        if (remote != null) return remote.rename(id, name);
        Registry.Record record = resolveSession(id);
        if (record == null) return notFound(id);

        record.displayName = name;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sessionId", id);
        out.put("displayName", name);
        return ResponseEntity.ok(out);
    }

    private Map<String, Object> batchMutate(String action, Object rawIds) {
        if (remote != null) return remote.batch(action, rawIds);
        List<String> ids = new ArrayList<>();
        if (rawIds instanceof List<?> list) {
            for (Object v : list) {
                if (v instanceof String s) ids.add(s);
            }
        }
        List<String> done = new ArrayList<>();
        List<String> skipped = new ArrayList<>();
        List<String> notFoundIds = new ArrayList<>();
        List<Object> errors = new ArrayList<>();
        for (String raw : ids) {
            String id = raw;
            Registry.Record record = resolveSession(id);
            if (record == null) {
                notFoundIds.add(id);
                continue;
            }

            switch (action) {
                case "archive" -> {
                    if (record.archived) skipped.add(id);
                    else {
                        record.archived = true;
                        done.add(id);
                    }
                }
                case "unarchive" -> {
                    if (record.archived) {
                        record.archived = false;
                        done.add(id);
                    } else skipped.add(id);
                }
                default -> {
                    record.deleted = true;
                    done.add(id);
                }
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        switch (action) {
            case "archive" -> {
                out.put("archived", done);
                out.put("alreadyArchived", skipped);
                out.put("notFound", notFoundIds);
                out.put("errors", errors);
            }
            case "unarchive" -> {
                out.put("unarchived", done);
                out.put("alreadyActive", skipped);
                out.put("notFound", notFoundIds);
                out.put("errors", errors);
            }
            default -> {
                out.put("removed", done);
                out.put("notFound", notFoundIds);
                out.put("errors", errors);
                out.put("fileCleanupPending", List.of());
            }
        }
        return out;
    }

    private Map<String, Object> standaloneSessionBody(Registry.Record record, String clientFacingId) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sessionId", clientFacingId);
        // daemon 分配的客户端身份：客户端随 prompt 以 X-Qwen-Client-Id 带回，
        // 我们据此盖 originatorClientId（suppressOwnUserEcho 的匹配键）
        out.put("clientId", record.clientId);
        out.put("workspaceCwd", Registry.WORKSPACE_CWD);
        out.put("attached", false);
        out.put("createdAt", java.time.Instant.ofEpochMilli(record.createdAt).toString());
        out.put("sourceType", "standalone");
        out.put("context", Map.of("kind", "standalone"));
        out.put("projectlessOutputDirectory", Registry.WORKSPACE_CWD + "/out/" + clientFacingId);
        out.put("workingDirectory", Map.of("state", "ready"));
        return out;
    }
}
