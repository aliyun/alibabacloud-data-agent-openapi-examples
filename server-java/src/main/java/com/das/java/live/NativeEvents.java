package com.das.java.live;

import com.das.java.core.Frames;
import com.fasterxml.jackson.databind.*;
import java.util.*;

/** One SDK subscription owns its native identity, global sequence and replay receipt proof. */
public final class NativeEvents implements AutoCloseable {
    private static final ObjectMapper JSON = new ObjectMapper()
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
        .enable(com.fasterxml.jackson.core.JsonParser.Feature.STRICT_DUPLICATE_DETECTION);
    private static final Set<String> CONTROL = Set.of("stream_open", "replay_complete", "slow_client_warning");
    private final RawSse input;
    private final String sessionId, requestedEpoch;
    private final boolean replay;
    private Long scanned;
    private long count;
    private String epoch, nativeSessionId;
    private boolean receipt;
    private final ArrayDeque<Map<String, Object>> ready = new ArrayDeque<>();
    private final List<Map<String, Object>> suffix = new ArrayList<>();
    private int suffixBytes;

    public NativeEvents(RemoteEventStream stream, String sessionId, String cursor, String requestedEpoch) throws Exception {
        this(stream, sessionId, cursor, requestedEpoch, 30_000);
    }
    NativeEvents(RemoteEventStream stream, String sessionId, String cursor, String requestedEpoch, long timeoutMs) throws Exception {
        input = new RawSse(stream, Math.min(30_000, timeoutMs));
        this.sessionId = sessionId; this.requestedEpoch = requestedEpoch; replay = cursor != null;
        if (cursor != null && (!cursor.matches("[0-9]{1,16}") || Long.parseLong(cursor) > 9_007_199_254_740_991L)
            || requestedEpoch != null && (cursor == null || !requestedEpoch.matches("[A-Za-z0-9_-]{1,64}"))) {
            close(); throw RawSse.invalid();
        }
        scanned = cursor == null ? null : Long.parseLong(cursor);
    }
    public String epoch() { return epoch; }
    public String requestId() { return input.requestId(); }
    public Map<String, Object> next(long timeoutMs) throws Exception {
        long deadline = System.nanoTime()+Math.max(1, timeoutMs > 0 ? timeoutMs : 600_000)*1_000_000;
        while (ready.isEmpty()) {
            long left = (deadline-System.nanoTime())/1_000_000;
            if (left <= 0) throw new java.io.IOException("Events read deadline exceeded");
            RawSse.Frame wire = input.next(left);
            if (wire == null) { if (replay && !receipt || epoch == null) throw RawSse.invalid(); return null; }
            Map<String, Object> event = decode(wire);
            if (event == null) continue;
            String type = (String) event.get("type");
            if (replay && !receipt && (!suffix.isEmpty() || Set.of("turn_complete", "turn_error").contains(type))) {
                suffixBytes += JSON.writeValueAsBytes(event).length;
                if (suffix.size() >= 4096 || suffixBytes > 4*1024*1024) throw RawSse.invalid();
                suffix.add(event); continue;
            }
            if (type.equals("replay_complete")) { ready.addAll(suffix); suffix.clear(); }
            ready.add(event);
        }
        return ready.remove();
    }
    private JsonNode parse(String value) throws Exception {
        try { return JSON.readTree(value); } catch (Exception failure) { throw RawSse.invalid(); }
    }
    private static long integer(JsonNode value) throws Exception {
        if (value == null || !value.isIntegralNumber() || !value.canConvertToLong()
            || value.longValue() < 0 || value.longValue() > 9_007_199_254_740_991L) throw RawSse.invalid();
        return value.longValue();
    }
    private Map<String, Object> decode(RawSse.Frame wire) throws Exception {
        JsonNode outer = parse(wire.data());
        if (outer == null || !outer.isObject()) throw RawSse.invalid();
        if (outer.size() == 1 && (outer.has("RequestId") || outer.has("requestId") || outer.has("ACKRequestId"))) return null;
        for (String key : List.of("Error", "error", "Code", "code")) if (outer.hasNonNull(key)) throw RawSse.invalid();
        JsonNode value = outer;
        JsonNode field = outer.has("Event") ? outer.get("Event") : outer.get("event");
        String hint = wire.event();
        if (field != null) {
            if (field.isTextual() && !field.textValue().stripLeading().startsWith("{")) {
                hint = field.textValue(); value = outer.has("Data") ? outer.get("Data") : outer.get("data");
                if (value != null && value.isTextual()) value = parse(value.textValue());
            } else value = field.isTextual() ? parse(field.textValue()) : field;
        } else if (outer.has("Data") && !outer.has("type")) value = outer.get("Data");
        if (value == null || !value.isObject()) throw RawSse.invalid();
        String type = value.path("type").asText(null);
        JsonNode data = value.has("data") ? value.get("data") : value.get("Data");
        if (type == null) {
            if (value.has("update") || value.has("Update")) type = "session_update";
            else if (value.has("stopReason") || value.has("StopReason")) type = "turn_complete";
            else type = hint;
            if (data == null) data = value;
        }
        if (type == null || type.isBlank() || type.indexOf('\n') >= 0 || type.indexOf('\r') >= 0
            || hint != null && !hint.equals("message") && !hint.equals(type)) throw RawSse.invalid();
        if (data == null) data = JSON.createObjectNode();
        if (!data.isObject()) throw RawSse.invalid();
        Map<String, Object> body = JSON.convertValue(data, Map.class);
        for (String key : List.of("SessionId", "Update", "PromptId", "StopReason")) if (body.containsKey(key)) {
            body.putIfAbsent(Character.toLowerCase(key.charAt(0))+key.substring(1), body.get(key)); body.remove(key);
        }
        for (JsonNode supplied : List.of(value.path("sessionId"), data.path("sessionId"), data.path("SessionId"))) {
            if (!supplied.isMissingNode() && (!supplied.isTextual() || !supplied.textValue().equals(sessionId)
                && !supplied.textValue().equals(nativeSessionId))) throw RawSse.invalid();
        }
        String prompt = value.path("promptId").asText(null);
        Object nested = body.get("promptId");
        if (value.has("promptId") && (prompt == null || prompt.isEmpty())
            || nested != null && (!(nested instanceof String text) || text.isEmpty())
            || prompt != null && nested != null && !prompt.equals(nested)) throw RawSse.invalid();
        if (prompt == null && nested instanceof String text) prompt = text;
        if (Set.of("turn_complete", "turn_error").contains(type) && prompt == null) throw RawSse.invalid();
        String transport = wire.id();
        JsonNode outerId = outer.has("Id") ? outer.get("Id") : outer.get("id");
        if (transport == null && outerId != null) transport = outerId.asText();
        Map<String, Object> event = new LinkedHashMap<>(); event.put("v", 1); event.put("type", type); event.put("data", body);
        if (prompt != null) event.put("promptId", prompt);
        for (String key : List.of("originatorClientId", "_meta")) if (value.has(key)) event.put(key, JSON.convertValue(value.get(key), Object.class));
        if (CONTROL.contains(type)) {
            boolean emptyReset = "".equals(transport) && (type.equals("stream_open")
                || type.equals("replay_complete") && data.path("replayedCount").isIntegralNumber() && data.path("replayedCount").longValue() == 0);
            if (value.has("id") || transport != null && !emptyReset && (!transport.matches("[0-9]{1,16}") || scanned == null
                || Long.parseLong(transport) != scanned)) throw RawSse.invalid();
        }
        if (type.equals("stream_open")) {
            Object actual = body.get("eventEpoch"), nativeId = body.get("nativeSessionId");
            if (epoch != null || !sessionId.equals(body.get("sessionId")) || !(actual instanceof String text)
                || !text.matches("[A-Za-z0-9_-]{1,64}") || !(nativeId instanceof String nativeText)
                || !nativeText.matches("[A-Za-z0-9_-]{1,128}") || requestedEpoch != null && !requestedEpoch.equals(text)) throw RawSse.invalid();
            epoch = text; nativeSessionId = nativeText; return event;
        }
        if (epoch == null || Set.of("state_resync_required", "client_evicted", "stream_error", "session_died").contains(type)) throw RawSse.invalid();
        if (body.containsKey("sessionId")) body.put("sessionId", sessionId);
        if (type.equals("replay_complete")) {
            long total = integer(data.get("replayedCount"));
            if (receipt || total != count) throw RawSse.invalid();
            boolean hasLast = false;
            for (String key : List.of("lastReplayedEventId", "lastEventId")) if (data.has(key)) {
                hasLast = true; if (total == 0 || scanned == null || integer(data.get(key)) != scanned) throw RawSse.invalid();
            }
            if (total > 0 && !hasLast) throw RawSse.invalid();
            receipt = true; return event;
        }
        if (type.equals("slow_client_warning")) return event;
        JsonNode id = value.has("id") ? value.get("id") : outerId;
        long number;
        if (id != null && id.isIntegralNumber()) number = integer(id);
        else if (transport != null && transport.matches("[0-9]{1,16}")) number = Long.parseLong(transport);
        else throw RawSse.invalid();
        if (number < 1 || number > 9_007_199_254_740_991L || scanned != null && number != scanned+1
            || transport != null && (!transport.matches("[0-9]{1,16}") || Long.parseLong(transport) != number)) throw RawSse.invalid();
        scanned = number; if (!receipt) count++; event.put("id", number);
        if (type.equals("permission_request") && body.get("requestId") instanceof String requestId && body.get("options") instanceof List<?> options) {
            Map<String, Object> tool = body.get("toolCall") instanceof Map<?, ?> map ? Frames.asMap(map) : Map.of();
            List<Map<String, Object>> mapped = new ArrayList<>();
            for (Object raw : options) { Map<String, Object> option = new LinkedHashMap<>(Frames.asMap(raw));
                if (!option.containsKey("name") && option.containsKey("label")) option.put("name", option.get("label")); mapped.add(option); }
            body.putAll(Frames.asMap(com.das.java.daemon.Events.permissionRequest(sessionId, requestId, tool,
                body.get("title") instanceof String title ? title : null, mapped).get("data")));
        }
        return event;
    }
    @Override public void close() { input.close(); }
}
