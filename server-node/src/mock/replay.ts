import { MOCK_MAX_GAP_MS, timestampOf, type AcpFrame } from '@das/shared';

export interface ReplayOptions {
  /** 用录制件里的真实时间间隔（长轮会真的等 191s）。 */
  realtime: boolean;
  /** 非 realtime 时的播放倍速。 */
  speed: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 按录制件的 `Timestamp` 差回放帧流。
 *
 * 为什么要保留时序：工具卡片的状态流转（pending→in_progress→completed）、
 * 逐字出现的正文、心跳与断流的相对位置，这些只有在"帧是慢慢来的"时候才测得出来。
 * 一次性 push 901 帧的话，前端聚合器的 rAF 节流、背压、在途锁全都是死的。
 *
 * 压平与倍速只改等待时长，不改帧序、帧数、帧内容。
 */
export async function* replayFrames(
  frames: readonly AcpFrame[],
  opts: ReplayOptions,
): AsyncGenerator<AcpFrame, void, unknown> {
  let prev: number | undefined;

  for (const frame of frames) {
    const ts = timestampOf(frame);
    if (prev !== undefined && ts !== undefined) {
      let gap = Math.max(0, ts - prev);
      if (!opts.realtime) gap = Math.min(gap, MOCK_MAX_GAP_MS) / opts.speed;
      if (gap > 0) await sleep(gap);
    }
    if (ts !== undefined) prev = ts;
    yield frame;
  }
}
