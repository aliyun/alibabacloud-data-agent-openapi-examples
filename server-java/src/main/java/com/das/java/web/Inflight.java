package com.das.java.web;

import com.das.java.core.ApiError;
import com.das.java.core.Constants;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * 进程级"单轮在途"锁。与 Node 实现的 server-node/inflight.ts、Python 实现的 inflight.py 同源同语义。
 *
 * 为什么放在后端而不是前端：同一个会话同时只能跑一轮，第二次请求会被服务端直接拒绝。
 * 前端的软锁只能挡住同一个标签页；把锁放在持有连接的那一层，跨标签页也生效，
 * 而且能在**碰到上游之前**就返回——prompt 是写操作，一旦送出去就收不回来。
 *
 * 注意这不是分布式锁：多进程部署时每个进程各有一份。
 */
@Component
public class Inflight {
    public static final class Entry {
        public final String sessionId;
        public final long startedAt;
        /** 上游给的 rid，第一帧到达才知道；认出即回填（不是等流结束）。 */
        public volatile String rid;

        Entry(String sessionId, long startedAt) {
            this.sessionId = sessionId;
            this.startedAt = startedAt;
        }
    }

    public sealed interface AcquireResult permits Acquired, Rejected {}

    public record Acquired(Entry entry, Runnable release) implements AcquireResult {}

    public record Rejected(ApiError error, Entry heldBy) implements AcquireResult {}

    private final Map<String, Entry> inflight = new ConcurrentHashMap<>();

    public AcquireResult tryAcquire(String sessionId) {
        Entry existing = inflight.get(sessionId);
        if (existing != null) {
            long heldForMs = System.currentTimeMillis() - existing.startedAt;
            return new Rejected(
                ApiError.apiError("concurrent_rejected",
                    // message 里刻意带上上游那个特征串：即便这条错误是本地锁产生的，
                    // 经过 classify 也会得到与上游真实拒绝**完全相同**的 kind，前端不需要区分"谁拒绝的"。
                    Constants.CONCURRENT_REJECTED_TEXT + ", session_id=" + sessionId
                        + "（本地在途锁拦截，未发往上游；上一轮已进行 " + Math.round(heldForMs / 1000.0) + "s）"),
                existing);
        }
        Entry entry = new Entry(sessionId, System.currentTimeMillis());
        // 幂等释放：流收尾与异常路径都可能走到这里。
        Runnable release = new Runnable() {
            private boolean released;

            @Override
            public synchronized void run() {
                if (released) return;
                released = true;
                inflight.remove(sessionId, entry);
            }
        };
        inflight.put(sessionId, entry);
        return new Acquired(entry, release);
    }
}
