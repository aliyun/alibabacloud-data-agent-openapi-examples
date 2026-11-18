package com.das.java.live;

import com.das.java.core.ApiError;
import com.das.java.live.Normalize.DasApiException;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Raw SDK response reader: complete UTF-8 SSE frames, bounded payload, owned cancellation. */
final class RawSse implements AutoCloseable {
    record Frame(String id, String event, String data) {}
    final RemoteEventStream remote;
    final RemoteEventStream.Metadata metadata;
    private final Reader reader;
    private long deadline;
    RawSse(RemoteEventStream remote) throws Exception {
        this(remote, 30_000);
    }
    RawSse(RemoteEventStream remote, long timeoutMs) throws Exception {
        this.remote = remote;
        long openingDeadline = System.nanoTime()+Math.max(1, timeoutMs)*1_000_000;
        try {
            metadata = remote.metadata(timeoutMs);
            String contentType = metadata.headers().entrySet().stream().filter(e -> e.getKey().equalsIgnoreCase("content-type"))
                .map(Map.Entry::getValue).findFirst().orElse("");
            if (metadata.status() != 200) {
                String id = requestId();
                if (id == null) {
                    ByteArrayOutputStream body = new ByteArrayOutputStream();
                    byte[] chunk;
                    long errorDeadline = Math.min(openingDeadline, System.nanoTime()+10_000_000_000L);
                    while ((chunk = remote.next(Math.max(1, (errorDeadline-System.nanoTime())/1_000_000))) != null) {
                        if (System.nanoTime() >= errorDeadline) break;
                        if (body.size()+chunk.length > 65_536) break;
                        body.write(chunk);
                    }
                    try {
                        var error = new com.fasterxml.jackson.databind.ObjectMapper().readTree(body.toByteArray());
                        if (error != null) id = ApiError.validRequestId(error.path("RequestId").asText(null));
                    } catch (Exception ignored) { /* Never include private error payloads. */ }
                }
                throw new SdkSseStream.SseException("SSE HTTP failure", metadata.status(), id);
            }
            if (!contentType.matches("(?i)text/event-stream(?:\\s*;.*)?")) throw invalid();
        } catch (Exception failure) { remote.close(); throw failure; }
        reader = new InputStreamReader(new InputStream() {
            byte[] bytes = new byte[0]; int position;
            @Override public int read() throws IOException {
                while (position == bytes.length) {
                    long remaining = (deadline-System.nanoTime())/1_000_000;
                    if (remaining <= 0) throw new IOException("SSE frame deadline exceeded");
                    bytes = remote.next(remaining); position = 0;
                    if (bytes == null) return -1;
                }
                return bytes[position++] & 255;
            }
            @Override public int read(byte[] target, int offset, int length) throws IOException {
                if (length == 0) return 0;
                int first = read(); if (first < 0) return -1;
                target[offset] = (byte) first;
                int count = Math.min(length-1, bytes.length-position);
                System.arraycopy(bytes, position, target, offset+1, count); position += count;
                return count+1;
            }
        }, StandardCharsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT));
    }
    String requestId() { return Normalize.headerRequestId(metadata.headers()); }
    Frame next(long timeout) throws Exception {
        deadline = System.nanoTime()+Math.max(1, timeout > 0 ? timeout : 600_000)*1_000_000;
        List<String> lines = new ArrayList<>(); StringBuilder line = new StringBuilder(); int size = 0;
        for (;;) {
            if (System.nanoTime() >= deadline) throw new IOException("SSE frame deadline exceeded");
            int value;
            try { value = reader.read(); } catch (java.nio.charset.CharacterCodingException invalid) { throw invalid(); }
            if (value < 0) return null; // Incomplete data never becomes an applied frame.
            if (++size > 4*1024*1024) throw invalid();
            if (value != '\n') { line.append((char) value); continue; }
            String current = line.toString(); line.setLength(0);
            if (current.endsWith("\r")) current = current.substring(0, current.length()-1);
            if (!current.isEmpty()) { lines.add(current); continue; }
            String id = null, type = null; List<String> data = new ArrayList<>();
            for (String field : lines) {
                if (field.startsWith(":")) continue;
                int colon = field.indexOf(':');
                String key = colon < 0 ? field : field.substring(0, colon);
                String text = colon < 0 ? "" : field.substring(colon+1);
                if (text.startsWith(" ")) text = text.substring(1);
                switch (key) {
                    case "id" -> { if (id != null || text.indexOf(0) >= 0) throw invalid(); id = text; }
                    case "event" -> { if (type != null) throw invalid(); type = text; }
                    case "data" -> data.add(text);
                    case "retry" -> { }
                    default -> throw invalid();
                }
            }
            if (!data.isEmpty()) return new Frame(id, type, String.join("\n", data));
            lines.clear(); size = 0;
        }
    }
    static DasApiException invalid() { return new DasApiException(ApiError.of("stream_break", "原生事件续传契约校验失败")); }
    @Override public void close() { remote.close(); }
}
