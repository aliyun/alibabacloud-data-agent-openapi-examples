package com.das.java.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * pendingPermissions 的「重启后就不可回」回归验证。
 *
 * 痛点：后端重启后 journal 与 pendingPermissions 一起清空（进程级）。用户重开会话时
 * load 会把历史播种回来，里面仍可能含**待解答**的 permission_request；没有重建的话，
 * 那张卡的 DOM requestId 会向一个空表回应 → 404「无法 response」（LIVE 实测过的情形）。
 * 语义与 Node daemon-pending-rebuild.test.ts、Python tests/test_daemon.py 中的两条逐条对齐。
 */
class PendingRebuildTest {

    private Journal journalWith(Object[][] pairs) {
        Journal journal = new Journal();
        for (Object[] pair : pairs) {
            String requestId = (String) pair[0];
            boolean isResolved = Boolean.TRUE.equals(pair[1]);
            journal.append(
                isResolved
                    ? Events.permissionResolved("sess-1", requestId, java.util.Map.of("outcome", "selected"))
                    : Events.permissionRequest(
                        "sess-1", requestId, java.util.Map.of("toolCallId", "tc-" + requestId), null,
                        List.of(java.util.Map.of("optionId", "proceed_once", "name", "同意"))
                    )
            );
        }
        return journal;
    }

    @Test
    void rebuildPairsRequestAndResolution() {
        Registry registry = new Registry();
        Registry.Record record = registry.ensure("sess-1");
        record.journal.seed(
            journalWith(new Object[][]{
                {"req-a", false}, {"req-b", false}, {"req-b", true},
            }).all().stream().map(Journal.Entry::event).toList()
        );

        // 模拟重启：清了 pending（但 journal 保留——重启实际是两项都丢，种子重新播种后同样读这项）
        record.pendingPermissions.clear();
        Registry.rebuildPendingPermissions(record);

        assertEquals(java.util.Set.of("req-a"), record.pendingPermissions.keySet());
        assertEquals("permission_request", record.pendingPermissions.get("req-a").get("type"));
    }

    @Test
    void resolutionNotReOffered() {
        Registry registry = new Registry();
        Registry.Record record = registry.ensure("sess-1");
        record.journal.seed(
            journalWith(new Object[][]{{"req-a", false}, {"req-a", true}})
                .all().stream().map(Journal.Entry::event).toList()
        );
        Registry.rebuildPendingPermissions(record);
        assertTrue(record.pendingPermissions.isEmpty());
    }

    @Test
    void outOfBandPendingIsWiped() {
        Registry registry = new Registry();
        Registry.Record record = registry.ensure("sess-1");
        record.journal.seed(
            journalWith(new Object[][]{{"req-a", false}}).all().stream().map(Journal.Entry::event).toList()
        );
        record.pendingPermissions.put("req-ghost",
            Events.permissionRequest("sess-1", "req-ghost", null, null, List.of()));
        Registry.rebuildPendingPermissions(record);
        assertEquals(java.util.Set.of("req-a"), record.pendingPermissions.keySet());
    }
}
