package com.das.java.live;

import static org.junit.jupiter.api.Assertions.*;

import com.aliyun.core.http.HttpHeaders;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.reactivestreams.Publisher;
import org.reactivestreams.Subscriber;
import org.reactivestreams.Subscription;

@Timeout(10)
class RemoteEventStreamTest {
    @Test void sdkFailureAfterMetadataCannotOvertakeBufferedBytesOrPublisherEnd() throws Exception {
        try (var stream = new RemoteEventStream()) {
            var publisher = start(stream);
            byte[] first = bytes(": heartbeat\n\n");
            byte[] second = bytes("id: 42\ndata: 你好🌏");
            byte[] third = bytes("\n\n");
            publisher.emit(first);
            publisher.emit(second);
            publisher.emit(third);
            publisher.complete();
            assertEquals(2, publisher.pending.size(), "HTTP EOF can precede draining demand-gated bytes");

            stream.onError(new IOException("SDK null-body post-processing"));
            stream.onError(new IOException("same failure forwarded by SDK future"));

            assertArrayEquals(first, stream.next());
            assertArrayEquals(second, stream.next());
            assertArrayEquals(third, stream.next());
            assertNull(stream.next());
            assertNull(stream.next());
        }
    }

    @Test void publisherOwnsErrorsAsSoonAsMetadataIsAvailableEvenBeforeFirstByte() throws Exception {
        try (var stream = new RemoteEventStream()) {
            var publisher = start(stream);
            stream.onError(new IOException("SDK failure before first byte"));
            publisher.emit(bytes("data: still streaming\n\n"));
            publisher.complete();
            assertArrayEquals(bytes("data: still streaming\n\n"), stream.next());
            assertNull(stream.next());
        }
    }

    @Test void subscriberFailureExposesRealTransportErrorAfterIgnoredSdkError() throws Exception {
        try (var stream = new RemoteEventStream()) {
            var publisher = start(stream);
            publisher.emit(bytes("partial frame"));
            stream.onError(new IOException("SDK post-processing"));
            var transport = new IOException("connection reset");
            publisher.fail(transport);
            // The SDK also reports the same transport failure through its handler/future.
            stream.onError(transport);

            assertArrayEquals(bytes("partial frame"), stream.next());
            assertSame(transport, assertThrows(IOException.class, stream::next).getCause());
            assertNull(stream.next());
            assertEquals(200, stream.metadata().status());
        }
    }

    @Test void failureBeforeHeadersPreservesFirstCauseAndRejectsLaterPublisher() throws Exception {
        try (var stream = new RemoteEventStream()) {
            var original = new IOException("request failed before response headers");
            stream.onError(null);
            stream.onError(original);
            stream.onError(new IOException("duplicate SDK failure"));
            assertSame(original, assertThrows(ExecutionException.class, stream::metadata).getCause());

            var late = new ManualPublisher();
            stream.onStream(late, 200, new HttpHeaders());
            assertEquals(1, late.subscription.cancellations);
            assertEquals(0, late.subscription.requests);
            late.lateBytes("must not replace failed request");
            late.subscriber.onComplete();
            assertSame(original, assertThrows(IOException.class, stream::next).getCause());
            assertNull(stream.next());
        }
    }

    @Test void closeUnblocksMetadataAndReaderBeforeHeadersAndCancelsLateSubscription() throws Exception {
        try (var stream = new RemoteEventStream();
             var metadata = new WaitingCall<>(stream::metadata);
             var reader = new WaitingCall<>(stream::next)) {
            metadata.awaitBlocked();
            reader.awaitBlocked();
            stream.close();

            Throwable failure = assertThrows(ExecutionException.class, metadata::get).getCause();
            assertInstanceOf(ExecutionException.class, failure);
            assertInstanceOf(IOException.class, failure.getCause());
            assertNull(reader.get());

            var late = new ManualPublisher();
            stream.onStream(late, 200, new HttpHeaders());
            assertEquals(1, late.subscription.cancellations);
            assertEquals(0, late.subscription.requests);
            stream.onError(new IOException("late SDK failure"));
            late.lateBytes("late bytes after close");
            assertNull(stream.next());
        }
    }

    @Test void closeUnblocksSubscribedReaderAndCancelsSubscriptionExactlyOnce() throws Exception {
        try (var stream = new RemoteEventStream()) {
            var publisher = start(stream);
            try (var reader = new WaitingCall<>(stream::next)) {
                reader.awaitBlocked();
                stream.close();
                stream.close();
                assertNull(reader.get());
                assertEquals(1, publisher.subscription.cancellations);
                assertEquals(200, stream.metadata().status());
                publisher.lateBytes("cancelled bytes");
                publisher.subscriber.onError(new IOException("cancel callback"));
                assertNull(stream.next());
            }
        }
    }

    @Test void closeBetweenHeadersAndOnSubscribeCancelsWithoutRequestingData() throws Exception {
        try (var stream = new RemoteEventStream()) {
            var publisher = new ManualPublisher();
            publisher.deferSubscription = true;
            stream.onStream(publisher, 200, new HttpHeaders());
            assertEquals(200, stream.metadata().status());
            stream.close();
            publisher.attachSubscription();
            assertEquals(1, publisher.subscription.cancellations);
            assertEquals(0, publisher.subscription.requests);
            assertNull(stream.next());
        }
    }

    @Test void repeatedSuccessAndLateErrorOrBytesCannotPolluteCompletedStream() throws Exception {
        try (var stream = new RemoteEventStream()) {
            var publisher = start(stream);
            publisher.emit(bytes("accepted"));
            publisher.complete();
            // Deliberately violate Publisher rules to check terminal idempotence.
            publisher.subscriber.onComplete();
            publisher.subscriber.onError(new IOException("late transport error"));
            publisher.lateBytes("bytes after completion");
            stream.onError(new IOException("late SDK error"));
            assertArrayEquals(bytes("accepted"), stream.next());
            assertNull(stream.next());
            publisher.lateBytes("bytes after END was consumed");
            assertNull(stream.next());
            assertNull(stream.next());
        }
    }

    @Test void repeatedFailureAndLateSuccessOrBytesCannotReplaceOriginalTransportError() throws Exception {
        try (var stream = new RemoteEventStream()) {
            var publisher = start(stream);
            var original = new IOException("first transport failure");
            publisher.fail(original);
            publisher.subscriber.onError(new IOException("duplicate transport failure"));
            publisher.subscriber.onComplete();
            publisher.lateBytes("bytes after failure");
            assertSame(original, assertThrows(IOException.class, stream::next).getCause());
            assertNull(stream.next());
            assertNull(stream.next());
        }
    }

    @Test void secondPublisherIsCancelledAndCannotContaminateOriginalStream() throws Exception {
        try (var stream = new RemoteEventStream()) {
            var original = start(stream);
            var duplicate = new ManualPublisher();
            stream.onStream(duplicate, 503, new HttpHeaders());
            assertEquals(1, duplicate.subscription.cancellations);
            duplicate.lateBytes("foreign bytes");
            duplicate.subscriber.onError(new IOException("foreign failure"));
            duplicate.subscriber.onComplete();
            original.emit(bytes("original bytes"));
            original.complete();
            assertEquals(200, stream.metadata().status());
            assertArrayEquals(bytes("original bytes"), stream.next());
            assertNull(stream.next());
        }
    }

    private static ManualPublisher start(RemoteEventStream stream) throws Exception {
        var publisher = new ManualPublisher();
        var headers = new HttpHeaders();
        headers.set("content-type", "text/event-stream");
        stream.onStream(publisher, 200, headers);
        assertEquals(200, stream.metadata().status());
        assertEquals("text/event-stream", stream.metadata().headers().get("content-type"));
        assertEquals(1, publisher.subscription.requests);
        return publisher;
    }

    private static byte[] bytes(String value) { return value.getBytes(StandardCharsets.UTF_8); }

    /** Models HTTP EOF while buffered chunks still wait for downstream demand. */
    private static final class ManualPublisher implements Publisher<ByteBuffer> {
        private final ArrayDeque<byte[]> pending = new ArrayDeque<>();
        private final ManualSubscription subscription = new ManualSubscription();
        private Subscriber<? super ByteBuffer> subscriber;
        private boolean deferSubscription;
        private boolean complete;
        private boolean terminalDelivered;

        @Override public void subscribe(Subscriber<? super ByteBuffer> value) {
            assertNull(subscriber, "one subscriber per fixture");
            subscriber = value;
            if (!deferSubscription) attachSubscription();
        }

        private void attachSubscription() { subscriber.onSubscribe(subscription); }

        private void emit(byte[] value) {
            pending.add(value);
            drain();
        }

        private void complete() {
            complete = true;
            drain();
        }

        private void fail(Throwable error) {
            terminalDelivered = true;
            subscriber.onError(error);
        }

        private void lateBytes(String value) { subscriber.onNext(ByteBuffer.wrap(bytes(value))); }

        private void drain() {
            while (!terminalDelivered && subscription.cancellations == 0
                    && subscription.demand > 0 && !pending.isEmpty()) {
                subscription.demand--;
                subscriber.onNext(ByteBuffer.wrap(pending.remove()));
            }
            if (!terminalDelivered && subscription.cancellations == 0 && complete && pending.isEmpty()) {
                terminalDelivered = true;
                subscriber.onComplete();
            }
        }

        private final class ManualSubscription implements Subscription {
            private long demand;
            private int requests;
            private int cancellations;

            @Override public void request(long value) {
                assertTrue(value > 0);
                requests++;
                demand += value;
                drain();
            }

            @Override public void cancel() { cancellations++; }
        }
    }

    /** Wait for the public blocking call itself, without scheduling sleeps or private-field access. */
    private static final class WaitingCall<T> implements AutoCloseable {
        private final CountDownLatch entered = new CountDownLatch(1);
        private final FutureTask<T> result;
        private final Thread thread;

        private WaitingCall(Callable<T> action) {
            result = new FutureTask<>(() -> {
                entered.countDown();
                return action.call();
            });
            thread = new Thread(result, "remote-event-stream-test-waiter");
            thread.setDaemon(true);
            thread.start();
        }

        private void awaitBlocked() throws InterruptedException {
            assertTrue(entered.await(2, TimeUnit.SECONDS));
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (System.nanoTime() < deadline) {
                Thread.State state = thread.getState();
                if (state == Thread.State.WAITING || state == Thread.State.TIMED_WAITING) return;
                assertFalse(result.isDone(), "call must block until the stream is closed");
                Thread.yield();
            }
            fail("stream call did not enter a blocking wait");
        }

        private T get() throws Exception { return result.get(2, TimeUnit.SECONDS); }

        @Override public void close() throws InterruptedException {
            result.cancel(true);
            thread.join(1000);
            assertFalse(thread.isAlive(), "test waiter must terminate");
        }
    }
}
