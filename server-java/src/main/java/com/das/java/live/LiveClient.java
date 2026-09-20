package com.das.java.live;

import com.aliyun.dataworks_public20240518.Client;
import com.aliyun.dataworks_public20240518.models.CancelAgentSessionRequest;
import com.aliyun.dataworks_public20240518.models.CancelAgentSessionResponse;
import com.aliyun.dataworks_public20240518.models.CreateAgentSessionRequest;
import com.aliyun.dataworks_public20240518.models.CreateAgentSessionResponse;
import com.aliyun.dataworks_public20240518.models.GetAgentSessionTokenUsageRequest;
import com.aliyun.dataworks_public20240518.models.GetAgentSessionTokenUsageResponse;
import com.aliyun.dataworks_public20240518.models.ListAgentSessionArtifactsRequest;
import com.aliyun.dataworks_public20240518.models.ListAgentSessionArtifactsResponse;
import com.aliyun.dataworks_public20240518.models.ListAgentSessionsRequest;
import com.aliyun.dataworks_public20240518.models.ListAgentSessionsResponse;
import com.aliyun.dataworks_public20240518.models.ListAgentSessionsResponseBody;
import com.aliyun.dataworks_public20240518.models.ListAgentsRequest;
import com.aliyun.dataworks_public20240518.models.ListAgentsResponse;
import com.aliyun.dataworks_public20240518.models.ReplyAgentSessionRequest;
import com.aliyun.dataworks_public20240518.models.ReplyAgentSessionResponse;
import com.aliyun.dataworks_public20240518.models.ReplyAgentSessionResponseBody;
import com.aliyun.teaopenapi.models.Config;
import com.aliyun.teautil.models.RuntimeOptions;
import com.das.java.config.AppConfig;
import com.das.java.core.ApiError;
import com.das.java.core.Constants;
import com.das.java.core.Frames;
import com.das.java.live.Normalize.DasApiException;
import com.das.java.sse.SseFetcher;
import com.das.java.sse.SseFetcher.SseException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 真实上游调用。**所有 LIVE 路径都在这里，一处也不散到路由里**——
 * 路由只负责"mock 还是 live"的分派与 HTTP 语义。
 * 与 Node 实现的 server-node/live.ts、Python 实现的 live.py 同源同语义。
 *
 * 两个流式接口（PromptAgentSession / LoadAgentSession）不走 SDK：Java SDK 9.8.0
 * 没有 *WithSSE 变体，用 SseFetcher（ACS3 签名 POST + 手写 SSE 解析）代替。
 * 其余 7 个非流式接口走 SDK——SDK 的响应 cast 会静默丢弃模型未声明的键
 * （包括 JsonRpcResponse.Error），所以拿不到代码与 message 时绝不编造（Normalize）。
 */
public final class LiveClient {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String JSONRPC_VERSION = "2.0";
    /** 列表分页的硬上限。上游没承诺页数收敛，不设上限等于把死循环留给线上。 */
    private static final int MAX_PAGES = 10;
    private static final int PAGE_SIZE = 100;

    private final Client client;
    private final AppConfig cfg;
    private final AtomicLong rpcIdCounter = new AtomicLong();

    /** 构造失败让进程直接起不来——带病启动比启动失败难查得多。 */
    public LiveClient(AppConfig cfg) throws Exception {
        this.cfg = cfg;
        Config config = new Config()
            .setAccessKeyId(cfg.accessKeyId())
            .setAccessKeySecret(cfg.accessKeySecret())
            .setRegionId(cfg.regionId())
            .setConnectTimeout(10_000);
        if (cfg.endpoint() != null) {
            // 留空时 SDK 按 regionId 走内置映射；非空直接当 host，覆盖映射（预发/日常网关靠它）。
            config.setEndpoint(cfg.endpoint());
        }
        this.client = new Client(config);
    }

    private String nextRpcId() {
        // 上游要求 Id 存在；它是 JSON-RPC 的请求标识，与 RequestId（rid）不是一回事。
        return String.valueOf(rpcIdCounter.incrementAndGet());
    }

    /** 每次调用现造一个 RuntimeOptions。真正生效的是两个超时；prompt（写操作）绝不重试。 */
    private RuntimeOptions runtimeFor(int readTimeoutMs) {
        RuntimeOptions runtime = new RuntimeOptions();
        runtime.autoretry = false;
        runtime.maxAttempts = 1;
        runtime.readTimeout = readTimeoutMs;
        runtime.connectTimeout = 10_000;
        return runtime;
    }

    private RuntimeOptions runtimeDefault() {
        return runtimeFor(Constants.DEFAULT_READ_TIMEOUT_MS);
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
            ListAgentsResponse resp = client.listAgentsWithOptions(
                new ListAgentsRequest()
                    .setId(nextRpcId())
                    .setJsonrpc(JSONRPC_VERSION)
                    .setParams(new ListAgentsRequest.ListAgentsRequestParams().setMaxResults(PAGE_SIZE)),
                runtimeDefault());
            var body = resp.getBody();
            var rpc = body.getJsonRpcResponse();
            var result = rpc == null ? null : rpc.getResult();
            if (result == null) throw new DasApiException(Normalize.missingResultError(api, resp.getStatusCode(), body.getRequestId()));
            List<String> agents = new ArrayList<>();
            if (result.getAgents() != null) {
                for (var row : result.getAgents()) {
                    if (row.getAgentName() != null && !row.getAgentName().isEmpty()) agents.add(row.getAgentName());
                }
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("agents", agents);
            out.put("totalCount", result.getTotalCount());
            out.put("requestId", body.getRequestId());
            return out;
        } catch (DasApiException e) {
            throw e;
        } catch (Exception e) {
            throw new DasApiException(Normalize.toApiError(e, api));
        }
    }

    // ------------------------------------------------------------------
    // sessions
    // ------------------------------------------------------------------

    /** 建会话。成功判据只有 SessionId 非空（HTTP 200 + 有 Result 但 SessionId 为空仍是失败）。 */
    public Map<String, Object> createSession(String mode) throws Exception {
        String api = "CreateAgentSession";
        try {
            CreateAgentSessionResponse resp = client.createAgentSessionWithOptions(
                buildCreateSessionRequest(mode), runtimeDefault());
            var body = resp.getBody();
            var rpc = body.getJsonRpcResponse();
            var result = rpc == null ? null : rpc.getResult();
            if (result == null) {
                // 空响应体是这条接口最常见的失败形态，单独归一类：处置方式与其它 rpc_error 完全不同。
                throw new DasApiException(ApiError.createEmptyBody(
                    api + " 返回 HTTP " + resp.getStatusCode() + " 但没有 JsonRpcResponse.Result，拿不到 SessionId"
                        + (body.getRequestId() != null ? "（RequestId " + body.getRequestId() + "）" : "")
                        + "。实测最常见的原因是账号下没有运行中的 DataWorks 实例，或者该账号需要 RESOURCE_GROUP_ID 而没配。"));
            }
            String sessionId = result.getSessionId();
            if (sessionId == null || sessionId.isEmpty()) {
                throw new DasApiException(ApiError.createEmptyBody(api + " 返回了 Result 但 SessionId 为空"));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("sessionId", sessionId);
            if (body.getRequestId() != null) out.put("requestId", body.getRequestId());
            return out;
        } catch (DasApiException e) {
            throw e;
        } catch (Exception e) {
            throw new DasApiException(Normalize.toApiError(e, api));
        }
    }

    /**
     * CreateAgentSession 的请求构造。嵌套关系是血泪教训：initialConfigOptions 只存在于
     * meta 之下，agentName 只存在于 meta.agent 之下——塞错层级，序列化会按模型声明静默丢弃。
     */
    CreateAgentSessionRequest buildCreateSessionRequest(String mode) {
        return new CreateAgentSessionRequest()
            .setId(nextRpcId())
            .setJsonrpc(JSONRPC_VERSION)
            .setParams(new CreateAgentSessionRequest.CreateAgentSessionRequestParams()
                .setMeta(new CreateAgentSessionRequest.CreateAgentSessionRequestParamsMeta()
                    .setAgent(new CreateAgentSessionRequest.CreateAgentSessionRequestParamsMetaAgent()
                        .setAgentName(cfg.agentName()))
                    .setConfig(new CreateAgentSessionRequest.CreateAgentSessionRequestParamsMetaConfig()
                        .setSessionSource(cfg.sessionSource())
                        // 类型是 Array<{SessionTagCode}> 而不是 string[]：传字符串数组会被静默忽略。
                        .setSessionTags(List.of(
                            new CreateAgentSessionRequest.CreateAgentSessionRequestParamsMetaConfigSessionTags()
                                .setSessionTagCode(cfg.sessionSource()))))
                    // ResourceGroupId 走 InitialConfigOptions，且上游**不校验有效性**。
                    // mode：yolo 放行全部工具授权；default 停下等人（人卡，配 /reply 回覆）。
                    .setInitialConfigOptions(new CreateAgentSessionRequest.CreateAgentSessionRequestParamsMetaInitialConfigOptions()
                        .setResourceGroupId(cfg.resourceGroupId())
                        .setMode(mode))));
    }

    public Map<String, Object> listSessions() throws Exception {
        String api = "ListAgentSessions";
        try {
            List<Map<String, Object>> collected = new ArrayList<>();
            String nextToken = null;
            Integer totalCount = null;
            boolean truncated = false;

            for (int page = 0; page < MAX_PAGES; page++) {
                ListAgentSessionsResponse resp = client.listAgentSessionsWithOptions(
                    new ListAgentSessionsRequest()
                        .setId(nextRpcId())
                        .setJsonrpc(JSONRPC_VERSION)
                        .setParams(new ListAgentSessionsRequest.ListAgentSessionsRequestParams()
                            // AgentName 实测**必填**；SessionSourceList 是生效的过滤器；
                            // SessionTitle 过滤器被**静默忽略**——标题搜索一律前端做。
                            .setAgentName(cfg.agentName())
                            .setSessionSourceList(List.of(cfg.sessionSource()))
                            .setMaxResults(PAGE_SIZE)
                            .setNextToken(nextToken)),
                    runtimeDefault());
                var body = resp.getBody();
                var rpc = body.getJsonRpcResponse();
                var result = rpc == null ? null : rpc.getResult();
                if (result == null) {
                    throw new DasApiException(Normalize.missingResultError(api, resp.getStatusCode(), body.getRequestId()));
                }
                if (totalCount == null) totalCount = result.getTotalCount();
                if (result.getAgentSessions() != null) {
                    for (ListAgentSessionsResponseBody.ListAgentSessionsResponseBodyJsonRpcResponseResultAgentSessions row
                         : result.getAgentSessions()) {
                        Map<String, Object> summary = toSessionSummary(row);
                        if (summary != null) collected.add(summary);
                    }
                }
                nextToken = result.getNextToken();
                if (nextToken == null || nextToken.isEmpty()) break;
                if (page == MAX_PAGES - 1) truncated = true;
            }

            Map<String, Object> out = new LinkedHashMap<>();
            out.put("sessions", collected);
            // TotalCount 与已收集条数之差，归因不唯一（分页上限时也含"没取的页"），
            // 所以必须一并返回 truncated，不把差额说成"被过滤掉 N 条"。
            out.put("filteredOut", Math.max(0, (totalCount != null ? totalCount : collected.size()) - collected.size()));
            out.put("total", totalCount != null ? totalCount : collected.size());
            out.put("truncated", truncated);
            return out;
        } catch (DasApiException e) {
            throw e;
        } catch (Exception e) {
            throw new DasApiException(Normalize.toApiError(e, api));
        }
    }

    private Map<String, Object> toSessionSummary(
        ListAgentSessionsResponseBody.ListAgentSessionsResponseBodyJsonRpcResponseResultAgentSessions row) {
        if (row.getSessionId() == null || row.getSessionId().isEmpty()) return null;
        var meta = row.getMeta();
        List<String> tags = new ArrayList<>();
        if (meta != null && meta.getSessionTagList() != null) {
            for (var tag : meta.getSessionTagList()) {
                if (tag.getSessionTagCode() != null) tags.add(tag.getSessionTagCode());
            }
        }
        long createdAt = row.getSessionCreatedAt() != null ? row.getSessionCreatedAt() : 0L;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sessionId", row.getSessionId());
        // SessionTitle = 首条 prompt 原文（可能带注入的校验码说明），剥离由前端做。
        String title = row.getSessionTitle();
        out.put("title", title != null && !title.isEmpty() ? title
            : (row.getSessionDescription() != null ? row.getSessionDescription() : ""));
        out.put("createdAt", createdAt);
        // 恒等于 createdAt（实测 29/29）。照原样透传，运行态一律以前端流为准。
        out.put("updatedAt", row.getSessionUpdatedAt() != null ? row.getSessionUpdatedAt() : createdAt);
        // 恒为 RELEASED，同样不能当运行态用。
        out.put("status", meta != null && meta.getSessionStatus() != null && !meta.getSessionStatus().isEmpty()
            ? meta.getSessionStatus() : "UNKNOWN");
        out.put("source", meta != null ? meta.getSessionSource() : null);
        out.put("tags", tags);
        return out;
    }

    // ------------------------------------------------------------------
    // usage / artifacts / cancel
    // ------------------------------------------------------------------

    public Map<String, Object> usage(String sessionId) throws Exception {
        String api = "GetAgentSessionTokenUsage";
        long started = System.currentTimeMillis();
        try {
            GetAgentSessionTokenUsageResponse resp = client.getAgentSessionTokenUsageWithOptions(
                new GetAgentSessionTokenUsageRequest()
                    .setId(nextRpcId())
                    .setJsonrpc(JSONRPC_VERSION)
                    .setParams(new GetAgentSessionTokenUsageRequest.GetAgentSessionTokenUsageRequestParams()
                        .setSessionId(sessionId)),
                runtimeDefault());
            var body = resp.getBody();
            var rpc = body.getJsonRpcResponse();
            var result = rpc == null ? null : rpc.getResult();
            if (result == null) {
                throw new DasApiException(Normalize.missingResultError(api, resp.getStatusCode(), body.getRequestId()));
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("promptTokens", result.getPromptTokens());
            out.put("completionTokens", result.getCompletionTokens());
            out.put("totalTokens", result.getTotalTokens());
            out.put("cachedTokens", result.getCachedTokens());
            out.put("thoughtsTokens", result.getThoughtsTokens());
            out.put("elapsedMs", System.currentTimeMillis() - started);
            if (body.getRequestId() != null) out.put("requestId", body.getRequestId());
            return out;
        } catch (DasApiException e) {
            throw e;
        } catch (Exception e) {
            throw new DasApiException(Normalize.toApiError(e, api));
        }
    }

    /** artifacts：**原样返回，不做兜底填充**：实测两个 artifact 接口恒返回空数组。 */
    public Map<String, Object> artifacts(String sessionId) throws Exception {
        String api = "ListAgentSessionArtifacts";
        long started = System.currentTimeMillis();
        try {
            ListAgentSessionArtifactsResponse resp = client.listAgentSessionArtifactsWithOptions(
                new ListAgentSessionArtifactsRequest()
                    .setId(nextRpcId())
                    .setJsonrpc(JSONRPC_VERSION)
                    .setParams(new ListAgentSessionArtifactsRequest.ListAgentSessionArtifactsRequestParams()
                        .setSessionId(sessionId)),
                runtimeDefault());
            var body = resp.getBody();
            var rpc = body.getJsonRpcResponse();
            var result = rpc == null ? null : rpc.getResult();
            if (result == null) {
                throw new DasApiException(Normalize.missingResultError(api, resp.getStatusCode(), body.getRequestId()));
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
            throw new DasApiException(Normalize.toApiError(e, api));
        }
    }

    /**
     * cancel。【LIVE 09-18】上游已会真正取消：HTTP 200 + 流以 stopReason=cancelled 收场。
     * delivered = 上游接受了取消请求（HTTP 200）。取消失败的处置是让调用方知道
     * "没取消成"，而不是收到一个 5xx——异常记进 detail 透给前端。
     */
    public Map<String, Object> cancel(String sessionId) throws Exception {
        String api = "CancelAgentSession";
        String upstream = "调用未返回";
        Integer status = null;
        try {
            CancelAgentSessionResponse resp = client.cancelAgentSessionWithOptions(
                new CancelAgentSessionRequest()
                    .setId(nextRpcId())
                    .setJsonrpc(JSONRPC_VERSION)
                    .setParams(new CancelAgentSessionRequest.CancelAgentSessionRequestParams()
                        .setSessionId(sessionId)),
                runtimeDefault());
            status = resp.getStatusCode();
            upstream = "HTTP " + status;
        } catch (Exception e) {
            upstream = Normalize.toApiError(e, api).message();
        }

        boolean delivered = status != null && status == 200;
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("delivered", delivered);
        result.put("warning", delivered ? "cancel-accepted" : "cancel-upstream-error");
        result.put("detail", delivered
            ? "已向上游发出 " + api + "（" + upstream + "），取消请求已被接受。"
                + "若当时有执行中的轮次，流会以 `stopReason=cancelled` 终态收场"
                + "（实测 3/3：1200 字长文在 432 字处被截断；空闲会话上取消是 no-op）。"
                + "注意：cancelled 终态目前不落库——稍后 LoadAgentSession 里那一轮 "
                + "`terminated=false`、无 stopReason，属上游已知缺口，不代表取消失败。"
            : "已向上游发出 " + api + " 但未获 200（本次结果：" + upstream + "）。"
                + "取消未确认生效：那一轮可能仍在执行，结果稍后拉历史确认。");
        return result;
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
            ReplyAgentSessionRequest.ReplyAgentSessionRequestParams params =
                new ReplyAgentSessionRequest.ReplyAgentSessionRequestParams()
                    .setSessionId(sessionId)
                    .setPermissionRequestId((String) input.get("permissionRequestId"));
            Object answers = input.get("answers");
            if (answers instanceof Map<?, ?> map && !map.isEmpty()) {
                Map<String, String> typed = new LinkedHashMap<>();
                for (Map.Entry<?, ?> e : map.entrySet()) typed.put(String.valueOf(e.getKey()), (String) e.getValue());
                params.setAnswers(typed);
            }
            ReplyAgentSessionRequest.ReplyAgentSessionRequestParamsOutcome outcome =
                new ReplyAgentSessionRequest.ReplyAgentSessionRequestParamsOutcome()
                    .setOutcome((String) input.get("outcome"));
            if (input.get("optionId") != null) outcome.setOptionId((String) input.get("optionId"));
            params.setOutcome(outcome);

            ReplyAgentSessionResponse resp = client.replyAgentSessionWithOptions(
                new ReplyAgentSessionRequest()
                    .setId(nextRpcId())
                    .setJsonrpc(JSONRPC_VERSION)
                    .setParams(params),
                runtimeDefault());

            ReplyAgentSessionResponseBody body = resp.getBody();
            var rpc = body.getJsonRpcResponse();
            String requestId = body.getRequestId();
            if (rpc != null && rpc.getError() != null) {
                var error = rpc.getError();
                throw new DasApiException(ApiError.redact(ApiError.apiError("rpc_error",
                    api + " 被上游拒绝：" + (error.getMessage() != null ? error.getMessage() : "无 message")
                        + (error.getErrorCode() != null ? " [" + error.getErrorCode() + "]" : "")
                        + (error.getCode() != null ? " (code=" + error.getCode() + ")" : "")
                        + (requestId != null ? "，RequestId " + requestId : ""))));
            }
            if (rpc == null || rpc.getResult() == null || rpc.getResult().getAccepted() == null) {
                throw new DasApiException(ApiError.redact(ApiError.apiError("rpc_error",
                    api + " 返回 HTTP 200 但没有 JsonRpcResponse.Result.accepted"
                        + (requestId != null ? "（RequestId " + requestId + "）" : ""))));
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
            throw new DasApiException(Normalize.toApiError(e, api));
        }
    }

    // ------------------------------------------------------------------
    // 历史（LoadAgentSession · 手写 SSE）
    // ------------------------------------------------------------------

    /**
     * 拉一整份历史帧。
     *
     * 用**独立的 30s 停滞上限**：实测在会话 RUNNING 期间调 load，4 次里有 2 次会阻塞
     * 到那一轮跑完才返回（178s、81.6s）。阻塞不可预测，快速失败让用户重试，
     * 好过把界面挂死三分钟。停滞上限在每次 next() 上执行（帧在流就继续等）。
     *
     * `Meta.BeginLogOffset` 是**死参数**：传任何值都返回全量，所以不传。
     */
    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> loadFrames(String sessionId) throws Exception {
        String api = "LoadAgentSession";
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("SessionId", sessionId);
        params.put("Meta", Map.of("IsReload", true));

        List<Map<String, Object>> frames = new ArrayList<>();
        SseFetcher fetcher;
        try {
            fetcher = new SseFetcher(cfg, api, params, nextRpcId());
        } catch (SseException e) {
            throw new DasApiException(Normalize.toApiError(e, api));
        }
        try (fetcher) {
            while (true) {
                String data;
                try {
                    data = fetcher.next(Constants.HISTORY_READ_TIMEOUT_MS);
                } catch (SseException e) {
                    throw new DasApiException(Normalize.toApiError(e, api));
                }
                if (data == null) break;
                Map<String, Object> frame = frameFromData(data);
                if (frame != null) frames.add(frame);
            }
        }
        return frames;
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
    public SseFetcher openPromptStream(String sessionId, String outboundText, List<String> acks) throws Exception {
        String api = "PromptAgentSession";
        Map<String, Object> prompt = new LinkedHashMap<>();
        prompt.put("Type", "text");
        prompt.put("Text", outboundText);
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("SessionId", sessionId);
        params.put("Prompt", List.of(prompt));
        try {
            return new SseFetcher(cfg, api, params, nextRpcId());
        } catch (SseException e) {
            throw new DasApiException(Normalize.toApiError(e, api));
        }
    }
}
