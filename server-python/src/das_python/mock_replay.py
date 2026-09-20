"""MOCK 回放：按真实 Timestamp 的相对间隔吐帧（压平 + 倍速）。

与 Node 实现的 server-node/mock/replay.ts 同源同语义。只改等待时间，帧序、帧数、
帧内容、相对顺序全部保真——这是"mock 下验收通过"能推广到真实链路的前提。
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncGenerator

from .constants import MOCK_DEFAULT_SPEED, MOCK_MAX_GAP_MS


async def replay_frames(
    frames: list[dict[str, Any]],
    realtime: bool = False,
    speed: float = MOCK_DEFAULT_SPEED,
    max_gap_ms: int = MOCK_MAX_GAP_MS,
) -> AsyncGenerator[dict[str, Any], None]:
    """回放一串帧，用 asyncio.sleep 模拟帧间隔。

    - realtime=False（默认）：超过 max_gap 的间隔压平到 max_gap，再除以 speed 倍速；
    - realtime=True：按原始时间间隔回放（MOCK_SPEED 不生效）。
    """
    prev_ts: int | None = None
    for frame in frames:
        if prev_ts is not None and not realtime:
            current = frame.get("Timestamp")
            if isinstance(current, int):
                gap_ms = min(current - prev_ts, max_gap_ms)
                if gap_ms > 0:
                    await asyncio.sleep(gap_ms / 1000.0 / speed)
        prev_ts = frame.get("Timestamp") if isinstance(frame.get("Timestamp"), int) else prev_ts
        yield frame
