package com.das.java.core;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 轮次聚合与历史归约。与 Node 实现的 shared/turn.ts 同源同语义。
 *
 * 这是全工程唯一的帧解释点：后端拉历史用它、前端渲染在途流用它、mock 回放也用它。
 * 只存聚合结果、不存原始帧——实测 901 帧/191 秒，存原始帧会让内存随轮次长度线性膨胀。
 */
public final class Turn {
    private Turn() {}

    private static final java.util.Set<String> KNOWN_UPDATES =
        new java.util.HashSet<>(java.util.Arrays.asList(Constants.OBSERVED_SESSION_UPDATES));
    private static final java.util.Set<String> KNOWN_TOOL_STATUSES =
        new java.util.HashSet<>(java.util.Arrays.asList(Constants.OBSERVED_TOOL_STATUSES));

    public static Map<String, Object> createTurn(String rid) {
        Map<String, Object> turn = new LinkedHashMap<>();
        turn.put("rid", rid);
        turn.put("sessionId", null);
        turn.put("userText", "");
        turn.put("thoughtText", "");
        turn.put("messageText", "");
        turn.put("tools", new ArrayList<Map<String, Object>>());
        turn.put("contextUsage", null);
        turn.put("tokenUsage", null);
        turn.put("terminated", false);
        turn.put("stopReason", null);
        turn.put("rawStopReason", null);
        turn.put("error", null);
        turn.put("frameCount", 0);
        turn.put("firstTimestamp", null);
        turn.put("lastTimestamp", null);
        turn.put("minOffset", null);
        turn.put("maxOffset", null);
        turn.put("queuedNotices", 0);
        turn.put("unrecognizedUpdates", new ArrayList<String>());
        return turn;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> tools(Map<String, Object> turn) {
        return (Map<String, Object>) turn;
    }

    private static Map<String, Object> findTool(Map<String, Object> turn, String toolCallId) {
        for (Object o : (List<?>) turn.get("tools")) {
            @SuppressWarnings("unchecked")
            Map<String, Object> tool = (Map<String, Object>) o;
            if (tool.get("toolCallId").equals(toolCallId)) return tool;
        }
        return null;
    }

    private static void noteUnrecognized(Map<String, Object> turn, String label) {
        @SuppressWarnings("unchecked")
        List<String> list = (List<String>) turn.get("unrecognizedUpdates");
        if (!list.contains(label)) list.add(label);
    }

    /** 把一帧并入轮次聚合。这是全工程唯一的帧解释点（前端/后端/mock 同源）。 */
    @SuppressWarnings("unchecked")
    public static void applyFrame(Map<String, Object> turn, Map<String, Object> frame) {
        turn.put("frameCount", ((int) turn.get("frameCount")) + 1);

        if (turn.get("rid") == null) turn.put("rid", Frames.requestIdOf(frame));
        if (turn.get("sessionId") == null) turn.put("sessionId", Frames.sessionIdOf(frame));

        Long timestamp = Frames.timestampOf(frame);
        if (timestamp != null) {
            if (turn.get("firstTimestamp") == null || timestamp < (long) turn.get("firstTimestamp")) {
                turn.put("firstTimestamp", timestamp);
            }
            if (turn.get("lastTimestamp") == null || timestamp > (long) turn.get("lastTimestamp")) {
                turn.put("lastTimestamp", timestamp);
            }
        }

        Integer offset = Frames.offsetOf(frame);
        if (offset != null) {
            if (turn.get("minOffset") == null || offset < (int) turn.get("minOffset")) {
                turn.put("minOffset", offset);
            }
            if (turn.get("maxOffset") == null || offset > (int) turn.get("maxOffset")) {
                turn.put("maxOffset", offset);
            }
        }

        Map<String, Object> error = Frames.errorOf(frame);
        if (error != null) {
            // 错误帧不产出内容。同一轮的帧仍会继续到达（断流前已有 1200 帧），只记录、不终止聚合。
            turn.put("error", error);
            return;
        }

        Frames.TerminalInfo terminal = Frames.terminalOf(frame);
        if (terminal != null) {
            turn.put("terminated", true);
            turn.put("stopReason", terminal.stopReason());
            turn.put("rawStopReason", terminal.rawStopReason());
            return;
        }

        Map<String, Object> update = Frames.updateOf(frame);
        if (update == null) {
            // 排队通知帧（Method="_qwen/notify"）没有 update，它是"你的提示词排上了"的信号。
            Map<String, Object> params = Frames.paramsOf(frame);
            Object noticeKind = params == null ? null : params.get("kind");
            if (noticeKind instanceof String) {
                turn.put("queuedNotices", ((int) turn.get("queuedNotices")) + 1);
                return;
            }
            noteUnrecognized(turn, "<no update>");
            return;
        }

        String kind = Frames.sessionUpdateOf(frame);
        if (kind == null) {
            noteUnrecognized(turn, "<missing sessionUpdate>");
            return;
        }
        if (!KNOWN_UPDATES.contains(kind)) noteUnrecognized(turn, kind);

        switch (kind) {
            case "user_message_chunk" -> {
                String text = Frames.textOf(update);
                // 归档态里同一句提示词会出现两条完全相同的 user_message_chunk（实测），
                // 不去重界面上就会把提示词显示两遍。
                if (!text.isEmpty() && !text.equals(turn.get("userText"))) {
                    turn.put("userText", (String) turn.get("userText") + text);
                }
            }
            case "agent_thought_chunk" -> turn.put("thoughtText", (String) turn.get("thoughtText") + Frames.textOf(update));
            case "agent_message_chunk" -> {
                turn.put("messageText", (String) turn.get("messageText") + Frames.textOf(update));
                Map<String, Object> usage = Frames.tokenUsageOf(update);
                if (usage != null) turn.put("tokenUsage", usage);
            }
            case "tool_call", "tool_call_update" -> applyToolFrame(turn, update, offset, timestamp);
            case "usage_update" -> {
                Integer size = update.get("size") instanceof Integer i ? i : null;
                Integer used = update.get("used") instanceof Integer i ? i : null;
                if (size != null || used != null) {
                    Map<String, Object> prev = turn.get("contextUsage") instanceof Map<?, ?> m ? (Map<String, Object>) (Object) m : null;
                    Map<String, Object> contextUsage = new LinkedHashMap<>();
                    contextUsage.put("size", size != null ? size : (prev != null ? prev.getOrDefault("size", 0) : 0));
                    contextUsage.put("used", used != null ? used : (prev != null ? prev.getOrDefault("used", 0) : 0));
                    turn.put("contextUsage", contextUsage);
                }
            }
            default -> { /* config_option_update 等：已记进 unrecognizedUpdates */ }
        }
    }

    private static void applyToolFrame(
        Map<String, Object> turn, Map<String, Object> update, Integer offset, Long timestamp
    ) {
        String toolCallId = update.get("toolCallId") instanceof String s && !s.isEmpty() ? s : null;
        if (toolCallId == null) {
            noteUnrecognized(turn, "<tool frame without toolCallId>");
            return;
        }

        String statusRaw = update.get("status") instanceof String s ? s : null;
        String status = statusRaw != null && KNOWN_TOOL_STATUSES.contains(statusRaw) ? statusRaw : "unknown";

        Map<String, Object> tool = findTool(turn, toolCallId);
        if (tool == null) {
            tool = new LinkedHashMap<>();
            tool.put("toolCallId", toolCallId);
            tool.put("name", null);
            tool.put("title", null);
            tool.put("status", "unknown");
            tool.put("command", null);
            tool.put("description", null);
            tool.put("rawInput", null);
            tool.put("locations", new ArrayList<String>());
            tool.put("resultText", null);
            tool.put("firstOffset", offset);
            tool.put("lastOffset", offset);
            tool.put("firstTimestamp", timestamp);
            tool.put("lastTimestamp", timestamp);
            ((List<Object>) turn.get("tools")).add(tool);
        }

        // 一律"有值才覆盖"：completed 帧不带 title/rawInput.command，
        // 无脑赋值会把 in_progress 阶段拿到的信息擦掉。
        String name = Frames.toolNameOf(update);
        if (name != null) tool.put("name", name);
        if (update.get("title") instanceof String t && !t.isEmpty()) tool.put("title", t);
        if (!status.equals("unknown")) tool.put("status", status);

        Map<String, Object> rawInputMap = update.get("rawInput") instanceof Map<?, ?> m
            ? (Map<String, Object>) (Object) m : null;
        if (rawInputMap != null) {
            Object command = rawInputMap.get("command");
            if (command instanceof String c && !c.isEmpty()) tool.put("command", c);
            Object description = rawInputMap.get("description");
            if (description instanceof String d && !d.isEmpty()) tool.put("description", d);
        }

        // rawInput 增量合并而不是整包替换：pending 帧的 rawInput 是 `{}`，
        // 替换会把前一帧拿到的参数擦成空。
        if (rawInputMap != null && !rawInputMap.isEmpty()) {
            Map<String, Object> merged = new LinkedHashMap<>();
            if (tool.get("rawInput") instanceof Map<?, ?> prev) {
                @SuppressWarnings("unchecked")
                Map<String, Object> prevMap = (Map<String, Object>) prev;
                merged.putAll(prevMap);
            }
            merged.putAll(rawInputMap);
            tool.put("rawInput", merged);
        }

        List<String> locations = Frames.locationsOf(update);
        if (!locations.isEmpty()) tool.put("locations", locations);

        String resultText = Frames.toolResultText(update);
        if (resultText != null) tool.put("resultText", resultText);
        if (offset != null) tool.put("lastOffset", offset);
        if (timestamp != null) {
            if (tool.get("firstTimestamp") == null || timestamp < (long) tool.get("firstTimestamp")) {
                tool.put("firstTimestamp", timestamp);
            }
            if (tool.get("lastTimestamp") == null || timestamp > (long) tool.get("lastTimestamp")) {
                tool.put("lastTimestamp", timestamp);
            }
        }
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> reduceFrames(List<Map<String, Object>> frames, String rid) {
        Map<String, Object> turn = createTurn(rid);
        for (Map<String, Object> frame : frames) applyFrame(turn, frame);
        return turn;
    }

    public static Map<String, Object> reduceHistory(List<Map<String, Object>> frames) {
        Rid.Partition partition = Rid.partitionByRid(frames);
        List<Map<String, Object>> turns = new ArrayList<>();
        List<String> nonTurnRids = new ArrayList<>();
        Map<String, Integer> rids = new LinkedHashMap<>();

        for (var entry : partition.byRid().entrySet()) {
            String rid = entry.getKey();
            List<Map<String, Object>> group = entry.getValue();
            rids.put(rid, group.size());
            // 轮次判据：该 rid 名下至少有一条 user_message_chunk。
            // 只有 load 自己的 rid 与配置帧不满足这条，正好被排除。
            boolean isTurn = group.stream().anyMatch(f -> "user_message_chunk".equals(Frames.sessionUpdateOf(f)));
            if (isTurn) turns.add(reduceFrames(group, rid));
            else nonTurnRids.add(rid);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("turns", turns);
        out.put("droppedRidLess", partition.ridLess().size());
        out.put("rids", rids);
        out.put("nonTurnRids", nonTurnRids);
        out.put("totalFrames", partition.total());
        return out;
    }
}
