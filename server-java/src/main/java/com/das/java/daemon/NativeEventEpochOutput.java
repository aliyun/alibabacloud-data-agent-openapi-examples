package com.das.java.daemon;

import jakarta.servlet.http.HttpServletResponse;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Map;

/** Verify native identity before committing headers, including POP streams with only a body handshake. */
final class NativeEventEpochOutput extends OutputStream {
    private final HttpServletResponse response;
    private final String expected;
    private final ByteArrayOutputStream prelude = new ByteArrayOutputStream();
    private String epoch;
    private boolean observed;

    NativeEventEpochOutput(HttpServletResponse response, String expected, String header) throws IOException {
        this.response = response;
        this.expected = expected;
        epoch = header;
        if (header != null && (!valid(header) || expected != null && !expected.equals(header)))
            throw new IOException("GetAgentSessionEvents epoch mismatch");
    }

    private static boolean valid(String value) { return value.matches("[A-Za-z0-9_-]{1,64}"); }

    void observe(Map<String, Object> event) {
        if ("stream_open".equals(event.get("type")) && event.get("data") instanceof Map<?, ?> data
            && data.containsKey("eventEpoch")) {
            Object value = data.get("eventEpoch");
            if (!(value instanceof String nativeEpoch) || !valid(nativeEpoch)
                || epoch != null && !epoch.equals(nativeEpoch))
                throw new IllegalStateException("GetAgentSessionEvents epoch mismatch");
            epoch = nativeEpoch;
        }
        if (expected != null && !expected.equals(epoch))
            throw new IllegalStateException("GetAgentSessionEvents epoch could not be verified");
        if (!observed && epoch != null) response.setHeader("X-Qwen-Event-Epoch", epoch);
        observed = true;
    }

    @Override public void write(int value) throws IOException { write(new byte[]{(byte) value}, 0, 1); }
    @Override public void write(byte[] bytes, int offset, int length) throws IOException {
        if (!observed) {
            if (length > 65_536 - prelude.size()) throw new IOException("GetAgentSessionEvents opening prelude exceeds 64 KiB");
            prelude.write(bytes, offset, length);
            return;
        }
        OutputStream output = response.getOutputStream();
        if (prelude.size() != 0) { prelude.writeTo(output); prelude.reset(); }
        output.write(bytes, offset, length);
    }

    @Override public void flush() throws IOException { if (observed) response.getOutputStream().flush(); }

    void finish() throws IOException {
        if (!observed && expected != null) throw new IOException("GetAgentSessionEvents missing opening frame");
        if (!observed) observed = true;
        write(new byte[0]);
        flush();
    }
}
