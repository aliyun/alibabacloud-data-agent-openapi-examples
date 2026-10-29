package com.das.java.live;

import com.das.java.core.ApiError;
import com.das.java.core.Frames;
import com.das.java.live.Normalize.DasApiException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** 快照跨多轮：中断后只读重拉，不按单轮 offset 拼接，完整回执前不返回历史。 */
final class LoadSnapshotReader {
    interface Opener { RecoveringPromptStream.Source open(long remainingMs) throws Exception; }
    private static final ObjectMapper JSON = new ObjectMapper();
    private LoadSnapshotReader() {}

    static List<Map<String, Object>> read(Opener open, long budgetMs, int attempts, long delayMs) throws Exception {
        long deadline = System.nanoTime() + budgetMs * 1_000_000L;
        String popRequestId = null;
        for (int attempt = 0; attempt < attempts && System.nanoTime() < deadline; attempt++) {
            List<Map<String, Object>> frames = new ArrayList<>();
            popRequestId = null;
            RecoveringPromptStream.Source opened = null;
            try (var source = open.open(remaining(deadline))) {
                opened = source;
                while (System.nanoTime() < deadline) {
                    String data = source.next(remaining(deadline));
                    String headerId = ApiError.validRequestId(source.requestId());
                    if (headerId != null) popRequestId = ApiError.validRequestId(headerId);
                    if (data == null) break;
                    Map<String, Object> frame;
                    try {
                        Object parsed = JSON.readValue(data, Object.class);
                        String ack = Frames.popAckRequestId(parsed);
                        if (ack != null && headerId == null) popRequestId = ack;
                        frame = Frames.frameFromSdkBody(parsed);
                    }
                    catch (Exception malformed) { continue; }
                    if (frame == null) continue;
                    boolean own = source.rpcId().equals(String.valueOf(frame.get("Id")));
                    if (frame.get("Error") instanceof Map<?, ?> error && (own || frame.get("Id") == null)) {
                        throw new DasApiException(ApiError.classify(
                            error.get("message") instanceof String value ? value : "LoadAgentSession failed",
                            error.get("code") instanceof Number n ? n.intValue() : null,
                            error.get("errorCode") instanceof String value ? value : null, null).withRequestId(popRequestId));
                    }
                    frames.add(frame);
                    if (own && frame.get("Result") instanceof Map<?, ?> result
                        && result.get("stopReason") instanceof String reason && !reason.isEmpty()) {
                        if (!"end_turn".equals(reason)) throw new DasApiException(ApiError.streamBreakWithoutTerminal(frames.size()).withRequestId(popRequestId));
                        return frames;
                    }
                }
            } catch (Exception error) {
                if (error instanceof InterruptedException) Thread.currentThread().interrupt();
                String headerId = opened == null ? null : ApiError.validRequestId(opened.requestId());
                if (headerId != null) popRequestId = ApiError.validRequestId(headerId);
                ApiError api = Normalize.toApiError(error, "LoadAgentSession").withRequestId(popRequestId).withPreferredRequestId(headerId);
                if (Thread.currentThread().isInterrupted() || !"transport".equals(api.kind())
                    || System.nanoTime() >= deadline || attempt + 1 >= attempts) throw new DasApiException(api);
            }
            if (attempt + 1 >= attempts) break;
            long delay = delayMs * (1L << attempt);
            if (remaining(deadline) <= delay) break;
            Thread.sleep(delay);
        }
        throw new DasApiException(ApiError.streamBreakWithoutTerminal(0).withRequestId(popRequestId));
    }

    private static long remaining(long deadline) { return Math.max(1, (deadline - System.nanoTime()) / 1_000_000); }
}
