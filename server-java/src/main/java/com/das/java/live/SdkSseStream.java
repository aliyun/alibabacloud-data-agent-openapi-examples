package com.das.java.live;

import com.fasterxml.jackson.databind.ObjectMapper;
import darabonba.core.TeaModel;
import java.util.Iterator;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * 官方异步 SDK 的 SSE 流式调用（*WithResponseIterable）→ 阻塞式拉取句柄。
 * 对外契约与 Node 侧 callSSEApi 的消费管道一致：next() 逐次吐出与线格式
 * `data:` 等价的 JSON 字符串，下游 Frames 管道零改动。
 *
 * 模型 → 载荷的保真：响应体的 @NameInMap 就是线格式 PascalCase 键（Jsonrpc/
 * Method/Params/…），Params/Result 声明为 Object（自由帧），toMap() 唯一会
 * 多出的是顶层 null 键（上游 JSON 是省略 null 的）——剥掉后逐字节等价。
 * 剥的只是顶层：Params 本身是自由 Map，原样透传。
 *
 * 线程模型：构造时开一个后台线程驱动 SDK 迭代器（hasNext 内部是 5ms 轮询），
 * 把解析出的载荷推进队列；消费端 next() 阻塞取。与旧手写实现（SseFetcher）
 * 相同的骨架，只是读取侧换成了 SDK。
 *
 * 中止语义的变化（如实交代）：SDK 的 ResponseIterable/SSEResponseIterator 没有
 * per-stream cancel，close() 只能停止消费——HTTP 连接由 SDK 持有，直到上游
 * 结束那一轮才释放。旧实现 close() 会立刻杀掉连接。取消轮次的行为不受影响
 * （cancel 走 CancelAgentSession，与流解耦）。
 */
public final class SdkSseStream implements AutoCloseable {
    private static final ObjectMapper MAPPER = new ObjectMapper();

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
    private volatile Thread reader;
    private volatile boolean closed;

    /**
     * @param api       接口名（仅用于错误消息）
     * @param source    SDK 迭代器（ResponseIterable.iterator()，阻塞式）
     * @param statusCode  HTTP 状态码来源（ResponseIterable::getStatusCode；出错时附上）
     *
     * 停滞上限不在迭代器上设（SDK 没有读超时概念，READ_TIMEOUT 在 builder 里被注释掉了），
     * 由消费端用 next(timeoutMs) 逐次执行（load 30s 快速失败；prompt 不设整轮硬上限）。
     */
    public SdkSseStream(String api, Iterator<? extends TeaModel> source, Supplier<Integer> statusCode) {
        reader = new Thread(() -> readLoop(api, source, statusCode), "sdk-sse-" + api);
        reader.setDaemon(true);
        reader.start();
    }

    private void readLoop(String api, Iterator<? extends TeaModel> source, Supplier<Integer> statusCode) {
        try {
            // hasNext() 阻塞到下一帧 / 流结束 / 失败；失败时 sneakyThrow 原始异常
            // （可能是受检类型，所以这里按 Throwable 接）。
            while (!closed && source.hasNext()) {
                TeaModel item = source.next();
                if (item == null) continue;
                String data = payloadJson(api, item);
                if (data != null) queue.put(data);
            }
            queue.put(END);
        } catch (Throwable t) {
            if (closed) return; // close() 引起的迭代失败不是错误
            // statusCode 可空（pre-flight 失败根本没收到 HTTP 响应）；绝不能在这里再崩——
            // 错误路径再抛异常会让读取线程静默死掉，消费端永远等不到结束信号。
            Integer status;
            try {
                status = statusCode.get();
            } catch (Exception ignored) {
                status = null;
            }
            SseException failure = new SseException(api + " SSE 读取故障：" + describe(t), status);
            failure.initCause(t);
            queue.offer(new Failure(failure));
        }
    }

    private record Failure(SseException error) {}

    /**
     * 模型 → 线格式 `data:` 载荷。toMap() 给出 PascalCase 键；剥顶层 null
     * （上游序列化省略 null，保留会让 Frames 管道多出上游没有的键）。
     */
    static String payloadJson(String api, TeaModel item) {
        Map<String, Object> map = item.toMap();
        map.values().removeIf(Objects::isNull);
        try {
            return MAPPER.writeValueAsString(map);
        } catch (Exception e) {
            // 序列化失败的是单帧，不弄垮整条流：跳过（与下游"认不出的形状跳过"同理）。
            return null;
        }
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

    /** 停止消费（客户端断开 / 撞硬上限）。不重发、不 cancel——服务端那一轮还在跑。 */
    @Override
    public void close() {
        closed = true;
        if (reader != null) {
            reader.interrupt();
        }
    }

    /** 类名 + message + 根 cause：迭代器 sneakyThrow 的原异常必须能溯源到 SDK 内部类。 */
    private static String describe(Throwable t) {
        StringBuilder sb = new StringBuilder();
        Throwable current = t;
        for (int depth = 0; current != null && depth < 4; depth++) {
            if (depth > 0) sb.append(" ← ");
            sb.append(current.getClass().getSimpleName());
            if (current.getMessage() != null && !current.getMessage().isEmpty()) {
                sb.append('(').append(current.getMessage()).append(')');
            }
            current = current.getCause();
        }
        return sb.toString();
    }
}
