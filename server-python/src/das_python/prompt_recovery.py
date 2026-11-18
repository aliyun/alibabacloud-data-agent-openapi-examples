"""Only native Events can resume a Prompt; history offsets are not event cursors."""
from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

from .errors import api_error
from .normalize import SdkError, to_api_error
from .event_cursor import cursor_of


class SubscriptionInterrupted(Exception):
    pass


@dataclass
class ResumeState:
    prompt_id: str
    session_id: str | None = None
    cursor: dict[str, str] | None = None
    ended: bool = False

    def read(self, frame):
        try:
            return cursor_of(frame, self.session_id)
        except ValueError as invalid:
            raise SdkError(api_error("stream_break", "原生事件游标与会话不匹配")) from invalid

    def take(self, frame):
        current = self.read(frame)
        if current and self.cursor and (current["eventEpoch"] != self.cursor["eventEpoch"]
                or current["promptId"] != self.cursor["promptId"]
                or int(current["eventId"]) <= int(self.cursor["eventId"])):
            raise SdkError(api_error("stream_break", "原生游标发生跳代、重复或跨轮"))
        if self.cursor and not current:
            if frame.get("Error") and frame["Error"].get("errorCode") != "DAEMON_STREAM_CONTRACT_INVALID":
                raise SubscriptionInterrupted("原订阅结束，核对原生 Events")
            raise SdkError(api_error("stream_break", "续传帧缺少有效原生游标"))
        if current and (frame.get("Error") or isinstance((frame.get("Result") or {}).get("stopReason"), str)):
            if (current["eventType"] != ("turn_error" if frame.get("Error") else "turn_complete")
                    or str(frame.get("Id")) != self.prompt_id):
                raise SdkError(api_error("stream_break", "终态与原生事件证明不匹配"))
            self.ended = True

    @property
    def resumable(self):
        return not self.ended and self.cursor is not None


async def recover_prompt_frames(prompt_id: str, initial: AsyncIterator[dict[str, Any]],
                                events: Callable[[dict[str, str], int], AsyncIterator[dict[str, Any]]],
                                *, session_id: str | None = None, attempts: int = 3,
                                budget_ms: int = 600_000, delay_ms: int = 250):
    state = ResumeState(prompt_id, session_id)
    source, attempt, deadline = initial, 0, 0.0
    while True:
        try:
            if attempt:
                source = events(state.cursor, max(1, int((deadline-time.monotonic())*1000)))
            while True:
                if deadline and time.monotonic() >= deadline:
                    return
                async with asyncio.timeout(max(0, deadline-time.monotonic()) if deadline else None):
                    try:
                        frame = await anext(source)
                    except StopAsyncIteration:
                        break
                state.take(frame)
                yield frame
                state.cursor = state.read(frame) or state.cursor
                if state.ended:
                    return
        except Exception as error:
            if not state.resumable or (not isinstance(error, SubscriptionInterrupted)
                    and to_api_error(error, "GetAgentSessionEvents").kind != "transport"):
                raise
        finally:
            await source.aclose()
        if not state.resumable or attempt >= attempts:
            return
        deadline = deadline or time.monotonic()+budget_ms/1000
        delay = delay_ms*2**attempt/1000
        if time.monotonic()+delay >= deadline:
            return
        await asyncio.sleep(delay)
        attempt += 1
