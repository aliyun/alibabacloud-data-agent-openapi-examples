import asyncio
from types import SimpleNamespace

import pytest

from das_python.prompt_recovery import recover_prompt_frames
from das_python.live import _prompt_frames


def chunk(offset, rid="turn", text="x"):
    return {"Jsonrpc": "2.0", "RequestId": rid, "Params": {"sessionId": "session", "_meta": {"offset": offset},
            "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}}


def end(rpc_id="prompt", rid="turn", reason="end_turn"):
    return {"Jsonrpc": "2.0", "RequestId": rid, "Id": rpc_id, "Result": {"stopReason": reason}}


async def stream(rows, error=None):
    for row in rows:
        yield row
    if error:
        raise error


async def collect(initial, load, **kwargs):
    return [frame async for frame in recover_prompt_frames("prompt", initial, load, delay_ms=0, **kwargs)]


@pytest.mark.asyncio
async def test_resume_filters_history_duplicate_and_load_terminal():
    calls = []

    def load(offset, remaining):
        calls.append(offset)
        return "load", stream([chunk(100, "older"), end("load", "load-rid"), end("load", "turn"), chunk(1), chunk(2), end()])

    assert await collect(stream([chunk(1)], OSError("connection reset")), load) == [chunk(1), chunk(2), end()]
    assert calls == [1]


@pytest.mark.asyncio
async def test_repeated_eof_advances_cursor_and_is_bounded():
    calls = []

    def load(offset, remaining):
        calls.append(offset)
        return "load", stream([chunk(2)] if offset == 1 else [])

    assert await collect(stream([chunk(1)]), load) == [chunk(1), chunk(2)]
    assert calls == [1, 2, 2]


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", ["end_turn", "cancelled"])
async def test_terminal_does_not_reconnect(reason):
    def load(*args):
        raise AssertionError("must not Load")

    assert await collect(stream([chunk(1), end(reason=reason)]), load) == [chunk(1), end(reason=reason)]


@pytest.mark.asyncio
async def test_missing_cursor_and_business_error_do_not_reconnect():
    def load(*args):
        raise AssertionError("must not Load")

    await collect(stream([{"Jsonrpc": "2.0", "RequestId": "turn"}]), load)
    await collect(stream([chunk(1), {"Error": {"code": -32603, "message": "permission_required"}}]), load)


@pytest.mark.asyncio
async def test_auth_failure_does_not_retry():
    class Forbidden(Exception):
        status_code = 403

    calls = []

    def load(*args):
        calls.append(args)
        return "load", stream([], Forbidden("denied"))

    with pytest.raises(Forbidden):
        await collect(stream([chunk(1)]), load)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_consumer_close_closes_source_without_reconnect():
    closed = []

    async def initial():
        try:
            yield chunk(1)
            yield chunk(2)
        finally:
            closed.append(True)

    def load(*args):
        raise AssertionError("must not Load")

    iterator = recover_prompt_frames("prompt", initial(), load, delay_ms=0)
    await anext(iterator)
    await iterator.aclose()
    assert closed == [True]


@pytest.mark.asyncio
async def test_unpositioned_replay_must_not_report_success():
    bad = chunk(2)
    del bad["Params"]["_meta"]
    with pytest.raises(Exception, match="缺少 offset"):
        await collect(stream([chunk(1)]), lambda *_: ("load", stream([bad, end()])))


@pytest.mark.asyncio
async def test_sdk_integration_uses_begin_log_offset_and_only_one_prompt():
    prompt_requests, load_requests = [], []

    class Client:
        def prompt_agent_session_with_sse_async(self, request, runtime):
            prompt_requests.append(request)
            return stream([SimpleNamespace(body=SimpleNamespace(to_map=lambda: chunk(7)))])

        def load_agent_session_with_sse_async(self, request, runtime):
            load_requests.append(request)
            buffered = chunk(8)
            del buffered["RequestId"]
            return stream([SimpleNamespace(body=SimpleNamespace(to_map=lambda: end(request.id, "load-rid"))),
                           SimpleNamespace(body=SimpleNamespace(to_map=lambda: buffered)),
                           SimpleNamespace(body=SimpleNamespace(to_map=lambda: end(prompt_requests[0].id)))])

    frames = [f async for f in _prompt_frames(SimpleNamespace(client=Client()), "session", "test")]
    assert len(prompt_requests) == len(load_requests) == 1
    assert load_requests[0].to_map()["Params"]["Meta"] == {"IsReload": True, "BeginLogOffset": 7}
    assert len(frames) == 3


@pytest.mark.asyncio
async def test_running_buffer_without_request_id_is_scoped_by_session_and_cursor():
    buffered = chunk(2, text="recovered")
    del buffered["RequestId"]
    foreign = chunk(99)
    del foreign["RequestId"]
    foreign["Params"]["sessionId"] = "other"
    assert await collect(stream([chunk(1)]), lambda *_: ("load", stream([foreign, buffered, end()]))) == [chunk(1), buffered, end()]


@pytest.mark.asyncio
async def test_recovery_deadline_does_not_cancel_consumer_processing():
    closed = []

    async def resumed():
        try:
            yield chunk(2)
            yield end()
        finally:
            closed.append(True)

    iterator = recover_prompt_frames("prompt", stream([chunk(1)]), lambda *_: ("load", resumed()),
                                     delay_ms=0, budget_ms=20)
    assert await anext(iterator) == chunk(1)
    assert await anext(iterator) == chunk(2)
    # 超过恢复预算的下游处理不应被生成器内的 timeout 取消。
    await asyncio.sleep(0.05)
    with pytest.raises(StopAsyncIteration):
        await anext(iterator)
    assert closed == [True]


@pytest.mark.asyncio
async def test_idle_recovery_is_bounded_and_closes_source():
    closed = []

    async def idle():
        try:
            await asyncio.Event().wait()
            yield end()
        finally:
            closed.append(True)

    result = await asyncio.wait_for(collect(stream([chunk(1)]), lambda *_: ("load", idle()), budget_ms=20), 1)
    assert result == [chunk(1)]
    assert closed == [True]
