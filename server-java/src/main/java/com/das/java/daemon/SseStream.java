package com.das.java.daemon;

import com.das.java.core.Constants;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * 把 journal 分发成一条 SSE 长连接（`GET /session/:id/events`）。
 * 与 Node 实现的 server-node/daemon/sse.ts 同源同语义。
 *
 * 帧格式对齐真 daemon：`id: <n>` + `event: <type>` + `data: {v:1,...}` 三行一帧。
 * 与 ndjson 泵的关键差异：这里**没有**"上游迭代器释放"问题——journal 是纯内存，
 * 客户端断开只需停轮询；上游那一轮由 runner 独立消费，与这条连接无关。
 */
public final class SseStream {
    private SseStream() {}

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /**
     * 在调用线程上跑 SSE 循环，直到客户端断开（写失败）或被打断。
     *
     * @param lastEventId 客户端 `Last-Event-ID` 头（断线续传游标）；null = 只看新事件
     * @param snapshot    `?snapshot=1`：连接即附一条 session_snapshot（合成事件，不入 journal、无 id）
     */
    public static void stream(
        OutputStream out, Journal journal, String sessionId, Long lastEventId, boolean snapshot
    ) throws IOException {
        // 游标落在已不存在的区间（journal 触顶丢弃 / 进程重启）。真 daemon 此处强制
        // resync；v1 先尽力续播——从现存最旧事件开始，丢段比整个会话打不开轻。
        long cursor;
        if (lastEventId != null) {
            if (journal.lastId() > 0 && journal.firstId() > lastEventId + 1) {
                cursor = journal.firstId() - 1;
            } else {
                cursor = lastEventId;
            }
        } else {
            cursor = journal.lastId();
        }

        if (snapshot) {
            writeEvent(out, Events.sessionSnapshot(sessionId), null);
        }

        while (true) {
            List<Journal.Entry> entries;
            try {
                entries = journal.waitForMore(cursor, Constants.HEARTBEAT_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            if (entries.isEmpty()) {
                // 心跳注释行：保活 + 让中间层别缓冲（不占事件 id 空间）。
                out.write(": hb\n\n".getBytes(StandardCharsets.UTF_8));
                out.flush();
                continue;
            }
            for (Journal.Entry entry : entries) {
                writeEvent(out, entry.event(), entry.id());
                cursor = entry.id();
            }
        }
    }

    private static void writeEvent(OutputStream out, Map<String, Object> event, Long id) throws IOException {
        StringBuilder sb = new StringBuilder();
        if (id != null) sb.append("id: ").append(id).append('\n');
        sb.append("event: ").append(event.get("type")).append('\n');
        sb.append("data: ").append(MAPPER.writeValueAsString(event)).append('\n').append('\n');
        out.write(sb.toString().getBytes(StandardCharsets.UTF_8));
        out.flush();
    }
}
