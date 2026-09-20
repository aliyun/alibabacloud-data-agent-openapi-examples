package com.das.java.daemon;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 单会话事件日志：daemon 模型（202 异步 prompt + SSE + Last-Event-ID 续传）的服务端事实源。
 * 与 Node 实现的 server-node/daemon/journal.ts 同源同语义。
 *
 * 与 `/api/sessions/:id/prompt`（把上游流直连到客户端连接）的本质区别：
 * 事件先进 journal，再由 SSE 分发——浏览器断线重连时从游标续播，而服务端对上游
 * 那一轮的消费（runner）不受任何客户端连接存亡影响。这正是选这套协议的动机：
 * 对抗上游 218~258s 断流墙时，"连接断了"与"轮次丢了"第一次解耦。
 */
public class Journal {
    /** id 严格单调的日志条目（event 是盖上 id 之后的副本，toMap 即线格式事件）。 */
    public record Entry(long id, Map<String, Object> event) {}

    /**
     * 内存上限。一轮长轮实测 1201 帧，20k 条大约等于十几个长轮；daemon 真身用
     * 环形缓冲 + resync，我们先把上限放大到"单进程演示用不完"的量级，
     * 触顶时丢弃最旧事件（见 compact 的注释）。
     */
    public static final int MAX_EVENTS = 20_000;

    private final List<Entry> entries = new ArrayList<>();
    private long nextId = 1;
    /**
     * 历史种子（load 回放）与之后 live 轮次的分界。load 响应把种子放 `compactedReplay`、
     * 之后的放 `liveJournal`，语义对齐真 daemon（provider 按序重放两段）。
     */
    private int seedCount;

    /** 有执行中的轮次（在途锁的另一面视图，供会话列表的 hasActivePrompt 用）。 */
    public volatile boolean activePrompt;
    /** 执行中轮次的 promptId（cancel 路由发 prompt_cancelled 事件要用）。 */
    public volatile String activePromptId;

    /** 追加一条事件。返回含分配序号的条目；event 被复制并盖上 id（调用方的 map 不再被改）。 */
    public synchronized Entry append(Map<String, Object> event) {
        long id = nextId++;
        Entry entry = new Entry(id, Events.withId(event, id));
        entries.add(entry);
        compact();
        notifyAll();
        return entry;
    }

    /**
     * 用历史帧翻译出的事件做种子。只在 journal 为空时执行——第二次 load 幂等返回
     * 同一份日志（种子 + 期间发生的 live 轮次），不会把历史重复灌一遍。
     */
    public synchronized void seed(List<Map<String, Object>> events) {
        if (!entries.isEmpty()) return;
        for (Map<String, Object> event : events) append(event);
        seedCount = entries.size();
    }

    /** id 严格大于 lastId 的事件（保持顺序）。lastId<=0 视为从头。 */
    public synchronized List<Entry> since(long lastId) {
        List<Entry> out = new ArrayList<>();
        for (Entry e : entries) {
            if (lastId <= 0 || e.id() > lastId) out.add(e);
        }
        return out;
    }

    /** 历史种子段（load 响应的 compactedReplay）。 */
    public synchronized List<Entry> compacted() {
        return new ArrayList<>(entries.subList(0, Math.min(seedCount, entries.size())));
    }

    /** 种子之后的 live 段（load 响应的 liveJournal）。 */
    public synchronized List<Entry> live() {
        int from = Math.min(seedCount, entries.size());
        return new ArrayList<>(entries.subList(from, entries.size()));
    }

    public synchronized List<Entry> all() {
        return new ArrayList<>(entries);
    }

    public synchronized long lastId() {
        return entries.isEmpty() ? 0 : entries.get(entries.size() - 1).id();
    }

    public synchronized long firstId() {
        return entries.isEmpty() ? 0 : entries.get(0).id();
    }

    /**
     * 等待 id 大于 sinceId 的新事件；waitMs 内没有就返回空数组（SSE 心跳节拍由调用方决定）。
     * Object.wait/notifyAll：append 侧唤醒；先查再等，不存在"事件到了但没被唤醒"。
     */
    public synchronized List<Entry> waitForMore(long sinceId, long waitMs) throws InterruptedException {
        List<Entry> existing = since(sinceId);
        if (!existing.isEmpty()) return existing;
        wait(waitMs);
        return since(sinceId);
    }

    /**
     * 触顶丢弃最旧事件。丢弃意味着某些旧游标续传时会出现空洞——调用方（SSE 路由）
     * 检测到 `firstId > lastEventId + 1` 时只 warn 并从现存最旧事件续播：
     * 真身 daemon 在这里是强制 resync，v1 先选"尽力续播"，丢段比整个会话打不开轻。
     */
    private void compact() {
        if (entries.size() <= MAX_EVENTS) return;
        int drop = entries.size() - MAX_EVENTS;
        entries.subList(0, drop).clear();
        seedCount = Math.max(0, seedCount - drop);
    }
}
