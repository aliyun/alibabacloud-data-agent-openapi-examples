package com.das.java.web;

import com.das.java.core.ApiError;
import com.das.java.core.Frames;
import com.das.java.live.Normalize.DasApiException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 上游帧流 → wire 事件流。与 Node 实现的 server-node/pipeline.ts、Python 实现的 pipeline.py
 * 同源同语义。**live 与 mock 共用这一个类**，这是"mock 下验收通过"能推广到真实链路的前提。
 *
 * 三条硬规则：
 * 1. 帧原样透传（body 就是上游那一帧，不重塑、不改名）；后端唯一的加工是错误归一化。
 * 2. 带 Error 的帧既当普通帧透传（前端 reducer 会记下它），又额外产出一条归一化的
 *    error 事件（UI 文案按 kind 走）。
 * 3. 源结束却从未出现 Result.stopReason ⇒ **不发 done**，按收到过几帧分两种收尾：
 *    有帧归 stream_break（任务可能还在跑），零帧归 prompt_not_dispatched（根本没开始）。
 */
public final class Pipeline {
    private final String sessionId;
    private final boolean mock;
    private final long startedAt;

    private String rid;
    private boolean metaSent;
    private int frameCount;
    private Frames.TerminalInfo terminal;
    private boolean errorSent;

    public Pipeline(String sessionId, boolean mock, long startedAt) {
        this.sessionId = sessionId;
        this.mock = mock;
        this.startedAt = startedAt;
    }

    public String rid() {
        return rid;
    }

    private Map<String, Object> event(String type, Map<String, Object> fields) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("type", type);
        out.putAll(fields);
        return out;
    }

    /** 喂入一帧，返回本次应下发的事件（0~3 条：meta + frame + 可选的 error）。 */
    public List<Map<String, Object>> onFrame(Map<String, Object> frame) {
        frameCount += 1;
        List<Map<String, Object>> out = new ArrayList<>();

        if (!metaSent) {
            if (rid == null) rid = Frames.requestIdOf(frame);
            if (rid != null) {
                metaSent = true;
                Map<String, Object> meta = new LinkedHashMap<>();
                meta.put("rid", rid);
                meta.put("sessionId", sessionId);
                meta.put("mock", mock);
                meta.put("startedAt", startedAt);
                out.add(event("meta", meta));
            }
        }

        Map<String, Object> frameEvent = new LinkedHashMap<>();
        frameEvent.put("rid", rid != null ? rid : "");
        frameEvent.put("offset", Frames.offsetOf(frame));
        frameEvent.put("body", frame);
        out.add(event("frame", frameEvent));

        Map<String, Object> frameError = Frames.errorOf(frame);
        if (frameError != null && !errorSent) {
            errorSent = true;
            // 这一条也要过脱敏：上游鉴权类报文会把调用方的 AccessKeyId 原文回显出来。
            Object code = frameError.get("code");
            ApiError error = ApiError.redact(ApiError.classify(
                frameError.get("message") instanceof String s ? s : null,
                code instanceof Number n ? n.intValue() : null,
                frameError.get("errorCode") instanceof String s ? s : null,
                null));
            Map<String, Object> errorEvent = new LinkedHashMap<>();
            errorEvent.put("rid", rid != null ? rid : "");
            errorEvent.put("error", error.toMap());
            out.add(event("error", errorEvent));
        }

        if (terminal == null) terminal = Frames.terminalOf(frame);
        return out;
    }

    /**
     * 帧源在迭代中途抛出的错误（LIVE 下：鉴权失败、422 幽灵化、socket 被掐）。
     * 归一成一条 error 事件后直接结束。
     */
    public Map<String, Object> onError(DasApiException error, String apiName) {
        Map<String, Object> errorEvent = new LinkedHashMap<>();
        errorEvent.put("rid", rid != null ? rid : "");
        ApiError normalized = ApiError.redact(error.apiError());
        String message = normalized.message();
        if (apiName != null && !message.contains(apiName)) {
            normalized = new ApiError(
                normalized.kind(), normalized.code(), normalized.errorCode(), apiName + ": " + message,
                normalized.retryable(), normalized.fatalForSession(), normalized.upstreamStatus());
        }
        errorEvent.put("error", normalized.toMap());
        return event("error", errorEvent);
    }

    /**
     * 源正常结束后的收尾事件（done 或 error；errorSent 时返回 null——错误已经发过了）。
     * popRequestIds：上游只回 POP 回执、零帧时那些回执的 RequestId（唯一可查的线索）。
     */
    public Map<String, Object> finish(List<String> popRequestIds) {
        if (errorSent) return null;
        if (terminal != null) {
            Map<String, Object> done = new LinkedHashMap<>();
            done.put("rid", rid != null ? rid : "");
            done.put("stopReason", terminal.stopReason());
            done.put("rawStopReason", terminal.rawStopReason());
            done.put("frameCount", frameCount);
            return event("done", done);
        }
        // 两种"没有终态"必须分开，处置完全相反：
        //  · 收到过帧 ⇒ 断流，任务很可能还在服务端跑，动作是探测/拉历史接管，绝不重发；
        //  · 一帧都没收到 ⇒ 上游收下了请求却没派发给执行端，任务**根本没开始**。
        ApiError error = frameCount == 0
            ? ApiError.promptNotDispatched(
                popRequestIds == null || popRequestIds.isEmpty() ? null : popRequestIds.get(0),
                System.currentTimeMillis() - startedAt)
            : ApiError.streamBreakWithoutTerminal(frameCount);
        Map<String, Object> errorEvent = new LinkedHashMap<>();
        errorEvent.put("rid", rid != null ? rid : "");
        errorEvent.put("error", error.toMap());
        return event("error", errorEvent);
    }

    /** 撞硬上限时的收尾事件（主动收尾成 stream_break，而不是无限挂着）。 */
    public Map<String, Object> hardLimitEvent() {
        Map<String, Object> errorEvent = new LinkedHashMap<>();
        errorEvent.put("rid", rid != null ? rid : "");
        Map<String, Object> error = new LinkedHashMap<>();
        error.put("kind", "stream_break");
        error.put("message", "session stream ended without turn terminal (hard limit reached)");
        error.put("retryable", false);
        error.put("fatalForSession", false);
        errorEvent.put("error", error);
        return event("error", errorEvent);
    }
}
