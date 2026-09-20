"""进程级"单轮在途"锁。与 Node 实现的 server-node/inflight.ts 同源同语义。

为什么放在后端而不是前端：同一个会话同时只能跑一轮，第二次请求会被服务端直接拒绝。
前端的软锁只能挡住同一个标签页；把锁放在持有连接的那一层，跨标签页也生效，
而且能在**碰到上游之前**就返回——prompt 是写操作，一旦送出去就收不回来。

注意这不是分布式锁：多进程部署时每个进程各有一份。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from .errors import CONCURRENT_REJECTED_TEXT, ApiError, api_error


@dataclass
class InflightEntry:
    sessionId: str  # noqa: N815
    startedAt: int  # noqa: N815
    # 上游给的 rid，第一帧到达才知道；认出即回填（不是等流结束）。
    rid: str | None = None


@dataclass
class Acquired:
    entry: InflightEntry
    release: "Release"


@dataclass
class Release:
    """显式释放句柄（幂等）：stream 收尾与路由 finally 都可能走到这里。"""

    session_id: str
    entry: InflightEntry
    released: bool = field(default=False)

    def __call__(self) -> None:
        if self.released:
            return
        self.released = True
        _inflight.pop(self.session_id, None)


@dataclass
class Rejected:
    error: ApiError
    held_by: InflightEntry


_inflight: dict[str, InflightEntry] = {}


def try_acquire(session_id: str) -> Acquired | Rejected:
    existing = _inflight.get(session_id)
    if existing:
        held_for_ms = int((time.time() * 1000) - existing.startedAt)
        return Rejected(
            error=api_error(
                "concurrent_rejected",
                # message 里刻意带上上游那个特征串：这样即便这条错误是本地锁产生的，
                # 它经过 classifyError 也会得到与上游真实拒绝**完全相同**的 kind，
                # 前端不需要区分"谁拒绝的"。
                f"{CONCURRENT_REJECTED_TEXT}, session_id={session_id}"
                f"（本地在途锁拦截，未发往上游；上一轮已进行 {round(held_for_ms / 1000)}s）",
            ),
            held_by=existing,
        )

    entry = InflightEntry(sessionId=session_id, startedAt=int(time.time() * 1000), rid=None)
    _inflight[session_id] = entry
    return Acquired(entry=entry, release=Release(session_id, entry))
