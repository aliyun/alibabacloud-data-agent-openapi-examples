"""Native cursor contract: no cloud access or generated response-model casting."""
import json
from types import SimpleNamespace

import pytest

from das_python.normalize import SdkError
from das_python.pop import prompt_events, session_events


OPENER = {"type": "stream_open", "data": {
    "sessionId": "business", "nativeSessionId": "native", "eventEpoch": "epoch"}}
UPDATE = {"id": 5, "type": "session_update", "promptId": "p", "data": {
    "sessionId": "native", "update": {"sessionUpdate": "user_message_chunk"}}}
TERMINAL = {"id": 6, "type": "turn_complete", "promptId": "p", "data": {
    "sessionId": "native", "promptId": "p", "stopReason": "end_turn"}}
RECEIPT = {"type": "replay_complete", "data": {"replayedCount": 2, "lastReplayedEventId": 6}}


class Client:
    def __init__(self, frames):
        self.frames, self.calls, self.closed = frames, [], False

    async def call_sseapi_async(self, descriptor, request, runtime):
        self.calls.append((descriptor, request))
        try:
            for frame in self.frames:
                raw = frame if isinstance(frame, str) else json.dumps(frame)
                event = SimpleNamespace(data=raw, id=str(frame["id"]) if isinstance(frame, dict) and "id" in frame else None,
                                        event=frame.get("type") if isinstance(frame, dict) else None)
                yield SimpleNamespace(event=event, status_code=200, headers={"content-type": "text/event-stream"})
        finally:
            self.closed = True


@pytest.mark.asyncio
async def test_actual_pop_data_wrapper_and_empty_opening_id():
    class PopClient(Client):
        async def call_sseapi_async(self, descriptor, request, runtime):
            for frame in [OPENER, UPDATE, TERMINAL]:
                payload = frame["data"] if frame is OPENER else frame
                yield SimpleNamespace(event=SimpleNamespace(data=json.dumps({"Data": payload}),
                    id="" if frame is OPENER else str(frame["id"]), event=frame["type"]),
                    status_code=200, headers={"content-type": "text/event-stream"})
    events = [event async for event in session_events(SimpleNamespace(client=PopClient([])), "business", None)]
    assert [event["event"] for event in events] == ["stream_open", "session_update", "turn_complete"]
    assert events[-1]["data"]["promptId"] == "p"
    assert events[-1]["data"]["data"]["sessionId"] == "business"


@pytest.mark.asyncio
async def test_pop_data_only_terminal_promotes_its_validated_prompt_identity():
    class FlatClient(Client):
        async def call_sseapi_async(self, descriptor, request, runtime):
            for frame in [OPENER, UPDATE, TERMINAL]:
                yield SimpleNamespace(event=SimpleNamespace(data=json.dumps({"Data": frame["data"]}),
                    id="" if frame is OPENER else str(frame["id"]), event=frame["type"]),
                    status_code=200, headers={"content-type": "text/event-stream"})
    events = [event async for event in session_events(SimpleNamespace(client=FlatClient([])), "business", None)]
    assert events[-1]["data"]["promptId"] == "p"
    assert events[-1]["data"]["data"]["promptId"] == "p"


@pytest.mark.asyncio
async def test_fresh_live_subscription_delivers_terminal_without_receipt():
    client = Client([OPENER, UPDATE, TERMINAL])
    events = [event async for event in session_events(SimpleNamespace(client=client), "business", None)]
    assert [event["event"] for event in events] == ["stream_open", "session_update", "turn_complete"]
    assert events[-1]["data"]["data"]["sessionId"] == "business"
    assert client.closed and len(client.calls) == 1
    assert client.calls[0][1].query == {"SessionCode": "business"}


@pytest.mark.asyncio
@pytest.mark.parametrize("variant", ["valid", "bad-receipt", "missing-receipt", "wrong-epoch"])
async def test_replay_requires_receipt_and_paired_epoch(variant):
    frames = [OPENER, UPDATE, TERMINAL]
    if variant != "missing-receipt":
        frames.append(RECEIPT if variant != "bad-receipt" else {
            "type": "replay_complete", "data": {"replayedCount": 1, "lastEventId": 6}})
    client = Client(frames)
    observed = []

    async def consume():
        async for event in session_events(SimpleNamespace(client=client), "business", "4",
                                          event_epoch="wrong" if variant == "wrong-epoch" else "epoch"):
            observed.append(event["event"])

    if variant == "valid":
        await consume()
        assert observed == ["stream_open", "session_update", "turn_complete", "replay_complete"]
    else:
        with pytest.raises(SdkError):
            await consume()
        assert "turn_complete" not in observed
    assert client.closed and len(client.calls) == 1
    assert client.calls[0][1].headers["Last-Event-Id"] == "4"


@pytest.mark.asyncio
async def test_prompt_uses_public_wire_names_and_preserves_new_metadata():
    payload = {"_meta": {"eventCursor": {"eventId": "5"}}, "Params": {"SessionId": "business"}}
    client = Client([payload])
    result = [frame async for frame in prompt_events(client, "business", "hello", "rpc", None)]
    assert result[0].body == payload
    assert json.loads(client.calls[0][1].body["Params"]) == {
        "SessionId": "business", "Prompt": [{"Type": "text", "Text": "hello"}]}
    assert client.closed


@pytest.mark.asyncio
async def test_bad_prompt_json_is_not_a_retryable_network_failure():
    client = Client(['{broken-json'])
    with pytest.raises(SdkError) as failure:
        _ = [frame async for frame in prompt_events(client, "business", "hello", "rpc", None)]
    assert failure.value.api_error.kind == "stream_break"
    assert client.closed and len(client.calls) == 1
