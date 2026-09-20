package com.das.java.core;

import java.util.regex.Pattern;

/**
 * marker 归属校验已退役（2026-09-20 用户拍板）：注入/生成/流式 Scrubber/verified 判定
 * 全部移除。这里**只保留一个历史清洗助手** `stripMarkerInstruction`——
 * fixtures（抓包时代录制）里残留的「（本轮校验码 DAS-XXXXXX：…）」要从历史
 * 轮次的标题/提示词中剥掉，那是录制内容的残留现实，不是当前轮的机制。
 * 与 Node 实现的 shared/marker.ts 同源同语义。
 */
public final class Marker {
    private Marker() {}

    private static final Pattern INSTRUCTION_RE =
        Pattern.compile("\\n*（本轮校验码 " + Constants.MARKER_PREFIX + "-[0-9A-F]{6}：[^\\n]*）\\s*$");

    /** 剥掉录制内容里残留的校验码说明；匹配不上就原样返回（不静默删用户内容）。 */
    public static String stripMarkerInstruction(String text) {
        return INSTRUCTION_RE.matcher(text).replaceAll("");
    }
}
