package com.das.java.mock;

import com.das.java.core.Frames;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * MOCK 模式的数据源：`server-node/test/fixtures/` 下的录制件（同一仓库、同一份数据，不复制第二份）。
 * 与 Node 实现的 server-node/mock/fixtures.ts、Python 实现的 mock_fixtures.py 同源同语义。
 */
public final class MockFixtures {
    private MockFixtures() {}

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** fixtures 在 Node server 的测试目录里。repoRoot 解析失败时这里拿不到文件，启动 MOCK 会报错——如实报。 */
    public static Path fixtureDir(Path repoRoot) {
        return repoRoot.resolve("server-node").resolve("test").resolve("fixtures");
    }

    public static List<Map<String, Object>> readFixtureFrames(Path repoRoot, String name) {
        Path file = fixtureDir(repoRoot).resolve(name);
        List<String> lines;
        try {
            lines = Files.readAllLines(file);
        } catch (IOException e) {
            throw new IllegalStateException("读 fixture 失败：" + file + "（" + e.getMessage() + "）", e);
        }
        List<Map<String, Object>> frames = new ArrayList<>();
        for (String line : lines) {
            if (line.trim().isEmpty()) continue;
            Map<String, Object> frame = Frames.parseRecordedLine(line);
            if (frame == null) {
                throw new IllegalStateException("fixture " + name + " 有一行解析不出帧");
            }
            frames.add(frame);
        }
        return frames;
    }

    /** 非流式录制件：形如 {JsonRpcResponse:{Result:{…}}, RequestId:'…'}。 */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> readFixtureEnvelope(Path repoRoot, String name) {
        Path file = fixtureDir(repoRoot).resolve(name);
        Map<String, Object> parsed;
        try {
            parsed = MAPPER.readValue(Files.readString(file), Map.class);
        } catch (IOException e) {
            throw new IllegalStateException("读 fixture 失败：" + file + "（" + e.getMessage() + "）", e);
        }
        Map<String, Object> rpc = Frames.asMap(parsed.get("JsonRpcResponse"));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("result", rpc == null ? null : rpc.get("Result"));
        out.put("requestId", parsed.get("RequestId"));
        out.put("error", rpc == null ? null : rpc.get("Error"));
        return out;
    }

    public static Map<String, Object> readFixtureResult(Path repoRoot, String name) {
        Map<String, Object> envelope = readFixtureEnvelope(repoRoot, name);
        Object result = envelope.get("result");
        if (!(result instanceof Map<?, ?> map)) {
            throw new IllegalStateException("fixture " + name + " 里没有 JsonRpcResponse.Result");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> typed = (Map<String, Object>) map;
        return typed;
    }

    public record MockScenario(
        String sessionId,
        String title,
        String promptFixture,
        String historyFixture,
        String popAck,
        int frameCount,
        String teaches,
        long createdAt,
        String sourceOverride
    ) {}

    public record CreateResult(String sessionId) {}

    private static final String SHORT = "mock-short";
    private static final String TOOLS = "mock-tools";
    private static final String LONG = "mock-long";
    private static final String BREAK = "mock-break";
    private static final String GHOST = "mock-ghost";
    private static final String CONCURRENT = "mock-concurrent";
    private static final String ACK = "mock-ack-only";
    private static final String RENDER = "mock-render";

    /** 八条演示会话：七条各对一份录制件（ack-only 那条没有，它演示的正是"零帧"）。 */
    public static final List<MockScenario> SCENARIOS = List.of(
        new MockScenario(SHORT, "[MOCK] 短轮 · 22 帧 · end_turn",
            "prompt-short.jsonl", "load-clean.jsonl", null, 22,
            "最短闭环：一问一答、无工具调用、5.6s 拿到 end_turn", 1_789_026_610_000L, null),
        new MockScenario(TOOLS,
            // marker 注入已退役：标题不再带校验码说明。
            "[MOCK] 工具轮 · 392 帧 · 6 次调用",
            "prompt-tools.jsonl", "load-clean.jsonl", null, 392,
            "工具状态机：6 次调用（5 completed + 1 failed）", 1_789_029_139_000L, null),
        new MockScenario(LONG, "[MOCK] 长轮 · 901 帧 · 191s · 10 次调用",
            "prompt-long.jsonl", "load-polluted.jsonl", null, 901,
            "长轮 191s / 901 帧；历史用 RUNNING 期录的那份（有 rid-less 污染）", 1_789_027_001_000L, null),
        new MockScenario(BREAK, "[MOCK] 断流 · -32603 · 1201 帧",
            "error-stream-break.jsonl", "load-polluted.jsonl", null, 1201,
            "SSE 断流：吐完 1200 帧后收尾 -32603，任务可能仍在服务端跑", 1_788_787_752_000L, null),
        new MockScenario(GHOST, "[MOCK] 会话幽灵化 · 422 · 单帧",
            "error-session-ghost.jsonl", null, null, 1,
            "会话失效：1s 内单帧 -32603 / 422，不能再发，只能新建", 1_788_790_920_000L, null),
        new MockScenario(CONCURRENT, "[MOCK] 并发被拒 · 单帧",
            "error-concurrent-rejected.jsonl", "load-clean.jsonl", null, 1,
            "同一会话同时只能跑一轮，第二次请求被服务端直接拒绝", 1_788_276_326_000L, null),
        new MockScenario(ACK, "[MOCK] prompt 不派发 · 零帧 · 只有 POP 回执",
            null, null, "0dd3b146c75bf132a65efa7a3080e7cd", 0,
            "prompt 根本没派发：只有 POP 回执、零帧；与断流不同，任务没在跑", 1_789_483_174_000L, null),
        new MockScenario(RENDER, "[MOCK] 渲染覆盖 · 代码块 + mermaid（合成）",
            "synthetic-render.jsonl", "synthetic-render.jsonl", null, 4,
            "合成样例：覆盖代码块高亮与 mermaid 图渲染（非录制件）", 1_789_500_000_000L, null)
    );

    /** 两条"别的来源"的会话，用于证明 SessionSource 过滤真的生效。 */
    private static final String OTHER_SOURCE = "recorded-somewhere-else";
    private static final List<MockScenario> OTHER_SOURCE_SCENARIOS = List.of(
        new MockScenario("mock-other-source-1", "[MOCK] 别的来源 · 应被过滤掉",
            "prompt-short.jsonl", null, null, 22, "这条不该出现在列表里。", 1_788_313_631_000L, OTHER_SOURCE),
        new MockScenario("mock-other-source-2", "[MOCK] 别的来源 · 也应被过滤掉",
            "prompt-short.jsonl", null, null, 22, "这条也不该出现在列表里。", 1_788_313_630_000L, OTHER_SOURCE)
    );

    /** MOCK 模式下"新建会话"登记在这里（进程级，重启即清空）。 */
    private static final CopyOnWriteArrayList<MockScenario> CREATED = new CopyOnWriteArrayList<>();

    public static MockScenario findScenario(String sessionId) {
        for (MockScenario s : CREATED) {
            if (s.sessionId().equals(sessionId)) return s;
        }
        for (MockScenario s : SCENARIOS) {
            if (s.sessionId().equals(sessionId)) return s;
        }
        return null;
    }

    /**
     * MOCK 模式的会话列表。上游字段一律照真实形状给（status 恒 RELEASED、
     * updatedAt===createdAt），因为这两个"没用的字段"本身就是要教的内容：
     * 运行态问不出来，只能靠前端流。
     */
    public static Map<String, Object> mockSessions(String sessionSource) {
        List<MockScenario> all = new ArrayList<>();
        all.addAll(CREATED);
        all.addAll(SCENARIOS);
        all.addAll(OTHER_SOURCE_SCENARIOS);

        List<Map<String, Object>> sessions = new ArrayList<>();
        for (MockScenario s : all) {
            String source = s.sourceOverride() != null ? s.sourceOverride() : sessionSource;
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("sessionId", s.sessionId());
            row.put("title", s.title());
            row.put("createdAt", s.createdAt());
            row.put("updatedAt", s.createdAt());
            row.put("status", "RELEASED");
            row.put("source", source);
            row.put("tags", s.sourceOverride() != null ? List.of() : List.of("mock"));
            row.put("mockScenario", s.teaches());
            sessions.add(row);
        }
        List<Map<String, Object>> kept = new ArrayList<>();
        for (Map<String, Object> s : sessions) {
            if (sessionSource.equals(s.get("source"))) kept.add(s);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sessions", kept);
        out.put("filteredOut", sessions.size() - kept.size());
        out.put("total", sessions.size());
        return out;
    }

    /** 新建会话（MOCK）。成功判据与 live 完全一致：只有 SessionId 非空。 */
    public static Map<String, Object> mockCreateSession(String title) {
        String sessionId = SHORT + "-" + Long.toHexString(System.currentTimeMillis());
        CREATED.add(0, new MockScenario(
            sessionId,
            // SessionTitle = 首条 prompt 原文（含注入的校验码说明），与 live 行为一致
            title,
            "prompt-short.jsonl", "load-clean.jsonl", null, 22,
            "MOCK 下新建的会话，回放短轮样例（22 帧 / end_turn）。",
            System.currentTimeMillis(), null));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sessionId", sessionId);
        return out;
    }
}
