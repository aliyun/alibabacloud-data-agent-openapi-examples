package com.das.java.live;

import com.das.java.live.Normalize.DasApiException;
import java.util.*;

/** Public native identity; neither a history offset nor a request/trace ID. */
record EventCursor(String sessionId, String eventEpoch, String eventId, String promptId, String eventType) {
    Map<String, Object> toMap() { return Map.of("sessionId", sessionId, "eventEpoch", eventEpoch,
        "eventId", eventId, "promptId", promptId, "eventType", eventType); }
    static EventCursor read(Map<String, Object> frame, String expected) throws DasApiException {
        Object metadata = frame.getOrDefault("_meta", frame.getOrDefault("Meta", frame.get("meta")));
        if (!(metadata instanceof Map<?, ?> meta)) return null;
        Object raw = meta.getOrDefault("eventCursor", null);
        if (raw == null) raw = meta.get("EventCursor");
        if (raw == null) return null;
        if (!(raw instanceof Map<?, ?> cursor)) throw RawSse.invalid();
        var values = new ArrayList<String>();
        for (String key : List.of("sessionId", "eventEpoch", "eventId", "promptId", "eventType")) {
            Object value = cursor.containsKey(key) ? cursor.get(key) : cursor.get(Character.toUpperCase(key.charAt(0))+key.substring(1));
            if (!(value instanceof String text) || text.isEmpty()) throw RawSse.invalid();
            values.add(text);
        }
        EventCursor result = new EventCursor(values.get(0), values.get(1), values.get(2), values.get(3), values.get(4));
        if (expected != null && !expected.equals(result.sessionId) || !result.eventEpoch.matches("[A-Za-z0-9_-]{1,64}")
            || !result.eventId.matches("[0-9]{1,16}") || Long.parseLong(result.eventId) < 1
            || Long.parseLong(result.eventId) > 9_007_199_254_740_991L) throw RawSse.invalid();
        return result;
    }
}
