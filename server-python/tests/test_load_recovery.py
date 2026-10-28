import asyncio
from types import SimpleNamespace

import pytest

from das_python.load_recovery import read_load_snapshot
from das_python.live import _load_frames


def chunk(text):
    return {"Params": {"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}}


def end(id):
    return {"Id": id, "Result": {"stopReason": "end_turn"}}


async def frames(rows, error=None):
    for frame in rows:
        yield frame
    if error:
        raise error


@pytest.mark.asyncio
async def test_eof_discards_partial_and_historical_terminal():
    calls = []

    def open_stream(timeout):
        calls.append(timeout)
        return "load", frames([chunk("partial"), end("old")] if len(calls) == 1 else [chunk("full"), end("load")])

    assert await read_load_snapshot(open_stream, delay_ms=0) == [chunk("full"), end("load")]
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_repeated_eof_fails_without_partial_history():
    calls = []

    def open_stream(timeout):
        calls.append(timeout)
        return "load", frames([chunk("partial")])

    with pytest.raises(Exception, match="未返回部分历史"):
        await read_load_snapshot(open_stream, delay_ms=0)
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_transport_failure_reloads_but_business_failure_does_not():
    calls = []

    def open_stream(timeout):
        calls.append(timeout)
        return "load", frames([chunk("x")], OSError("reset")) if len(calls) == 1 else frames([end("load")])

    assert await read_load_snapshot(open_stream, delay_ms=0) == [end("load")]
    assert len(calls) == 2
    calls.clear()

    def denied(timeout):
        calls.append(timeout)
        return "load", frames([{"Id": "load", "Error": {"code": -32603, "message": "permission_required"}}])

    with pytest.raises(Exception, match="permission_required"):
        await read_load_snapshot(denied, delay_ms=0)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_idle_deadline_and_caller_cancellation_close_sources():
    closed = []

    async def idle():
        try:
            await asyncio.Event().wait()
            yield end("load")
        finally:
            closed.append(True)

    with pytest.raises(TimeoutError):
        await asyncio.wait_for(read_load_snapshot(lambda _: ("load", idle()), budget_ms=20, delay_ms=0), 1)
    assert closed == [True]
    task = asyncio.create_task(read_load_snapshot(lambda _: ("load", idle())))
    await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert closed == [True, True]


@pytest.mark.asyncio
async def test_sdk_load_snapshot_uses_own_receipt_and_no_offset():
    requests = []

    class Client:
        def load_agent_session_with_sse_async(self, request, runtime):
            requests.append(request)
            rows = [chunk("partial")] if len(requests) == 1 else [chunk("full"), end(request.id)]
            return frames([SimpleNamespace(body=SimpleNamespace(to_map=lambda row=row: row)) for row in rows])

    result = await _load_frames(SimpleNamespace(client=Client()), "s")
    assert result[0] == chunk("full")
    assert len(requests) == 2
    for request in requests:
        assert request.to_map()["Params"]["Meta"] == {"IsReload": True}
