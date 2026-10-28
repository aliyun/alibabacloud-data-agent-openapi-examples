package com.das.java.live;

import com.das.java.core.ApiError;
import com.das.java.core.Frames;
import com.das.java.live.Normalize.DasApiException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;

/** 旧 Prompt 的有界只读续传。关闭本地流不会重发 Prompt 或调用 Cancel。 */
public final class RecoveringPromptStream implements AutoCloseable {
    interface Source extends AutoCloseable {
        String next(long timeoutMs) throws Exception;
        default String rpcId() { return null; }
        @Override void close();
    }
    interface Loader { Source open(long offset, long remainingMs) throws Exception; }
    private static final ObjectMapper JSON = new ObjectMapper();
    private final String promptId;
    private final Loader loader;
    private final int maxAttempts;
    private final long budgetMs;
    private final long delayMs;
    private volatile Source source;
    private volatile boolean closed;
    private String rid;
    private long offset;
    private String sessionId;
    private boolean ended;
    private int attempt;
    private long deadline;

    RecoveringPromptStream(String promptId, Source source, Loader loader) {
        this(promptId, source, loader, 3, 600_000, 250);
    }
    RecoveringPromptStream(String promptId, Source source, Loader loader, int attempts, long budgetMs, long delayMs) {
        this.promptId = promptId;
        this.source = source;
        this.loader = loader;
        this.maxAttempts = attempts;
        this.budgetMs = budgetMs;
        this.delayMs = delayMs;
    }

    static Source wrap(SdkSseStream stream) { return wrap(stream, null); }

    static Source wrap(SdkSseStream stream, String rpcId) {
        return new Source() {
            public String next(long timeoutMs) throws Exception { return stream.next(timeoutMs); }
            public String rpcId() { return rpcId; }
            public void close() { stream.close(); }
        };
    }

    @SuppressWarnings("unchecked")
    private boolean take(Map<String, Object> frame) throws DasApiException {
        boolean replay = attempt > 0;
        Map<?, ?> params = frame.get("Params") instanceof Map<?, ?> map ? map : Map.of();
        Map<?, ?> meta = params.get("_meta") instanceof Map<?, ?> map ? map : Map.of();
        Object raw = meta.get("offset");
        boolean positioned = raw instanceof Number n && n.doubleValue() == n.longValue()
            && n.longValue() > 0 && n.longValue() <= 9_007_199_254_740_991L;
        if (!replay) {
            if (rid == null) rid = Frames.requestIdOf(frame);
            if (sessionId == null && params.get("sessionId") instanceof String value) sessionId = value;
        }
        boolean own = rid != null && (rid.equals(frame.get("RequestId"))
            || (frame.get("RequestId") == null && sessionId != null && sessionId.equals(params.get("sessionId")) && positioned));
        if (replay && sessionId != null && params.get("sessionId") != null && !sessionId.equals(params.get("sessionId"))) return false;
        boolean response = promptId.equals(String.valueOf(frame.get("Id"))) && (frame.get("RequestId") == null || own);
        // Load 自身错误有自己的 JSON-RPC Id；历史中其他轮的错误不能污染本轮。
        if (replay && frame.get("Error") instanceof Map<?, ?> error && frame.get("Id") != null
            && String.valueOf(frame.get("Id")).equals(source.rpcId())) {
            throw new DasApiException(ApiError.classify(
                error.get("message") instanceof String text ? text : "LoadAgentSession failed",
                error.get("code") instanceof Number n ? n.intValue() : null,
                error.get("errorCode") instanceof String text ? text : null, null));
        }
        if (replay && frame.get("Id") != null && String.valueOf(frame.get("Id")).equals(source.rpcId())) return false;
        if (replay && !own && !response) return false;
        Map<?, ?> result = frame.get("Result") instanceof Map<?, ?> map ? map : Map.of();
        boolean terminal = result.get("stopReason") instanceof String reason && !reason.isEmpty();
        if (frame.get("Error") != null || terminal) ended = true;
        if (own && positioned) {
            long next = ((Number)raw).longValue();
            if (replay && next <= offset) return false;
            offset = Math.max(offset, next);
        } else if (replay && params.get("update") != null && !terminal) {
            if (!Boolean.TRUE.equals(meta.get("waitForResponse"))) {
                throw new DasApiException(ApiError.streamBreakWithoutTerminal(0));
            }
            return false;
        }
        return true;
    }

    private boolean resumable() { return !ended && rid != null && offset > 0; }

    public String next() throws DasApiException {
        while (!closed && !ended) {
            if (deadline > 0 && System.nanoTime() >= deadline) return null;
            try {
                if (source == null) source = loader.open(offset, remainingMs());
                if (closed) { source.close(); return null; }
                String data = source.next(deadline == 0 ? 0 : remainingMs());
                if (data != null) {
                    Map<String, Object> frame;
                    try { frame = Frames.frameFromSdkBody(JSON.readValue(data, Object.class)); }
                    catch (Exception malformed) { continue; }
                    if (frame == null) { if (attempt == 0) return data; continue; }
                    if (take(frame)) return data;
                    continue;
                }
            } catch (Exception error) {
                if (closed || Thread.currentThread().isInterrupted()) return null;
                ApiError api = Normalize.toApiError(error, attempt == 0 ? "PromptAgentSession" : "LoadAgentSession");
                if (!resumable() || !"transport".equals(api.kind())) throw new DasApiException(api);
            }
            if (source != null) source.close();
            source = null;
            if (!resumable() || attempt >= maxAttempts) return null;
            if (deadline == 0) deadline = System.nanoTime() + budgetMs * 1_000_000;
            long delay = delayMs * (1L << attempt);
            if (remainingMs() <= delay) return null;
            try { Thread.sleep(delay); }
            catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return null; }
            attempt++;
        }
        return null;
    }

    private long remainingMs() { return Math.max(1, (deadline - System.nanoTime()) / 1_000_000); }
    @Override public void close() { closed = true; if (source != null) source.close(); }
}
