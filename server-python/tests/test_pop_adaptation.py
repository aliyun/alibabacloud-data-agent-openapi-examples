"""Offline contract tests; no credentials or cloud requests."""
import json
from dataclasses import replace
from types import SimpleNamespace
import pytest
from fastapi.testclient import TestClient
from das_python import main
from das_python.config import AppConfig
from das_python.daemon.registry import SessionRecord
from das_python.daemon.live_routes import _remote_sse_stream, _remote_epoch
from das_python.live import LiveContext, _create_session_result, _list_sessions_result
from das_python.normalize import SdkError
from das_python.pop import rpc, session_events
from das_python.session_options import creation_options


def config(**overrides):
    return replace(AppConfig(mock=True, mockRealtime=False, mockSpeed=1000, port=0,
        corsOrigin=[], regionId="cn-beijing", endpoint=None, agentName="configured-agent",
        sessionSource="test", resourceGroupId=None, accessKeyId=None,
        accessKeySecret=None, serverHost="127.0.0.1", webDist=None), **overrides)


class FakePop:
    def __init__(self):
        self.calls = []
        self.error = None

    async def call_api_async(self, descriptor, request, runtime):
        params = json.loads(request.body["Params"])
        self.calls.append((descriptor, params, runtime))
        if self.error:
            return {"body": {"RequestId": "r", "JsonRpcResponse": {"Error": {"Message": self.error}}}}
        result = {"SessionId": "Remote-ID"} if descriptor.action == "CreateAgentSession" else {}
        if descriptor.action == "ListAgentSessions":
            result = {"AgentSessions": [{"SessionId": "Remote-ID", "SessionTitle": "persisted title",
                                         "Meta": {"Archived": params["Archived"]}}]}
        if descriptor.action == "ArchiveAgentSession":
            result = {"SessionId": params["SessionId"], "Archived": params["Archived"]}
        if descriptor.action == "UpdateAgentSessionTitle":
            result = {"SessionId": params["SessionId"], "Title": params["Title"]}
        return {"body": {"RequestId": "r", "JsonRpcResponse": {"Result": result}}}


@pytest.mark.asyncio
async def test_create_uses_published_fields_and_ui_overrides():
    client = FakePop()
    cfg = config(model="env-model", mode="plan", reasoningEffort="medium")
    result = await _create_session_result(LiveContext(client, cfg), options={
        "modelServiceId": "selected-model", "approvalMode": "auto-edit", "reasoningEffort": "none"})
    assert result["sessionId"] == "Remote-ID"
    desc, params, runtime = client.calls[0]
    assert (desc.action, desc.method, desc.req_body_type) == ("CreateAgentSession", "POST", "formData")
    assert params["Meta"]["Agent"] == {"AgentName": "configured-agent"}
    assert params["Meta"]["InitialConfigOptions"] == {"Mode": "auto-edit", "Model": "selected-model", "ReasoningEffort": "none"}
    assert "RuntimePolicy" not in params["Meta"]
    assert runtime.autoretry is False


@pytest.mark.parametrize("mode", ["plan", "default", "auto-edit", "auto", "yolo"])
def test_modes_and_validation(mode):
    assert creation_options(config(), {"approvalMode": mode})["mode"] == mode
    with pytest.raises(ValueError):
        creation_options(config(), {"modelServiceId": 1})
    with pytest.raises(ValueError):
        creation_options(config(), {"approvalMode": "unsupported"})


@pytest.mark.asyncio
async def test_pop_error_retained_and_empty_delete_result_is_success():
    client = FakePop()
    ctx = LiveContext(client, config())
    assert (await rpc(ctx, "DeleteAgentSession", {"SessionId": "s"}))["result"] == {}
    client.error = "access denied"
    with pytest.raises(SdkError, match="access denied"):
        await rpc(ctx, "DeleteAgentSession", {"SessionId": "s"})


@pytest.mark.asyncio
async def test_archive_filter_is_remote():
    client = FakePop()
    result = await _list_sessions_result(LiveContext(client, config()), archived=True)
    assert client.calls[0][1]["Archived"] is True
    assert result["sessions"][0]["title"] == "persisted title"
    assert result["sessions"][0]["archived"] is True
    active = await _list_sessions_result(LiveContext(client, config()))
    assert client.calls[-1][1]["Archived"] is False
    assert active["sessions"][0]["archived"] is False


def live_app(monkeypatch):
    client = FakePop()
    monkeypatch.setattr(main, "create_sdk_client", lambda cfg: client)
    return TestClient(main.create_app(config(mock=False, model="env-model", mode="plan",
        reasoningEffort="high", models=("env-model", "other")))), client


def test_routes_defaults_creation_mutations_and_failures(monkeypatch):
    http, pop = live_app(monkeypatch)
    assert http.get("/d/openapi/session-options").json() == {
        "agentName": "configured-agent", "model": "env-model", "approvalMode": "plan",
        "reasoningEffort": "high", "models": ["env-model", "other"], "promptTransport": "http-stream"}
    body = {"modelServiceId": "selected", "approvalMode": "auto", "reasoningEffort": "none"}
    assert http.post("/d/standalone/sessions", json=body).status_code == 200
    first_params = pop.calls[-1][1]
    assert http.post("/api/sessions", json=body).json()["ok"]
    assert first_params == pop.calls[-1][1]
    assert http.patch("/d/session/Remote-ID/metadata", json={"displayName": "new title"}).json()["displayName"] == "new title"
    assert pop.calls[-1][1] == {"SessionId": "Remote-ID", "Title": "new title"}
    before = len(pop.calls)
    assert http.patch("/d/session/Remote-ID/metadata", json={"displayName": "x" * 513}).status_code == 400
    assert len(pop.calls) == before
    assert http.post("/d/standalone/sessions/archive", json={"sessionIds": ["Remote-ID"]}).json()["archived"]
    assert pop.calls[-1][1] == {"SessionId": "Remote-ID", "Archived": True}
    assert http.get("/d/standalone/sessions?archiveState=archived").json()["sessions"]
    assert pop.calls[-1][1]["Archived"] is True
    pop.error = "denied"
    result = http.post("/d/standalone/sessions/delete", json={"sessionIds": ["Remote-ID"]}).json()
    assert result["removed"] == [] and result["errors"][0]["code"] == "upstream_error"
    assert http.delete("/d/session/Remote-ID").status_code == 502
    assert http.get("/d/standalone/sessions/Remote-ID").status_code == 502
    assert http.patch("/d/session/Remote-ID/metadata", json={"displayName": "bad"}).status_code == 502
    for route in ("model", "approval-mode", "config-option"):
        assert http.post(f"/d/session/Remote-ID/{route}", json={}).status_code == 409
    pop.error = None
    assert http.delete("/d/session/Remote-ID").status_code == 204
    assert pop.calls[-1][0].action == "DeleteAgentSession"


class FakeEvents:
    def __init__(self, frames):
        self.frames = frames
        self.requests = []
        self.closed = False

    async def call_sseapi_async(self, descriptor, request, runtime):
        self.requests.append((descriptor, request))
        try:
            for cursor, kind, data in self.frames:
                yield SimpleNamespace(event=SimpleNamespace(id=cursor, event=kind, data=json.dumps(data)))
        finally:
            self.closed = True


@pytest.mark.asyncio
async def test_raw_and_pop_events_preserve_cursors_data_and_close():
    data = {"v": 1, "type": "session_update", "data": {"TextWithCase": "kept"}}
    client = FakeEvents([("0042", "session_update", data),
        (None, None, {"Id": "43", "Event": "session_update", "Data": json.dumps(data)})])
    events = [event async for event in session_events(LiveContext(client, config()), "session", "0041")]
    desc, req = client.requests[0]
    assert desc.action == "GetAgentSessionEvents" and desc.method == "GET"
    assert req.query == {"SessionCode": "session"}
    assert req.headers == {"accept": "text/event-stream", "Last-Event-Id": "0041"}
    assert [event["id"] for event in events] == ["0042", "43"]
    assert events[0]["data"] == {**data, "id": 42}
    assert events[1]["data"] == {**data, "id": 43}
    assert client.closed


@pytest.mark.asyncio
async def test_live_stream_never_uses_journal_cursor_or_events():
    event = {"v": 1, "type": "permission_request", "data": {"requestId": "permission", "sessionId": "public-session"}}
    client = FakeEvents([("7", "permission_request", {"Id": "7", "Event": "permission_request", "Data": event})])
    record = SessionRecord("public-session")
    record.journal.append({"v": 1, "type": "local_only", "data": {}})
    ctx = LiveContext(client, config())
    output = "".join([chunk async for chunk in _remote_sse_stream(ctx, record.real_id, "0")])
    assert client.requests[0][1].headers == {"accept": "text/event-stream", "Last-Event-Id": "0"}
    assert "id: 7" in output and "local_only" not in output
    assert '"sessionId":"public-session"' in output
    assert not record.pending_permissions
    assert _remote_epoch(ctx.cfg, record.real_id) == _remote_epoch(ctx.cfg, record.real_id)


@pytest.mark.asyncio
async def test_real_sdk_events_streams_before_eof_and_signs_correct_get(monkeypatch):
    """Use actual signed SDK with synthetic keys and a localhost SSE peer."""
    import asyncio
    from aiohttp import web
    from das_python.live import create_sdk_client
    for key in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
        monkeypatch.delenv(key, raising=False)
    received = []
    release = asyncio.Event()

    async def handle(request):
        received.append((request.method, request.headers.get("x-acs-action"), request.query.get("SessionCode"), request.headers.get("Last-Event-Id")))
        assert request.headers["Accept"] == "text/event-stream"
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        await response.write(b'id: 18\nevent: session_update\ndata: {"v":1,"type":"session_update","data":{"text":"live"}}\n\n')
        await release.wait()
        return response

    app = web.Application()
    app.router.add_get("/", handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    cfg = config(accessKeyId="synthetic", accessKeySecret="synthetic", endpoint=f"127.0.0.1:{port}")
    client = create_sdk_client(cfg)
    client._protocol = "http"
    stream = session_events(LiveContext(client, cfg), "public-session", "17")
    try:
        event = await asyncio.wait_for(anext(stream), 2)
        assert event["id"] == "18" and event["data"]["data"]["text"] == "live"
        assert not release.is_set()  # first frame arrived before upstream EOF
        assert received == [("GET", "GetAgentSessionEvents", "public-session", "17")]
    finally:
        release.set()
        await stream.aclose()
        await runner.cleanup()


def test_invalid_create_and_resume_cursors_never_call_upstream(monkeypatch):
    http, pop = live_app(monkeypatch)
    for body in ({"approvalMode": None}, {"reasoningEffort": 1}, {"modelServiceId": ""}):
        assert http.post("/d/standalone/sessions", json=body).status_code == 400
        assert not http.post("/api/sessions", json=body).json()["ok"]
    assert pop.calls == []
    for cursor in ("-1", "NaN", "9007199254740992"):
        assert http.get("/d/session/s/events", headers={"Last-Event-Id": cursor}).status_code == 400


@pytest.mark.asyncio
async def test_event_wrapper_and_partial_close():
    data = {"v": 1, "type": "session_update", "data": {"text": "live"}}
    client = FakeEvents([(None, None, {"Id": "24", "Event": data}), ("25", "session_update", data)])
    stream = session_events(LiveContext(client, config()), "s", None)
    assert (await anext(stream))["id"] == "24"
    await stream.aclose()
    assert client.closed


@pytest.mark.asyncio
async def test_agent_management_examples_use_top_level_forms_and_version():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location("agent_management", Path(__file__).parents[1] / "examples/agent_management.py")
    examples = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(examples)
    calls = []

    class AdminClient:
        async def call_api_async(self, descriptor, request, runtime):
            calls.append((descriptor.action, request.body))
            return {"body": {"Agent": {"AgentVersion": 3, "Name": "a"}}}

    client = AdminClient()
    await examples.create_agent(client, "a", system_prompt="helper", skills=[{"Source": "OFFICIAL", "SkillId": "catalog-id"}],
                                expert_suites=[{"SuiteId": "db-suite", "Version": 1}], publish_immediately=True)
    assert calls[-1][1]["PublishImmediately"] == "true"
    assert json.loads(calls[-1][1]["Skills"]) == [{"Source": "OFFICIAL", "SkillId": "catalog-id"}]
    current = await examples.get_agent(client, "a")
    await examples.update_agent(client, "a", expected_version=current["Agent"]["AgentVersion"], display_name="changed")
    assert calls[-1] == ("UpdateAgent", {"Name": "a", "ExpectedVersion": 3, "DisplayName": "changed", "PublishImmediately": "false"})
    assert "Skills" not in calls[-1][1] and "Params" not in calls[-1][1]


def test_load_prompt_watermarks_are_remote_and_live_events_route_is_remote(monkeypatch):
    from das_python.daemon import live_routes as routes
    http, pop = live_app(monkeypatch)
    event = {"v": 1, "type": "session_update", "data": {"sessionId": "Remote-ID", "update": {"sessionUpdate": "agent_message_chunk"}}}
    events = FakeEvents([("42", "session_update", event)])
    pop.call_sseapi_async = events.call_sseapi_async
    http.post("/d/standalone/sessions", json={"modelServiceId": "selected"})
    response = http.get("/d/session/Remote-ID/events", headers={"Last-Event-Id": "0"})
    assert "id: 42" in response.text
    assert events.requests[0][1].headers == {"accept": "text/event-stream", "Last-Event-Id": "0"}
    assert response.headers["x-qwen-event-epoch"]

    async def history(*args):
        return []
    monkeypatch.setattr(routes, "_load_frames", history)
    loaded = http.post("/d/standalone/sessions/Remote-ID/load").json()
    assert "lastEventId" not in loaded
    assert loaded["eventEpoch"] == response.headers["x-qwen-event-epoch"]
    assert loaded["state"]["models"] == {"availableModels": []}
    assert loaded["liveJournal"] == []
    response = http.post("/d/session/Remote-ID/prompt", json={"prompt": [{"type": "text", "text": "test"}]})
    assert response.status_code == 410



@pytest.mark.asyncio
async def test_events_error_is_visible_and_never_uses_local_fallback():
    class Broken:
        async def call_sseapi_async(self, *args):
            raise RuntimeError("subscription unavailable")
            yield
    record = SessionRecord("s")
    record.journal.append({"type": "local_only", "data": {}})
    output = "".join([part async for part in _remote_sse_stream(LiveContext(Broken(), config()), record.real_id, None)])
    assert "turn_error" in output and "subscription unavailable" in output
    assert "local_only" not in output



def test_archived_directory_survives_app_restart_and_list_errors_propagate(monkeypatch):
    class PersistentPop(FakePop):
        archived = False

        async def call_api_async(self, descriptor, request, runtime):
            response = await super().call_api_async(descriptor, request, runtime)
            params = self.calls[-1][1]
            if not self.error:
                if descriptor.action == "ArchiveAgentSession":
                    self.archived = params["Archived"]
                elif descriptor.action == "ListAgentSessions" and params["Archived"] != self.archived:
                    response["body"]["JsonRpcResponse"]["Result"]["AgentSessions"] = []
            return response

    backend = PersistentPop()
    monkeypatch.setattr(main, "create_sdk_client", lambda cfg: backend)
    cfg = config(mock=False)
    first = TestClient(main.create_app(cfg))
    assert first.post("/d/standalone/sessions/archive", json={"sessionIds": ["Remote-ID"]}).json()["archived"]
    # A new app has an empty registry and no local archive flags.
    restarted = TestClient(main.create_app(cfg))
    assert restarted.get("/d/standalone/sessions").json()["sessions"] == []
    result = restarted.get("/d/standalone/sessions?archiveState=archived").json()
    assert result["sessions"][0]["sessionId"] == "Remote-ID"
    assert result["sessions"][0]["displayName"] == "persisted title"
    assert backend.calls[-1][1]["Archived"] is True
    backend.error = "list access denied"
    response = restarted.get("/d/standalone/sessions?archiveState=archived")
    assert response.status_code == 502 and "list access denied" in response.json()["error"]


@pytest.mark.parametrize("variant", ["raw", "event-object", "event-json", "data-object", "data-json", "named-data", "named-json-data"])
@pytest.mark.asyncio
async def test_all_verified_event_wrappers_and_ack_skip(variant):
    data = {"v": 1, "type": "session_update", "id": 8,
            "data": {"sessionId": "s", "text": "中文"}}
    variants = {
        "raw": data,
        "event-object": {"Id": "9", "Event": data},
        "event-json": {"Id": "9", "Event": json.dumps(data)},
        "data-object": {"Id": "9", "Event": "session_update", "Data": data},
        "data-json": {"Id": "9", "Event": "session_update", "Data": json.dumps(data)},
        "named-data": {"Id": "9", "Event": "session_update", "Data": data["data"]},
        "named-json-data": {"Id": "9", "Event": "session_update", "Data": json.dumps(data["data"])},
    }
    client = FakeEvents([("200", "message", {"RequestId": "ack"}), ("0010", None, variants[variant])])
    events = [event async for event in session_events(LiveContext(client, config()), "s", None)]
    assert len(events) == 1 and events[0]["id"] == "0010"
    assert events[0]["event"] == "session_update"
    assert events[0]["data"]["data"] == data["data"]


@pytest.mark.parametrize("cursor", [-1, True, 1.5, "-1", "9007199254740992", "NaN", "1\n2"])
@pytest.mark.asyncio
async def test_unsafe_outer_cursor_rejected_before_fallback(cursor):
    data = {"v": 1, "type": "session_update", "data": {}}
    client = FakeEvents([(cursor, None, {"Id": "12", "Event": json.dumps(data)})])
    with pytest.raises(ValueError, match="cursor"):
        _ = [event async for event in session_events(LiveContext(client, config()), "s", None)]
    assert client.closed


@pytest.mark.asyncio
async def test_payload_cursor_fallback_and_crosssession_rejection():
    data = {"v": 1, "type": "session_update", "id": 8, "data": {"sessionId": "s"}}
    client = FakeEvents([(None, None, {"Id": 12, "Event": json.dumps(data)}), (None, None, data)])
    events = [event async for event in session_events(LiveContext(client, config()), "s", None)]
    assert [event["id"] for event in events] == ["12", "8"]
    forbidden = {"v": 1, "type": "permission_request", "data": {"sessionId": "other", "requestId": "p"}}
    client = FakeEvents([("20", None, {"Event": json.dumps(forbidden)})])
    record = SessionRecord("s")
    output = "".join([part async for part in _remote_sse_stream(LiveContext(client, config()), record.real_id, None)])
    assert "another session" in output and "event: turn_error" in output
    assert "event: permission_request" not in output and "id: 20" not in output
    assert record.pending_permissions == {}


@pytest.mark.parametrize("default", [None, "configured-model"])
def test_model_sentinel_uses_environment_or_omits_on_both_create_routes(monkeypatch, default):
    client = FakePop()
    monkeypatch.setattr(main, "create_sdk_client", lambda cfg: client)
    http = TestClient(main.create_app(config(mock=False, model=default)))
    body = {"modelServiceId": "data-agent", "approvalMode": "plan", "reasoningEffort": "medium"}
    for route in ("/d/standalone/sessions", "/api/sessions"):
        assert http.post(route, json=body).status_code == 200
        initial = client.calls[-1][1]["Meta"]["InitialConfigOptions"]
        assert initial["Mode"] == "plan" and initial["ReasoningEffort"] == "medium"
        assert initial.get("Model") == default
        assert ("Model" in initial) == (default is not None)


@pytest.mark.parametrize("flattened", [False, True])
@pytest.mark.asyncio
async def test_actual_sdk_fragmented_utf8_multiline_sse_and_wire_cursor(monkeypatch, flattened):
    import asyncio
    from aiohttp import web
    from das_python.live import create_sdk_client
    for key in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
        monkeypatch.delenv(key, raising=False)
    release = asyncio.Event()
    seen = []
    daemon = {"v": 1, "type": "session_update", "data": {"sessionId": "s", "text": "中文续传"}}
    payload = json.dumps({"Id": 42, "Event": json.dumps(daemon["data"] if flattened else daemon, ensure_ascii=False)}, ensure_ascii=False, indent=2)
    wire = ('id: 999\r\ndata: {"RequestId":"ack-only"}\r\n\r\n'
            'id: 0018\r\nevent: session_update\r\n'
            + ''.join(f'data: {line}\r\n' for line in payload.splitlines()) + '\r\n').encode("utf-8")

    async def handle(request):
        seen.append((request.method, request.query.get("SessionCode"), request.headers.get("Last-Event-Id")))
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        # Force transport chunks through UTF-8 code points, CRLF, field names,
        # and JSON tokens; the actual SDK must incrementally decode all of them.
        for byte in wire:
            await response.write(bytes([byte]))
            await asyncio.sleep(0.001)
        await release.wait()
        return response

    app = web.Application()
    app.router.add_get("/", handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    cfg = config(accessKeyId="synthetic", accessKeySecret="synthetic", endpoint=f"127.0.0.1:{port}")
    client = create_sdk_client(cfg)
    client._protocol = "http"
    stream = session_events(LiveContext(client, cfg), "s", "0017")
    try:
        result = await asyncio.wait_for(anext(stream), 4)
        assert result["id"] == "0018"  # outer SSE cursor wins over Id=42
        assert result["event"] == "session_update" and result["data"] == {**daemon, "id": 18}
        assert seen == [("GET", "s", "0017")]
        assert not release.is_set()
    finally:
        release.set()
        await stream.aclose()
        await runner.cleanup()


@pytest.mark.parametrize("kind,flat", [
    ("session_update", {"sessionId": "s", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "live"}}}),
    ("turn_complete", {"sessionId": "s", "stopReason": "end_turn", "promptId": "p"}),
])
@pytest.mark.parametrize("wrapper", ["raw", "event", "event-json", "data", "data-json", "named-data"])
@pytest.mark.asyncio
async def test_flattened_public_events_normalize_to_canonical_daemon(kind, flat, wrapper):
    shapes = {"raw": flat, "event": {"Event": flat}, "event-json": {"Event": json.dumps(flat)},
              "data": {"Data": flat}, "data-json": {"Data": json.dumps(flat)},
              "named-data": {"Event": kind, "Data": flat}}
    client = FakeEvents([("51", "message", shapes[wrapper])])
    result = [event async for event in session_events(LiveContext(client, config()), "s", "50")]
    assert result == [{"id": "51", "event": kind, "data": {"v": 1, "type": kind, "data": flat, "id": 51}}]


@pytest.mark.asyncio
async def test_flattened_public_fields_and_crosssession_validation():
    client = FakeEvents([(None, None, {"Id": 52, "Data": {"SessionId": "s", "StopReason": "end_turn", "PromptId": "p"}})])
    events = [event async for event in session_events(LiveContext(client, config()), "s", None)]
    assert events[0]["id"] == "52"
    assert events[0]["data"]["data"] == {"sessionId": "s", "stopReason": "end_turn", "promptId": "p"}
    client = FakeEvents([("53", None, {"Data": {"sessionId": "another", "update": {}}})])
    with pytest.raises(ValueError, match="another session"):
        _ = [event async for event in session_events(LiveContext(client, config()), "s", None)]


def test_standalone_session_options_exposes_env_approval_and_models(monkeypatch):
    http, _ = live_app(monkeypatch)
    body = http.get("/d/standalone/session-options").json()
    assert body["approvalMode"] == "plan"
    assert [model["modelId"] for model in body["providers"][0]["models"]] == ["env-model", "other"]
    client = FakePop()
    monkeypatch.setattr(main, "create_sdk_client", lambda cfg: client)
    body = TestClient(main.create_app(config(mock=False))).get("/d/standalone/session-options").json()
    assert body["approvalMode"] == "yolo"
    assert body["providers"][0]["models"][0]["modelId"] == "data-agent"



def test_live_readback_uses_remote_title_and_repeated_archive_never_skips(monkeypatch):
    http, pop = live_app(monkeypatch)
    # FakePop acknowledges rename but deliberately keeps its persisted title.
    http.get("/d/standalone/sessions")
    renamed = http.patch("/d/session/Remote-ID/metadata", json={"displayName": "acknowledged only"})
    assert renamed.json()["displayName"] == "acknowledged only"
    assert http.get("/d/standalone/sessions/Remote-ID").json()["displayName"] == "persisted title"
    assert http.get("/d/standalone/sessions").json()["sessions"][0]["displayName"] == "persisted title"
    for _ in range(2):
        result = http.post("/d/standalone/sessions/archive", json={"sessionIds": ["Remote-ID"]}).json()
        assert result["archived"] == ["Remote-ID"] and result["alreadyArchived"] == []
    assert sum(call[0].action == "ArchiveAgentSession" for call in pop.calls) == 2
    pop.error = "archive denied"
    result = http.post("/d/standalone/sessions/archive", json={"sessionIds": ["Remote-ID"]}).json()
    assert result["archived"] == [] and result["alreadyArchived"] == [] and result["errors"]


@pytest.mark.parametrize("restore", ["load", "resume"])
def test_live_load_returns_fresh_pop_history_without_a_registry(monkeypatch, restore):
    from das_python.daemon import live_routes as routes
    http, _ = live_app(monkeypatch)
    frames = [
        {"RequestId": "history-rid", "Method": "session/update", "Params": {"sessionId": "s", "update": {
            "sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "new question"}}}},
        {"RequestId": "history-rid", "Method": "session/update", "Params": {"sessionId": "s", "update": {
            "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "fresh-authoritative-marker"}}}},
    ]
    reads = []
    async def load(ctx, sid):
        reads.append(sid)
        return frames
    monkeypatch.setattr(routes, "_load_frames", load)
    for _ in range(2):
        response = http.post(f"/d/standalone/sessions/s/{restore}")
        assert response.status_code == 200
        body = response.json()
        assert "fresh-authoritative-marker" in json.dumps(body["compactedReplay"])
        assert len(body["compactedReplay"]) == 2
        assert all("id" not in event for event in body["compactedReplay"])
        assert body["liveJournal"] == [] and "lastEventId" not in body
    assert reads == ["s", "s"]


def test_pending_permissions_rebuild_can_use_fresh_history_without_seed():
    from das_python.daemon.registry import rebuild_pending_permissions
    record = SessionRecord("s")
    old = {"v": 1, "type": "permission_request", "data": {"sessionId": "s", "requestId": "old"}}
    fresh = {"v": 1, "type": "permission_request", "data": {"sessionId": "s", "requestId": "fresh"}}
    record.journal.append(old)
    record.journal.active_prompt = True
    rebuild_pending_permissions(record, [fresh])
    assert record.pending_permissions == {"fresh": fresh}
    assert record.journal.all()[0].event["data"]["requestId"] == "old"
