package com.das.java.mock;

import com.das.java.core.Constants;
import com.das.java.core.Frames;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * MOCK 回放：按真实 Timestamp 的相对间隔吐帧（压平 + 倍速）。
 * 与 Node 实现的 server-node/mock/replay.ts、Python 实现的 mock_replay.py 同源同语义。
 * 只改等待时间，帧序、帧数、帧内容、相对顺序全部保真。
 */
public final class MockReplay {
    private MockReplay() {}

    /** 阻塞式逐帧迭代：在调用方线程里 sleep（mock 场景下帧间隔 ≤ 400ms/倍速）。 */
    public static Iterator<Map<String, Object>> replay(
        List<Map<String, Object>> frames, boolean realtime, double speed, int maxGapMs) {
        return new Iterator<>() {
            private int index = 0;
            private Long prevTs = null;

            @Override
            public boolean hasNext() {
                return index < frames.size();
            }

            @Override
            public Map<String, Object> next() {
                Map<String, Object> frame = frames.get(index++);
                Long current = Frames.timestampOf(frame);
                if (prevTs != null && current != null && !realtime) {
                    long gap = Math.min(current - prevTs, maxGapMs);
                    if (gap > 0) {
                        try {
                            Thread.sleep((long) (gap / speed));
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                    }
                }
                if (current != null) prevTs = current;
                return frame;
            }
        };
    }

    public static Iterator<Map<String, Object>> replayDefault(List<Map<String, Object>> frames, boolean realtime, double speed) {
        return replay(frames, realtime, speed, Constants.MOCK_MAX_GAP_MS);
    }
}
