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
    private boolean publisherStarted;
    private boolean terminal;
    private boolean requestNext;
    private boolean readFinished;

    @Override public void onStream(Publisher<ByteBuffer> publisher, int status, HttpHeaders headers) {
        final boolean accepted;
        synchronized (this) {
            accepted = !closed && !terminal && !publisherStarted;
            if (accepted) {
                // Claim ownership before exposing headers: SDK response processing can
                // finish while the publisher still has buffered, demand-gated bytes.
                publisherStarted = true;
                metadata.complete(new Metadata(status, headers.toMap()));
            }
        }
        try { publisher.subscribe(new Subscriber<ByteBuffer>() {
            @Override public void onSubscribe(Subscription value) {
                boolean cancel;
                synchronized (RemoteEventStream.this) {
                    cancel = !accepted || closed || terminal || subscription != null;
                    if (!cancel) subscription = value;
                }
                if (cancel) value.cancel(); else value.request(1);
            }
            @Override public void onNext(ByteBuffer value) {
                byte[] bytes = new byte[value.remaining()];
                value.get(bytes);
                synchronized (RemoteEventStream.this) {
                    if (accepted && !closed && !terminal) chunks.offer(bytes);
                }
            }
            @Override public void onError(Throwable error) { if (accepted) finish(error); }
            @Override public void onComplete() { if (accepted) finish(null); }
        }); } catch (Throwable error) { if (accepted) finish(error); }
    }

    /** SDK execution errors only own the pre-response phase. Subscriber owns the raw stream. */
    @Override public synchronized void onError(Throwable error) {
        if (publisherStarted || error == null) return;
        finish(error);
    }

    private synchronized void finish(Throwable error) {
        if (closed || terminal) return;
        terminal = true;
        if (error != null) metadata.completeExceptionally(error);
        chunks.offer(error == null ? END : error);
    }

    public Metadata metadata() throws Exception { return metadata.get(30, TimeUnit.SECONDS); }

    public byte[] next() throws IOException {
        if (closed || readFinished) return null;
        if (requestNext && subscription != null) subscription.request(1);
        requestNext = true;
        try {
            Object value = chunks.take();
            if (value == END) { readFinished = true; return null; }
            if (value instanceof Throwable error) {
                readFinished = true;
                throw new IOException("GetAgentSessionEvents stream failed", error);
            }
            return (byte[]) value;
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("Event stream interrupted", error);
        }
    }

    @Override public void close() {
        Subscription cancel;
        synchronized (this) {
            if (closed) return;
            closed = true;
            terminal = true;
            metadata.completeExceptionally(new IOException("Event stream closed"));
            chunks.clear();
            chunks.offer(END);
            cancel = subscription;
        }
        if (cancel != null) cancel.cancel();
    }
}
