"""单会话事件日志：daemon 模型（202 异步 prompt + SSE + Last-Event-ID 续传）的服务端事实源。
与 Node 实现的 server/daemon/journal.ts 同源同语义。

与 `/api/sessions/:id/prompt`（把上游流直连到客户端连接）的本质区别：
事件先进 journal，再由 SSE 分发——浏览器断线重连时从游标续播，而服务端对上游
那一轮的消费（runner）不受任何客户端连接存亡影响。这正是选这套协议的动机：
对抗上游 218~258s 断流墙时，"连接断了"与"轮次丢了"第一次解耦。

asyncio 实现注记：本工程所有访问都在单一事件循环里（FastAPI on uvicorn），所以
列表操作不需要互斥锁；等待唤醒用"每一代一个全新的 asyncio.Event"——append 时 set()
唤醒所有已挂上的等待者，然后换一个新的给下一代。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from .events import DaemonEvent, with_id

MAX_EVENTS = 20_000


@dataclass
class JournalEntry:
    id: int
    event: DaemonEvent


class SessionJournal:
    """
    内存上限。一轮长轮实测 1201 帧，20k 条大约等于十几个长轮；daemon 真身用
    环形缓冲 + resync，我们先把上限放大到"单进程演示用不完"的量级，
    触顶时丢弃最旧事件（见 _compact 的注释）。
    """

    def __init__(self) -> None:
        self._entries: list[JournalEntry] = []
        self._next_id = 1
        # 历史种子（load 回放）与之后 live 轮次的分界。load 响应把种子放 `compactedReplay`、
        # 之后的放 `liveJournal`，语义对齐真 daemon（provider 按序重放两段）。
        self._seed_count = 0
        self._wake = asyncio.Event()

        # 有执行中的轮次（在途锁的另一面视图，供会话列表的 hasActivePrompt 用）。
        self.active_prompt = False
        # 执行中轮次的 promptId（cancel 路由发 prompt_cancelled 事件要用）。
        self.active_prompt_id: str | None = None

    def append(self, event: DaemonEvent) -> JournalEntry:
        entry = JournalEntry(id=self._next_id, event=with_id(event, self._next_id))
        self._next_id += 1
        self._entries.append(entry)
        self._compact()
        # 唤醒当前代等待者，换代
        self._wake.set()
        self._wake = asyncio.Event()
        return entry

    def seed(self, events: list[DaemonEvent]) -> None:
        """Extend a pure historical prefix without resetting IDs or overwriting live events."""
        if self.active_prompt or len(self._entries) != self._seed_count or self.first_id() > 1:
            return
        existing = len(self._entries)
        if len(events) <= existing:
            return
        for index, entry in enumerate(self._entries):
            prior = {k: v for k, v in entry.event.items() if k != 'id'}
            incoming = {k: v for k, v in events[index].items() if k != 'id'}
            if prior != incoming:
                return
        for event in events[existing:]:
            self.append(event)
        self._seed_count = len(self._entries)

    def since(self, last_id: int) -> list[JournalEntry]:
        """id 严格大于 lastId 的事件（保持顺序）。lastId<=0 视为从头。"""
        if last_id <= 0:
            return list(self._entries)
        return [e for e in self._entries if e.id > last_id]

    def compacted(self) -> list[JournalEntry]:
        """历史种子段（load 响应的 compactedReplay）。"""
        return list(self._entries[: self._seed_count])

    def live(self) -> list[JournalEntry]:
        """种子之后的 live 段（load 响应的 liveJournal）。"""
        return list(self._entries[self._seed_count :])

    def all(self) -> list[JournalEntry]:
        return list(self._entries)

    def last_id(self) -> int:
        return self._entries[-1].id if self._entries else 0

    def first_id(self) -> int:
        return self._entries[0].id if self._entries else 0

    async def wait_for_more(self, since_id: int, wait_ms: int) -> list[JournalEntry]:
        """等待 id 大于 sinceId 的新事件；waitMs 内没有就返回空数组（SSE 心跳节拍由调用方决定）。

        先查再等：existing 非空直接返回；等待的是当前代的唤醒事件，append 换代
        不影响已挂上的等待者，不存在"事件到了但没被唤醒"。
        """
        existing = self.since(since_id)
        if existing:
            return existing
        wake = self._wake
        try:
            await asyncio.wait_for(asyncio.shield(wake.wait()), timeout=wait_ms / 1000)
        except TimeoutError:
            pass
        return self.since(since_id)

    def _compact(self) -> None:
        """触顶丢弃最旧事件。丢弃意味着某些旧游标续传时会出现空洞——调用方（SSE 路由）
        检测到 `firstId > lastEventId + 1` 时只 warn 并从现存最旧事件续播：
        真身 daemon 在这里是强制 resync，v1 先选"尽力续播"，丢段比整个会话打不开轻。"""
        if len(self._entries) <= MAX_EVENTS:
            return
        drop = len(self._entries) - MAX_EVENTS
        del self._entries[:drop]
        self._seed_count = max(0, self._seed_count - drop)
