package com.das.java.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.das.java.DasApplication;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.TestPropertySource;

/**
 * daemon 兼容层（/d）的端到端契约：与 Node 实现的 server-node/test/daemon-routes.test.ts
 * 同源同语义。整个 Spring 应用在真实端口上跑（MOCK=1），HTTP 断言与 Node 逐条对应。
 */
@SpringBootTest(classes = DasApplication.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties = {
    "spring.main.web-application-type=servlet",
    "logging.level.com.das.java.daemon=INFO"
})
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class DaemonRoutesTest {
    @LocalServerPort
    private int port;

    @Autowired
    private ObjectMapper mapper;

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    private String base() {
        return "http://127.0.0.1:" + port + "/d";
    }

    @Test
    void permitsConfiguredBrowserOriginWithDaemonHeaders() throws Exception {
        var request = HttpRequest.newBuilder(URI.create(base() + "/capabilities"))
            .header("Origin", "http://localhost:5173")
            .header("Access-Control-Request-Method", "GET")
            .header("Access-Control-Request-Headers", "x-qwen-client-id,x-qwen-event-epoch,last-event-id")
            .method("OPTIONS", HttpRequest.BodyPublishers.noBody()).build();
        var response = http.send(request, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, response.statusCode());
        assertEquals("http://localhost:5173", response.headers().firstValue("access-control-allow-origin").orElse(""));
        assertTrue(response.headers().firstValue("access-control-allow-headers").orElse("").contains("x-qwen-client-id"));

        var rejected = http.send(HttpRequest.newBuilder(URI.create(base() + "/capabilities"))
            .header("Origin", "https://untrusted.example")
            .header("Access-Control-Request-Method", "GET")
            .method("OPTIONS", HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(403, rejected.statusCode());
    }

    // ------------------------------------------------------------------
    // HTTP 助手
    // ------------------------------------------------------------------

    private record Res(int status, Json json) {}

    private record Json(Object value) {
        @SuppressWarnings("unchecked")
        Map<String, Object> asMap() {
            return (Map<String, Object>) value;
        }

        @SuppressWarnings("unchecked")
        List<Object> asList() {
            return (List<Object>) value;
        }
    }

    private Res get(String path) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create(base() + path)).GET().build();
        return send(req);
    }

    private Res post(String path, Object body) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create(base() + path))
            .header("content-type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)))
            .build();
        return send(req);
    }

    private Res patch(String path, Object body) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create(base() + path))
            .header("content-type", "application/json")
            .method("PATCH", HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)))
            .build();
        return send(req);
    }

    private Res delete(String path) throws Exception {
        HttpRequest req = HttpRequest.newBuilder(URI.create(base() + path)).DELETE().build();
        return send(req);
    }

    private Res send(HttpRequest req) throws Exception {
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        Object parsed = null;
        String text = res.body();
        if (text != null && !text.isEmpty()) parsed = mapper.readValue(text, Object.class);
        return new Res(res.statusCode(), new Json(parsed));
    }

    private Map<String, Object> promptAdmission(String sessionId, List<Map<String, Object>> prompt) throws Exception {
        Res res = post("/session/" + sessionId + "/prompt", Map.of("prompt", prompt));
        assertEquals(202, res.status(), "prompt 应返回 202: " + res.json().value());
        return res.json().asMap();
    }

    /** 轮询 transcript 直到出现目标事件类型（后台轮次是异步收尾的）。 */
    private List<Map<String, Object>> transcriptUntil(String sessionId, String type) throws Exception {
        long deadline = System.currentTimeMillis() + 15_000;
        while (true) {
            Res res = get("/session/" + sessionId + "/transcript");
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> events = (List<Map<String, Object>>) res.json().asMap().get("events");
            List<Map<String, Object>> out = events != null ? events : List.of();
            if (out.stream().anyMatch(e -> type.equals(e.get("type")))) return out;
            if (System.currentTimeMillis() > deadline) throw new AssertionError("transcript 等待 " + type + " 超时");
            Thread.sleep(80);
        }
    }

    // ------------------------------------------------------------------
    // SSE 帧读取
    // ------------------------------------------------------------------

    private record SseFrame(Long id, String event, Map<String, Object> envelope) {}

    @SuppressWarnings("unchecked")
    private List<SseFrame> readSseUntil(String sessionId, Long lastEventId, Map<String, Object> admission, String stopType)
        throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(base() + "/session/" + sessionId + "/events"))
            .header("accept", "text/event-stream")
            .timeout(Duration.ofSeconds(30));
        if (lastEventId != null) builder.header("last-event-id", String.valueOf(lastEventId));
        HttpResponse<InputStream> res = http.send(builder.GET().build(), HttpResponse.BodyHandlers.ofInputStream());

        assertEquals(200, res.statusCode());
        assertTrue(res.headers().firstValue("content-type").orElse("").contains("text/event-stream"));
        assertEquals(admission.get("eventEpoch"), res.headers().firstValue("x-qwen-event-epoch").orElse(null));
        assertTrue(res.headers().firstValue("x-qwen-sse-stream-id").isPresent());

        List<SseFrame> frames = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(res.body(), StandardCharsets.UTF_8))) {
            Long id = null;
            String event = null;
            StringBuilder data = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (event != null && data.length() > 0) {
                        Map<String, Object> envelope = mapper.readValue(data.toString(), Map.class);
                        frames.add(new SseFrame(id, event, envelope));
                        if (stopType.equals(event)) return frames;
                    }
                    id = null;
                    event = null;
                    data.setLength(0);
                    continue;
                }
                if (line.startsWith(":")) continue; // 心跳注释行
                if (line.startsWith("id: ")) id = Long.parseLong(line.substring(4));
                else if (line.startsWith("event: ")) event = line.substring(7);
                else if (line.startsWith("data: ")) {
                    if (data.length() > 0) data.append('\n');
                    data.append(line.substring(6));
                }
            }
        }
        return frames;
    }

    @SuppressWarnings("unchecked")
    private String updateKind(SseFrame frame) {
        Map<String, Object> data = (Map<String, Object>) frame.envelope().get("data");
        Map<String, Object> update = data != null ? (Map<String, Object>) data.get("update") : null;
        return update != null && update.get("sessionUpdate") instanceof String s ? s : null;
    }

    @SuppressWarnings("unchecked")
    private String updateText(SseFrame frame) {
        Map<String, Object> data = (Map<String, Object>) frame.envelope().get("data");
        Map<String, Object> update = data != null ? (Map<String, Object>) data.get("update") : null;
        Map<String, Object> content = update != null && update.get("content") instanceof Map<?, ?> m
            ? (Map<String, Object>) m : null;
        return content != null && content.get("text") instanceof String s ? s : null;
    }

    // ------------------------------------------------------------------
    // 用例（顺序与 Node daemon-routes.test.ts 对齐）
    // ------------------------------------------------------------------

    @Test
    @Order(1)
    void capabilitiesHasBothStandaloneFeatureTags() throws Exception {
        Res res = get("/capabilities");
        assertEquals(200, res.status());
        Map<String, Object> body = res.json().asMap();
        assertEquals(1, body.get("v"));
        @SuppressWarnings("unchecked")
        List<String> features = (List<String>) body.get("features");
        assertTrue(features.contains("standalone_sessions_v1"));
        assertTrue(features.contains("standalone_session_options_v1"));
        assertTrue(body.get("mode").equals("standalone"));
    }

    @Test
    @Order(2)
    void sessionOptionsHasRequiredProviderModelFields() throws Exception {
        Res res = get("/standalone/session-options");
        assertEquals(200, res.status());
        Map<String, Object> body = res.json().asMap();
        assertEquals(true, body.get("initialized"));
        @SuppressWarnings("unchecked")
        Map<String, Object> provider = ((List<Map<String, Object>>) body.get("providers")).get(0);
        assertEquals("model_provider", provider.get("kind"));
        assertEquals("ok", provider.get("status"));
        assertEquals("none", provider.get("authType"));
        assertEquals(true, provider.get("current"));
        @SuppressWarnings("unchecked")
        Map<String, Object> model = ((List<Map<String, Object>>) provider.get("models")).get(0);
        assertEquals("data-agent", model.get("modelId"));
        assertEquals(true, model.get("isCurrent"));
        assertEquals(false, model.get("isRuntime"));
    }

    @Test
    @Order(3)
    @SuppressWarnings("unchecked")
    void standaloneSessionsListHasStandaloneFields() throws Exception {
        Res res = get("/standalone/sessions");
        assertEquals(200, res.status());
        List<Map<String, Object>> sessions = (List<Map<String, Object>>) res.json().asMap().get("sessions");
        assertEquals(9, sessions.size(), "两条\"别的来源\"应被过滤（8 场景 + mock-permission）");
        for (Map<String, Object> s : sessions) {
            assertEquals("standalone", s.get("sourceType"));
            assertEquals(Map.of("kind", "standalone"), s.get("context"));
            assertTrue(s.get("workspaceCwd") instanceof String ws && !ws.isEmpty());
            assertTrue(s.get("createdAt") instanceof String);
        }
        assertTrue(sessions.stream().anyMatch(s -> "mock-short".equals(s.get("sessionId"))));
    }

    @Test
    @Order(4)
    void createReturnsRealIdAndLookupResolves() throws Exception {
        String aliasId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        Res created = post("/standalone/sessions", Map.of("sessionId", aliasId));
        assertEquals(200, created.status());
        Map<String, Object> body = created.json().asMap();
        assertNotEquals(aliasId, body.get("sessionId"));
        assertNotNull(body.get("sessionId"));
        assertEquals("standalone", body.get("sourceType"));
        assertEquals(Map.of("kind", "standalone"), body.get("context"));
        assertEquals(Map.of("state", "ready"), body.get("workingDirectory"));
        assertTrue(body.get("projectlessOutputDirectory") instanceof String);
        assertTrue(body.get("clientId") instanceof String);

        Res lookup = get("/standalone/sessions/" + body.get("sessionId"));
        assertEquals(200, lookup.status());
        assertEquals(body.get("sessionId"), lookup.json().asMap().get("sessionId"));
    }

    @Test
    @Order(5)
    @SuppressWarnings("unchecked")
    void loadSeedsHistoryIntoCompactedReplay() throws Exception {
        Res res = post("/standalone/sessions/mock-short/load", Map.of());
        assertEquals(200, res.status());
        Map<String, Object> body = res.json().asMap();
        assertEquals("mock-short", body.get("sessionId"));
        List<Map<String, Object>> compactedReplay = (List<Map<String, Object>>) body.get("compactedReplay");
        assertNotNull(compactedReplay);
        assertFalse(compactedReplay.isEmpty());
        assertTrue(((List<Object>) body.get("liveJournal")).isEmpty());
        Object lastEventId = body.get("lastEventId");
        assertTrue(lastEventId instanceof Number);
        assertEquals(((Number) compactedReplay.get(compactedReplay.size() - 1).get("id")).longValue(),
            ((Number) lastEventId).longValue());
        assertTrue(body.get("eventEpoch") instanceof String);
        assertEquals(List.of(Map.of(
            "modelId", "data-agent", "baseModelId", "data-agent",
            "name", "DataWorks Data Agent", "isCurrent", true, "isRuntime", false)),
            ((Map<String, Object>) body.get("state")).get("models"));
        assertEquals(Map.of(), ((Map<String, Object>) body.get("state")).get("modes"));
        assertNull(((Map<String, Object>) body.get("state")).get("configOptions"));
        assertEquals(false, body.get("historyHasMore"));
        // 种子里 user 回显必须已剥校验码说明
        List<Map<String, Object>> userChunks = compactedReplay.stream()
            .filter(e -> {
                Map<String, Object> data = (Map<String, Object>) e.get("data");
                Map<String, Object> update = data != null ? (Map<String, Object>) data.get("update") : null;
                return update != null && "user_message_chunk".equals(update.get("sessionUpdate"));
            })
            .toList();
        assertFalse(userChunks.isEmpty());
        for (Map<String, Object> chunk : userChunks) {
            Map<String, Object> data = (Map<String, Object>) chunk.get("data");
            Map<String, Object> update = (Map<String, Object>) data.get("update");
            Map<String, Object> content = (Map<String, Object>) update.get("content");
            assertFalse(String.valueOf(content.get("text")).contains("校验码"));
        }
    }

    @Test
    @Order(6)
    @SuppressWarnings("unchecked")
    void prompt202ThenSseStreamsSessionUpdatesToTurnComplete() throws Exception {
        Map<String, Object> admission = promptAdmission("mock-short",
            List.of(Map.of("type", "text", "text", "你好")));
        // 202 严格契约：只有这三个键
        assertEquals(new java.util.TreeSet<>(admission.keySet()),
            new java.util.TreeSet<>(List.of("promptId", "lastEventId", "eventEpoch")));

        List<SseFrame> frames = readSseUntil("mock-short",
            ((Number) admission.get("lastEventId")).longValue(), admission, "turn_complete");
        assertTrue(frames.size() > 1);

        // 续传语义：所有帧的 id 都严格大于 202 里的 lastEventId
        long lastEventId = ((Number) admission.get("lastEventId")).longValue();
        for (SseFrame frame : frames) {
            if (frame.id() != null) assertTrue(frame.id() > lastEventId);
        }

        // user 回显在流上也要剥掉校验码说明
        List<SseFrame> userChunks = frames.stream()
            .filter(f -> "session_update".equals(f.event()) && "user_message_chunk".equals(updateKind(f)))
            .toList();
        assertFalse(userChunks.isEmpty());
        for (SseFrame chunk : userChunks) {
            assertFalse(String.valueOf(updateText(chunk)).contains("校验码"));
        }

        // agent 输出存在且终态正确
        assertTrue(frames.stream().anyMatch(f -> "agent_message_chunk".equals(updateKind(f))));
        SseFrame turnComplete = frames.stream().filter(f -> "turn_complete".equals(f.event())).findFirst().orElseThrow();
        Map<String, Object> completeData = (Map<String, Object>) turnComplete.envelope().get("data");
        assertEquals("end_turn", completeData.get("stopReason"));
        assertEquals(admission.get("promptId"), completeData.get("promptId"));

        transcriptUntil("mock-short", "turn_complete");
    }

    @Test
    @Order(7)
    void inFlightPromptRejectsSecondWith409() throws Exception {
        Res created = post("/standalone/sessions", Map.of());
        String sessionId = (String) created.json().asMap().get("sessionId");

        Map<String, Object> first = promptAdmission(sessionId, List.of(Map.of("type", "text", "text", "第一轮")));
        assertNotNull(first.get("promptId"));

        Res second = post("/session/" + sessionId + "/prompt",
            Map.of("prompt", List.of(Map.of("type", "text", "text", "第二轮"))));
        assertEquals(409, second.status());
        assertEquals("session_concurrent_operation_in_progress", second.json().asMap().get("code"));

        transcriptUntil(sessionId, "turn_complete");
    }

    @Test
    @Order(8)
    void errorFrameEndsWithTurnErrorOnly() throws Exception {
        promptAdmission("mock-ghost", List.of(Map.of("type", "text", "text", "触发幽灵化")));
        List<Map<String, Object>> events = transcriptUntil("mock-ghost", "turn_error");
        assertEquals("turn_error", events.get(events.size() - 1).get("type"));
        assertFalse(events.stream().anyMatch(e -> "turn_complete".equals(e.get("type"))));
    }

    @Test
    @Order(9)
    void unsupportedPromptContentBlockGets400() throws Exception {
        Res res = post("/session/mock-render/prompt",
            Map.of("prompt", List.of(Map.of("type", "image", "data", "x", "mimeType", "image/png"))));
        assertEquals(400, res.status());
        assertEquals("unsupported_prompt_content", res.json().asMap().get("code"));
    }

    @Test
    @Order(10)
    void unknownSessionGets404AlignedWithApi() throws Exception {
        String[][] cases = {
            {"GET", "/standalone/sessions/no-such-session"},
        };
        Res load = post("/standalone/sessions/no-such-session/load", Map.of());
        assertEquals(404, load.status());
        assertEquals("standalone_session_not_found", load.json().asMap().get("code"));

        Res prompt = post("/session/no-such-session/prompt", Map.of("prompt", List.of(Map.of("type", "text", "text", "hi"))));
        assertEquals(404, prompt.status());
        assertEquals("standalone_session_not_found", prompt.json().asMap().get("code"));

        Res transcript = get("/session/no-such-session/transcript");
        assertEquals(404, transcript.status());
        assertEquals("standalone_session_not_found", transcript.json().asMap().get("code"));

        Res lookup = get("/standalone/sessions/no-such-session");
        assertEquals(404, lookup.status());
        assertEquals("standalone_session_not_found", lookup.json().asMap().get("code"));
    }

    @Test
    @Order(11)
    @SuppressWarnings("unchecked")
    void permissionFlowRespondAndReplay() throws Exception {
        // 1) prompt（fixture 带一条 permission_request 通知）→ SSE：permission_request + turn_complete
        Map<String, Object> admission = promptAdmission("mock-permission",
            List.of(Map.of("type", "text", "text", "请帮我起草一份上线公告")));
        List<SseFrame> frames = readSseUntil("mock-permission",
            ((Number) admission.get("lastEventId")).longValue(), admission, "turn_complete");
        List<String> eventTypes = frames.stream().map(SseFrame::event).toList();
        assertTrue(eventTypes.contains("permission_request"), "permission_request 应入流");
        assertTrue(eventTypes.contains("turn_complete"));
        SseFrame requestFrame = frames.stream()
            .filter(f -> "permission_request".equals(f.event())).findFirst().orElseThrow();
        Map<String, Object> requestData = (Map<String, Object>) requestFrame.envelope().get("data");
        assertEquals("req-keep-1", requestData.get("requestId"));
        assertEquals("mock-permission", requestData.get("sessionId"));
        assertTrue(requestData.get("toolCall") != null);
        var options = (List<Map<String, Object>>) requestData.get("options");
        var submit = options.stream().filter(o -> "allow_once".equals(o.get("kind"))).findFirst().orElseThrow();
        assertEquals(Events.OPENAPI_ANSWERS_OPTION, submit.get("optionId"));
        Res invalid = post("/session/mock-permission/permission/req-keep-1",
            Map.of("outcome", Map.of("outcome", "selected", "optionId", submit.get("optionId"))));
        assertEquals(400, invalid.status());

        transcriptUntil("mock-permission", "turn_complete");

        // 2) 未知 requestId → 404
        Res miss = post("/session/mock-permission/permission/req-unknown-1",
            Map.of("outcome", Map.of("outcome", "selected", "optionId", "proceed_once")));
        assertEquals(404, miss.status());
        assertEquals("permission_not_found", miss.json().asMap().get("code"));

        // 3) 回覆 → 200，journal 追加 permission_resolved
        Res respond = post("/session/mock-permission/permission/req-keep-1",
            Map.of("outcome", Map.of("outcome", "selected", "optionId", submit.get("optionId")), "answers", Map.of("0", "先列大纲")));
        assertEquals(200, respond.status());
        transcriptUntil("mock-permission", "permission_resolved");

        // 4) 已处理的 requestId 再次回覆 → 404
        Res replayed = post("/session/mock-permission/permission/req-keep-1",
            Map.of("outcome", Map.of("outcome", "selected", "optionId", "proceed_once")));
        assertEquals(404, replayed.status());
        assertEquals("permission_not_found", replayed.json().asMap().get("code"));
    }

    @Test
    @Order(12)
    @SuppressWarnings("unchecked")
    void permissionLegacyRouteAlsoWorks() throws Exception {
        // 同一会话再来一轮：replay 会把 permission_request 重新 set 成 pending
        Map<String, Object> admission = promptAdmission("mock-permission",
            List.of(Map.of("type", "text", "text", "换个问题")));
        assertNotNull(admission.get("promptId"));
        // 等新的轮次落账（第二个 turn_complete）——不然会撞在 worker 还没 set pending 的窗口中
        long deadline = System.currentTimeMillis() + 15_000;
        while (true) {
            Res tRes = get("/session/mock-permission/transcript");
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> events = (List<Map<String, Object>>) tRes.json().asMap().get("events");
            long completes = (events != null ? events : List.<Map<String, Object>>of())
                .stream().filter(e -> "turn_complete".equals(e.get("type"))).count();
            if (completes >= 2) break;
            assertTrue(System.currentTimeMillis() < deadline, "等待第二轮转 turn_complete 超时");
            Thread.sleep(100);
        }
        Res legacy = post("/permission/req-keep-1",
            Map.of("outcome", Map.of("outcome", "selected", "optionId", "proceed_once")));
        assertEquals(200, legacy.status());
    }

    @Test
    @Order(13)
    void heartbeatCancelDeleteSemantics() throws Exception {
        assertEquals(204, post("/session/mock-short/heartbeat", Map.of()).status());
        assertEquals(204, post("/session/mock-short/cancel", Map.of()).status());

        assertEquals(204, delete("/session/mock-concurrent").status());
        // 本地删除后从列表消失（journal 保留，深链重开仍在）
        Res list = get("/standalone/sessions");
        List<Map<String, Object>> sessions = (List<Map<String, Object>>) list.json().asMap().get("sessions");
        assertFalse(sessions.stream().anyMatch(s -> "mock-concurrent".equals(s.get("sessionId"))));
        assertEquals(404, get("/standalone/sessions/mock-concurrent").status());
    }

    @Test
    @Order(14)
    void renameOverridesDisplayNameProcessLocally() throws Exception {
        Res res = patch("/standalone/sessions/mock-break/metadata", Map.of("displayName", "我的断流实验"));
        assertEquals(200, res.status());
        assertEquals("mock-break", res.json().asMap().get("sessionId"));
        assertEquals("我的断流实验", res.json().asMap().get("displayName"));
    }

    @Test
    @Order(15)
    void unimplementedEndpointGets404WithCode() throws Exception {
        Res res = get("/workspace/mcp");
        assertEquals(404, res.status());
        assertEquals("not_implemented", res.json().asMap().get("code"));
    }
}
