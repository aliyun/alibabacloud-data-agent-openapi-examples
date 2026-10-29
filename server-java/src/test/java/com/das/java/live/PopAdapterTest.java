package com.das.java.live;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.aliyun.auth.credentials.Credential;
import com.aliyun.auth.credentials.provider.StaticCredentialProvider;
import com.aliyun.sdk.gateway.pop.Configuration;
import com.aliyun.sdk.service.dataworks_public20240518.AsyncClient;
import com.aliyun.sdk.service.dataworks_public20240518.DefaultAsyncClientBuilder;
import com.aliyun.sdk.gateway.pop.auth.SignatureAlgorithm;
import com.aliyun.sdk.gateway.pop.auth.SignatureVersion;
import com.das.java.config.AppConfig;
import com.das.java.config.SessionOptions;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import darabonba.core.client.ClientOverrideConfiguration;
import java.io.ByteArrayOutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class PopAdapterTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private HttpServer server;
    private PopAdapter adapter;
    private final LinkedBlockingQueue<Map<String, String>> requests = new LinkedBlockingQueue<>();
    private volatile String reply;
    private volatile int status = 200;
    private volatile boolean streaming;
    private volatile String headerRequestId;
    private java.util.function.Function<Map<String, String>, String> responseBody;

    @BeforeEach void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            Map<String, String> request = form(exchange.getRequestURI().getRawQuery());
            request.putAll(form(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)));
            request.put("method", exchange.getRequestMethod());
            request.put("action", exchange.getRequestHeaders().getFirst("x-acs-action"));
            request.put("authorization", exchange.getRequestHeaders().getFirst("Authorization"));
            request.put("cursor", exchange.getRequestHeaders().getFirst("Last-Event-Id"));
            requests.offer(request);
            exchange.getResponseHeaders().set("Content-Type", streaming ? "text/event-stream" : "application/json");
            if (headerRequestId != null) exchange.getResponseHeaders().set("x-acs-request-id", headerRequestId);
            byte[] body = (responseBody == null ? reply : responseBody.apply(request)).getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, body.length);
            // Deliberately split Unicode and SSE lines across chunks.
            for (byte b : body) { exchange.getResponseBody().write(b); exchange.getResponseBody().flush(); }
            exchange.close();
        });
        server.start();
        adapter = new PopAdapter.Builder().region("cn-hangzhou")
            .overrideConfiguration(ClientOverrideConfiguration.create().setProtocol("HTTP")
                .setEndpointOverride("127.0.0.1:" + server.getAddress().getPort()).setConnectTimeout(Duration.ofSeconds(2)))
            .credentialsProvider(StaticCredentialProvider.create(Credential.builder().accessKeyId("test-id").accessKeySecret("test-secret").build()))
            .serviceConfiguration(Configuration.create().setSignatureVersion(SignatureVersion.V3)
                .setSignatureAlgorithmV3(SignatureAlgorithm.ACS3_HMAC_SHA256)).build();
    }
    @AfterEach void stop() { adapter.close(); server.stop(0); }

    private static Map<String, String> form(String body) {
        Map<String, String> out = new LinkedHashMap<>();
        if (body != null && !body.isEmpty()) for (String pair : body.split("&")) {
            String[] parts = pair.split("=", 2);
            out.put(URLDecoder.decode(parts[0], StandardCharsets.UTF_8), URLDecoder.decode(parts.length > 1 ? parts[1] : "", StandardCharsets.UTF_8));
        }
        return out;
    }
    private Map<String, String> request() throws Exception {
        var value = requests.poll(5, TimeUnit.SECONDS);
        assertNotNull(value);
        assertTrue(value.get("authorization").startsWith("ACS3-HMAC-SHA256"));
        return value;
    }
    private AsyncClient sdkClient() {
        return new DefaultAsyncClientBuilder().region("cn-hangzhou")
            .overrideConfiguration(ClientOverrideConfiguration.create().setProtocol("HTTP")
                .setEndpointOverride("127.0.0.1:" + server.getAddress().getPort()).setConnectTimeout(Duration.ofSeconds(2)))
            .credentialsProvider(StaticCredentialProvider.create(Credential.builder().accessKeyId("test-id").accessKeySecret("test-secret").build()))
            .serviceConfiguration(Configuration.create().setSignatureVersion(SignatureVersion.V3)
                .setSignatureAlgorithmV3(SignatureAlgorithm.ACS3_HMAC_SHA256)).build();
    }

    private static AppConfig cfg() {
        AppConfig cfg = mock(AppConfig.class);
        when(cfg.regionId()).thenReturn("cn-hangzhou");
        when(cfg.accessKeyId()).thenReturn("test-id");
        when(cfg.accessKeySecret()).thenReturn("test-secret");
        when(cfg.agentName()).thenReturn("custom-agent");
        when(cfg.sessionSource()).thenReturn("test-source");
        return cfg;
    }

    @Test void managementHelpersUseTopLevelFormsAndPinnedReferencesOnlyWhenInvoked() throws Exception {
        reply = "{\"RequestId\":\"req\",\"Agent\":{\"Name\":\"custom\",\"AgentVersion\":3}}";
        try (var management = new AgentManagementExample(adapter)) {
            assertTrue(requests.isEmpty(), "Construction must not run management calls");
            var skill = Map.of("Source", "DB", "Name", "business-skill", "Version", 2);
            var suite = Map.of("Source", "DB", "SuiteId", "suite-example", "Version", 3);
            var result = management.createAgent("custom", Map.of(
                "Model", Map.of("modelName", "provider/model"), "Skills", List.of(skill),
                "ExpertSuites", List.of(suite), "Tools", List.of(Map.of("Name", "tool-server")),
                "CallableAgents", List.of(Map.of("Name", "child-agent"))));
            assertEquals(3, ((Number)((Map<?, ?>)result.get("Agent")).get("AgentVersion")).intValue());
            var create = request();
            assertEquals("CreateAgent", create.get("action"));
            assertEquals("custom", create.get("Name"));
            assertEquals("false", create.get("PublishImmediately"));
            assertFalse(create.containsKey("Params"));
            assertFalse(create.containsKey("Jsonrpc"));
            assertFalse(create.containsKey("Id"));
            assertEquals("provider/model", JSON.readTree(create.get("Model")).get("modelName").asText());
            assertEquals(JSON.valueToTree(List.of(skill)), JSON.readTree(create.get("Skills")));
            assertEquals(JSON.valueToTree(List.of(suite)), JSON.readTree(create.get("ExpertSuites")));
            management.getAgent("custom", null);
            var current = request();
            assertEquals("GetAgent", current.get("action"));
            assertFalse(current.containsKey("AgentVersion"));
            management.getAgent("custom", 3);
            assertEquals("3", request().get("AgentVersion"));
            management.updateAgent("custom", 3, Map.of("PublishImmediately", true, "Skills", List.of(skill)));
            var update = request();
            assertEquals("UpdateAgent", update.get("action"));
            assertEquals("3", update.get("ExpectedVersion"));
            assertEquals("true", update.get("PublishImmediately"));
            assertFalse(update.containsKey("Params"));
        }
    }

    @Test void managementRejectsUnsupportedFieldsAndBusinessErrorsWithoutRetry() throws Exception {
        try (var management = new AgentManagementExample(adapter)) {
            assertThrows(IllegalArgumentException.class, () -> management.createAgent("custom", Map.of("RuntimePolicy", Map.of())));
            assertThrows(IllegalArgumentException.class, () -> management.updateAgent("custom", 0, Map.of()));
            assertThrows(IllegalArgumentException.class, () -> management.getAgent("custom", -1));
            assertThrows(IllegalArgumentException.class, () -> management.createAgent("custom", Map.of("PublishImmediately", "true")));
            assertTrue(requests.isEmpty());
            reply = "{\"Error\":{\"Message\":\"conflict\"}}";
            assertThrows(Normalize.DasApiException.class, () -> management.updateAgent("custom", 3, Map.of()));
            assertEquals("UpdateAgent", request().get("action"));
            assertTrue(requests.isEmpty());
        }
    }

    @Test void signedLifecycleUsesJsonRpcParamsAndAcceptsEmptyDeleteResult() throws Exception {
        reply = "{\"RequestId\":\"req\",\"JsonRpcResponse\":{\"Result\":{}}}";
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient())) {
            client.renameSession("session-A", "新标题");
            var rename = request();
            assertEquals("POST", rename.get("method"));
            assertEquals("UpdateAgentSessionTitle", rename.get("action"));
            assertEquals("2.0", rename.get("Jsonrpc"));
            assertEquals(JSON.readTree("{\"SessionId\":\"session-A\",\"Title\":\"新标题\"}"), JSON.readTree(rename.get("Params")));
            client.archiveSession("session-A", false);
            var archive = request();
            assertEquals("ArchiveAgentSession", archive.get("action"));
            assertFalse(JSON.readTree(archive.get("Params")).get("Archived").asBoolean());
            client.deleteSession("session-A");
            assertEquals("DeleteAgentSession", request().get("action"));
        }
    }

    @Test void creationIncludesNewFieldsWithoutGeneratedSdkDroppingThem() throws Exception {
        reply = "{\"JsonRpcResponse\":{\"Result\":{\"SessionId\":\"created\"}}}";
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient())) {
            assertEquals("created", client.createSessionWithOptions(new SessionOptions("model(openai)", "plan", "high")).get("sessionId"));
            JsonNode meta = JSON.readTree(request().get("Params")).path("Meta");
            assertEquals("custom-agent", meta.path("Agent").path("AgentName").asText());
            assertEquals(JSON.readTree("{\"Model\":\"model(openai)\",\"Mode\":\"plan\",\"ReasoningEffort\":\"high\"}"), meta.path("InitialConfigOptions"));
        }
    }

    private void initialConfigError(Map<String, Object> error) throws Exception {
        reply = JSON.writeValueAsString(Map.of("RequestId", "config-request-id", "JsonRpcResponse", Map.of("Error", error)));
    }

    @Test void generatedCreateSdkAndBrowserRouteExposeOnlyKnownInitialConfigReasons() throws Exception {
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient())) {
            var mvc = org.springframework.test.web.servlet.setup.MockMvcBuilders.standaloneSetup(
                new com.das.java.daemon.DaemonController(cfg(), new LiveClientHolder(client), new com.das.java.web.Inflight())).build();
            for (String reason : List.of("capabilities_unavailable", "ambiguous_model", "model_not_available", "reasoning_not_available")) {
                for (boolean byCode : List.of(true, false)) {
                    initialConfigError(Map.of("Code", 400,
                        "ErrorCode", byCode ? "INVALID_SESSION_INITIAL_CONFIG" : "OTHER_ERROR",
                        "Message", byCode ? "Configuration rejected" : "INVALID_SESSION_INITIAL_CONFIG",
                        "Data", Map.of("reason", reason, "token", "fixture-secret", "messages", List.of("private diagnostic"))));
                    var response = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                        .post("/d/standalone/sessions").contentType("application/json")
                        .content("{\"modelServiceId\":\"deepseek-v4-flash-0731\",\"approvalMode\":\"yolo\"}"))
                        .andReturn().getResponse();
                    assertEquals(502, response.getStatus());
                    var body = JSON.readTree(response.getContentAsString());
                    String expected = "CreateAgentSession: " + (byCode ? "Configuration rejected" : "INVALID_SESSION_INITIAL_CONFIG")
                        + " (reason=" + reason + ") | requestId=config-request-id";
                    assertEquals(expected, body.path("error").asText());
                    assertEquals("config-request-id", body.path("requestId").asText());
                    assertFalse(response.getContentAsString().contains("fixture-secret"));
                    assertFalse(response.getContentAsString().contains("private diagnostic"));
                    var sent = request();
                    assertEquals("CreateAgentSession", sent.get("action"));
                    var initial = JSON.readTree(sent.get("Params")).path("Meta").path("InitialConfigOptions");
                    assertEquals("deepseek-v4-flash-0731", initial.path("Model").asText());
                    assertEquals("yolo", initial.path("Mode").asText());
                    assertFalse(initial.has("ReasoningEffort"));
                }
            }
        }
    }

    @Test void genericRpcAcceptsDataMapCasingButRejectsOtherErrorsAndUnsafeReasons() throws Exception {
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient())) {
            for (String key : List.of("Data", "data")) {
                initialConfigError(Map.of("ErrorCode", "INVALID_SESSION_INITIAL_CONFIG", "Message", "rejected",
                    key, Map.of("reason", "model_not_available", "token", "fixture-secret")));
                var error = assertThrows(Normalize.DasApiException.class, () -> client.deleteSession("s")).apiError();
                assertEquals("DeleteAgentSession: rejected (reason=model_not_available) | requestId=config-request-id", error.message());
                assertEquals("config-request-id", error.requestId());
                assertEquals("DeleteAgentSession", request().get("action"));
            }
            for (Object diagnostics : List.of(
                Map.of("reason", "unknown-fixture-secret"), Map.of("reason", "model_not_available\nfixture-secret"),
                Map.of("reason", "MODEL_NOT_AVAILABLE"), Map.of("reason", " model_not_available"),
                Map.of("reason", Map.of("token", "fixture-secret")), Map.of("reason", 123),
                Map.of("messages", List.of("fixture-secret")), List.of("fixture-secret"), "fixture-secret")) {
                initialConfigError(Map.of("ErrorCode", "INVALID_SESSION_INITIAL_CONFIG", "Message", "rejected", "Data", diagnostics));
                var error = assertThrows(Normalize.DasApiException.class, () -> client.deleteSession("s")).apiError();
                assertEquals("DeleteAgentSession: rejected | requestId=config-request-id", error.message());
                assertEquals("config-request-id", error.requestId());
                request();
            }
            initialConfigError(Map.of("ErrorCode", "INVALID_SESSION_INITIAL_CONFIG_SUFFIX", "Message", "prefix INVALID_SESSION_INITIAL_CONFIG",
                "Data", Map.of("reason", "model_not_available", "token", "fixture-secret")));
            var error = assertThrows(Normalize.DasApiException.class, () -> client.deleteSession("s")).apiError();
            assertEquals("DeleteAgentSession: prefix INVALID_SESSION_INITIAL_CONFIG | requestId=config-request-id", error.message());
            request();
        }
    }

    @Test void generatedCreateRouteDoesNotExposeUnknownReasonsOrArbitraryData() throws Exception {
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient())) {
            var mvc = org.springframework.test.web.servlet.setup.MockMvcBuilders.standaloneSetup(
                new com.das.java.daemon.DaemonController(cfg(), new LiveClientHolder(client), new com.das.java.web.Inflight())).build();
            for (Map<String, Object> error : List.of(
                Map.<String, Object>of("ErrorCode", "INVALID_SESSION_INITIAL_CONFIG", "Message", "INVALID_SESSION_INITIAL_CONFIG",
                    "Data", Map.of("reason", "unknown-fixture-secret", "token", "fixture-secret")),
                Map.<String, Object>of("ErrorCode", "OTHER_ERROR", "Message", "prefix INVALID_SESSION_INITIAL_CONFIG",
                    "Data", Map.of("reason", "model_not_available", "messages", List.of("fixture-secret"))),
                Map.<String, Object>of("ErrorCode", "INVALID_SESSION_INITIAL_CONFIG", "Message", "INVALID_SESSION_INITIAL_CONFIG"))) {
                initialConfigError(error);
                var response = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                    .post("/d/standalone/sessions").contentType("application/json").content("{}"))
                    .andReturn().getResponse();
                assertEquals(502, response.getStatus());
                var body = JSON.readTree(response.getContentAsString());
                assertEquals("CreateAgentSession: " + error.get("Message") + " | requestId=config-request-id", body.path("error").asText());
                assertEquals("config-request-id", body.path("requestId").asText());
                assertFalse(response.getContentAsString().contains("fixture-secret"));
                request();
            }
        }
    }

    @Test void genericMutationDoesNotAutomaticallyRetryUpstream503() throws Exception {
        status = 503;
        reply = "{\"Code\":\"ServiceUnavailable\",\"Message\":\"temporary failure\",\"RequestId\":\"test-503\"}";
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient())) {
            assertThrows(Normalize.DasApiException.class, () -> client.deleteSession("s"));
            assertEquals("DeleteAgentSession", request().get("action"));
            assertTrue(requests.isEmpty(), "Completed SDK call must have sent exactly one write despite HTTP 503");
        }
    }

    @Test void cancelValidatesRpcErrorAndMissingResultInsteadOfTrustingHttp200() throws Exception {
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient())) {
            for (String body : List.of("{\"JsonRpcResponse\":{\"Error\":{\"Message\":\"denied\"}}}", "{}")) {
                reply = body;
                assertEquals(false, client.cancel("s").get("delivered"));
                assertEquals("CancelAgentSession", request().get("action"));
                assertTrue(requests.isEmpty());
            }
            for (String result : List.of("{}", "{\"Delivered\":false,\"Noop\":false}")) {
                reply = "{\"JsonRpcResponse\":{\"Result\":" + result + "}}";
                assertEquals(false, client.cancel("s").get("delivered"));
                request();
            }
            reply = "{\"JsonRpcResponse\":{\"Result\":{\"Delivered\":true,\"Noop\":false}}}";
            assertEquals(true, client.cancel("s").get("delivered"));
            request();
            reply = "{\"JsonRpcResponse\":{\"Result\":{\"Delivered\":false,\"Noop\":true}}}";
            var noop = client.cancel("s");
            assertEquals(false, noop.get("delivered"));
            assertEquals(true, noop.get("noop"));
            request();
            status = 503;
            reply = "{\"Code\":\"ServiceUnavailable\",\"Message\":\"unavailable\"}";
            assertEquals(false, client.cancel("s").get("delivered"));
            request();
            assertTrue(requests.isEmpty(), "Cancel is never automatically retried");
        }
    }

    @Test void legacyCancelRequiresMatchingSessionAndAbsentDeliveryFields() throws Exception {
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient())) {
            reply = "{\"RequestId\":\"legacy-request\",\"JsonRpcResponse\":{\"Result\":{\"SessionId\":\"s\"}}}";
            var result = client.cancel("s");
            assertEquals(true, result.get("accepted"));
            assertEquals(false, result.get("delivered"));
            assertFalse(result.containsKey("noop"), "Legacy ACK does not establish idle state");
            assertEquals("cancel-accepted-legacy", result.get("warning"));
            assertEquals("legacy-request", result.get("requestId"));
            assertEquals("CancelAgentSession", request().get("action"));
            for (String rejected : List.of(
                "{\"SessionId\":\"other\"}", "{}",
                "{\"SessionId\":\"s\",\"Delivered\":false,\"Noop\":false}",
                "{\"SessionId\":\"s\",\"Delivered\":false}",
                "{\"SessionId\":\"s\",\"Noop\":false}",
                "{\"SessionId\":\"s\",\"Delivered\":null}")) {
                reply = "{\"JsonRpcResponse\":{\"Result\":" + rejected + "}}";
                var failure = client.cancel("s");
                assertEquals(false, failure.get("accepted"), rejected);
                assertEquals(false, failure.get("delivered"), rejected);
                assertEquals("cancel-upstream-error", failure.get("warning"), rejected);
                request();
            }
            assertTrue(requests.isEmpty(), "Legacy cancellation must not retry");
        }
    }

    @Test void rpcErrorAndMissingResultAreFailures() throws Exception {
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient())) {
            reply = "{\"JsonRpcResponse\":{\"Error\":{\"Code\":403,\"Message\":\"denied\"}}}";
            assertThrows(Normalize.DasApiException.class, () -> client.renameSession("s", "t"));
            request();
            reply = "{\"JsonRpcResponse\":{}}";
            assertThrows(Normalize.DasApiException.class, () -> client.deleteSession("s"));
            request();
            assertTrue(requests.isEmpty(), "Mutations must never retry");
        }
    }

    @Test void archivedListUsesRemoteFilterAndPreservesRemoteMetadata() throws Exception {
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient())) {
            for (boolean archived : new boolean[]{false, true}) {
                reply = "{\"JsonRpcResponse\":{\"Result\":{\"TotalCount\":1,\"AgentSessions\":[{\"SessionId\":\"s\",\"SessionTitle\":\"renamed\",\"Meta\":{\"Archived\":" + archived + "}}]}}}";
                var result = client.listSessions(archived);
                assertEquals(1, result.get("total"));
                assertEquals(archived, ((Map<?, ?>) ((List<?>) result.get("sessions")).get(0)).get("archived"));
                var request = request();
                assertEquals("ListAgentSessions", request.get("action"));
                assertEquals(archived, JSON.readTree(request.get("Params")).get("Archived").asBoolean());
            }
        }
    }

    @Test void generatedSessionCallsRejectRpcErrorsAndNeverRetryWrites() throws Exception {
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient())) {
            reply = "{\"RequestId\":\"rejected\",\"JsonRpcResponse\":{\"Error\":{\"Code\":403,\"Message\":\"denied\"},\"Result\":{\"SessionId\":\"must-not-accept\"}}}";
            assertThrows(Normalize.DasApiException.class,
                () -> client.createSessionWithOptions(new SessionOptions(null, "yolo", null)));
            assertEquals("CreateAgentSession", request().get("action"));
            assertTrue(requests.isEmpty());
            status = 503;
            reply = "{\"Code\":\"ServiceUnavailable\",\"Message\":\"temporary failure\"}";
            assertThrows(Normalize.DasApiException.class,
                () -> client.createSessionWithOptions(new SessionOptions("model", "plan", "none")));
            assertEquals("CreateAgentSession", request().get("action"));
            assertTrue(requests.isEmpty(), "Generated session creation must not retry an ambiguous write");
            assertThrows(Normalize.DasApiException.class, () -> client.renameSession("s", "title"));
            assertEquals("UpdateAgentSessionTitle", request().get("action"));
            assertTrue(requests.isEmpty(), "Generated rename must not retry");
        }
    }

    @Test void generatedCreationOmitsUnsetOptionsAndPreservesProjectAndResourceGroup() throws Exception {
        AppConfig config = cfg();
        when(config.projectId()).thenReturn("12345");
        when(config.resourceGroupId()).thenReturn("rg-example");
        reply = "{\"JsonRpcResponse\":{\"Result\":{\"SessionId\":\"created\"}}}";
        try (LiveClient client = new LiveClient(config, adapter, sdkClient())) {
            client.createSessionWithOptions(new SessionOptions(null, "default", null));
            var wire = request();
            var options = JSON.readTree(wire.get("Params")).path("Meta").path("InitialConfigOptions");
            assertEquals("12345", options.path("ProjectId").asText());
            assertEquals("rg-example", options.path("ResourceGroupId").asText());
            assertEquals("default", options.path("Mode").asText());
            assertFalse(options.has("Model"));
            assertFalse(options.has("ReasoningEffort"));
        }
    }

    @Test void generatedManagementRequestsPreservePublishAndRawErrorVersionFields() throws Exception {
        reply = "{\"RequestId\":\"publish-request\",\"Agent\":{\"Name\":\"custom\",\"AgentVersion\":7}}";
        try (var management = new AgentManagementExample(adapter)) {
            management.createAgent("custom", Map.of("PublishImmediately", true, "Metadata", Map.of("owner", "example"),
                "VisibilityScope", Map.of("UserIds", List.of("user"), "ProjectIds", List.of("project"))));
            var create = request();
            assertEquals("CreateAgent", create.get("action"));
            assertEquals("true", create.get("PublishImmediately"));
            assertEquals("example", JSON.readTree(create.get("Metadata")).path("owner").asText());
            assertEquals("user", JSON.readTree(create.get("VisibilityScope")).path("UserIds").get(0).asText());
            assertFalse(create.containsKey("Jsonrpc"));
            reply = "{\"Error\":{\"Message\":\"denied\"},\"Agent\":{\"Name\":\"must-not-accept\",\"AgentVersion\":9}}";
            assertThrows(Normalize.DasApiException.class, () -> management.createAgent("custom", Map.of()));
            assertEquals("CreateAgent", request().get("action"));
            assertThrows(Normalize.DasApiException.class, () -> management.getAgent("custom", 7));
            assertEquals("GetAgent", request().get("action"));
            assertTrue(requests.isEmpty(), "Management never retries a business rejection");
        }
    }

    @Test void generatedReplyKeepsAnswersAndRejectsBusinessErrors() throws Exception {
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient())) {
            reply = "{\"RequestId\":\"reply-request\",\"JsonRpcResponse\":{\"Result\":{\"Accepted\":true}}}";
            assertEquals(true, client.reply("session-A", Map.of("permissionRequestId", "permission-A", "outcome", "selected",
                "answers", Map.of("0", "回答 😀"))).get("accepted"));
            var request = request();
            assertEquals("ReplyAgentSession", request.get("action"));
            var params = JSON.readTree(request.get("Params"));
            assertEquals("session-A", params.path("SessionId").asText());
            assertEquals("permission-A", params.path("PermissionRequestId").asText());
            assertEquals("回答 😀", params.path("Answers").path("0").asText());
            reply = "{\"JsonRpcResponse\":{\"Error\":{\"Code\":403,\"Message\":\"rejected\"},\"Result\":{\"Accepted\":true}}}";
            assertThrows(Normalize.DasApiException.class, () -> client.reply("session-A",
                Map.of("permissionRequestId", "permission-A", "outcome", "selected", "optionId", "proceed_once")));
            assertEquals("ReplyAgentSession", request().get("action"));
            assertTrue(requests.isEmpty());
        }
    }

    @Test void singleSessionLookupFiltersByRemoteSidAcrossActiveAndArchivedWithoutSourceCache() throws Exception {
        responseBody = request -> {
            try {
                boolean archived = JSON.readTree(request.get("Params")).path("Archived").asBoolean();
                return archived
                    ? "{\"JsonRpcResponse\":{\"Result\":{\"AgentSessions\":[{\"SessionId\":\"case-SID\",\"SessionTitle\":\"remote archived\",\"Meta\":{\"Archived\":true}}]}}}"
                    : "{\"JsonRpcResponse\":{\"Result\":{\"AgentSessions\":[]}}}";
            } catch (Exception error) { throw new RuntimeException(error); }
        };
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient())) {
            assertEquals("remote archived", client.sessionSummary("case-SID").get("title"));
            for (boolean archived : new boolean[]{false, true}) {
                var params = JSON.readTree(request().get("Params"));
                assertEquals("case-SID", params.path("SessionId").asText());
                assertEquals(archived, params.path("Archived").asBoolean());
                assertFalse(params.has("AgentName"));
                assertFalse(params.has("SessionSourceList"));
            }
        }
    }

    @Test void rawSignedGetPreservesDaemonSseAndExplicitZeroReplayCursor() throws Exception {
        streaming = true;
        reply = ": heartbeat\r\n\r\nid: 42\r\nevent: message\r\ndata: {\"v\":1,\"type\":\"text\",\"data\":{\"sessionId\":\"session-A\",\"text\":\"你好🌏\"},\"id\":42}\r\n\r\n";
        for (String cursor : new String[]{"41", "0", null}) {
            try (var remote = adapter.events("session-A", cursor)) {
                assertEquals(200, remote.metadata().status());
                // Let the HTTP execution finish before the slower SSE consumer drains it.
                // SDK response post-processing must not race the raw publisher terminal.
                Thread.sleep(200);
                var output = new ByteArrayOutputStream();
                List<String> cursors = new ArrayList<>();
                RemoteSseRelay.relay(remote, output, "session-A", cursors::add);
                assertEquals(reply.replace("\r\n", "\n"), output.toString(StandardCharsets.UTF_8));
                assertEquals(List.of("42"), cursors);
            }
            var get = request();
            assertEquals("GetAgentSessionEvents", get.get("action"));
            assertEquals("GET", get.get("method"));
            assertEquals("session-A", get.get("SessionCode"));
            assertFalse(get.containsKey("SessionId"));
            assertFalse(get.containsKey("LastEventId"));
            assertEquals(cursor, get.get("cursor"));
        }
    }

    @Test void popWrapperPreservesOuterIdAndParsesEventJsonStringOrObject() throws Exception {
        for (Object inner : List.of(Map.of("v", 1, "type", "text", "data", Map.of("text", "你好")), "{\"v\":1,\"type\":\"text\",\"data\":{\"text\":\"你好\"}}")) {
            var output = new ByteArrayOutputStream();
            var cursors = new ArrayList<String>();
            RemoteSseRelay.writeFrame(List.of("data: " + JSON.writeValueAsString(Map.of("Id", "72", "Event", inner))), output, "session-A", cursors::add);
            String wire = output.toString(StandardCharsets.UTF_8);
            assertTrue(wire.startsWith("id: 72\n"));
            assertTrue(wire.contains("你好"));
            assertFalse(wire.contains("\"Event\""));
            assertEquals(List.of("72"), cursors);
        }
    }

    @Test void upstream403RemainsErrorStatusAndBody() throws Exception {
        status = 403;
        reply = "{\"Code\":\"Forbidden\",\"Message\":\"denied\"}";
        try (var remote = adapter.events("session-A", null)) {
            assertEquals(403, remote.metadata().status());
            var output = new ByteArrayOutputStream();
            byte[] chunk;
            while ((chunk = remote.next()) != null) output.write(chunk);
            assertEquals(reply, output.toString(StandardCharsets.UTF_8));
        }
    }
    @Test void creationAgentOverrideDoesNotLeakIntoNextRequest() throws Exception {
        reply = "{\"JsonRpcResponse\":{\"Result\":{\"SessionId\":\"created\"}}}";
        AppConfig config = cfg();
        try (LiveClient client = new LiveClient(config, adapter, sdkClient())) {
            client.createSessionWithOptions(SessionOptions.resolve(config, Map.of("agentName", " ui-agent ")));
            assertEquals("ui-agent", JSON.readTree(request().get("Params")).at("/Meta/Agent/AgentName").asText());
            client.createSessionWithOptions(new SessionOptions(null, "yolo", null));
            assertEquals("custom-agent", JSON.readTree(request().get("Params")).at("/Meta/Agent/AgentName").asText());
            assertEquals("custom-agent", config.agentName());
        }
    }

    @Test void listAndLookupForwardRequestAgentWithoutChangingDefaultFilters() throws Exception {
        reply = "{\"JsonRpcResponse\":{\"Result\":{\"AgentSessions\":[{\"SessionId\":\"case-SID\",\"SessionTitle\":\"remote\"}]}}}";
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient())) {
            client.listSessions(true, " ui-agent ");
            var params = JSON.readTree(request().get("Params"));
            assertEquals("ui-agent", params.path("AgentName").asText());
            assertEquals("test-source", params.at("/SessionSourceList/0").asText());
            assertTrue(params.path("Archived").asBoolean());
            client.listSessions(false);
            params = JSON.readTree(request().get("Params"));
            assertEquals("custom-agent", params.path("AgentName").asText());
            assertEquals("test-source", params.at("/SessionSourceList/0").asText());
            assertNotNull(client.sessionSummary("case-SID", " ui-agent "));
            params = JSON.readTree(request().get("Params"));
            assertEquals("case-SID", params.path("SessionId").asText());
            assertEquals("ui-agent", params.path("AgentName").asText());
            assertFalse(params.hasNonNull("SessionSourceList"));
            assertNotNull(client.sessionSummary("case-SID"));
            params = JSON.readTree(request().get("Params"));
            assertFalse(params.hasNonNull("AgentName"));
            assertThrows(IllegalArgumentException.class, () -> client.listSessions(false, " "));
            assertThrows(IllegalArgumentException.class, () -> client.sessionSummary("case-SID", "a\nb"));
            assertTrue(requests.isEmpty());
        }
    }

    @Test void errorMetadataSurvivesSdk403RpcRejectionMissingResultAndRedaction() throws Exception {
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient())) {
            status = 403;
            reply = "{\"Code\":\"Forbidden\",\"Message\":\"denied LTAIsecret123\",\"RequestId\":\"pop-403\",\"Extra\":\"must-not-leak\"}";
            var forbidden = assertThrows(Normalize.DasApiException.class, () -> client.deleteSession("s")).apiError();
            assertEquals("pop-403", forbidden.requestId());
            assertEquals(403, forbidden.upstreamStatus());
            assertFalse(forbidden.message().contains("LTAIsecret123"));
            assertFalse(forbidden.message().contains("must-not-leak"));
            assertEquals("DeleteAgentSession", request().get("action"));
            status = 200;
            for (String rpc : List.of("{\"Error\":{\"Code\":403,\"Message\":\"denied LTAIsecret123\"}}", "{}")) {
                reply = "{\"RequestId\":\"pop-200\",\"JsonRpcResponse\":" + rpc + "}";
                var error = assertThrows(Normalize.DasApiException.class, () -> client.renameSession("s", "t")).apiError();
                assertEquals("pop-200", error.toMap().get("requestId"));
                assertFalse(error.message().contains("LTAIsecret123"));
                request();
            }
            reply = "{\"RequestId\":\"empty-create\",\"JsonRpcResponse\":{\"Result\":{}}}";
            assertEquals("empty-create", assertThrows(Normalize.DasApiException.class,
                () -> client.createSession("yolo")).apiError().requestId());
            request();
            headerRequestId = "header-only";
            reply = "{}";
            assertEquals("header-only", assertThrows(Normalize.DasApiException.class,
                () -> client.renameSession("s", "t")).apiError().requestId());
            request();
            headerRequestId = null;
            for (Object invalid : List.of("", " ", "bad\nID", "x".repeat(257), 123, Map.of("id", "fake"))) {
                reply = JSON.writeValueAsString(Map.of("RequestId", invalid, "JsonRpcResponse", Map.of()));
                assertFalse(assertThrows(Normalize.DasApiException.class,
                    () -> client.deleteSession("s")).apiError().toMap().containsKey("requestId"));
                request();
            }
            reply = "{\"JsonRpcResponse\":{\"Result\":{\"requestId\":\"business-id\"}}}";
            assertFalse(client.cancel("s").containsKey("requestId"));
            request();
            assertTrue(requests.isEmpty(), "Error metadata must not introduce retries");
        }
    }

    private org.springframework.test.web.servlet.MockMvc routes(LiveClient client) {
        return org.springframework.test.web.servlet.setup.MockMvcBuilders.standaloneSetup(
            new com.das.java.daemon.DaemonController(cfg(), new LiveClientHolder(client), new com.das.java.web.Inflight())).build();
    }

    @Test void daemonCreateAndLoadWireErrorsCarryOnlyPopMetadata() throws Exception {
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient(), sdkClient())) {
            var mvc = routes(client);
            reply = "{\"RequestId\":\"create-pop\",\"JsonRpcResponse\":{\"Error\":{\"Message\":\"denied\"}}}";
            mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/d/standalone/sessions")
                .contentType("application/json").content("{}"))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isBadGateway())
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath("$.requestId").value("create-pop"))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath("$.error").isString());
            request();
            streaming = true;
            for (boolean header : new boolean[]{true, false}) {
                headerRequestId = header ? "load-header" : null;
                // An ACP error's RequestId is the turn rid, never a POP ID.
                reply = "data: {\"RequestId\":\"turn-rid\",\"Error\":{\"code\":403,\"message\":\"denied\"}}\n\n";
                var result = mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/d/standalone/sessions/s/load"))
                    .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isBadGateway()).andReturn();
                var body = JSON.readTree(result.getResponse().getContentAsString());
                if (header) assertEquals("load-header", body.path("requestId").asText());
                else assertFalse(body.has("requestId"));
                assertTrue(body.path("error").isTextual());
                request();
            }
            headerRequestId = null;
            reply = "data: {\"RequestId\":\"load-ack\"}\n\ndata: {\"Error\":{\"message\":\"denied\"}}\n\n";
            mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/d/standalone/sessions/s/load"))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath("$.requestId").value("load-ack"));
            request();
            assertTrue(requests.isEmpty());
        }
    }

    @Test void ndjsonWireCarriesHeaderOrAckForErrorAndEofWithoutUsingTurnOrPermissionIds() throws Exception {
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient(), sdkClient())) {
            var controller = new com.das.java.web.PromptApiController(cfg(), new LiveClientHolder(client), new com.das.java.web.Inflight());
            streaming = true;
            for (String source : List.of("header", "ack", "none")) for (boolean error : new boolean[]{true, false}) {
                headerRequestId = "header".equals(source) ? "prompt-header" : null;
                reply = ("ack".equals(source) ? "data: {\"RequestId\":\"prompt-ack\"}\n\n" : "")
                    + (error ? "data: {\"RequestId\":\"turn-rid\",\"Error\":{\"message\":\"denied LTAIsecret123\"}}\n\n"
                    : "data: {\"RequestId\":\"turn-rid\",\"Id\":\"event-id\",\"Method\":\"_qwen/notify\",\"Params\":{\"kind\":\"permission_request\",\"data\":{\"requestId\":\"permission-id\"}}}\n\n");
                var response = new org.springframework.mock.web.MockHttpServletResponse();
                controller.prompt("s", Map.of("text", "question"), response);
                var events = response.getContentAsString().lines().map(line -> {
                    try { return JSON.readTree(line); } catch (Exception e) { throw new RuntimeException(e); }
                }).toList();
                var failure = events.stream().filter(event -> "error".equals(event.path("type").asText())).findFirst().orElseThrow().path("error");
                if ("none".equals(source)) assertFalse(failure.has("requestId"));
                else assertEquals("header".equals(source) ? "prompt-header" : "prompt-ack", failure.path("requestId").asText());
                assertFalse(failure.path("message").asText().contains("LTAIsecret123"));
                assertFalse(events.stream().anyMatch(event -> "done".equals(event.path("type").asText())));
                assertEquals("PromptAgentSession", request().get("action"));
                assertTrue(requests.isEmpty(), "No re-prompt, cancel or load without positioned frames");
            }
        }
    }


    @Test void generatedSseParseFailureBeforeFirstFrameKeepsHeaderWithoutUsingRid() throws Exception {
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient(), sdkClient())) {
            streaming = true; headerRequestId = "parse-pop"; reply = "data: not-json\n\n";
            var controller = new com.das.java.web.PromptApiController(cfg(), new LiveClientHolder(client), new com.das.java.web.Inflight());
            var response = new org.springframework.mock.web.MockHttpServletResponse();
            org.junit.jupiter.api.Assertions.assertTimeoutPreemptively(Duration.ofSeconds(10), () ->
                controller.prompt("s", Map.of("text", "synthetic"), response));
            var events = response.getContentAsString().lines().map(line -> {
                try { return JSON.readTree(line); } catch (Exception e) { throw new RuntimeException(e); }
            }).toList();
            var error = events.stream().filter(event -> "error".equals(event.path("type").asText())).findFirst().orElseThrow().path("error");
            assertEquals("parse-pop", error.path("requestId").asText());
            assertFalse(events.stream().anyMatch(event -> "done".equals(event.path("type").asText())));
            assertEquals("PromptAgentSession", request().get("action"));
            assertTrue(requests.isEmpty());
        }
    }

    @Test void eventsNonSuccessIsSafePrecommitJsonWithHeaderOrBodyRequestId() throws Exception {
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient(), sdkClient())) {
            var controller = new com.das.java.daemon.DaemonController(cfg(), new LiveClientHolder(client), new com.das.java.web.Inflight());
            for (boolean header : new boolean[]{true, false}) {
                status = 403; headerRequestId = header ? "header-pop" : null;
                reply = "{\"RequestId\":\"body-pop\",\"Message\":\"private SDK dump\",\"credentials\":\"private-secret\"}";
                var response = new org.springframework.mock.web.MockHttpServletResponse();
                controller.events("s", null, null, response);
                assertEquals(502, response.getStatus());
                assertEquals(header ? "header-pop" : "body-pop", JSON.readTree(response.getContentAsString()).path("requestId").asText());
                assertFalse(response.getContentAsString().contains("private"));
                assertEquals("GetAgentSessionEvents", request().get("action"));
                assertTrue(requests.isEmpty());
            }
        }
    }

    @Test void sseHeaderBeatsDifferentAckAndTruncatedPayloadStillCarriesIt() throws Exception {
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient(), sdkClient())) {
            streaming = true; headerRequestId = "header-pop";
            reply = "data: {\"RequestId\":\"ack-pop\"}\n\ndata: {\"RequestId\":\"turn-rid\",\"Error\":{\"message\":\"denied\"}}\n\n";
            var controller = new com.das.java.web.PromptApiController(cfg(), new LiveClientHolder(client), new com.das.java.web.Inflight());
            var response = new org.springframework.mock.web.MockHttpServletResponse();
            controller.prompt("s", Map.of("text", "synthetic"), response);
            assertTrue(response.getContentAsString().contains("\"requestId\":\"header-pop\""));
            assertFalse(response.getContentAsString().contains("\"requestId\":\"ack-pop\""));
            request();
            reply = "data: {\"RequestId\":\"turn-rid\",\"Params\":{}}\n\ndata: {";
            response = new org.springframework.mock.web.MockHttpServletResponse();
            controller.prompt("s", Map.of("text", "synthetic"), response);
            assertTrue(response.getContentAsString().contains("\"requestId\":\"header-pop\""));
            assertFalse(response.getContentAsString().contains("\"type\":\"done\""));
            request(); assertTrue(requests.isEmpty());
        }
    }

    @Test void sdkHttp403DoesNotInventIdWhenSdkDropsHeaderOnlyMetadata() throws Exception {
        status = 403; headerRequestId = "header-403";
        reply = "{\"Code\":\"Forbidden\",\"Message\":\"denied\"}";
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient(), sdkClient())) {
            var error = assertThrows(Normalize.DasApiException.class, () -> client.deleteSession("s")).apiError();
            assertNull(error.requestId(), "Pinned SDK does not expose header-only metadata on ordinary HTTP failures");
            request();
            error = assertThrows(Normalize.DasApiException.class, () -> client.createSession("yolo")).apiError();
            assertNull(error.requestId(), "Pinned SDK does not expose header-only metadata on ordinary HTTP failures");
            request();
            error = assertThrows(Normalize.DasApiException.class, () -> client.reply("s",
                Map.of("permissionRequestId", "card-id", "outcome", "cancelled"))).apiError();
            assertNull(error.requestId(), "Pinned SDK does not expose header-only metadata on ordinary HTTP failures");
            request(); assertTrue(requests.isEmpty());
        }
    }

    @Test void generatedSseHttp403KeepsStandardSdkIdWithoutLeakingIntoNextRpc() throws Exception {
        try (LiveClient client = new LiveClient(cfg(), adapter, sdkClient(), sdkClient())) {
            status = 403; headerRequestId = null;
            reply = "{\"Code\":\"Forbidden\",\"Message\":\"denied\",\"RequestId\":\"sdk-body-403\"}";
            var failure = assertThrows(Normalize.DasApiException.class, () -> client.loadFrames("s"));
            assertEquals("sdk-body-403", failure.apiError().requestId());
            request(); assertTrue(requests.isEmpty(), "Load business rejection must not retry");
            var controller = new com.das.java.web.PromptApiController(cfg(), new LiveClientHolder(client), new com.das.java.web.Inflight());
            var response = new org.springframework.mock.web.MockHttpServletResponse();
            controller.prompt("s", Map.of("text", "synthetic"), response);
            assertTrue(response.getContentAsString().contains("\"requestId\":\"sdk-body-403\""));
            request(); assertTrue(requests.isEmpty());
            reply = "{\"Code\":\"Forbidden\",\"Message\":\"denied\"}";
            response = new org.springframework.mock.web.MockHttpServletResponse();
            controller.prompt("s", Map.of("text", "synthetic"), response);
            var lines = response.getContentAsString().lines().map(line -> {
                try { return JSON.readTree(line); } catch (Exception e) { throw new RuntimeException(e); }
            }).toList();
            assertFalse(lines.stream().filter(event -> "error".equals(event.path("type").asText()))
                .findFirst().orElseThrow().path("error").has("requestId"));
            request(); assertTrue(requests.isEmpty());
        }
    }
}
