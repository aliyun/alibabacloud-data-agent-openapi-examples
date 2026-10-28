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

}
