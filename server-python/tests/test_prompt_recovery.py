import asyncio
import json
from types import SimpleNamespace

import pytest

from das_python.prompt_recovery import recover_prompt_frames
from das_python.live import _prompt_frames
from das_python.normalize import SdkError


def cursor(number, kind="session_update"):
    return {"sessionId": "session", "eventEpoch": "epoch", "eventId": str(number), "promptId": "native-prompt", "eventType": kind}


def chunk(number):
    return {"Jsonrpc": "2.0", "Params": {"sessionId": "session", "update": {"sessionUpdate": "agent_message_chunk"}},
            "_meta": {"eventCursor": cursor(number)}}


def end(number=6, rpc="prompt"):
    return {"Jsonrpc": "2.0", "Id": rpc, "Result": {"stopReason": "end_turn"},
            "_meta": {"eventCursor": cursor(number, "turn_complete")}}


async def stream(rows, error=None):
    for row in rows:
        yield row
    if error:
        raise error


async def collect(initial, events, **kwargs):
    return [frame async for frame in recover_prompt_frames("prompt", initial, events, session_id="session", delay_ms=0, **kwargs)]


@pytest.mark.asyncio
async def test_resumes_only_after_applied_native_cursor():
    calls = []
    def events(saved, remaining):
        calls.append(saved)
        return stream([chunk(5), end()])
    assert await collect(stream([chunk(4)], OSError("connection reset")), events) == [chunk(4), chunk(5), end()]
    assert calls == [cursor(4)]


@pytest.mark.asyncio
async def test_repeated_eof_advances_cursor_and_is_bounded():
    calls = []
    def events(saved, remaining):
        calls.append(saved["eventId"])
        return stream([chunk(5)] if saved["eventId"] == "4" else [])
    assert await collect(stream([chunk(4)]), events) == [chunk(4), chunk(5)]
    assert calls == ["4", "5", "5"]


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["sessionId", "eventEpoch", "promptId", "eventId"])
async def test_rejects_cross_session_epoch_prompt_or_duplicate_cursor(field):
    bad = chunk(5)
    bad["_meta"]["eventCursor"][field] = "4" if field == "eventId" else "other"
    with pytest.raises(SdkError):
        await collect(stream([chunk(4)]), lambda *_: stream([bad]))


@pytest.mark.asyncio
async def test_legacy_offset_and_pre_admission_error_do_not_authorize_resume():
    def forbidden(*args):
        raise AssertionError("must not subscribe Events")
    legacy = chunk(4)
    del legacy["_meta"]
    legacy["Params"]["_meta"] = {"offset": 900}
    assert await collect(stream([legacy]), forbidden) == [legacy]
    error = {"Error": {"code": -32603, "message": "denied"}}
    assert await collect(stream([error]), forbidden) == [error]
    assert await collect(stream([chunk(4), end()]), forbidden) == [chunk(4), end()]


@pytest.mark.asyncio
async def test_subscription_error_after_admission_checks_events_without_publishing_fake_terminal():
    failure = {"Error": {"errorCode": "DAEMON_STREAM_ENDED", "message": "ended"}}
    assert await collect(stream([chunk(4), failure]), lambda *_: stream([end()])) == [chunk(4), end()]


@pytest.mark.asyncio
async def test_auth_failure_does_not_retry():
    class Forbidden(Exception):
        status_code = 403
    calls = []
    def events(*args):
        calls.append(args)
        return stream([], Forbidden("denied"))
    with pytest.raises(Forbidden):
        await collect(stream([chunk(4)]), events)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_consumer_close_closes_source_without_reconnect():
    closed = []
    async def initial():
        try:
            yield chunk(4)
        finally:
            closed.append(True)
    iterator = recover_prompt_frames("prompt", initial(), lambda *_: pytest.fail("unexpected GET"), delay_ms=0)
    await anext(iterator)
    await iterator.aclose()
    assert closed == [True]


@pytest.mark.asyncio
async def test_recovery_deadline_does_not_cancel_consumer_processing():
    closed = []
    async def resumed():
        try:
            yield chunk(5)
            yield end()
        finally:
            closed.append(True)
    iterator = recover_prompt_frames("prompt", stream([chunk(4)]), lambda *_: resumed(), delay_ms=0, budget_ms=20)
    assert await anext(iterator) == chunk(4)
    assert await anext(iterator) == chunk(5)
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
    assert await asyncio.wait_for(collect(stream([chunk(4)]), lambda *_: idle(), budget_ms=20), 1) == [chunk(4)]
    assert closed == [True]


@pytest.mark.asyncio
async def test_native_adapter_deadline_does_not_cancel_downstream_after_yield():
    from das_python.live import _resumed_prompt_frames
    closed = []
    class Client:
        async def call_sseapi_async(self, descriptor, request, runtime):
            try:
                for event in [
                    {"type": "stream_open", "data": {"sessionId": "session", "nativeSessionId": "native", "eventEpoch": "epoch"}},
                    {"id": 5, "type": "session_update", "promptId": "native-prompt", "data": {"sessionId": "native", "update": {}}},
                ]:
                    yield SimpleNamespace(status_code=200, headers={"content-type": "text/event-stream"},
                        event=SimpleNamespace(data=json.dumps(event), id=None, event=event["type"]))
                await asyncio.Event().wait()
            finally:
                closed.append(True)
    ctx = SimpleNamespace(client=Client())
    source = recover_prompt_frames("prompt", stream([chunk(4)]),
        lambda saved, remaining: _resumed_prompt_frames(ctx, "session", "prompt", saved, remaining, []),
        session_id="session", delay_ms=0, budget_ms=20)
    try:
        assert await anext(source) == chunk(4)
        assert (await anext(source))["_meta"]["eventCursor"]["eventId"] == "5"
        await asyncio.sleep(0.05)
        with pytest.raises(StopAsyncIteration):
            await anext(source)
    finally:
        await source.aclose()
    assert closed == [True]


@pytest.mark.asyncio
async def test_sdk_core_metadata_and_events_receipt_complete_original_prompt_without_load():
    calls = []
    class Client:
        async def call_sseapi_async(self, descriptor, request, runtime):
            calls.append((descriptor.action, request))
            def response(value):
                return SimpleNamespace(status_code=200, headers={"content-type": "text/event-stream"},
                    event=SimpleNamespace(data=json.dumps(value), id=None, event=value.get("type")))
            if descriptor.action == "PromptAgentSession":
                assert json.loads(request.body["Params"]) == {"SessionId": "session", "Prompt": [{"Type": "text", "Text": "test"}]}
                yield response(chunk(4))
            else:
                assert request.query == {"SessionCode": "session", "EventEpoch": "epoch"}
                assert request.headers["Last-Event-Id"] == "4"
                yield response({"type": "stream_open", "data": {"sessionId": "session", "nativeSessionId": "native", "eventEpoch": "epoch"}})
                yield response({"id": 5, "type": "turn_complete", "promptId": "native-prompt", "data": {"sessionId": "native", "stopReason": "end_turn"}})
                yield response({"id": 6, "type": "pending_prompt_completed", "promptId": "native-prompt", "data": {}})
                yield response({"type": "replay_complete", "data": {"replayedCount": 2, "lastEventId": 6}})
    frames = [frame async for frame in _prompt_frames(SimpleNamespace(client=Client()), "session", "test")]
    assert [action for action, _ in calls] == ["PromptAgentSession", "GetAgentSessionEvents"]
    assert len(frames) == 2
    assert frames[-1]["_meta"]["eventCursor"]["eventId"] == "5"
    assert frames[-1]["Result"]["stopReason"] == "end_turn"
