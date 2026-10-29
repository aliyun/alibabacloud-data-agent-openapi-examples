package com.das.java.live;

import com.aliyun.auth.credentials.Credential;
import com.aliyun.auth.credentials.provider.StaticCredentialProvider;
import com.aliyun.sdk.gateway.pop.Configuration;
import com.aliyun.sdk.gateway.pop.auth.SignatureAlgorithm;
import com.aliyun.sdk.gateway.pop.auth.SignatureVersion;
import com.aliyun.sdk.service.dataworks_public20240518.AsyncClient;
import com.aliyun.sdk.service.dataworks_public20240518.DefaultAsyncClientBuilder;
import com.aliyun.sdk.service.dataworks_public20240518.models.CreateAgentSessionRequest;
import com.aliyun.sdk.service.dataworks_public20240518.models.GetAgentSessionTokenUsageRequest;
import com.aliyun.sdk.service.dataworks_public20240518.models.GetAgentSessionTokenUsageResponse;
import com.aliyun.sdk.service.dataworks_public20240518.models.ListAgentSessionArtifactsRequest;
import com.aliyun.sdk.service.dataworks_public20240518.models.ListAgentSessionArtifactsResponse;
import com.aliyun.sdk.service.dataworks_public20240518.models.ListAgentSessionsRequest;
import com.aliyun.sdk.service.dataworks_public20240518.models.ListAgentsRequest;
import com.aliyun.sdk.service.dataworks_public20240518.models.ListAgentsResponse;
import com.aliyun.sdk.service.dataworks_public20240518.models.LoadAgentSessionRequest;
import com.aliyun.sdk.service.dataworks_public20240518.models.PromptAgentSessionRequest;
import com.aliyun.sdk.service.dataworks_public20240518.models.ReplyAgentSessionRequest;
import com.aliyun.sdk.service.dataworks_public20240518.models.ReplyAgentSessionResponse;
import com.aliyun.sdk.service.dataworks_public20240518.models.ReplyAgentSessionResponseBody;
import com.aliyun.sdk.service.dataworks_public20240518.models.UpdateAgentSessionTitleRequest;
import com.das.java.config.AppConfig;
import com.das.java.config.SessionOptions;
import com.das.java.core.ApiError;
import com.das.java.core.Constants;
import com.das.java.core.Frames;
import com.das.java.live.Normalize.DasApiException;
import com.fasterxml.jackson.databind.ObjectMapper;
import darabonba.core.ResponseIterable;
import darabonba.core.TeaModel;
import darabonba.core.client.ClientOverrideConfiguration;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 真实上游调用。**所有 LIVE 路径都在这里，一处也不散到路由里**——
 * 路由只负责"mock 还是 live"的分派与 HTTP 语义。
 * 与 Node 实现的 server-node/live.ts、Python 实现的 live.py 同源同语义。
 *
 * Official SDK transport and signing. PopAdapter supplies explicit wire fields for
 * lifecycle actions and response fields still missing from SDK 9.0.17. GetAgentSessionEvents
 * uses a signed GET and raw reactive byte transport; prompt/load keep generated SSE methods.
 *
 * 重试语义：SDK 默认不装配 RetryPolicy ⇒ 只发一次，与旧 runtimeFor 的
 * autoretry=false、prompt 绝不重试一致。
 *
 * Generated REST/SSE clients plus a generic POP adapter. Non-stream calls have a 600s timeout;
 * SSE 流上不能有这种超时（RUNNING 期 load 实测阻塞过 178s，中途静默期更长），
 * 停滞保护由消费端 next(timeoutMs) 逐次执行。
 */
public final class LiveClient implements AutoCloseable {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String JSONRPC_VERSION = "2.0";
    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);
    /** 列表分页的硬上限。上游没承诺页数收敛，不设上限等于把死循环留给线上。 */
    private static final int MAX_PAGES = 10;
    private static final int PAGE_SIZE = 100;

    private final AsyncClient rest;
    private final AsyncClient sse;
    private final AppConfig cfg;
    private final PopAdapter pop;
    private final AtomicLong rpcIdCounter = new AtomicLong();

    /** 构造失败让进程直接起不来——带病启动比启动失败难查得多。 */
    public LiveClient(AppConfig cfg) { this(cfg, PopAdapter.create(cfg)); }

    LiveClient(AppConfig cfg, PopAdapter pop) {
        this(cfg, pop, buildClient(cfg, Duration.ofMillis(Constants.DEFAULT_READ_TIMEOUT_MS)));
    }

    LiveClient(AppConfig cfg, PopAdapter pop, AsyncClient rest) {
        this(cfg, pop, rest, buildClient(cfg, null));
    }

    LiveClient(AppConfig cfg, PopAdapter pop, AsyncClient rest, AsyncClient sse) {
        this.cfg = cfg;
        this.pop = pop;
        this.rest = rest;
        this.sse = sse;
    }

    /**
     * 留空 endpoint 时 SDK 按 regionId 走内置映射（regional 规则，与旧默认一致）；
     * 非空直接当 host，覆盖映射（预发/日常网关靠它）。
     *
     * 签名必须显式 V3(ACS3)：SDK 默认 V1,而 SSE 请求强制走"内容哈希 + canonical
     * headers"的签名分支,V1 signer 的 getContent()/hash() 恒返回 null——V1 + SSE
     * 会在签名组装处 NPE(9.0.9 实测,PopV1Signer.getContent()=null)。
     * V3 对非流式接口同样合法,没必要为它拆两条配置。
     */
    private static AsyncClient buildClient(AppConfig cfg, Duration responseTimeout) {
        ClientOverrideConfiguration override = ClientOverrideConfiguration.create()
            .setConnectTimeout(CONNECT_TIMEOUT);
        if (responseTimeout != null) {
            override.setResponseTimeout(responseTimeout);
        }
        if (cfg.endpoint() != null) {
            override.setEndpointOverride(cfg.endpoint());
        }
        return new DefaultAsyncClientBuilder()
            .credentialsProvider(StaticCredentialProvider.create(
                Credential.builder()
                    .accessKeyId(cfg.accessKeyId())
                    .accessKeySecret(cfg.accessKeySecret())
                    .securityToken(cfg.securityToken())
                    .build()))
            .region(cfg.regionId())
            .overrideConfiguration(override)
            .serviceConfiguration(Configuration.create()
                .setSignatureVersion(SignatureVersion.V3)
                .setSignatureAlgorithmV3(SignatureAlgorithm.ACS3_HMAC_SHA256))
            .build();
    }

    /** 进程退出时关掉两个 client（netty 线程池）；MOCK 模式根本不会构造到这一步。 */
    @Override
    public void close() {
        pop.close();
        rest.close();
        sse.close();
    }

    private String nextRpcId() {
        // 上游要求 Id 存在；它是 JSON-RPC 的请求标识，与 RequestId（rid）不是一回事。
        return String.valueOf(rpcIdCounter.incrementAndGet());
    }

    /** join 出来的异常总被 CompletionException 包一层：先剥掉再归一化。 */
    private static Throwable unwrap(Throwable t) {
        while ((t instanceof CompletionException || t instanceof ExecutionException) && t.getCause() != null) {
            t = t.getCause();
        }
        return t;
    }

    private static <T> T join(CompletableFuture<T> future) throws Exception {
        try {
            return future.join();
        } catch (CompletionException e) {
            Throwable cause = unwrap(e);
            if (cause instanceof Exception ex) throw ex;
            throw e;
        }
    }

    private static DasApiException toDas(Throwable e, String api) {
        return new DasApiException(Normalize.toApiError(unwrap(e), api));
    }

    public AppConfig cfg() {
        return cfg;
    }

    // ------------------------------------------------------------------
    // ListAgents（自检用，不对外暴露路由：价值是验证网络 + AK/SK + 签名）
    // ------------------------------------------------------------------

    public Map<String, Object> listAgents() throws Exception {
        String api = "ListAgents";
        try {
            ListAgentsResponse resp = join(rest.listAgents(
                ListAgentsRequest.builder()
                    .id(nextRpcId())
                    .jsonrpc(JSONRPC_VERSION)
                    .params(ListAgentsRequest.Params.builder().maxResults(PAGE_SIZE).build())
                    .build()));
            var body = resp.getBody();
            var rpc = body == null ? null : body.getJsonRpcResponse();
            var result = rpc == null ? null : rpc.getResult();
            if (result == null) throw new DasApiException(Normalize.missingResultError(api, resp.getStatusCode(), responseRequestId(body == null ? null : body.getRequestId(), resp.getHeaders())));
            List<String> agents = new ArrayList<>();
            if (result.getAgents() != null) {
                for (var row : result.getAgents()) {
                    if (row.getAgentName() != null && !row.getAgentName().isEmpty()) agents.add(row.getAgentName());
                }
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("agents", agents);
            out.put("totalCount", result.getTotalCount());
            String responseId = responseRequestId(body.getRequestId(), resp.getHeaders());
            if (responseId != null) out.put("requestId", responseId);
            return out;
        } catch (DasApiException e) {
            throw e;
        } catch (Exception e) {
            throw toDas(e, api);
        }
    }

    // ------------------------------------------------------------------
    // sessions
    // ------------------------------------------------------------------

    /** 建会话。成功判据只有 SessionId 非空（HTTP 200 + 有 Result 但 SessionId 为空仍是失败）。 */
    public Map<String, Object> createSession(String mode) throws Exception {
        return createSessionWithOptions(SessionOptions.resolve(cfg, mode == null ? null : Map.of("approvalMode", mode)));
    }

    public Map<String, Object> createSessionWithOptions(SessionOptions options) throws Exception {
        Map<String, Object> result = callResponse("CreateAgentSession", rest.createAgentSession(buildCreateSessionRequest(options))
            .thenApply(response -> sdkOutput(response.getStatusCode(), response.getBody(), response.getHeaders())));
        Object sessionId = result.get("SessionId");
        if (!(sessionId instanceof String id) || id.isBlank())
            throw new DasApiException(ApiError.createEmptyBody("CreateAgentSession returned no SessionId").withRequestId(result.get("requestId")));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sessionId", sessionId);
        if (result.get("requestId") != null) out.put("requestId", result.get("requestId"));
        return out;
    }

    public Map<String, Object> renameSession(String id, String title) throws Exception {
        return callResponse("UpdateAgentSessionTitle", rest.updateAgentSessionTitle(UpdateAgentSessionTitleRequest.builder()
            .id(nextRpcId()).jsonrpc(JSONRPC_VERSION)
            .params(UpdateAgentSessionTitleRequest.Params.builder().sessionId(id).title(title).build()).build())
            .thenApply(response -> sdkOutput(response.getStatusCode(), response.getBody(), response.getHeaders())));
    }

    public Map<String, Object> archiveSession(String id, boolean archived) throws Exception {
        return callPop("ArchiveAgentSession", Map.of("SessionId", id, "Archived", archived));
    }

    public Map<String, Object> deleteSession(String id) throws Exception {
        return callPop("DeleteAgentSession", Map.of("SessionId", id));
    }

    public RemoteEventStream events(String id, String cursor) { return pop.events(id, cursor); }

    private static String responseRequestId(Object bodyId, Map<String, String> headers) {
        String id = ApiError.validRequestId(bodyId);
        return id != null ? id : Normalize.headerRequestId(headers);
    }

    private static PopAdapter.Output sdkOutput(Integer status, TeaModel body, Map<String, String> headers) {
        PopAdapter.Output output = new PopAdapter.Output();
        output.statusCode = status;
        output.headers = headers;
        output.body = body == null ? null : body.toMap();
        return output;
    }

    private Map<String, Object> callPop(String api, Map<String, Object> params) throws Exception {
        return callResponse(api, pop.call(api, nextRpcId(), params));
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> callResponse(String api, CompletableFuture<PopAdapter.Output> response) throws Exception {
        try {
            PopAdapter.Output output = join(response);
            Map<String, Object> body = output.body;
            String requestId = body == null ? null : ApiError.validRequestId(body.get("RequestId"));
            if (requestId == null) requestId = Normalize.headerRequestId(output.headers);
            Object rpcValue = body == null ? null : body.get("JsonRpcResponse");
            Map<?, ?> rpc = rpcValue instanceof Map<?, ?> map ? map : Map.of();
            if (rpc.get("Error") instanceof Map<?, ?> error) {
                Integer code = error.get("Code") instanceof Number number ? number.intValue() : null;
                String errorCode = error.get("ErrorCode") instanceof String text ? text : null;
                String message = error.get("Message") instanceof String text ? text : "Upstream JSON-RPC request failed";
                message = initialConfigMessage(error, errorCode, message);
                throw new DasApiException(ApiError.redact(ApiError.classify(api + ": " + message
                    + (requestId == null ? "" : " | requestId=" + requestId), code, errorCode, output.statusCode).withRequestId(requestId)));
            }
            if (!(rpc.get("Result") instanceof Map<?, ?> result)) {
                throw new DasApiException(ApiError.apiError("rpc_error", api + " returned no JsonRpcResponse.Result"
                    + (requestId == null ? "" : " | requestId=" + requestId)).withRequestId(requestId));
            }
            Map<String, Object> out = new LinkedHashMap<>((Map<String, Object>) result);
            out.remove("requestId"); // A Result field is not POP response metadata.
            if (requestId != null) out.put("requestId", requestId);
            return out;
        } catch (DasApiException e) { throw e; }
        catch (Exception e) { throw toDas(e, api); }
    }

    /** Expose only this error's closed reason vocabulary, never arbitrary upstream diagnostics. */
    private static String initialConfigMessage(Map<?, ?> error, String errorCode, String message) {
        if (!"INVALID_SESSION_INITIAL_CONFIG".equals(errorCode) && !"INVALID_SESSION_INITIAL_CONFIG".equals(message)) return message;
        Object data = error.get("Data");
        if (!(data instanceof Map<?, ?>)) data = error.get("data");
        if (data instanceof Map<?, ?> diagnostics && diagnostics.get("reason") instanceof String reason) {
            switch (reason) {
                case "capabilities_unavailable", "ambiguous_model", "model_not_available", "reasoning_not_available":
                    return message + " (reason=" + reason + ")";
                default:
                    break;
            }
        }
        return message;
    }

    /** 9.0.17 models all initial options used by the workbench. */
    CreateAgentSessionRequest buildCreateSessionRequest(SessionOptions options) {
        var initial = CreateAgentSessionRequest.InitialConfigOptions.builder()
            .mode(options.approvalMode()).model(options.model()).reasoningEffort(options.reasoningEffort())
            .resourceGroupId(cfg.resourceGroupId()).projectId(cfg.projectId()).build();
        var meta = CreateAgentSessionRequest.Meta.builder()
            .agent(CreateAgentSessionRequest.Agent.builder().agentName(options.agentName() != null ? options.agentName() : cfg.agentName()).build())
            .config(CreateAgentSessionRequest.Config.builder().sessionSource(cfg.sessionSource())
                .sessionTags(List.of(CreateAgentSessionRequest.SessionTags.builder().sessionTagCode(cfg.sessionSource()).build())).build())
            .initialConfigOptions(initial).build();
        return CreateAgentSessionRequest.builder().id(nextRpcId()).jsonrpc(JSONRPC_VERSION)
            .params(CreateAgentSessionRequest.Params.builder().meta(meta).build()).build();
    }

    public Map<String, Object> listSessions() throws Exception { return listSessions(false); }

    public Map<String, Object> listSessions(boolean archived) throws Exception { return listSessions(archived, null); }

    public Map<String, Object> listSessions(boolean archived, String agentName) throws Exception {
        return listSessions(archived, null, SessionOptions.validateAgentName(agentName));
    }

    public Map<String, Object> sessionSummary(String sessionId) throws Exception { return sessionSummary(sessionId, null); }

    @SuppressWarnings("unchecked")
    public Map<String, Object> sessionSummary(String sessionId, String agentName) throws Exception {
        agentName = SessionOptions.validateAgentName(agentName);
        for (boolean archived : new boolean[]{false, true}) {
            var result = listSessions(archived, sessionId, agentName);
            for (var row : (List<Map<String, Object>>)result.get("sessions"))
                if (sessionId.equals(row.get("sessionId"))) return row;
        }
        return null;
    }

    private Map<String, Object> listSessions(boolean archived, String sessionId, String agentName) throws Exception {
        List<Map<String, Object>> collected = new ArrayList<>();
        String next = null;
        int total = 0;
        boolean truncated = false;
        for (int page = 0; page < MAX_PAGES; page++) {
            var params = ListAgentSessionsRequest.Params.builder().maxResults(PAGE_SIZE).archived(archived).nextToken(next);
            if (sessionId == null) params.agentName(agentName != null ? agentName : cfg.agentName()).sessionSourceList(List.of(cfg.sessionSource()));
            else {
                params.sessionId(sessionId);
                if (agentName != null) params.agentName(agentName);
            }

            Map<String, Object> result = callResponse("ListAgentSessions", rest.listAgentSessions(ListAgentSessionsRequest.builder()
                .id(nextRpcId()).jsonrpc(JSONRPC_VERSION).params(params.build()).build())
                .thenApply(response -> sdkOutput(response.getStatusCode(), response.getBody(), response.getHeaders())));
            if (result.get("TotalCount") instanceof Number number) total = number.intValue();
            if (result.get("AgentSessions") instanceof List<?> rows) for (Object raw : rows) {
                if (!(raw instanceof Map<?, ?> row) || !(row.get("SessionId") instanceof String id) || id.isBlank()) continue;
                Map<?, ?> meta = row.get("Meta") instanceof Map<?, ?> map ? map : Map.of();
                List<String> tags = new ArrayList<>();
                if (meta.get("SessionTagList") instanceof List<?> values) for (Object value : values) {
                    if (value instanceof Map<?, ?> tag && tag.get("SessionTagCode") instanceof String code) tags.add(code);
                }
                Map<String, Object> summary = new LinkedHashMap<>();
                summary.put("sessionId", id);
                Object title = row.get("SessionTitle");
                summary.put("title", title instanceof String text && !text.isEmpty() ? text : row.get("SessionDescription"));
                Object created = row.get("SessionCreatedAt") == null ? 0L : row.get("SessionCreatedAt");
                summary.put("createdAt", created);
                summary.put("updatedAt", row.get("SessionUpdatedAt") == null ? created : row.get("SessionUpdatedAt"));
                summary.put("status", meta.get("SessionStatus") == null ? "UNKNOWN" : meta.get("SessionStatus"));
                summary.put("source", meta.get("SessionSource"));
                summary.put("tags", tags);
                summary.put("archived", Boolean.TRUE.equals(meta.get("Archived")));
                collected.add(summary);
            }
            next = result.get("NextToken") instanceof String text && !text.isEmpty() ? text : null;
            if (next == null) break;
            if (page == MAX_PAGES - 1) truncated = true;
        }
        return Map.of("sessions", collected, "filteredOut", Math.max(0, total - collected.size()),
            "total", total, "truncated", truncated);
    }

    // ------------------------------------------------------------------
    // usage / artifacts / cancel
    // ------------------------------------------------------------------

    public Map<String, Object> usage(String sessionId) throws Exception {
        String api = "GetAgentSessionTokenUsage";
        long started = System.currentTimeMillis();
        try {
            GetAgentSessionTokenUsageResponse resp = join(rest.getAgentSessionTokenUsage(
                GetAgentSessionTokenUsageRequest.builder()
                    .id(nextRpcId())
                    .jsonrpc(JSONRPC_VERSION)
                    .params(GetAgentSessionTokenUsageRequest.Params.builder()
                        .sessionId(sessionId)
                        .build())
                    .build()));
            var body = resp.getBody();
            var rpc = body == null ? null : body.getJsonRpcResponse();
            var result = rpc == null ? null : rpc.getResult();
            if (result == null) {
                throw new DasApiException(Normalize.missingResultError(api, resp.getStatusCode(), responseRequestId(body == null ? null : body.getRequestId(), resp.getHeaders())));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("promptTokens", result.getPromptTokens());
            out.put("completionTokens", result.getCompletionTokens());
            out.put("totalTokens", result.getTotalTokens());
            out.put("cachedTokens", result.getCachedTokens());
            out.put("thoughtsTokens", result.getThoughtsTokens());
            out.put("elapsedMs", System.currentTimeMillis() - started);
            String responseId = responseRequestId(body.getRequestId(), resp.getHeaders());
            if (responseId != null) out.put("requestId", responseId);
            return out;
        } catch (DasApiException e) {
            throw e;
        } catch (Exception e) {
            throw toDas(e, api);
        }
    }

    /** artifacts：**原样返回，不做兜底填充**：实测两个 artifact 接口恒返回空数组。 */
    public Map<String, Object> artifacts(String sessionId) throws Exception {
        String api = "ListAgentSessionArtifacts";
        long started = System.currentTimeMillis();
        try {
            ListAgentSessionArtifactsResponse resp = join(rest.listAgentSessionArtifacts(
                ListAgentSessionArtifactsRequest.builder()
                    .id(nextRpcId())
                    .jsonrpc(JSONRPC_VERSION)
                    .params(ListAgentSessionArtifactsRequest.Params.builder()
                        .sessionId(sessionId)
                        .build())
                    .build()));
            var body = resp.getBody();
            var rpc = body == null ? null : body.getJsonRpcResponse();
            var result = rpc == null ? null : rpc.getResult();
            if (result == null) {
                throw new DasApiException(Normalize.missingResultError(api, resp.getStatusCode(), responseRequestId(body == null ? null : body.getRequestId(), resp.getHeaders())));
            }
            List<Object> artifacts = new ArrayList<>();
            if (result.getArtifacts() != null) {
                // 实测恒空；有内容时按声明字段转出（SDK cast 丢弃未声明键的限制与非流式一脉相承）。
                for (var item : result.getArtifacts()) {
                    artifacts.add(MAPPER.convertValue(item, Map.class));
                }
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("artifacts", artifacts);
            out.put("elapsedMs", System.currentTimeMillis() - started);
            return out;
        } catch (DasApiException e) {
            throw e;
        } catch (Exception e) {
            throw toDas(e, api);
        }
    }

    /**
     * cancel。【LIVE 09-18】上游已会真正取消：HTTP 200 + 流以 stopReason=cancelled 收场。
     * delivered = 上游返回成功 JSON-RPC Result；仅 HTTP 200 不足以确认。取消失败时让调用方知道
     * "没取消成"，而不是收到一个 5xx——异常记进 detail 透给前端。
     */
    public Map<String, Object> cancel(String sessionId) throws Exception {
        try {
            Map<String, Object> accepted = callPop("CancelAgentSession", Map.of("SessionId", sessionId));
            Map<String, Object> result = new LinkedHashMap<>();
            boolean noop = Boolean.TRUE.equals(accepted.get("Noop"));
            boolean delivered = Boolean.TRUE.equals(accepted.get("Delivered"));
            // Older deployments acknowledge only the target SID. Never infer delivery
            // or idle state, and never downgrade explicit delivery/no-op fields.
            boolean legacy = !accepted.containsKey("Delivered") && !accepted.containsKey("Noop")
                && sessionId.equals(accepted.get("SessionId"));
            result.put("accepted", delivered || noop || legacy);
            result.put("delivered", delivered);
            if (!legacy) result.put("noop", noop);
            result.put("warning", legacy ? "cancel-accepted-legacy"
                : delivered ? "cancel-accepted" : noop ? "cancel-noop" : "cancel-upstream-error");
            result.put("detail", delivered
                ? "CancelAgentSession accepted the request; execution cancellation is confirmed only by its remote terminal."
                : legacy ? "CancelAgentSession acknowledged the matching session; delivery and execution cancellation are unconfirmed."
                : noop ? "The remote session is idle; cancellation is a no-op."
                : "CancelAgentSession did not confirm Delivered or Noop.");
            if (accepted.get("requestId") != null) result.put("requestId", accepted.get("requestId"));
            return result;
        } catch (Exception error) {
            ApiError failure = Normalize.toApiError(error, "CancelAgentSession");
            Map<String, Object> result = new LinkedHashMap<>(Map.of("accepted", false, "delivered", false,
                "warning", "cancel-upstream-error", "detail", failure.message()));
            if (failure.requestId() != null) result.put("requestId", failure.requestId());
            return result;
        }
    }

    // ------------------------------------------------------------------
    // 人卡回覆（ReplyAgentSession）
    // ------------------------------------------------------------------

    /**
     * 回覆人卡交互。【LIVE 09-17】实测：accepted=true 后原 prompt 流继续，绝不重发 prompt。
     *
     * 与其它非流式调用不同：**ReplyAgentSession 的响应模型声明了 Error 字段**，
     * 业务错误（code/errorCode/message）能穿过 SDK 的 cast 被原样读出。
     */
    public Map<String, Object> reply(String sessionId, Map<String, Object> input) throws Exception {
        String api = "ReplyAgentSession";
        try {
            ReplyAgentSessionRequest.Params.Builder params = ReplyAgentSessionRequest.Params.builder()
                .sessionId(sessionId)
                .permissionRequestId((String) input.get("permissionRequestId"));
            Object answers = input.get("answers");
            if (answers instanceof Map<?, ?> map && !map.isEmpty()) {
                Map<String, String> typed = new LinkedHashMap<>();
                for (Map.Entry<?, ?> e : map.entrySet()) typed.put(String.valueOf(e.getKey()), (String) e.getValue());
                params.answers(typed);
            }
            ReplyAgentSessionRequest.Outcome.Builder outcome = ReplyAgentSessionRequest.Outcome.builder()
                .outcome((String) input.get("outcome"));
            if (input.get("optionId") != null) outcome.optionId((String) input.get("optionId"));
            params.outcome(outcome.build());

            ReplyAgentSessionResponse resp = join(rest.replyAgentSession(
                ReplyAgentSessionRequest.builder()
                    .id(nextRpcId())
                    .jsonrpc(JSONRPC_VERSION)
                    .params(params.build())
                    .build()));

            ReplyAgentSessionResponseBody body = resp.getBody();
            var rpc = body == null ? null : body.getJsonRpcResponse();
            String requestId = responseRequestId(body == null ? null : body.getRequestId(), resp.getHeaders());
            if (rpc != null && rpc.getError() != null) {
                var error = rpc.getError();
                throw new DasApiException(ApiError.redact(ApiError.apiError("rpc_error",
                    api + " 被上游拒绝：" + (error.getMessage() != null ? error.getMessage() : "无 message")
                        + (error.getErrorCode() != null ? " [" + error.getErrorCode() + "]" : "")
                        + (error.getCode() != null ? " (code=" + error.getCode() + ")" : "")
                        + (requestId != null ? "，RequestId " + requestId : "")).withRequestId(requestId)));
            }
            if (rpc == null || rpc.getResult() == null || rpc.getResult().getAccepted() == null) {
                throw new DasApiException(ApiError.redact(ApiError.apiError("rpc_error",
                    api + " 返回 HTTP 200 但没有 JsonRpcResponse.Result.accepted"
                        + (requestId != null ? "（RequestId " + requestId + "）" : "")).withRequestId(requestId)));
            }
            boolean accepted = rpc.getResult().getAccepted();
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("accepted", accepted);
            if (requestId != null) out.put("requestId", requestId);
            out.put("detail", accepted
                ? "上游已接受回覆。后续执行事件从原 PromptAgentSession 流上继续收，不要重发 prompt。"
                : "上游明确返回 accepted=false：回覆未被采纳（requestId 可能已过期或已被他人回覆）。");
            return out;
        } catch (DasApiException e) {
            throw e;
        } catch (Exception e) {
            throw toDas(e, api);
        }
    }

    // ------------------------------------------------------------------
    // 历史（LoadAgentSession · 官方 SSE）
    // ------------------------------------------------------------------

    /** 历史快照总预算30秒，最多3次只读拉取；完整Load回执前不返回半份历史。 */
    public List<Map<String, Object>> loadFrames(String sessionId) throws Exception {
        return LoadSnapshotReader.read(remainingMs -> openLoadStream(sessionId, null),
            Constants.HISTORY_READ_TIMEOUT_MS, 3, 250);
    }

    /** SSE data 载荷 → 线格式帧（live 路径拒收 POP-only 载荷；帧的其它处理与 Node/Python 同源）。 */
    private static Map<String, Object> frameFromData(String data) {
        Object parsed;
        try {
            parsed = MAPPER.readValue(data, Object.class);
        } catch (Exception e) {
            return null;
        }
        return Frames.frameFromSdkBody(parsed);
    }

    /**
     * 发一轮 prompt，返回**线格式帧**的阻塞式拉取句柄。
     * 帧到达顺序即上游顺序；POP 回执的 RequestId 填进 acks（零帧场景唯一可查的线索）。
     * 抛出的异常不在这里吞，交给流管道归一化。
     */
    public RecoveringPromptStream openPromptStream(String sessionId, String outboundText, List<String> acks) throws Exception {
        String api = "PromptAgentSession";
        String promptId = java.util.UUID.randomUUID().toString();
        try {
            ResponseIterable<com.aliyun.sdk.service.dataworks_public20240518.models.PromptAgentSessionResponseBody> iterable =
                sse.promptAgentSessionWithResponseIterable(
                    PromptAgentSessionRequest.builder()
                        .id(promptId)
                        .jsonrpc(JSONRPC_VERSION)
                        .params(PromptAgentSessionRequest.Params.builder()
                            .sessionId(sessionId)
                            .prompt(List.of(PromptAgentSessionRequest.Prompt.builder()
                                .type("text")
                                .text(outboundText)
                                .build()))
                            .build())
                        .build());
            return new RecoveringPromptStream(promptId,
                RecoveringPromptStream.wrap(new SdkSseStream(api, iterable.iterator(), iterable::getStatusCode, iterable::getHeaders)),
                (offset, remainingMs) -> openLoadStream(sessionId, offset));
        } catch (Exception e) {
            throw toDas(e, api);
        }
    }
    /** 在途 Load 必须流式消费；调用方用剩余恢复预算限制每次 next。 */
    private RecoveringPromptStream.Source openLoadStream(String sessionId, Long offset) throws Exception {
        String loadId = nextRpcId();
        var iterable = sse.loadAgentSessionWithResponseIterable(LoadAgentSessionRequest.builder()
            .id(loadId).jsonrpc(JSONRPC_VERSION)
            .params(LoadAgentSessionRequest.Params.builder().sessionId(sessionId)
                .meta(LoadAgentSessionRequest.Meta.builder().isReload(true).beginLogOffset(offset).build())
                .build()).build());
        return RecoveringPromptStream.wrap(new SdkSseStream("LoadAgentSession", iterable.iterator(), iterable::getStatusCode, iterable::getHeaders), loadId);
    }

}
