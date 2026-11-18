package com.das.java.live;

import com.das.java.core.ApiError;
import com.das.java.core.Frames;
import com.das.java.live.Normalize.DasApiException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;

/** Request-owned native Events continuation; never re-Prompt, merge Load history, or Cancel on disconnect. */
public final class RecoveringPromptStream implements AutoCloseable {
    interface Source extends AutoCloseable {
        String next(long timeoutMs) throws Exception;
        default String requestId() { return null; }
        default String rpcId() { return null; }
        @Override void close();
    }
    interface Loader { Source open(EventCursor cursor, long remainingMs) throws Exception; }
    private static final ObjectMapper JSON = new ObjectMapper();
    private final String promptId;
    private final String sessionId;
    private final Loader loader;
    private final int maxAttempts;
    private final long budgetMs, delayMs;
    private volatile Source source;
    private volatile boolean closed;
    private EventCursor cursor;
    private boolean ended;
    private String popRequestId;
    private int attempt;
    private long deadline;

    public String requestId() { return popRequestId; }
    RecoveringPromptStream(String promptId, Source source, Loader loader) {
        this(promptId, null, source, loader, 3, 600_000, 250);
    }
    RecoveringPromptStream(String promptId, Source source, Loader loader, int attempts, long budgetMs, long delayMs) {
        this(promptId, null, source, loader, attempts, budgetMs, delayMs);
    }
    RecoveringPromptStream(String promptId, String sessionId, Source source, Loader loader, int attempts, long budgetMs, long delayMs) {
        this.promptId = promptId; this.sessionId = sessionId; this.source = source; this.loader = loader;
        this.maxAttempts = attempts; this.budgetMs = budgetMs; this.delayMs = delayMs;
    }
    static Source wrap(SdkSseStream stream) { return wrap(stream, null); }
    static Source wrap(SdkSseStream stream, String rpcId) {
        return new Source() {
            public String next(long timeoutMs) throws Exception { return stream.next(timeoutMs); }
            public String requestId() { return stream.requestId(); }
            public String rpcId() { return rpcId; }
            public void close() { stream.close(); }
        };
    }
    private static class SubscriptionInterrupted extends Exception {}
    private void take(Map<String, Object> frame) throws Exception {
        EventCursor next = EventCursor.read(frame, sessionId);
        if (next != null && cursor != null && (!next.eventEpoch().equals(cursor.eventEpoch())
            || !next.promptId().equals(cursor.promptId()) || Long.parseLong(next.eventId()) <= Long.parseLong(cursor.eventId())))
            throw RawSse.invalid();
        if (cursor != null && next == null) {
            if (frame.get("Error") instanceof Map<?, ?> error && !"DAEMON_STREAM_CONTRACT_INVALID".equals(error.get("errorCode")))
                throw new SubscriptionInterrupted();
            throw RawSse.invalid();
        }
        Map<?, ?> result = frame.get("Result") instanceof Map<?, ?> map ? map : Map.of();
        if (next != null && (frame.get("Error") != null || result.get("stopReason") instanceof String)) {
            if (!next.eventType().equals(frame.get("Error") == null ? "turn_complete" : "turn_error")
                || !promptId.equals(String.valueOf(frame.get("Id")))) throw RawSse.invalid();
            ended = true;
        }
        if (next != null) cursor = next;
    }
    private boolean resumable() { return !ended && cursor != null; }
    public String next() throws DasApiException {
        while (!closed && !ended) {
            if (deadline > 0 && System.nanoTime() >= deadline) return null;
            try {
                if (source == null) {
                    popRequestId = null; source = loader.open(cursor, remainingMs());
                }
                if (closed) { source.close(); return null; }
                String data = source.next(deadline == 0 ? 600_000 : remainingMs());
                String headerId = ApiError.validRequestId(source.requestId());
                if (headerId != null) popRequestId = headerId;
                if (data != null) {
                    Object parsed;
                    try { parsed = JSON.readValue(data, Object.class); } catch (Exception invalid) { throw RawSse.invalid(); }
                    String ack = Frames.popAckRequestId(parsed);
                    if (ack != null && headerId == null) popRequestId = ack;
                    Map<String, Object> frame = Frames.frameFromSdkBody(parsed);
                    if (frame != null) take(frame);
                    return data;
                }
            } catch (Exception error) {
                if (closed || Thread.currentThread().isInterrupted()) return null;
                String headerId = source == null ? null : ApiError.validRequestId(source.requestId());
                if (headerId != null) popRequestId = headerId;
                ApiError api = Normalize.toApiError(error, attempt == 0 ? "PromptAgentSession" : "GetAgentSessionEvents")
                    .withRequestId(popRequestId).withPreferredRequestId(headerId);
                popRequestId = api.requestId();
                if (!resumable() || !(error instanceof SubscriptionInterrupted) && !"transport".equals(api.kind()))
                    throw new DasApiException(api);
            }
            if (source != null) source.close();
            source = null;
            if (!resumable() || attempt >= maxAttempts) return null;
            if (deadline == 0) deadline = System.nanoTime()+budgetMs*1_000_000;
            long delay = delayMs*(1L << attempt);
            if (remainingMs() <= delay) return null;
            try { Thread.sleep(delay); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return null; }
            attempt++;
        }
        return null;
    }
    private long remainingMs() { return Math.max(1, (deadline-System.nanoTime())/1_000_000); }
    @Override public void close() { closed = true; if (source != null) source.close(); }
}
