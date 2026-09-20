import { hasRequestId, requestIdOf, type AcpFrame } from './frames.js';

export interface RidPartition {
  /** rid → 该 rid 名下的帧，保持到达顺序。 */
  byRid: Map<string, AcpFrame[]>;
  /** 没有可用 rid 的帧（键不存在，或键在但值不是非空字符串），保持到达顺序。 */
  ridLess: AcpFrame[];
  total: number;
}

/**
 * 按 rid 分组，并把没有 rid 的帧单独隔出来。
 *
 * 为什么必须隔离：load 返回的内容里混着"原始回放"帧，实测 977 帧里有 900 帧
 * 没有 RequestId 键，它们是同一轮内容的第二份拷贝。不隔离就会把每轮显示两遍。
 *
 * 判据是**键是否存在**，不是值是否为空——实测 `"RequestId": ""` 命中 0 行。
 */
export function partitionByRid(frames: Iterable<AcpFrame>): RidPartition {
  const byRid = new Map<string, AcpFrame[]>();
  const ridLess: AcpFrame[] = [];
  let total = 0;

  for (const frame of frames) {
    total += 1;
    if (!hasRequestId(frame)) {
      ridLess.push(frame);
      continue;
    }
    const rid = requestIdOf(frame);
    if (!rid) {
      // 键在，但值不是非空字符串（非字符串 / 空串）。
      // 空串当分组键会凭空多出一个"rid 为空的幽灵轮次"，所以一并归 ridLess。
      // 真实录制件里这种形态命中 0 行（977 行中 900 行是键压根不存在），
      // 这里是防御性处理：上游改了序列化方式时，退化可见而不是静默串轮。
      ridLess.push(frame);
      continue;
    }
    const bucket = byRid.get(rid);
    if (bucket) bucket.push(frame);
    else byRid.set(rid, [frame]);
  }

  return { byRid, ridLess, total };
}

/** 数某个 rid 名下的帧数。断流后的"完成探测器 A"就是拿它和 2 比。 */
export function countFramesForRid(frames: Iterable<AcpFrame>, rid: string): number {
  let n = 0;
  for (const frame of frames) {
    if (requestIdOf(frame) === rid) n += 1;
  }
  return n;
}
