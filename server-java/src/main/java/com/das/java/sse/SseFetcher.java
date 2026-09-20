package com.das.java.sse;

import com.das.java.config.AppConfig;
import com.das.java.sign.Acs3Signer;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * 手写 SSE 通道：ACS3 签名 POST PromptAgentSession / LoadAgentSession，逐行解析
 * `data:` 事件为 JSON 对象。与 Node SDK 的 callSSEApi（@alicloud/openapi-core 9.x）
 * 上线路径逐字节对齐（reqBodyType=formData：application/x-www-form-urlencoded 表单体）。
 *
 * 为什么不用 Java SDK：dataworks_public20240518 的 9.8.0（Maven 当前最新）没有
 * *WithSSE 变体；Java SDK 升级出 SSE 变体后，这里可以与 LiveClient 其余接口合并。
 *
 * 线程模型：fetch() 开一个后台线程做 HTTP 读取，把解析出的载荷推进队列；
 * 消费端 next() 阻塞取。生成器结束（流读完 / close()）以 done 信号收尾。
 */
public final class SseFetcher implements AutoCloseable {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(10);

    public static final class SseException extends Exception {
        private final Integer statusCode;

        public SseException(String message, Integer statusCode) {
            super(message);
            this.statusCode = statusCode;
        }

        public SseException(String message, Throwable cause) {
            super(message, cause);
            this.statusCode = null;
        }

        public Integer statusCode() {
            return statusCode;
        }
    }

    private static final Object END = new Object();

    private final LinkedBlockingQueue<Object> queue = new LinkedBlockingQueue<>();
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(CONNECT_TIMEOUT).build();
    private volatile Thread reader;
    private volatile boolean closed;

    /**
     * 发起签名 POST 并开始解析。
     *
     * @param action X-Acs-Action（PromptAgentSession / LoadAgentSession）
     * @param params JSON-RPC Params（PascalCase 线格式键；会作为 JSON 字符串塞进表单字段 Params）
     * @param rpcId  JSON-RPC Id（上游要求存在；与 rid 不是一回事）
     *
     * 读超时不在 java.net.http 的 request.timeout 上设——那个超时只管到响应头到达，
     * 管不到 SSE 的停滞读（RUNNING 期 load 会阻塞到轮次结束）。停滞上限由消费端
     * 用 next(timeoutMs) 逐次执行（load 30s 快速失败；prompt 由流管道的 330s 硬上限兜底）。
     */
    public SseFetcher(AppConfig cfg, String action, Map<String, Object> params, String rpcId)
        throws SseException {
        String endpoint = cfg.endpoint() != null
            ? cfg.endpoint()
            : "dataworks." + cfg.regionId() + ".aliyuncs.com";

        String paramsJson;
        try {
            paramsJson = params == null ? null : MAPPER.writeValueAsString(params);
        } catch (Exception e) {
            throw new SseException("序列化 Params 失败：" + e.getMessage(), e);
        }

        // 与 SDK 生成的请求体一致：toForm({Id, Jsonrpc, Params})（PascalCase 键）
        Map<String, String> form = new LinkedHashMap<>();
        form.put("Id", rpcId);
        form.put("Jsonrpc", "2.0");
        if (paramsJson != null) form.put("Params", paramsJson);
        byte[] body = Acs3Signer.toFormString(form).getBytes(StandardCharsets.UTF_8);
        String payloadHash = Acs3Signer.sha256Hex(body);

        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("host", endpoint);
        headers.put("x-acs-version", "2024-05-18");
        headers.put("x-acs-action", action);
        headers.put("user-agent", "das-server-java/0.1.0 (acs3-sse; java.net.http)");
        headers.put("x-acs-date", Acs3Signer.nowDate());
        headers.put("x-acs-signature-nonce", Acs3Signer.newNonce());
        headers.put("accept", "application/json");
        headers.put("content-type", "application/x-www-form-urlencoded");
        headers.put("x-acs-content-sha256", payloadHash);
        String authorization = Acs3Signer.authorization(
            "POST", "/", Map.of(), headers, payloadHash, cfg.accessKeyId(), cfg.accessKeySecret());

        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create("https://" + endpoint + "/"))
            .POST(HttpRequest.BodyPublishers.ofByteArray(body));
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if (e.getKey().equalsIgnoreCase("host")) continue; // HttpClient 自己管理 Host
            builder.header(e.getKey(), e.getValue());
        }
        builder.header("authorization", authorization);

        reader = new Thread(() -> readLoop(builder.build(), action), "sse-fetch-" + action);
        reader.setDaemon(true);
        reader.start();
    }

    private void readLoop(HttpRequest request, String action) {
        try {
            HttpResponse<java.io.InputStream> response =
                client.send(request, HttpResponse.BodyHandlers.ofInputStream());
            int status = response.statusCode();
            if (status >= 400) {
                // 非 2xx：响应体是错误 JSON（POP 层），读出来交给上层归一化。
                String text = new String(response.body().readAllBytes(), StandardCharsets.UTF_8);
                queue.put(new Failure(parseUpstreamError(text, status, action), status));
                return;
            }
            try (BufferedReader in = new BufferedReader(new InputStreamReader(response.body(), StandardCharsets.UTF_8))) {
                StringBuilder data = new StringBuilder();
                String line;
                while (!closed && (line = in.readLine()) != null) {
                    if (line.isEmpty()) {
                        // 事件边界：把攒下的 data 行合成一个载荷
                        emit(data.toString());
                        data.setLength(0);
                        continue;
                    }
                    if (line.startsWith("data:")) {
                        String piece = line.substring(5);
                        if (piece.startsWith(" ")) piece = piece.substring(1);
                        if (data.length() > 0) data.append('\n');
                        data.append(piece);
                    }
                    // event:/id:/retry: 与本工程语义无关，忽略（上游实测只发 data:）
                }
                emit(data.toString());
            }
            queue.put(END);
        } catch (IOException e) {
            if (closed) return; // close() 引起的读失败不是错误
            offerFailure(new SseException(action + " SSE 读取故障：" + e.getMessage(), e));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private record Failure(SseException error, int status) {}

    private void emit(String data) throws InterruptedException {
        if (data == null || data.trim().isEmpty() || closed) return;
        queue.put(data);
    }

    private void offerFailure(SseException error) {
        queue.offer(new Failure(error, error.statusCode() != null ? error.statusCode() : -1));
    }

    /** 上游非 2xx 的错误体里把 message / code / requestId 捞出来（POP 层 JSON）。 */
    private static SseException parseUpstreamError(String text, int status, String action) {
        String message = null;
        String requestId = null;
        String code = null;
        try {
            Object parsed = MAPPER.readValue(text, Object.class);
            if (parsed instanceof Map<?, ?> map) {
                Object m = map.get("Message") != null ? map.get("Message") : map.get("message");
                if (m instanceof String s) message = s;
                Object r = map.get("RequestId") != null ? map.get("RequestId") : map.get("requestId");
                if (r instanceof String s) requestId = s;
                Object c = map.get("Code") != null ? map.get("Code") : map.get("code");
                if (c instanceof String s) code = s;
            }
        } catch (Exception ignored) {
            // 响应体不是 JSON：原样截短使用
        }
        StringBuilder sb = new StringBuilder(action).append(" 上游返回 HTTP ").append(status);
        if (message != null) sb.append("：").append(message);
        if (code != null) sb.append(" [").append(code).append(']');
        if (requestId != null) sb.append("，RequestId ").append(requestId);
        if (message == null) {
            String shortText = text.length() > 200 ? text.substring(0, 200) : text;
            sb.append("：").append(shortText);
        }
        return new SseException(sb.toString(), status);
    }

    /** 不限期等下一个载荷。 */
    public String next() throws SseException {
        return next(0);
    }

    /**
     * 取下一个 `data:` 载荷（JSON 字符串）。流结束返回 null。
     * 上游故障抛 SseException（statusCode 可空；HTTP 错误带有 statusCode）。
     *
     * @param timeoutMs >0 时最多等这么久；超时抛 SseException（调用方据此实现
     *                  HISTORY_READ_TIMEOUT_MS 的快速失败）。
     */
    public String next(long timeoutMs) throws SseException {
        long deadline = timeoutMs > 0 ? System.nanoTime() + timeoutMs * 1_000_000L : Long.MAX_VALUE;
        while (true) {
            Object item;
            try {
                long waitMs = timeoutMs > 0
                    ? Math.max(1, Math.min(1000, (deadline - System.nanoTime()) / 1_000_000L))
                    : 1000;
                item = queue.poll(waitMs, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new SseException("SSE 消费被中断", e);
            }
            if (item == null) {
                if (closed) return null;
                if (timeoutMs > 0 && System.nanoTime() >= deadline) {
                    throw new SseException("SSE 读停滞超过 " + timeoutMs + "ms", (Integer) null);
                }
                continue;
            }
            if (item == END) return null;
            if (item instanceof Failure f) throw f.error();
            return (String) item;
        }
    }

    /** 停掉后台读取（客户端断开 / 撞硬上限）：不重发、不 cancel——服务端那一轮还在跑。 */
    @Override
    public void close() {
        closed = true;
        if (reader != null) {
            reader.interrupt();
        }
    }
}
