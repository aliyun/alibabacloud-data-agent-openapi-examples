package com.das.java.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** daemon journal。与 Node 实现的 server-node/test/daemon-journal.test.ts 同源同语义。 */
class JournalTest {

    private static Map<String, Object> updateEvent(int n) {
        return Events.sessionUpdate("s", Map.of(
            "sessionUpdate", "agent_message_chunk",
            "content", Map.of("type", "text", "text", "chunk-" + n)
        ), null);
    }

    @Test
    void appendAssignsMonotonicIdsAndSinceFilters() {
        Journal journal = new Journal();
        Journal.Entry a = journal.append(updateEvent(1));
        Journal.Entry b = journal.append(updateEvent(2));
        assertEquals(1, a.id());
        assertEquals(2, b.id());
        assertEquals(2, journal.lastId());
        assertEquals(List.of(2L), journal.since(1).stream().map(Journal.Entry::id).toList());
        assertEquals(List.of(1L, 2L), journal.since(0).stream().map(Journal.Entry::id).toList());
        assertTrue(journal.since(2).isEmpty());
    }

    @Test
    void seedOnlyOnEmptyJournalAndCompactedLiveSplit() {
        Journal journal = new Journal();
        journal.seed(List.of(updateEvent(1), updateEvent(2), updateEvent(3)));
        journal.append(updateEvent(4));
        journal.seed(List.of(updateEvent(9))); // 第二次 load：不能覆盖

        assertEquals(List.of(1L, 2L, 3L, 4L), journal.all().stream().map(Journal.Entry::id).toList());
        assertEquals(List.of(1L, 2L, 3L), journal.compacted().stream().map(Journal.Entry::id).toList());
        assertEquals(List.of(4L), journal.live().stream().map(Journal.Entry::id).toList());
    }

    @Test
    void waitForMoreReturnsImmediatelyOnNewEventsAndEmptyOnTimeout() throws Exception {
        Journal journal = new Journal();
        journal.append(updateEvent(1));

        var wokenList = new java.util.concurrent.atomic.AtomicReference<List<Journal.Entry>>();
        Thread waiter = new Thread(() -> {
            try {
                wokenList.set(journal.waitForMore(1, 5_000));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        waiter.start();
        Thread.sleep(50);
        journal.append(updateEvent(2)); // append 必须唤醒等待者
        waiter.join(2_000);
        assertEquals(List.of(2L), wokenList.get().stream().map(Journal.Entry::id).toList());

        List<Journal.Entry> timedOut = journal.waitForMore(2, 20);
        assertTrue(timedOut.isEmpty());
    }

    @Test
    void eventsCarryIdsWhenJournaled() {
        Journal journal = new Journal();
        Journal.Entry entry = journal.append(Events.turnComplete("s", "end_turn", "p1"));
        assertEquals(1, entry.id());
        assertEquals(1L, ((Number) entry.event().get("id")).longValue());
        assertEquals("turn_complete", entry.event().get("type"));
        @SuppressWarnings("unchecked")
        Map<String, Object> data = (Map<String, Object>) entry.event().get("data");
        assertEquals("s", data.get("sessionId"));
        assertEquals("end_turn", data.get("stopReason"));
        assertEquals("p1", data.get("promptId"));
    }
}
