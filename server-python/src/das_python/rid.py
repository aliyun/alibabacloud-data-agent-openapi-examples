"""按 rid 分组。与 Node 实现的 shared/rid.ts 同源同语义。"""

from __future__ import annotations

from typing import Any

from .frames import has_request_id, request_id_of

Frame = dict[str, Any]


class RidPartition:
    def __init__(self, by_rid: dict[str, list[Frame]], rid_less: list[Frame], total: int) -> None:
        self.byRid = by_rid  # noqa: N815 — 与 Node 侧字段名一致
        self.ridLess = rid_less  # noqa: N815
        self.total = total


def partition_by_rid(frames: list[Frame]) -> RidPartition:
    """按 rid 分组，并把没有 rid 的帧单独隔出来。

    为什么必须隔离：load 返回的内容里混着"原始回放"帧，实测 977 帧里有 900 帧
    没有 RequestId 键，它们是同一轮内容的第二份拷贝。不隔离就会把每轮显示两遍。

    判据是**键是否存在**，不是值是否为空——实测 `"RequestId": ""` 命中 0 行。
    """
    by_rid: dict[str, list[Frame]] = {}
    rid_less: list[Frame] = []
    total = 0

    for frame in frames:
        total += 1
        if not has_request_id(frame):
            rid_less.append(frame)
            continue
        rid = request_id_of(frame)
        if not rid:
            # 键在，但值不是非空字符串。空串当分组键会凭空多出一个"rid 为空的幽灵轮次"，
            # 所以一并归 ridLess（真实录制件里这种形态命中 0 行，这里是防御性处理）。
            rid_less.append(frame)
            continue
        by_rid.setdefault(rid, []).append(frame)

    return RidPartition(by_rid, rid_less, total)


def count_frames_for_rid(frames: list[Frame], rid: str) -> int:
    """数某个 rid 名下的帧数。断流后的"完成探测器 A"就是拿它和 2 比。"""
    n = 0
    for frame in frames:
        if request_id_of(frame) == rid:
            n += 1
    return n
