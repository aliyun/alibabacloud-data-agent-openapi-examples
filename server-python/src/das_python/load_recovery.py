"""历史快照跨多轮；只读重拉而不按单轮 offset 合并半份历史。"""
import asyncio
import time
from collections.abc import AsyncIterator, Callable
from typing import Any

from .errors import api_error, classify_error
from .normalize import SdkError, to_api_error, with_request_id


async def read_load_snapshot(open_stream: Callable[[int], tuple[str, AsyncIterator[dict[str, Any]]]],
                             *, budget_ms: int = 30_000, attempts: int = 3,
                             delay_ms: int = 250, pop_request_ids: list[str] | None = None) -> list[dict[str, Any]]:
    deadline = time.monotonic() + budget_ms / 1000
    for attempt in range(attempts):
        if time.monotonic() >= deadline:
            break
        source = None
        frames = []
        try:
            load_id, source = open_stream(max(1, int((deadline - time.monotonic()) * 1000)))
            while time.monotonic() < deadline:
                async with asyncio.timeout(max(0, deadline - time.monotonic())):
                    try:
                        frame = await anext(source)
                    except StopAsyncIteration:
                        break
                own = str(frame.get("Id")) == load_id
                error = frame.get("Error")
                if error and (own or "Id" not in frame):
                    raise SdkError(classify_error(**{k: error[k] for k in ("code", "errorCode", "message") if k in error}))
                frames.append(frame)
                reason = (frame.get("Result") or {}).get("stopReason")
                if own and isinstance(reason, str) and reason:
                    if reason != "end_turn":
                        raise SdkError(api_error("stream_break", "Load 历史快照未正常完成。", requestId=(pop_request_ids or [None])[-1]))
                    return frames
        except Exception as error:
            api = with_request_id(to_api_error(error, "LoadAgentSession"), (pop_request_ids or [None])[-1])
            if api.kind != "transport" or time.monotonic() >= deadline or attempt + 1 >= attempts:
                if api.requestId:
                    raise SdkError(api) from error
                raise
        finally:
            if source is not None:
                await source.aclose()
        if attempt + 1 >= attempts:
            break
        delay = delay_ms * 2**attempt / 1000
        if time.monotonic() + delay >= deadline:
            break
        await asyncio.sleep(delay)
    raise SdkError(api_error("stream_break", "Load 历史流中断，未取得本次快照终态；未返回部分历史。", requestId=(pop_request_ids or [None])[-1]))
