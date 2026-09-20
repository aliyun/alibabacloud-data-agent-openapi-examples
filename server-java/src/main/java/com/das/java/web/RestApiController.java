package com.das.java.web;

import com.das.java.config.AppConfig;
import com.das.java.core.ApiError;
import com.das.java.core.Constants;
import com.das.java.core.Marker;
import com.das.java.core.Rid;
import com.das.java.core.Turn;
import com.das.java.live.LiveClient;
import com.das.java.live.Normalize.DasApiException;
import com.das.java.mock.MockFixtures;
import com.das.java.mock.MockFixtures.MockScenario;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 非流式 REST 端点。与 Node 实现的 server-node/routes/rest.ts、Python 实现的 main.py
 * 同源同语义。
 *
 * 一条贯穿全文件的约定：**业务错误也用 HTTP 200 承载**，响应体是
 * `{ok:false, error:{…}}`；只有传输层故障（后端连不上上游）才用 502。
 * 前端只按 error.kind 分支，状态码只用于区分"是我这边到上游的链路断了"
 * 和"上游给出了一个业务结论"。
 */
@RestController
public class RestApiController {
    private final AppConfig cfg;
    /** 只在 LIVE 模式存在。MOCK 模式**绝不**构造：那是"以为在测真实链路"的唯一屏障。 */
    private final LiveClient live;

    public RestApiController(AppConfig cfg, com.das.java.live.LiveClientHolder holder) {
        this.cfg = cfg;
        this.live = holder.client();
    }

    // ------------------------------------------------------------------
    // 统一出口
    // ------------------------------------------------------------------

    private static Map<String, Object> ok(Object result) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("result", result);
        return out;
    }

    private static Map<String, Object> err(ApiError error) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", false);
        out.put("error", error.toMap());
        return out;
    }

    /** 统一的响应出口：业务错误 200，传输层故障 502。 */
    private static ResponseEntity<Map<String, Object>> send(Map<String, Object> body) {
        boolean isOk = Boolean.TRUE.equals(body.get("ok"));
        if (!isOk && body.get("error") instanceof Map<?, ?> error
            && "transport".equals(error.get("kind"))) {
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(body);
        }
        return ResponseEntity.ok(body);
    }

    private static Map<String, Object> liveError(Exception exc, String apiName) {
        ApiError error = exc instanceof DasApiException e
            ? ApiError.redact(e.apiError())
            : com.das.java.live.Normalize.toApiError(exc, apiName);
        return err(error);
    }

    // ------------------------------------------------------------------
    // health
    // ------------------------------------------------------------------

    @GetMapping("/api/health")
    public Map<String, Object> health() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("mock", cfg.mock());
        result.put("region", cfg.regionId());
        result.put("agent", cfg.agentName());
        result.put("sessionSource", cfg.sessionSource());
        result.put("resourceGroupIdConfigured", cfg.resourceGroupId() != null);
        // 只说"有没有"，不说"是什么"：health 是前端启动时第一个请求，
        // 内容会进浏览器 network 面板、日志和截图。
        result.put("credentials", cfg.accessKeyId() != null && cfg.accessKeySecret() != null ? "present" : "missing");
        if (cfg.mock()) {
            result.put("mockReplay", cfg.mockRealtime() ? "真实时间间隔" : "压平 + " + cfg.mockSpeed() + "x 倍速");
        }
        return ok(result);
    }

    // ------------------------------------------------------------------
    // 会话列表 / 建会话
    // ------------------------------------------------------------------

    @GetMapping("/api/sessions")
    public ResponseEntity<Map<String, Object>> sessions() throws Exception {
        if (live != null) {
            try {
                return send(ok(live.listSessions()));
            } catch (Exception exc) {
                return send(liveError(exc, "ListAgentSessions"));
            }
        }
        return send(ok(MockFixtures.mockSessions(cfg.sessionSource())));
    }

    @PostMapping("/api/sessions")
    public ResponseEntity<Map<String, Object>> createSession(@RequestBody(required = false) Map<String, Object> body) throws Exception {
        Object rawMode = body == null ? null : body.get("mode");
        String mode = null;
        if (rawMode instanceof String s && !s.isEmpty()) {
            if (s.equals("default") || s.equals("yolo")) {
                mode = s;
            } else {
                return send(err(ApiError.apiError("rpc_error", "mode 只接受 'yolo' | 'default'，收到：" + s)));
            }
        }
        if (live != null) {
            try {
                return send(ok(live.createSession(mode != null ? mode : "yolo")));
            } catch (Exception exc) {
                return send(liveError(exc, "CreateAgentSession"));
            }
        }
        Object rawTitle = body == null ? null : body.get("title");
        String title = rawTitle instanceof String s ? s : "新建会话";
        String stripped = Marker.stripMarkerInstruction(title);
        return send(ok(MockFixtures.mockCreateSession(!stripped.isEmpty() ? stripped : title)));
    }

    // ------------------------------------------------------------------
    // 人卡回覆（ReplyAgentSession）
    //
    // 用 POST 不只是风格：回覆会真实改变服务端那一轮的执行走向，GET 属 CORS 简单请求。
    // ------------------------------------------------------------------

    @PostMapping("/api/sessions/{id}/reply")
    public ResponseEntity<Map<String, Object>> reply(
        @PathVariable("id") String sessionId,
        @RequestBody(required = false) Map<String, Object> body) throws Exception {
        if (body == null) body = Map.of();

        String permissionRequestId = body.get("permissionRequestId") instanceof String s ? s.trim() : "";
        if (permissionRequestId.isEmpty()) {
            return send(err(ApiError.apiError("rpc_error",
                "reply 需要 permissionRequestId（来自流上 _qwen/notify permission_request 帧的 data.requestId）")));
        }
        String outcome = "cancelled".equals(body.get("outcome")) ? "cancelled" : "selected";
        String optionId = body.get("optionId") instanceof String s && !s.trim().isEmpty() ? s.trim() : null;
        Map<String, String> answers = null;
        if (body.get("answers") != null) {
            if (!(body.get("answers") instanceof Map<?, ?> raw)) {
                return send(err(ApiError.apiError("rpc_error",
                    "answers 必须是 { \"0\": \"答案文本\" } 形状的对象（索引键 → 答案）")));
            }
            answers = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : raw.entrySet()) {
                if (!(e.getValue() instanceof String v)) {
                    return send(err(ApiError.apiError("rpc_error", "answers[\"" + e.getKey() + "\"] 必须是字符串")));
                }
                answers.put(String.valueOf(e.getKey()), v);
            }
        }
        if (outcome.equals("selected") && optionId == null && (answers == null || answers.isEmpty())) {
            return send(err(ApiError.apiError("rpc_error",
                "outcome=selected 时必须带 optionId（工具授权）或 answers（ask_user_question）；"
                    + "只回 selected 会以 proceed_once 解除阻塞但 agent 收不到答案")));
        }

        if (live != null) {
            try {
                Map<String, Object> input = new LinkedHashMap<>();
                input.put("permissionRequestId", permissionRequestId);
                if (answers != null && !answers.isEmpty()) input.put("answers", answers);
                if (optionId != null) input.put("optionId", optionId);
                input.put("outcome", outcome);
                return send(ok(live.reply(sessionId, input)));
            } catch (Exception exc) {
                return send(liveError(exc, "ReplyAgentSession"));
            }
        }
        // MOCK 分支没有可回覆的真实交互，如实拒绝。
        return send(err(ApiError.apiError("rpc_error", "MOCK 模式回放的是录制件，没有可回覆的真实交互；人卡请切 LIVE 模式")));
    }

    // ------------------------------------------------------------------
    // 历史 / usage / artifacts / cancel / probe
    // ------------------------------------------------------------------

    @GetMapping("/api/sessions/{id}/history")
    public ResponseEntity<Map<String, Object>> history(@PathVariable("id") String sessionId) throws Exception {
        long started = System.currentTimeMillis();
        if (live != null) {
            try {
                List<Map<String, Object>> frames = live.loadFrames(sessionId);
                Map<String, Object> reduced = Turn.reduceHistory(frames);
                reduced.put("elapsedMs", System.currentTimeMillis() - started);
                return send(ok(reduced));
            } catch (Exception exc) {
                return send(liveError(exc, "LoadAgentSession"));
            }
        }
        MockScenario scenario = MockFixtures.findScenario(sessionId);
        if (scenario == null) {
            return send(err(ApiError.apiError("rpc_error", "MOCK 模式下没有这个会话：" + sessionId)));
        }
        List<Map<String, Object>> frames = scenario.historyFixture() != null
            ? MockFixtures.readFixtureFrames(cfg.repoRoot(), scenario.historyFixture())
            : List.of();
        Map<String, Object> reduced = Turn.reduceHistory(frames);
        reduced.put("elapsedMs", System.currentTimeMillis() - started);
        return send(ok(reduced));
    }

    @GetMapping("/api/sessions/{id}/usage")
    public ResponseEntity<Map<String, Object>> usage(@PathVariable("id") String sessionId) throws Exception {
        long started = System.currentTimeMillis();
        if (live != null) {
            try {
                return send(ok(live.usage(sessionId)));
            } catch (Exception exc) {
                return send(liveError(exc, "GetAgentSessionTokenUsage"));
            }
        }
        // MOCK 也要校验会话存在：不校验的话任意 id 都返回同一份录制数据，
        // 而 LIVE 下这个 id 会真报错——那样"MOCK 下验收通过"就推广不到真实链路。
        if (MockFixtures.findScenario(sessionId) == null) {
            return send(err(ApiError.apiError("rpc_error", "MOCK 模式下没有这个会话：" + sessionId)));
        }
        Map<String, Object> recorded = MockFixtures.readFixtureResult(cfg.repoRoot(), "rest-token-usage.json");
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("promptTokens", recorded.get("PromptTokens"));
        result.put("completionTokens", recorded.get("CompletionTokens"));
        result.put("totalTokens", recorded.get("TotalTokens"));
        result.put("cachedTokens", recorded.get("CachedTokens"));
        result.put("thoughtsTokens", recorded.get("ThoughtsTokens"));
        result.put("elapsedMs", System.currentTimeMillis() - started);
        return send(ok(result));
    }

    @GetMapping("/api/sessions/{id}/artifacts")
    public ResponseEntity<Map<String, Object>> artifacts(@PathVariable("id") String sessionId) throws Exception {
        if (live != null) {
            try {
                return send(ok(live.artifacts(sessionId)));
            } catch (Exception exc) {
                return send(liveError(exc, "ListAgentSessionArtifacts"));
            }
        }
        if (MockFixtures.findScenario(sessionId) == null) {
            return send(err(ApiError.apiError("rpc_error", "MOCK 模式下没有这个会话：" + sessionId)));
        }
        // elapsedMs 恒为 0 是真的：MOCK 下这一路不发任何请求。
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("artifacts", new ArrayList<>());
        result.put("elapsedMs", 0);
        return send(ok(result));
    }

    /**
     * cancel。【LIVE 09-18】上游已会真取消：HTTP 200 + 流以 stopReason=cancelled 收场。
     * MOCK 分支是 no-op：回放没有可取消的执行，delivered:false 在 MOCK 下是准确的。
     */
    @PostMapping("/api/sessions/{id}/cancel")
    public ResponseEntity<Map<String, Object>> cancel(@PathVariable("id") String sessionId) throws Exception {
        if (live != null) {
            try {
                return send(ok(live.cancel(sessionId)));
            } catch (Exception exc) {
                return send(liveError(exc, "CancelAgentSession"));
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("delivered", false);
        result.put("warning", "mock-replay-uncancellable");
        result.put("detail",
            "MOCK 模式回放的是录制件，没有可取消的执行——`delivered:false` 在 MOCK 下是准确的。"
                + "真实模式下 cancel 已生效（2026-09-18 实测 3/3：HTTP 200 + 流以 "
                + "`stopReason=cancelled` 终态收场；空闲会话上是 no-op）。");
        return send(ok(result));
    }

    /**
     * 断流之后的完成探测器。rid 必填：探测的对象是"断流的那一轮"。
     * 每次探测都会触发一次完整的 load，前端必须限频，别做成 1s 轮询。
     */
    @GetMapping("/api/sessions/{id}/probe")
    public ResponseEntity<Map<String, Object>> probe(
        @PathVariable("id") String sessionId,
        @RequestParam(name = "rid", required = false) String rid,
        @RequestParam(name = "tokens", required = false) String rawTokens) throws Exception {
        if (rid == null || rid.trim().isEmpty()) {
            return send(err(ApiError.apiError("rpc_error",
                "probe 需要 rid 参数：探测的对象是断流的那一轮，rid 是它唯一的标识")));
        }
        rid = rid.trim();
        Double baselineTokens = null;
        if (rawTokens != null && !rawTokens.trim().isEmpty()) {
            try {
                double v = Double.parseDouble(rawTokens.trim());
                if (Double.isFinite(v) && v > 0) baselineTokens = v;
            } catch (NumberFormatException ignored) {
                // 非数字当未传：只用探测器 A（帧数）
            }
        }

        if (live != null) {
            try {
                return send(ok(liveProbe(sessionId, rid, baselineTokens)));
            } catch (Exception exc) {
                return send(liveError(exc, "LoadAgentSession(probe)"));
            }
        }

        MockScenario scenario = MockFixtures.findScenario(sessionId);
        if (scenario == null || scenario.historyFixture() == null) {
            return send(err(ApiError.apiError("rpc_error", "MOCK 模式下这个会话没有可回放的历史：" + sessionId)));
        }
        List<Map<String, Object>> frames = MockFixtures.readFixtureFrames(cfg.repoRoot(), scenario.historyFixture());
        int framesForRid = Rid.countFramesForRid(frames, rid);
        Map<String, Object> usageEnvelope = MockFixtures.readFixtureEnvelope(cfg.repoRoot(), "rest-token-usage.json");
        Object totalTokens = usageEnvelope.get("result") instanceof Map<?, ?> r ? r.get("TotalTokens") : null;

        List<String> by = new ArrayList<>();
        if (framesForRid > 2) by.add("frames");
        if (baselineTokens != null && totalTokens instanceof Number n && n.doubleValue() > baselineTokens) {
            by.add("tokens");
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("done", !by.isEmpty());
        result.put("by", by);
        result.put("framesForRid", framesForRid);
        result.put("totalTokens", totalTokens);
        // MOCK 只读本地 fixture，loadsIssued 是 0——写成 1 会让这个数字失去意义。
        result.put("loadsIssued", 0);
        result.put("elapsedMs", 0);
        return send(ok(result));
    }

    /**
     * 探测"断流的那一轮到底跑完了没有"。两个判据都只能给"完成"信号、给不了"进度"。
     * **绝不自动重发 prompt**——重发等于把同一个写操作执行两遍。
     */
    private Map<String, Object> liveProbe(String sessionId, String rid, Double baselineTokens) throws Exception {
        long started = System.currentTimeMillis();
        List<Map<String, Object>> frames = live.loadFrames(sessionId);
        int loadsIssued = 1;
        int framesForRid = Rid.countFramesForRid(frames, rid);

        // 探测器 B 失败要如实退化成"只按帧数"：usage 出错不应拖垮整个探测。
        Object totalTokens = null;
        try {
            totalTokens = live.usage(sessionId).get("totalTokens");
        } catch (Exception ignored) {
        }

        List<String> by = new ArrayList<>();
        if (framesForRid > 2) by.add("frames");
        if (baselineTokens != null && totalTokens instanceof Number n && n.doubleValue() > baselineTokens) {
            by.add("tokens");
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("done", !by.isEmpty());
        result.put("by", by);
        result.put("framesForRid", framesForRid);
        if (totalTokens != null) result.put("totalTokens", totalTokens);
        result.put("loadsIssued", loadsIssued);
        result.put("elapsedMs", System.currentTimeMillis() - started);
        return result;
    }
}
