package com.das.java.live;

import com.aliyun.core.http.HttpHeaders;
import com.aliyun.core.http.HttpResponseHandler;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.reactivestreams.Publisher;
import org.reactivestreams.Subscriber;
import org.reactivestreams.Subscription;

/** Raw SDK transport. Pull one chunk at a time so a slow browser bounds memory usage. */
public final class RemoteEventStream implements HttpResponseHandler, AutoCloseable {
    public record Metadata(int status, Map<String, String> headers) {}
    private static final Object END = new Object();
    private final CompletableFuture<Metadata> metadata = new CompletableFuture<>();
    private final LinkedBlockingQueue<Object> chunks = new LinkedBlockingQueue<>();
    private volatile Subscription subscription;
    private volatile boolean closed;
    private boolean requestNext;

    @Override public void onStream(Publisher<ByteBuffer> publisher, int status, HttpHeaders headers) {
        metadata.complete(new Metadata(status, headers.toMap()));
        publisher.subscribe(new Subscriber<ByteBuffer>() {
            @Override public void onSubscribe(Subscription value) {
                subscription = value;
                if (closed) value.cancel(); else value.request(1);
            }
            @Override public void onNext(ByteBuffer value) {
                byte[] bytes = new byte[value.remaining()];
                value.get(bytes);
                if (!closed) chunks.offer(bytes);
            }
            @Override public void onError(Throwable error) { RemoteEventStream.this.onError(error); }
            @Override public void onComplete() { chunks.offer(END); }
        });
    }

    @Override public void onError(Throwable error) {
        if (error == null || closed) return;
        metadata.completeExceptionally(error);
        chunks.offer(error);
    }

    public Metadata metadata() throws Exception { return metadata.get(30, TimeUnit.SECONDS); }

    public byte[] next() throws IOException {
        if (closed) return null;
        if (requestNext && subscription != null) subscription.request(1);
        requestNext = true;
        try {
            Object value = chunks.take();
            if (value == END) return null;
            if (value instanceof Throwable error) throw new IOException("GetAgentSessionEvents stream failed", error);
            return (byte[]) value;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("Event stream interrupted", error);
        }
    }

    @Override public void close() {
        closed = true;
        if (subscription != null) subscription.cancel();
        chunks.clear();
        chunks.offer(END);
    }
}
