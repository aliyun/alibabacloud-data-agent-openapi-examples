package com.das.java.web;

import com.das.java.config.AppConfig;
import com.das.java.core.ApiError;
import com.das.java.core.Constants;
import com.das.java.core.Frames;
import com.das.java.live.LiveClient;
import com.das.java.live.Normalize;
import com.das.java.live.Normalize.DasApiException;
import com.das.java.live.SdkSseStream;
import com.das.java.mock.MockFixtures;
import com.das.java.mock.MockFixtures.MockScenario;
import com.das.java.mock.MockReplay;
import com.das.java.web.Inflight.AcquireResult;
import com.das.java.web.Inflight.Acquired;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * `POST /api/sessions/:id/prompt` → `application/x-ndjson`。与 Node 实现的
 * server-node/routes/prompt.ts、Python 实现的 main.py 中的 prompt 路由同源同语义。
 *
 * 这是全工程唯一一条流式路由，也是唯一一处"写操作"：prompt 一旦送出去，服务端那一轮
 * 就开始跑了，断开连接不会停掉它。所以顺序是硬的：
 * **校验参数 → 拿在途锁 → 进流 → 调上游**。把锁放在流开始之前，被拒的那一方还能
 * 拿到一个普通 JSON 响应。
 */
@RestController
public class PromptApiController {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Object END = new Object();

    private final AppConfig cfg;
    private final LiveClient live;
    private final Inflight inflight;

    public PromptApiController(AppConfig cfg, com.das.java.live.LiveClientHolder holder, Inflight inflight) {
        this.cfg = cfg;
        this.live = holder.client();
        this.inflight = inflight;
    }

    /**
     * 返回 ResponseEntity 的提前返回都是"还没碰到上游"的校验失败（普通 JSON）；
     * 一旦决定进流，就直接在请求线程上写 HttpServletResponse——
     * 不走 Spring 的 StreamingResponseBody 转换链（它只支持 application/json，
     * 会拒掉 application/x-ndjson），这与 Node/Python 的"一条流占一个执行单元"同构。
     */
    @PostMapping("/api/sessions/{id}/prompt")
    public ResponseEntity<Map<String, Object>> prompt(
        @PathVariable("id") String sessionId,
        @RequestBody(required = false) Map<String, Object> body,
        HttpServletResponse response) throws IOException {
        String text = body != null && body.get("text") instanceof String s ? s.trim() : "";
        if (text.isEmpty()) {
            return json(ApiError.apiError("rpc_error", "prompt 文本为空"));
        }

        // marker 归属校验已退役（2026-09-20）：不再注入校验码，prompt 原文即 outbound。
        String outbound = text;

        List<String> popRequestIds = new ArrayList<>();
        FrameSource source;
        if (live != null) {
            // 注意这里只是**登记**了参数，HTTP 请求要到 producer 线程第一次 next() 才发出——
            // 所以在途锁之前构造它并不会碰到上游（与 Node 异步生成器、Python async gen 的惰性和本一致）。
            source = new LivePromptSource(live, sessionId, outbound, popRequestIds);
        } else {
            MockScenario scenario = MockFixtures.findScenario(sessionId);
            if (scenario == null) {
                return json(ApiError.apiError("rpc_error", "MOCK 模式下没有这个会话：" + sessionId));
            }
            // ack-only 场景没有录制帧：回放空帧列表 ⇒ 与 live 走同一条收尾分类
            // （零帧 + 有回执 ⇒ prompt_not_dispatched）。
            List<Map<String, Object>> frames = scenario.promptFixture() != null
                ? MockFixtures.readFixtureFrames(cfg.repoRoot(), scenario.promptFixture())
                : List.of();
            source = new MockFrameSource(MockReplay.replayDefault(frames, cfg.mockRealtime(), cfg.mockSpeed()));
            if (scenario.popAck() != null) popRequestIds.add(scenario.popAck());
        }

        AcquireResult acquire = inflight.tryAcquire(sessionId);
        if (acquire instanceof Inflight.Rejected rejected) {
            source.close();
            return json(rejected.error());
        }
        Acquired acquired = (Acquired) acquire;

        response.setStatus(HttpServletResponse.SC_OK);
        response.setContentType(Wire.CONTENT_TYPE + "; charset=utf-8");
        response.setHeader("Cache-Control", "no-store, no-transform");
        response.setHeader("X-Accel-Buffering", "no");
        pump(response.getOutputStream(), source, sessionId, popRequestIds, acquired);
        return null; // 响应已由本方法写完，Spring 不再做视图/转换处理
    }

    private static ResponseEntity<Map<String, Object>> json(ApiError error) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("ok", false);
        body.put("error", error.toMap());
        return ResponseEntity.ok(body);
    }

    // ------------------------------------------------------------------
    // 帧源：mock 与 live 的统一抽象（同一个泵消费）
    // ------------------------------------------------------------------

    private interface FrameSource extends AutoCloseable {
        /** 下一帧；源结束返回 null。故障抛 DasApiException。 */
        Map<String, Object> next() throws DasApiException;

        @Override
        void close();
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

    /**
     * live 提示词的帧源：每帧过 frameFromSdkBody；POP 回执（不是帧）收集进 acks。
     * 构造是惰性的——第一次 next() 才真正发起流式调用（拿到在途锁之后才碰上游）。
     */
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
                    parsed = MAPPER.readValue(data, Object.class);
                } catch (Exception e) {
                    continue; // 非 JSON 载荷：视为认不出来的形状，跳过
                }
                Map<String, Object> frame = Frames.frameFromSdkBody(parsed);
                if (frame != null) return frame;
                String ack = Frames.popAckRequestId(parsed);
                if (ack != null) {
                    acks.add(ack);
                    continue;
                }
                // 真认不出来的形状：上游改了载荷。跳过（与 Node/Python 一致，warn 由日志承担）。
            }
        }

        @Override
        public void close() {
            if (stream != null) stream.close();
        }
    }

    // ------------------------------------------------------------------
    // 泵：约束与 Node 的 streamWire、Python 的 stream() 同源
    // （心跳 15s；硬上限 330s；客户端断开 → 释放锁并停源，不 cancel 不重发）
    // ------------------------------------------------------------------

    private void pump(
        OutputStream output,
        FrameSource source,
        String sessionId,
        List<String> popRequestIds,
        Acquired acquired
    ) throws IOException {
        Pipeline pipeline = new Pipeline(sessionId, live == null, System.currentTimeMillis());
        java.util.concurrent.LinkedBlockingQueue<Object> events = new java.util.concurrent.LinkedBlockingQueue<>();

        Thread producer = new Thread(() -> {
            try {
                while (true) {
                    Map<String, Object> frame = source.next();
                    if (frame == null) break;
                    for (Map<String, Object> event : pipeline.onFrame(frame)) {
                        events.put(event);
                        if ("meta".equals(event.get("type")) && pipeline.rid() != null) {
                            // 回填 rid 必须在流进行中，不能等流结束：锁拒绝日志靠它指认在途轮次。
                            acquired.entry().rid = pipeline.rid();
                        }
                    }
                }
                Map<String, Object> finish = pipeline.finish(popRequestIds);
                if (finish != null) events.put(finish);
            } catch (DasApiException e) {
                events.offer(pipeline.onError(e, "PromptAgentSession"));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (Throwable t) {
                events.offer(pipeline.onError(
                    new DasApiException(Normalize.toApiError(t, "PromptAgentSession")), "PromptAgentSession"));
            } finally {
                events.offer(END);
            }
        }, "prompt-producer-" + sessionId);
        producer.setDaemon(true);
        producer.start();

        long lastWrite = System.currentTimeMillis();
        try {
            while (true) {
                Object item = events.poll(1, java.util.concurrent.TimeUnit.SECONDS);
                long now = System.currentTimeMillis();
                if (item == null) {
                    if (now - lastWrite >= Constants.HEARTBEAT_MS) {
                        writeLine(output, Wire.heartbeat(now));
                        lastWrite = now;
                    }
                    continue;
                }
                if (item == END) break;
                @SuppressWarnings("unchecked")
                Map<String, Object> event = (Map<String, Object>) item;
                writeLine(output, event);
                lastWrite = System.currentTimeMillis();
            }
        } catch (IOException | RuntimeException writeFailure) {
            // 客户端断开：停源、释放锁，不 cancel 不重发——服务端那一轮还在跑。
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            source.close();
            acquired.release().run();
        }
    }

    private static void writeLine(OutputStream output, Map<String, Object> event) throws IOException {
        output.write((Wire.serialize(event) + "\n").getBytes(StandardCharsets.UTF_8));
        output.flush();
    }
}
