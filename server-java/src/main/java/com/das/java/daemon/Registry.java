package com.das.java.daemon;

import com.das.java.config.AppConfig;
import com.das.java.core.Marker;
import com.das.java.live.LiveClient;
import com.das.java.mock.MockFixtures;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** 会话注册表：始终以 OpenAPI 返回的真实 sessionId 为身份。 */
public class Registry {
    private static final Logger log = LoggerFactory.getLogger(Registry.class);

    /**
     * standalone 会话没有真实工作区，但契约要求 workspaceCwd 为非空字符串。
     * 用一个稳定的假路径：所有会话共用，侧栏不会按工作区分组出多个假区。
     */
    public static final String WORKSPACE_CWD = "/data-agent";

    public static class Record {
        /** 上游真实 SessionId——一切上游调用都用它。 */
        public final String realId;
        /**
         * daemon 分配的客户端身份：create/load 响应里回显（session.clientId），客户端发
         * prompt 时经 X-Qwen-Client-Id 带回——我们再盖上 user 回显事件的 originatorClientId，
         * web-shell 的 suppressOwnUserEcho 靠它精确匹配抑制自己的回显。
         */
        public final String clientId = UUID.randomUUID().toString();
        public final Journal journal = new Journal();
        /**
         * 在途 permission 请求：requestId → permission_request 的事件本体。
         * 用户点卡时 /session/:id/permission/:requestId 共享这份状态；回覆成功或上游
         * permission_resolved 时删除。
         */
        public final Map<String, Map<String, Object>> pendingPermissions = new java.util.concurrent.ConcurrentHashMap<>();
        /** rename 覆盖（进程级：上游没有改名接口，SessionTitle 恒为首条 prompt 原文）。 */
        public volatile String displayName;
        public volatile boolean archived;
        /** 本地删除标记（上游没有删除接口，只能挡住列表展示，进程级）。 */
        public volatile boolean deleted;
        public final long createdAt = System.currentTimeMillis();
        /** 最近一次列表拉取缓存的上游摘要（createdAt / 标题等真实值），单会话 lookup 兜底用。 */
        public volatile Map<String, Object> cachedSummary;

        Record(String realId) {
            this.realId = realId;
        }
    }

    private final Map<String, Record> byKey = new HashMap<>();
    /** 记录集合，用于统计与本地元数据视图。 */
    private final LinkedHashSet<Record> records = new LinkedHashSet<>();

    public synchronized Record resolve(String id) {
        return id == null ? null : byKey.get(id.toLowerCase());
    }

    public synchronized Record ensure(String realId) {
        String key = realId.toLowerCase();
        Record record = byKey.get(key);
        if (record == null) {
            record = new Record(realId);
            byKey.put(key, record);
            records.add(record);
        }
        return record;
    }

    /**
     * **重启/置换场景**：用 journal 里的事件量重新看清 `pendingPermissions`。
     *
     * 后端重启后 journal 丢光，pendingPermissions 自然也丢。用户重开会话时 load 会把
     * 上游历史播种回来——里面可能含着**仍然待解答**的 permission_request。
     * 不重建的话，那张卡的 DOM requestId 会向一个空表回应 → 404「无法 response」。
     * 重建规则：按 requestId 配对，permission_request 加，permission_resolved 减。
     */
    public static void rebuildPendingPermissions(Record record) {
        record.pendingPermissions.clear();
        for (Journal.Entry entry : record.journal.all()) {
            Map<String, Object> ev = entry.event();
            Object type = ev.get("type");
            Object data = ev.get("data");
            if (!(data instanceof Map<?, ?> dataMap)) continue;
            Object requestId = dataMap.get("requestId");
            if (!(requestId instanceof String rid)) continue;
            if ("permission_request".equals(type)) {
                record.pendingPermissions.put(rid, ev);
            } else if ("permission_resolved".equals(type) || "permission_already_resolved".equals(type)) {
                record.pendingPermissions.remove(rid);
            }
        }
    }

    public synchronized List<Record> allRecords() {
        return new ArrayList<>(records);
    }

    /** 状态面板（GET /daemon/status）用的注册表统计。 */
    public synchronized Map<String, Object> stats() {
        int activePrompts = 0;
        for (Record record : records) {
            if (record.journal.activePrompt) activePrompts += 1;
        }
        return Map.of("sessions", records.size(), "activePrompts", activePrompts);
    }

    // ------------------------------------------------------------------
    // 会话摘要（webshell 语义下的 standalone summary）
    // ------------------------------------------------------------------

    /** 会话摘要列表（侧栏数据源）。上游失败时返回空列表并 warn——空侧栏比 500 诚实。 */
    public List<Map<String, Object>> listSummaries(AppConfig cfg, LiveClient live) {
        List<Map<String, Object>> base;
        if (live != null) {
            try {
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> sessions =
                    (List<Map<String, Object>>) live.listSessions().get("sessions");
                base = sessions != null ? sessions : List.of();
            } catch (Exception e) {
                log.warn("daemon 会话列表：上游 ListAgentSessions 失败，本次返回空列表：{}", e.getMessage());
                return List.of();
            }
        } else {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> sessions =
                (List<Map<String, Object>>) MockFixtures.mockSessions(cfg.sessionSource()).get("sessions");
            base = sessions;
        }

        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> summary : base) {
            String sessionId = (String) summary.get("sessionId");
            Record record = resolve(sessionId);
            if (record != null && (record.deleted || record.archived)) continue;
            Map<String, Object> standalone = toStandalone(summary, record);
            if (record != null) record.cachedSummary = standalone;
            out.add(standalone);
        }
        return out;
    }

    /** webshell 会话摘要：必填字段钉死在 SDK 的 parseStandaloneSummary 校验器上。 */
    private Map<String, Object> toStandalone(Map<String, Object> summary, Record record) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sessionId", summary.get("sessionId"));
        out.put("workspaceCwd", WORKSPACE_CWD);
        out.put("createdAt", isoOf(summary.get("createdAt")));
        out.put("updatedAt", isoOf(summary.get("updatedAt")));
        String title = summary.get("title") instanceof String s ? Marker.stripMarkerInstruction(s) : "";
        String displayName = record != null && record.displayName != null
            ? record.displayName
            : (!title.isEmpty() ? title : String.valueOf(summary.get("sessionId")).substring(0, 8));
        out.put("displayName", displayName);
        out.put("clientCount", 0);
        out.put("hasActivePrompt", record != null && record.journal.activePrompt);
        out.put("isWaitingForPermission", false);
        out.put("sourceType", "standalone");
        out.put("context", Map.of("kind", "standalone"));
        if (summary.get("mockScenario") != null) out.put("mockScenario", summary.get("mockScenario"));
        return out;
    }

    /** 归档视图（`?archiveState=archived`）：注册表里 archived 且未删除的记录。 */
    public List<Map<String, Object>> archivedSummaries() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Record record : allRecords()) {
            if (!record.archived || record.deleted) continue;
            out.add(summaryFor(record, record.realId));
        }
        return out;
    }

    /** 单会话 lookup（GET /standalone/sessions/:id）：优先列表缓存，没有就最小可用形状。 */
    public Map<String, Object> summaryFor(Record record, String clientFacingId) {
        Map<String, Object> cached = record.cachedSummary;
        if (cached != null) {
            Map<String, Object> out = new LinkedHashMap<>(cached);
            out.put("sessionId", clientFacingId);
            out.put("displayName", record.displayName != null ? record.displayName : cached.get("displayName"));
            out.put("hasActivePrompt", record.journal.activePrompt);
            return out;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sessionId", clientFacingId);
        out.put("workspaceCwd", WORKSPACE_CWD);
        out.put("createdAt", Instant.ofEpochMilli(record.createdAt).toString());
        out.put("updatedAt", Instant.ofEpochMilli(record.createdAt).toString());
        out.put("displayName", record.displayName != null ? record.displayName : clientFacingId.substring(0, 8));
        out.put("clientCount", 0);
        out.put("hasActivePrompt", record.journal.activePrompt);
        out.put("isWaitingForPermission", false);
        out.put("sourceType", "standalone");
        out.put("context", Map.of("kind", "standalone"));
        return out;
    }

    /** createdAt/updatedAt 都按上游毫秒时间戳转 ISO（与 Node new Date(ms).toISOString() 对齐）。 */
    private static String isoOf(Object value) {
        long ms = value instanceof Number n ? n.longValue() : 0L;
        return Instant.ofEpochMilli(ms).toString();
    }
}
