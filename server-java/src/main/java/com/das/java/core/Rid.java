package com.das.java.core;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 按 rid 分组。与 Node 实现的 shared/rid.ts 同源同语义。 */
public final class Rid {
    private Rid() {}

    public record Partition(
        /** rid → 该 rid 名下的帧，保持到达顺序。 */
        Map<String, List<Map<String, Object>>> byRid,
        /** 没有可用 rid 的帧（键不存在，或键在但值不是非空字符串），保持到达顺序。 */
        List<Map<String, Object>> ridLess,
        int total
    ) {}

    /**
     * 按 rid 分组，并把没有 rid 的帧单独隔出来。
     *
     * 为什么必须隔离：load 返回的内容里混着"原始回放"帧，实测 977 帧里有 900 帧
     * 没有 RequestId 键，它们是同一轮内容的第二份拷贝。不隔离就会把每轮显示两遍。
     *
     * 判据是**键是否存在**，不是值是否为空——实测 `"RequestId": ""` 命中 0 行。
     */
    public static Partition partitionByRid(List<Map<String, Object>> frames) {
        Map<String, List<Map<String, Object>>> byRid = new LinkedHashMap<>();
        List<Map<String, Object>> ridLess = new ArrayList<>();
        int total = 0;

        for (Map<String, Object> frame : frames) {
            total += 1;
            if (!Frames.hasRequestId(frame)) {
                ridLess.add(frame);
                continue;
            }
            String rid = Frames.requestIdOf(frame);
            if (rid == null) {
                // 键在，但值不是非空字符串。空串当分组键会凭空多出幽灵轮次（防御性处理）。
                ridLess.add(frame);
                continue;
            }
            byRid.computeIfAbsent(rid, k -> new ArrayList<>()).add(frame);
        }
        return new Partition(byRid, ridLess, total);
    }

    /** 数某个 rid 名下的帧数。断流后的"完成探测器 A"就是拿它和 2 比。 */
    public static int countFramesForRid(List<Map<String, Object>> frames, String rid) {
        int n = 0;
        for (Map<String, Object> frame : frames) {
            if (rid.equals(Frames.requestIdOf(frame))) n += 1;
        }
        return n;
    }
}
