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

    @Test
    @SuppressWarnings("unchecked")
    void questionOptionsDoNotInventToolApproval() {
        var plain = Events.permissionRequest("s", "r", Map.of("_meta", Map.of("toolName", "shell")), null, List.of());
        assertEquals(List.of(), ((Map<String, Object>) plain.get("data")).get("options"));
        var question = Events.permissionRequest("s", "r", Map.of("_meta", Map.of("toolName", "ask_user_question")), null,
            List.of(Map.of("optionId", "real-allow", "kind", "allow_once")));
        var data = (Map<String, Object>) question.get("data");
        assertEquals(List.of(Map.of("optionId", "real-allow", "label", "real-allow", "kind", "allow_once")), data.get("options"));
        assertTrue(!data.containsKey("openApiAnswersOnly"));
    }

    @Test
    void restoredQuestionSendsOnlyAnswersUpstream() throws Exception {
        var live = org.mockito.Mockito.mock(com.das.java.live.LiveClient.class);
        var cfg = org.mockito.Mockito.mock(com.das.java.config.AppConfig.class);
        String id = "00000000-0000-4000-8000-000000000001";
        org.mockito.Mockito.when(live.loadFrames(id)).thenReturn(List.of(
            Map.of("RequestId", "turn-1", "Params", Map.of("update", Map.of(
                "sessionUpdate", "user_message_chunk", "content", Map.of("type", "text", "text", "Ask a question")))),
            Map.of("RequestId", "turn-1", "Params", Map.of("kind", "permission_request", "data", Map.of(
                "requestId", "question-1", "toolCall", Map.of("_meta", Map.of("toolName", "ask_user_question")))))
        ));
        Map<String, Object> input = Map.of("permissionRequestId", "question-1", "outcome", "selected", "answers", Map.of("0", "A"));
        org.mockito.Mockito.when(live.reply(id, input)).thenReturn(Map.of("accepted", true));
        var controller = new DaemonController(cfg, new com.das.java.live.LiveClientHolder(live), new com.das.java.web.Inflight());
        assertEquals(200, controller.loadSession(id).getStatusCode().value());
        assertEquals(200, controller.permissionOnSession(id, "question-1", Map.of(
            "outcome", Map.of("outcome", "selected", "optionId", Events.OPENAPI_ANSWERS_OPTION), "answers", Map.of("0", "A")
        )).getStatusCode().value());
        org.mockito.Mockito.verify(live).reply(id, input);
    }
}
