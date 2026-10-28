"""LIVE stateless transport contract; synthetic clients only, no cloud calls.

Prepared before implementation so the old admission/receipt and Registry paths
fail explicitly. MOCK keeps its independent daemon/journal contract tests.
"""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from das_python import main
from das_python.daemon import routes, live_routes
from das_python.daemon.events import OPENAPI_ANSWERS_OPTION
from test_pop_adaptation import FakeEvents, FakePop, config


@pytest.fixture
def live_app(monkeypatch):
    pop = FakePop()
    pop.call_sseapi_async = FakeEvents([]).call_sseapi_async
    monkeypatch.setattr(main, "create_sdk_client", lambda cfg: pop)
    return main.create_app(config(mock=False)), pop


def test_live_does_not_construct_a_session_registry(monkeypatch):
    pop = FakePop()
    monkeypatch.setattr(main, "create_sdk_client", lambda cfg: pop)

    def forbidden_registry(*args, **kwargs):
        raise AssertionError("LIVE must not create a process session Registry")

    monkeypatch.setattr(routes, "SessionRegistry", forbidden_registry)
    app = main.create_app(config(mock=False))
    assert TestClient(app).get("/d/health").status_code == 200


@pytest.mark.parametrize("mock,transport", [(False, "http-stream"), (True, "daemon")])
def test_session_options_advertise_the_only_prompt_transport(monkeypatch, mock, transport):
    monkeypatch.setattr(main, "create_sdk_client", lambda cfg: FakePop())
    response = TestClient(main.create_app(config(mock=mock))).get("/d/openapi/session-options")
    assert response.status_code == 200
    assert response.json()["promptTransport"] == transport


@pytest.mark.parametrize("path", [
    "/d/session/Unseen-ID/prompt",
    "/d/session/Unseen-ID/openapi-prompt/local-admission/receipt",
])
def test_live_retires_background_prompt_and_receipt_without_dispatch(live_app, monkeypatch, path):
    app, pop = live_app

    pending = []
    monkeypatch.setattr(routes, "submit_turn", lambda loop, turn: pending.append(turn))
    try:
        response = TestClient(app).post(path, json={"prompt": [{"type": "text", "text": "synthetic"}]})
        assert response.status_code in (404, 410)
        assert not pending
        assert not pop.calls
    finally:
        for turn in pending:
            turn.acquired.release()


@pytest.mark.parametrize("path", ["/d/session/Unseen-ID/status", "/d/daemon/status"])
def test_live_status_has_no_fabricated_idle_state(live_app, path):
    app, pop = live_app
    response = TestClient(app).get(path)
    assert response.status_code == 404
    assert "hasActivePrompt" not in response.json()
    assert not pop.calls


def test_live_heartbeat_is_no_state_no_upstream(live_app):
    app, pop = live_app
    assert TestClient(app).post("/d/session/Unseen-ID/heartbeat").status_code == 204
    assert not pop.calls


def test_live_sidless_permission_is_rejected_without_scanning_or_reply(live_app, monkeypatch):
    app, pop = live_app

    async def forbidden_reply(*args):
        raise AssertionError("legacy permission cannot infer a session")

    monkeypatch.setattr(live_routes, "_reply_result", forbidden_reply)
    response = TestClient(app).post("/d/permission/p", json={"outcome": {"outcome": "selected", "optionId": "allow"}})
    assert response.status_code in (400, 404, 410)
    assert not pop.calls


@pytest.mark.parametrize("accepted,status", [(True, 200), (False, 404)])
def test_live_permission_goes_remote_without_local_pending_card(live_app, monkeypatch, accepted, status):
    app, _ = live_app
    calls = []

    async def reply(ctx, sid, body):
        calls.append((sid, body))
        return {"accepted": accepted}

    monkeypatch.setattr(live_routes, "_reply_result", reply)
    http = TestClient(app)
    for _ in range(2):
        response = http.post("/d/session/Mixed-Case-ID/permission/p", json={"outcome": {"outcome": "selected", "optionId": "allow"}})
        assert response.status_code == status
    assert calls == [("Mixed-Case-ID", {"permissionRequestId": "p", "answers": None, "optionId": "allow", "outcome": "selected"})] * 2


def test_live_answers_ui_sentinel_never_reaches_pop(live_app, monkeypatch):
    app, _ = live_app
    calls = []

    async def reply(ctx, sid, body):
        calls.append(body)
        return {"accepted": True}

    monkeypatch.setattr(live_routes, "_reply_result", reply)
    http = TestClient(app)
    body = {"outcome": {"outcome": "selected", "optionId": OPENAPI_ANSWERS_OPTION}, "answers": {"0": "synthetic"}}
    assert http.post("/d/session/s/permission/p", json=body).status_code == 200
    assert calls[0]["optionId"] is None
    assert calls[0]["answers"] == {"0": "synthetic"}
    body.pop("answers")
    assert http.post("/d/session/s/permission/p", json=body).status_code == 400
    assert len(calls) == 1


@pytest.mark.parametrize("header,cursor", [(None, None), ("0", "0"), ("0041", "0041")])
def test_live_events_cursor_is_only_from_this_request_header(live_app, header, cursor):
    app, pop = live_app
    event = {"v": 1, "type": "permission_request", "data": {"sessionId": "Mixed-ID", "requestId": "p"}}
    remote = FakeEvents([("42", "permission_request", event)])
    pop.call_sseapi_async = remote.call_sseapi_async
    http = TestClient(app)
    response = http.get("/d/session/Mixed-ID/events?lastEventId=999&snapshot=true", headers={} if header is None else {"Last-Event-ID": header})
    assert response.status_code == 200
    assert "id: 42\n" in response.text
    assert "workbench_prompt_result" not in response.text
    assert "session_snapshot" not in response.text
    assert remote.requests[0][1].query == {"SessionCode": "Mixed-ID"}
    assert remote.requests[0][1].headers.get("Last-Event-Id") == cursor
    # A new subscription must not reuse the prior connection's observed cursor.
    http.get("/d/session/Mixed-ID/events")
    assert "Last-Event-Id" not in remote.requests[-1][1].headers
    assert remote.closed


@pytest.mark.parametrize("cursor", ["-1", "abc", "9007199254740992"])
def test_live_bad_events_cursor_rejected_before_remote(live_app, cursor):
    app, pop = live_app
    remote = FakeEvents([])
    pop.call_sseapi_async = remote.call_sseapi_async
    response = TestClient(app).get("/d/session/s/events", headers={"Last-Event-ID": cursor})
    assert response.status_code == 400
    assert not remote.requests


def test_live_remote_directory_failure_cannot_fall_back_to_old_summary(live_app):
    app, pop = live_app
    http = TestClient(app)
    assert http.get("/d/standalone/sessions").status_code == 200
    pop.error = "synthetic upstream denial"
    assert http.get("/d/standalone/sessions/Remote-ID").status_code >= 400
    pop.error = None
    assert http.get("/d/standalone/sessions/Unseen-ID").status_code == 404


def test_live_delete_does_not_create_a_local_tombstone(live_app):
    app, pop = live_app
    http = TestClient(app)
    assert http.delete("/d/session/Remote-ID").status_code == 204
    # Remote fake still authorizes this sid; local success must not override it.
    response = http.patch("/d/session/Remote-ID/metadata", json={"displayName": "remote title"})
    assert response.status_code == 200
    assert pop.calls[-1][1] == {"SessionId": "Remote-ID", "Title": "remote title"}


@pytest.mark.asyncio
async def test_live_same_sid_concurrent_http_prompts_are_admitted_only_by_upstream(live_app, monkeypatch):
    app, _ = live_app
    both_started = asyncio.Event()
    finish = asyncio.Event()
    calls = []

    async def frames(ctx, sid, text, pop_ids):
        calls.append((sid, text))
        if len(calls) == 2:
            both_started.set()
        await finish.wait()
        yield {"RequestId": text, "Result": {"stopReason": "end_turn"}}

    monkeypatch.setattr(main, "live_prompt_frames", frames)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://asgi") as http:
        tasks = [asyncio.create_task(http.post("/api/sessions/Same-ID/prompt", json={"text": text})) for text in ("one", "two")]
        try:
            await asyncio.wait_for(both_started.wait(), 1)
        finally:
            finish.set()
            responses = await asyncio.gather(*tasks)
    assert sorted(calls) == [("Same-ID", "one"), ("Same-ID", "two")]
    for response in responses:
        assert response.status_code == 200
        events = [json.loads(line) for line in response.text.splitlines()]
        assert events[-1]["type"] == "done"
        assert all(event["type"] != "error" for event in events)


@pytest.mark.asyncio
async def test_live_http_prompt_never_touches_the_process_inflight_lock(live_app, monkeypatch):
    app, _ = live_app

    def forbidden_lock(*args):
        raise AssertionError("LIVE admission belongs exclusively to upstream")

    async def frames(*args):
        yield {"RequestId": "synthetic-rid", "Result": {"stopReason": "end_turn"}}

    monkeypatch.setattr(main, "try_acquire", forbidden_lock)
    monkeypatch.setattr(main, "live_prompt_frames", frames)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://asgi") as http:
        result = await http.post("/api/sessions/s/prompt", json={"text": "synthetic"})
    assert json.loads(result.text.splitlines()[-1])["type"] == "done"


def test_live_load_resume_and_transcript_are_fresh_remote_reads(live_app, monkeypatch):
    app, _ = live_app
    reads = []

    async def load(ctx, sid):
        reads.append(sid)
        return [{"version": len(reads)}]

    def translate(frames, sid):
        return [{"v": 1, "type": "session_update", "data": {"sessionId": sid,
            "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": str(frames[0]["version"])}}}}]

    monkeypatch.setattr(live_routes, "_load_frames", load)
    monkeypatch.setattr(live_routes, "history_frames_to_events", translate)
    http = TestClient(app)
    for i, path in enumerate(("/d/standalone/sessions/Mixed-ID/load",
                              "/d/standalone/sessions/Mixed-ID/resume",
                              "/d/session/Mixed-ID/transcript"), start=1):
        response = http.request("GET" if path.endswith("transcript") else "POST", path)
        assert response.status_code == 200
        body = response.json()
        events = body["events"] if path.endswith("transcript") else body["compactedReplay"]
        assert events[0]["data"]["update"]["content"]["text"] == str(i)
        assert "lastEventId" not in body
        assert all("id" not in event for event in events)
        if not path.endswith("transcript"):
            assert body["liveJournal"] == []
            assert not body["state"]["models"].get("currentModelId")
    assert reads == ["Mixed-ID"] * 3


def test_live_batch_mutations_preserve_path_sid_and_never_short_circuit(live_app):
    app, pop = live_app
    http = TestClient(app)
    for route, field in (("archive", "archived"), ("unarchive", "unarchived"), ("delete", "removed")):
        for _ in range(2):
            result = http.post(f"/d/standalone/sessions/{route}", json={"sessionIds": ["Mixed-ID"]})
            assert result.status_code == 200
            assert result.json()[field] == ["Mixed-ID"]
            assert pop.calls[-1][1]["SessionId"] == "Mixed-ID"
    assert len(pop.calls) == 6


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [False, True])
async def test_live_http_prompt_terminal_is_owned_by_the_http_response(live_app, monkeypatch, failure):
    app, _ = live_app
    closed = []

    async def frames(*args):
        try:
            if failure:
                raise ConnectionError("synthetic upstream failure")
            yield {"RequestId": "owned-rid", "Result": {"stopReason": "end_turn"}}
        finally:
            closed.append(True)

    def forbidden_background(*args):
        raise AssertionError("HTTP prompt must never start a background daemon turn")

    monkeypatch.setattr(main, "live_prompt_frames", frames)
    monkeypatch.setattr(routes, "submit_turn", forbidden_background)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://asgi") as http:
        response = await http.post("/api/sessions/s/prompt", json={"text": "synthetic"})
    assert response.status_code == 200
    events = [json.loads(line) for line in response.text.splitlines()]
    terminals = [event for event in events if event["type"] in ("done", "error")]
    assert [event["type"] for event in terminals] == ["error" if failure else "done"]
    assert closed == [True]


def test_http_prompt_flushes_headers_before_first_frame_and_disconnect_does_not_cancel(live_app, monkeypatch):
    """Real socket: buffered ASGI clients cannot prove admission before first token."""
    import socket
    import threading
    import time
    import uvicorn

    app, pop = live_app
    entered = threading.Event()
    closed = threading.Event()
    calls = []

    async def blocked_frames(ctx, sid, text, pop_ids):
        calls.append((sid, text))
        entered.set()
        try:
            await asyncio.Event().wait()
            yield {}
        finally:
            closed.set()

    monkeypatch.setattr(main, "live_prompt_frames", blocked_frames)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", lifespan="off"))
    thread = threading.Thread(target=lambda: server.run(sockets=[listener]), daemon=True)
    thread.start()
    try:
        for _ in range(200):
            if server.started:
                break
            time.sleep(.01)
        assert server.started
        started = time.monotonic()
        with httpx.stream("POST", f"http://127.0.0.1:{port}/api/sessions/s/prompt",
                          json={"text": "synthetic"}, timeout=2) as response:
            assert response.status_code == 200
            assert "application/x-ndjson" in response.headers["content-type"]
            assert time.monotonic() - started < 2
            assert entered.wait(1)
        assert closed.wait(2), "disconnect must release the request's upstream iterator"
        assert calls == [("s", "synthetic")]
        assert pop.calls == []  # no Cancel, retry or history request caused by disconnect
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        listener.close()


@pytest.mark.asyncio
async def test_http_prompt_preterminal_eof_is_unknown_not_success(live_app, monkeypatch):
    app, pop = live_app
    calls = []

    async def frames(ctx, sid, text, pop_ids):
        calls.append(sid)
        yield {"RequestId": "own-rid", "Method": "session/update", "Params": {"sessionId": sid,
            "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "partial"}}}}

    monkeypatch.setattr(main, "live_prompt_frames", frames)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://asgi") as http:
        response = await http.post("/api/sessions/s/prompt", json={"text": "synthetic"})
        assert (await http.get("/d/session/s/status")).status_code == 404
    events = [json.loads(line) for line in response.text.splitlines()]
    assert events[-1]["type"] == "error"
    assert events[-1]["error"]["kind"] == "stream_break"
    assert not any(event["type"] == "done" for event in events)
    assert calls == ["s"] and pop.calls == []


def test_live_history_and_permission_work_on_a_fresh_app_without_admission(monkeypatch):
    pop = FakePop()
    monkeypatch.setattr(main, "create_sdk_client", lambda cfg: pop)
    reads, replies = [], []

    async def load(ctx, sid):
        reads.append(sid)
        return []

    async def reply(ctx, sid, body):
        replies.append((sid, body["permissionRequestId"]))
        return {"accepted": True}

    monkeypatch.setattr(live_routes, "_load_frames", load)
    monkeypatch.setattr(live_routes, "_reply_result", reply)
    for _ in range(2):
        http = TestClient(main.create_app(config(mock=False)))
        assert http.post("/d/standalone/sessions/Remote-ID/resume").status_code == 200
        assert http.post("/d/session/Remote-ID/permission/p", json={"outcome": {"outcome": "selected", "optionId": "allow"}}).status_code == 200
    assert reads == ["Remote-ID"] * 2
    assert replies == [("Remote-ID", "p")] * 2
