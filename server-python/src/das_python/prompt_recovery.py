"""旧 Prompt 断流后只读 Load 续接；游标不跨轮，Load 自身终态不算完成。"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from collections.abc import AsyncIterator, Callable
from typing import Any

from .errors import api_error, classify_error
from .normalize import SdkError, to_api_error


@dataclass
class ResumeState:
    prompt_id: str
    rid: str | None = None
    offset: int = 0
    session_id: str | None = None
    ended: bool = False

    def take(self, frame: dict[str, Any], replay: bool, load_id: str = "") -> bool:
        error = frame.get("Error")
        if replay and error and str(frame.get("Id")) == load_id:
            raise SdkError(classify_error(**{k: error[k] for k in ("code", "errorCode", "message") if k in error}))
        if replay and str(frame.get("Id")) == load_id:
            return False
        params = frame.get("Params") or {}
        offset = (params.get("_meta") or {}).get("offset")
        positioned = isinstance(offset, int) and not isinstance(offset, bool) and 0 < offset <= 2**53 - 1
        if not replay:
            self.rid = self.rid or frame.get("RequestId")
            self.session_id = self.session_id or params.get("sessionId")
        own = self.rid is not None and (frame.get("RequestId") == self.rid or (
            not frame.get("RequestId") and self.session_id and params.get("sessionId") == self.session_id and positioned))
        if replay and self.session_id and params.get("sessionId") and params.get("sessionId") != self.session_id:
            return False
        own_response = str(frame.get("Id")) == self.prompt_id and (not frame.get("RequestId") or own)
        if replay and not own and not own_response:
            return False
        terminal = frame.get("Result", {}).get("stopReason")
        if error or isinstance(terminal, str) and terminal:
            self.ended = True
        if own and positioned:
            if replay and offset <= self.offset:
                return False
            self.offset = max(self.offset, offset)
        elif replay and params.get("update") and not terminal:
            if not (params.get("_meta") or {}).get("waitForResponse"):
                raise SdkError(api_error("stream_break", "Load 续传帧缺少 offset，无法安全合并；请拉取历史恢复。"))
            return False
        return True

    @property
    def resumable(self) -> bool:
        return not self.ended and bool(self.rid) and self.offset > 0


async def recover_prompt_frames(prompt_id: str, initial: AsyncIterator[dict[str, Any]],
                                load: Callable[[int, int], tuple[str, AsyncIterator[dict[str, Any]]]],
                                *, attempts: int = 3, budget_ms: int = 600_000,
                                delay_ms: int = 250) -> AsyncIterator[dict[str, Any]]:
    state = ResumeState(prompt_id)
    source = initial
    load_id = ""
    attempt = 0
    deadline = 0.0
    while True:
        try:
            while True:
                if deadline and time.monotonic() >= deadline:
                    return
                # 只约束上游读取；yield 后不能保留会取消消费者 task 的计时器。
                async with asyncio.timeout(max(0, deadline - time.monotonic()) if deadline else None):
                    try:
                        frame = await anext(source)
                    except StopAsyncIteration:
                        break
                if state.take(frame, attempt > 0, load_id):
                    yield frame
                if state.ended:
                    return
        except Exception as error:
            if not state.resumable or to_api_error(error, "LoadAgentSession").kind != "transport":
                raise
        finally:
            await source.aclose()
        if not state.resumable or attempt >= attempts:
            return
        if not deadline:
            deadline = time.monotonic() + budget_ms / 1000
        delay = delay_ms * 2**attempt / 1000
        if time.monotonic() + delay >= deadline:
            return
        await asyncio.sleep(delay)
        attempt += 1
        load_id, source = load(state.offset, max(1, int((deadline - time.monotonic()) * 1000)))
