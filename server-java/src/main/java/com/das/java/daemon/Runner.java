package com.das.java.daemon;

import com.das.java.config.AppConfig;
import com.das.java.core.ApiError;
import com.das.java.core.Constants;
import com.das.java.core.Frames;
import com.das.java.live.LiveClient;
import com.das.java.live.Normalize;
import com.das.java.live.Normalize.DasApiException;
import com.das.java.mock.MockFixtures;
import com.das.java.mock.MockFixtures.MockScenario;
import com.das.java.mock.MockReplay;
import com.das.java.live.SdkSseStream;
import com.das.java.web.Inflight;
import com.das.java.web.Inflight.AcquireResult;
import com.das.java.web.Inflight.Acquired;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * daemon prompt 准入与后台轮次。与 Node 实现的 server-node/daemon/runner.ts 同源同语义。
 *
 * 所有校验都在**还没碰到上游**之前完成（写操作纪律），通过后立刻返回 202 所需的
 * {promptId, lastEventId}，轮次在后台跑、事件写 journal、SSE 分发。
 *
 * 这是与 `/api/sessions/:id/prompt`（上游流直连客户端）最大的架构差异：
 * 客户端连接的存亡从此不影响上游那一轮的收尾。
 */
public class Runner {
    private static final Logger log = LoggerFactory.getLogger(Runner.class);
    private static final ExecutorService EXECUTOR = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "daemon-runner");
        t.setDaemon(true);
        return t;
    });

    public sealed interface Admission permits Admitted, Rejected {}

    public record Admitted(String promptId, long lastEventId) implements Admission {}

    public record Rejected(int status, String error, String code) implements Admission {}

    private final AppConfig cfg;
    private final LiveClient live;
    private final Inflight inflight;

    public Runner(AppConfig cfg, LiveClient live, Inflight inflight) {
        this.cfg = cfg;
        this.live = live;
        this.inflight = inflight;
    }

    public Admission admit(Registry.Record record, String clientFacingId, Object promptBlocks, String clientId) {
        if (!(promptBlocks instanceof List<?> list) || list.isEmpty()) {
            return new Rejected(400, "prompt 需要至少一个 content block（{type:\"text\",text}）", "empty_prompt");
        }
        StringBuilder texts = new StringBuilder();
        for (Object block : list) {
            if (block instanceof Map<?, ?> map
                && "text".equals(map.get("type"))
                && map.get("text") instanceof String text) {
                texts.append(text);
                continue;
            }
            Object type = block instanceof Map<?, ?> map ? map.get("type") : null;
            // 上游 PromptAgentSession 只收文本块；图片块如实拒绝而不是静默丢弃（缺口见 OPENAPI-GAPS）
            return new Rejected(400,
                "不支持的 prompt content block（type=" + type + "）：上游 data agent OpenAPI 仅接受文本",
                "unsupported_prompt_content");
        }
        String text = texts.toString().trim();
        if (text.isEmpty()) {
            return new Rejected(400, "prompt 文本为空", "empty_prompt");
        }

        // marker 归属校验已退役（2026-09-20）：不再注入校验码，prompt 原文即 outbound。
        String outbound = text;

        AcquireResult acquire = inflight.tryAcquire(record.realId);
        if (acquire instanceof Inflight.Rejected rejected) {
            return new Rejected(409, rejected.error().message(), "session_concurrent_operation_in_progress");
        }
        Acquired acquired = (Acquired) acquire;

        String promptId = UUID.randomUUID().toString();
        Journal journal = record.journal;
        journal.activePrompt = true;
        journal.activePromptId = promptId;
        // 202 的 lastEventId 必须在后台任务可能追加任何事件**之前**取——
        // 客户端拿它做 SSE 游标起点，晚了就漏掉这一轮的头几帧。
        long lastEventId = journal.lastId();

        long startedAt = System.currentTimeMillis();
        EXECUTOR.submit(() -> {
            try {
                runTurn(record, clientFacingId, promptId, outbound, clientId, acquired, startedAt);
            } catch (Throwable t) {
                // runTurn 内部已兜所有已知路径；这里只防"兜底本身抛了"这种把进程带走的形态。
                log.error("daemon prompt 后台任务异常退出 sessionId={} promptId={}", record.realId, promptId, t);
                journal.activePrompt = false;
                journal.activePromptId = null;
            }
        });

        return new Admitted(promptId, lastEventId);
    }

    /**
     * 后台轮次：帧源（live=签名 SSE / mock=录制件回放）→ 翻译 → journal。
     *
     * 收尾分类与 pipeline 同源：
     *  · 帧内 Error → 首个错误归一成 turn_error（后续帧继续收）；
     *  · Result.stopReason → turn_complete；
     *  · 无终态：有帧 ⇒ stream_break（绝不重发）；零帧+有回执 ⇒ prompt_not_dispatched。
     * 硬上限 330s 对齐实测断流墙，到点主动按 stream_break 收尾。
     */
    @SuppressWarnings("unchecked")
    private void runTurn(
        Registry.Record record, String clientFacingId, String promptId, String outbound,
        String clientId, Acquired acquired, long startedAt
    ) {
        Journal journal = record.journal;
        List<String> acks = new ArrayList<>();
        FrameSource source = openSource(record.realId, outbound, acks);

        int frameCount = 0;
        boolean errorSent = false;
        Frames.TerminalInfo terminal = null;
        boolean ridBackfilled = false;
        /** 本轮 user 回显的累积文本：上游把 echo 发两份（bridge-echo），去重判据与 historyFramesToEvents 同源。 */
        String userText = "";
        long deadline = System.currentTimeMillis() + Constants.STREAM_HARD_LIMIT_MS;

        try {
            while (true) {
                if (System.currentTimeMillis() > deadline) break;
                Map<String, Object> frame = source.next();
                if (frame == null) break;
                frameCount += 1;
                if (!ridBackfilled) {
                    String rid = Frames.requestIdOf(frame);
                    if (rid != null) {
                        ridBackfilled = true;
                        // 在途锁条目的 rid 回填：撞锁的日志要能报出"正在跑的是哪一轮"
                        acquired.entry().rid = rid;
                    }
                }
                if (!errorSent) {
                    // permission 通知帧先于 session_update 处理（到达序的真实顺序）；
                    // 此前这些帧被整帧丢弃就在这条吞掉的——「没有弹框」的根因。
                    Map<String, Object> permissionEvent = Translate.frameToPermissionEvent(frame, clientFacingId);
                    if (permissionEvent != null) {
                        journal.append(permissionEvent);
                        if (permissionEvent.get("data") instanceof Map<?, ?> dataMap
                            && dataMap.get("requestId") instanceof String requestId) {
                            if ("permission_request".equals(permissionEvent.get("type"))) {
                                record.pendingPermissions.put(requestId, permissionEvent);
                            } else {
                                record.pendingPermissions.remove(requestId);
                            }
                        }
                    }
                    Map<String, Object> event = Translate.frameToSessionUpdate(frame, clientFacingId, true, clientId);
                    boolean duplicateUserChunk = false;
                    if (event != null) {
                        Map<String, Object> data = (Map<String, Object>) event.get("data");
                        Map<String, Object> update = (Map<String, Object>) data.get("update");
                        String kind = update.get("sessionUpdate") instanceof String s ? s : null;
                        if ("user_message_chunk".equals(kind)) {
                            String text = textOf(update);
                            if (!text.isEmpty() && text.equals(userText)) duplicateUserChunk = true;
                            else userText += text;
                        }
                        // agent 思考/回答的 chunk 文本原样透传（marker 剥离机制已退役，不再有任何剥除器）
                    }
                    if (event != null && !duplicateUserChunk) journal.append(event);
                }
                // errorSent 之后只消费不投喂：turn_error 是本轮事件流的终态（daemon 语义），
                // 上游断流前还会再吐少量帧（实测 mock-break 录制件错误帧后仍有收尾帧），
                // 迟到的 session_update 会在 web-shell 里变成"终态之后的孤儿内容"。

                Map<String, Object> frameError = Frames.errorOf(frame);
                if (frameError != null && !errorSent) {
                    errorSent = true;
                    Object code = frameError.get("code");
                    ApiError api = ApiError.redact(ApiError.classify(
                        frameError.get("message") instanceof String s ? s : null,
                        code instanceof Number n ? n.intValue() : null,
                        frameError.get("errorCode") instanceof String s ? s : null,
                        null));
                    journal.append(Events.turnError(clientFacingId, api.message(), promptId, api.kind(), api.kind()));
                }
                if (terminal == null) terminal = Frames.terminalOf(frame);
            }

            if (!errorSent) {
                if (terminal != null) {
                    journal.append(Events.turnComplete(clientFacingId,
                        terminal.rawStopReason() != null ? terminal.rawStopReason() : "end_turn", promptId));
                } else {
                    ApiError api = frameCount == 0 && !acks.isEmpty()
                        ? ApiError.promptNotDispatched(acks.get(0), System.currentTimeMillis() - startedAt)
                        : ApiError.streamBreakWithoutTerminal(frameCount);
                    journal.append(Events.turnError(clientFacingId, api.message(), promptId, api.kind(), api.kind()));
                }
            }
        } catch (DasApiException e) {
            if (!errorSent) {
                ApiError api = ApiError.redact(e.apiError());
                journal.append(Events.turnError(clientFacingId, api.message(), promptId, api.kind(), api.kind()));
            }
        } catch (Throwable t) {
            if (!errorSent) {
                ApiError api = Normalize.toApiError(t, "PromptAgentSession");
                journal.append(Events.turnError(clientFacingId, api.message(), promptId, api.kind(), api.kind()));
            }
        } finally {
            source.close();
            acquired.release().run();
            journal.activePrompt = false;
            journal.activePromptId = null;
            Map<String, Object> stats = new LinkedHashMap<>();
            stats.put("sessionId", record.realId);
            stats.put("clientFacingId", clientFacingId);
            stats.put("promptId", promptId);
            stats.put("frames", frameCount);
            stats.put("errorSent", errorSent);
            stats.put("elapsedMs", System.currentTimeMillis() - startedAt);
            log.info("daemon prompt 轮次收尾 {}", stats);
        }
    }

    // ------------------------------------------------------------------
    // 帧源：mock 与 live 的统一抽象（与 PromptApiController 里的同款骨架，
    // 但 daemon 侧要带 userText 去重 + scrubber，所以不进同一个类）
    // ------------------------------------------------------------------

    private interface FrameSource extends AutoCloseable {
        Map<String, Object> next() throws DasApiException;

        @Override
        void close();
    }

    private FrameSource openSource(String realId, String outbound, List<String> acks) {
        if (live != null) {
            return new LivePromptSource(live, realId, outbound, acks);
        }
        MockScenario scenario = MockFixtures.findScenario(realId);
        List<Map<String, Object>> frames = scenario != null && scenario.promptFixture() != null
            ? MockFixtures.readFixtureFrames(cfg.repoRoot(), scenario.promptFixture())
            : List.of();
        if (scenario != null && scenario.popAck() != null) acks.add(scenario.popAck());
        return new MockFrameSource(MockReplay.replayDefault(frames, cfg.mockRealtime(), cfg.mockSpeed()));
    }

    private static final class MockFrameSource implements FrameSource {
        private final Iterator<Map<String, Object>> iterator;

        MockFrameSource(Iterator<Map<String, Object>> iterator) {
            this.iterator = iterator;
        }

        @Override
        public Map<String, Object> next() {
            return iterator.hasNext() ? iterator.next() : null;
        }

        @Override
        public void close() {}
    }

    private static final class LivePromptSource implements FrameSource {
        private final LiveClient live;
        private final String sessionId;
        private final String outbound;
        private final List<String> acks;
        private SdkSseStream stream;

        LivePromptSource(LiveClient live, String sessionId, String outbound, List<String> acks) {
            this.live = live;
            this.sessionId = sessionId;
            this.outbound = outbound;
            this.acks = acks;
        }

        @Override
        public Map<String, Object> next() throws DasApiException {
            if (stream == null) {
                try {
                    stream = live.openPromptStream(sessionId, outbound, acks);
                } catch (Exception e) {
                    if (e instanceof DasApiException de) throw de;
                    throw new DasApiException(Normalize.toApiError(e, "PromptAgentSession"));
                }
            }
            while (true) {
                String data;
                try {
                    data = stream.next();
                } catch (SdkSseStream.SseException e) {
                    throw new DasApiException(Normalize.toApiError(e, "PromptAgentSession"));
                }
                if (data == null) return null;
                Object parsed;
                try {
                    parsed = new com.fasterxml.jackson.databind.ObjectMapper().readValue(data, Object.class);
                } catch (Exception e) {
                    continue;
                }
                Map<String, Object> frame = Frames.frameFromSdkBody(parsed);
                if (frame != null) return frame;
                String ack = Frames.popAckRequestId(parsed);
                if (ack != null) {
                    acks.add(ack);
                }
            }
        }

        @Override
        public void close() {
            if (stream != null) stream.close();
        }
    }

    @SuppressWarnings("unchecked")
    private static String textOf(Map<String, Object> update) {
        Object content = update.get("content");
        if (content instanceof Map<?, ?> map && map.get("text") instanceof String s) return s;
        if (content instanceof String s) return s;
        return "";
    }
}
