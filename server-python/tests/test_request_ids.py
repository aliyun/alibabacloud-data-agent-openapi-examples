"""Real SDK -> loopback POP HTTP/SSE -> ASGI JSON/NDJSON; synthetic credentials only."""
import json

import httpx
import pytest
from aiohttp import web
from alibabacloud_tea_openapi.exceptions import ClientException

from das_python import main
from das_python.errors import ApiError, api_error, classify_error, redact_api_error, with_api_name
from das_python.live import create_sdk_client
from das_python.normalize import SdkError, to_api_error, missing_result_error, read_non_stream_body
from test_pop_adaptation import config


@pytest.mark.parametrize("request_id", [None, "", " ", "x\n", "x\r", "x\x00", "x\x7f", "x\x85", "x\u202e", "中文", "x y", "x\t", "x" * 257, {}, [], 42])
def test_invalid_ids_are_omitted_everywhere(request_id):
    error = api_error("rpc_error", "unchanged", requestId=request_id)
    assert "requestId" not in error.to_dict()
    assert error.requestId is None
    normalized = to_api_error(ClientException(status_code=403, message="denied", request_id=request_id), "CreateAgentSession")
    assert "requestId" not in normalized.to_dict()
    assert normalized.message == "CreateAgentSession: denied"


@pytest.mark.parametrize("request_id", ["remote-id", "x" * 256])
def test_all_error_transformations_keep_valid_id(request_id):
    original = classify_error(message="denied LTAIfakefakefakefake1", requestId=request_id)
    prefixed = with_api_name(redact_api_error(original), "CreateAgentSession")
    assert prefixed.requestId == request_id
    assert "LTAIfakefakefakefake1" not in prefixed.message
    assert to_api_error(SdkError(prefixed), "CreateAgentSession").to_dict() == prefixed.to_dict()
    assert ApiError("rpc_error", "original").to_dict() == {
        "kind": "rpc_error", "code": None, "errorCode": None, "message": "original",
        "retryable": False, "fatalForSession": False, "upstreamStatus": None}


@pytest.mark.parametrize("source", ["attribute", "data-upper", "data-lower", "headers", "data-headers", "response"])
def test_sdk_exception_sources_are_allowlisted(source):
    from types import SimpleNamespace
    error = ClientException(status_code=403, message="denied", data={"credentials": "secret-data"})
    if source == "attribute":
        error.request_id = "remote"
    elif source.startswith("data-") and source != "data-headers":
        error.data["RequestId" if source == "data-upper" else "requestId"] = "remote"
    elif source == "headers":
        error.headers = {"X-ACS-Request-ID": "remote", "Authorization": "secret-header"}
    elif source == "data-headers":
        error.data["headers"] = {"x-acs-request-id": "remote", "Authorization": "secret-header"}
    else:
        error.response = SimpleNamespace(headers={"x-acs-request-id": "remote"})
    wire = to_api_error(error, "CreateAgentSession").to_dict()
    assert wire["requestId"] == "remote"
    assert "secret" not in json.dumps(wire)


def test_sdk_cast_missing_result_retains_response_id():
    from alibabacloud_dataworks_public20240518.models import ListAgentsResponse
    response = ListAgentsResponse().from_map({"statusCode": 200, "headers": {"x-acs-request-id": "header-pop"},
        "body": {"RequestId": "body-pop", "JsonRpcResponse": {"Error": {"Message": "SDK drops this"}}}})
    error = missing_result_error("ListAgents", read_non_stream_body(response)).api_error
    assert error.requestId == "body-pop"
    assert "没有 JsonRpcResponse.Result" in error.message


@pytest.fixture
async def wire(monkeypatch):
    for key in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.delenv(key, raising=False)
    state = {"requests": []}

    async def handle(request):
        form = await request.post()
        state["requests"].append((request.headers["x-acs-action"], dict(form)))
        reply = state["responses"].pop(0) if "responses" in state else state
        if reply.get("abort"):
            response = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Content-Length": "100000", **reply.get("headers", {})})
            await response.prepare(request)
            await response.write(reply["sse"].encode())
            request.transport.close()
            return response
        if "sse" in reply:
            return web.Response(content_type="text/event-stream", text=reply["sse"], headers=reply.get("headers", {}))
        return web.json_response(reply.get("body", {}), status=reply.get("status", 200), headers=reply.get("headers", {}))

    app = web.Application()
    app.router.add_route("*", "/", handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    cfg = config(mock=False, accessKeyId="synthetic-key", accessKeySecret="synthetic-secret",
                 endpoint=f"127.0.0.1:{site._server.sockets[0].getsockname()[1]}")
    sdk = create_sdk_client(cfg)
    sdk._protocol = "http"
    monkeypatch.setattr(main, "create_sdk_client", lambda _: sdk)
    state["app"] = main.create_app(cfg)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=state["app"]), base_url="http://asgi") as client:
        try:
            yield client, state
        finally:
            await runner.cleanup()


@pytest.mark.asyncio
@pytest.mark.parametrize("request_id", ["sdk-403-pop", None, "", "x" * 257, "invalid\nID", {"credentials": "HIDDEN-ID-SECRET"}, 42])
async def test_sdk_403_create_wire(wire, request_id):
    client, state = wire
    state.update(status=403, body={"Code": "Forbidden", "Message": "Deny LTAIfakefakefakefake1",
                                  "AccessKeySecret": "DO-NOT-EXPOSE", "RequestId": request_id})
    response = await client.post("/d/standalone/sessions", json={})
    data = response.json()
    assert response.status_code == 502 and data["code"] == "create_failed"
    if request_id == "sdk-403-pop":
        assert data["requestId"] == request_id
    else:
        assert "requestId" not in data
    assert "HIDDEN-ID-SECRET" not in response.text
    assert "invalid\\nID" not in response.text
    assert "x" * 257 not in response.text
    assert "Deny" in data["error"]
    assert "LTAIfakefakefakefake1" not in response.text and "DO-NOT-EXPOSE" not in response.text
    assert [action for action, _ in state["requests"]] == ["CreateAgentSession"]


@pytest.mark.asyncio
@pytest.mark.parametrize("envelope", [{"Error": {"Message": "rpc denied"}}, {}, {"Result": {}}])
@pytest.mark.parametrize("request_id", ["pop-create", None, "bad\ncontrol"])
async def test_create_jsonrpc_error_missing_or_empty_result(wire, envelope, request_id):
    client, state = wire
    state["body"] = {"JsonRpcResponse": envelope, "RequestId": request_id}
    response = await client.post("/d/standalone/sessions", json={})
    data = response.json()
    assert response.status_code == 502
    assert data.get("requestId") == ("pop-create" if request_id == "pop-create" else None)
    if request_id != "pop-create":
        assert "requestId" not in data
        assert "bad\\ncontrol" not in response.text
    if "Error" in envelope:
        assert data["error"] == f"CreateAgentSession: rpc denied (RequestId={'pop-create' if request_id == 'pop-create' else ''})"
    elif not envelope:
        assert data["error"] == "CreateAgentSession: missing JsonRpcResponse.Result"
    else:
        assert data["error"] == "CreateAgentSession returned an empty SessionId"


@pytest.mark.asyncio
@pytest.mark.parametrize("method,path,body,code", [
    ("GET", "/d/standalone/sessions", None, "list_failed"),
    ("GET", "/d/standalone/sessions/s", None, "lookup_failed"),
    ("PATCH", "/d/session/s/metadata", {"displayName": "title"}, "rename_failed"),
    ("POST", "/d/session/s/cancel", {}, "cancel_failed"),
    ("DELETE", "/d/session/s", None, "delete_failed"),
    ("POST", "/d/session/s/permission/card-id", {"outcome": {"outcome": "selected", "optionId": "allow"}}, "permission_upstream_error"),
])
async def test_daemon_string_errors_keep_remote_id(wire, method, path, body, code):
    client, state = wire
    state["body"] = {"RequestId": "remote-pop", "JsonRpcResponse": {"Error": {"Message": "denied"}}}
    response = await client.request(method, path, json=body)
    assert response.json()["requestId"] == "remote-pop"
    assert response.json()["code"] == code
    assert isinstance(response.json()["error"], str)


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["archive", "unarchive", "delete"])
async def test_batch_errors_keep_each_call_id_without_cache(wire, action):
    client, state = wire
    state["body"] = {"RequestId": "remote-pop", "JsonRpcResponse": {"Error": {"Message": "denied"}}}
    response = await client.post(f"/d/standalone/sessions/{action}", json={"sessionIds": ["s"]})
    assert response.json()["errors"][0]["requestId"] == "remote-pop"
    state["body"].pop("RequestId")
    response = await client.post(f"/d/standalone/sessions/{action}", json={"sessionIds": ["s"]})
    assert "requestId" not in response.json()["errors"][0]


def sse(*bodies):
    return "".join("data: " + json.dumps(body) + "\n\n" for body in bodies)


@pytest.mark.asyncio
@pytest.mark.parametrize("pop_id", ["ack-pop", None, "bad\ncontrol", "x" * 257])
@pytest.mark.parametrize("failure", ["frame", "eof", "parse"])
async def test_prompt_ndjson_failure_uses_only_pop_metadata(wire, pop_id, failure):
    client, state = wire
    frames = [{"RequestId": pop_id}] if pop_id is not None else []
    if failure == "frame":
        frames.append({"RequestId": "turn-rid", "Error": {"code": -32603, "message": "denied"}})
    elif failure == "eof":
        frames.append({"RequestId": "turn-rid", "Method": "session/update", "Params": {"data": {"requestId": "card-id"}}})
    state["sse"] = sse(*frames) + ("data: broken-json\n\n" if failure == "parse" else "")
    response = await client.post("/api/sessions/s/prompt", json={"text": "synthetic"})
    events = [json.loads(line) for line in response.text.splitlines()]
    error = events[-1]["error"]
    assert events[-1]["type"] == "error" and not any(e["type"] == "done" for e in events)
    if pop_id == "ack-pop":
        assert error["requestId"] == pop_id
    else:
        assert "requestId" not in error
    assert error.get("requestId") not in ("turn-rid", "card-id")
    assert len(state["requests"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["frame", "eof", "parse"])
@pytest.mark.parametrize("source", ["ack", "header", "none"])
async def test_daemon_load_sse_failure(wire, failure, source):
    client, state = wire
    frames = [{"RequestId": "load-pop"}] if source == "ack" else []
    if source == "header":
        state["headers"] = {"x-acs-request-id": "load-pop", "Authorization": "DO-NOT-EXPOSE"}
    if failure == "frame":
        frames.append({"RequestId": "history-turn-rid", "Error": {"code": -32603, "message": "load denied"}})
    elif failure == "eof":
        frames.append({"RequestId": "history-turn-rid", "Method": "session/update", "Params": {}})
    state["sse"] = sse(*frames) + ("data: broken-json\n\n" if failure == "parse" else "")
    response = await client.post("/d/standalone/sessions/s/load")
    data = response.json()
    assert data["code"] == "load_failed" and isinstance(data["error"], str)
    if source == "none":
        assert "requestId" not in data
    else:
        assert data["requestId"] == "load-pop"
    assert "DO-NOT-EXPOSE" not in response.text
    assert len(state["requests"]) == (3 if failure != "frame" else 1)


@pytest.mark.asyncio
async def test_events_header_forwarded_and_precommit_failure_json(wire):
    client, state = wire
    state.update(headers={"X-ACS-Request-ID": "events-pop", "Authorization": "DO-NOT-EXPOSE"},
                 sse=sse({"type": "permission_request", "data": {"sessionId": "s", "requestId": "card-id"}}))
    response = await client.get("/d/session/s/events")
    assert response.headers["x-acs-request-id"] == "events-pop"
    assert "authorization" not in response.headers
    assert "card-id" in response.text and "DO-NOT-EXPOSE" not in response.text
    state.pop("sse")
    state.update(status=403, body={"Code": "Forbidden", "Message": "denied", "RequestId": "sdk-pop"})
    response = await client.get("/d/session/s/events")
    assert response.status_code == 502
    assert response.json()["requestId"] == "sdk-pop"
    assert isinstance(response.json()["error"], str)


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["parse", "network"])
async def test_prompt_header_survives_sdk_decode_or_socket_failure(wire, fault):
    client, state = wire
    state["headers"] = {"X-ACS-Request-ID": "header-pop", "Authorization": "HIDDEN-HEADER"}
    if fault == "parse":
        state["sse"] = "data: broken-json\n\n"
    else:
        state["abort"] = True
        state["sse"] = sse({"RequestId": "ack-pop"}, {"RequestId": "turn-rid", "Method": "session/update", "Params": {}})
    response = await client.post("/api/sessions/s/prompt", json={"text": "synthetic"})
    events = [json.loads(line) for line in response.text.splitlines()]
    assert events[-1]["error"]["requestId"] == "header-pop"
    assert not any(event["type"] == "done" for event in events)
    assert "HIDDEN-HEADER" not in response.text
    assert len(state["requests"]) == 1


@pytest.mark.asyncio
async def test_events_after_commit_keeps_header_and_never_fabricates_terminal(wire):
    _, state = wire
    state.update(headers={"x-acs-request-id": "events-pop"}, sse=sse(
        {"type": "session_update", "data": {"sessionId": "s", "update": {}}}) + "data: broken-json\n\n")
    # ASGI records the committed response even when the upstream stream fails.
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=state["app"], raise_app_exceptions=False), base_url="http://asgi") as client:
        response = await client.get("/d/session/s/events")
    assert response.headers["x-acs-request-id"] == "events-pop"
    assert "event: session_update" in response.text
    assert "turn_error" not in response.text and "turn_complete" not in response.text


@pytest.mark.asyncio
async def test_daemon_permission_card_id_is_never_a_remote_request_id(wire):
    client, state = wire
    state["body"] = {"JsonRpcResponse": {"Result": {"Accepted": False}}}
    response = await client.post("/d/session/s/permission/card-id", json={"outcome": {"outcome": "selected", "optionId": "allow"}})
    assert response.status_code == 404
    assert "requestId" not in response.json()
    state["body"]["RequestId"] = "real-pop"
    response = await client.post("/d/session/s/permission/card-id", json={"outcome": {"outcome": "selected", "optionId": "allow"}})
    assert response.json()["requestId"] == "real-pop"


@pytest.mark.asyncio
async def test_prompt_pop_only_ack_then_empty_next_call_has_no_cached_id(wire):
    client, state = wire
    state["sse"] = sse({"RequestId": "only-pop"})
    response = await client.post("/api/sessions/s/prompt", json={"text": "synthetic"})
    error = json.loads(response.text.splitlines()[-1])["error"]
    assert error["kind"] == "prompt_not_dispatched" and error["requestId"] == "only-pop"
    state["sse"] = sse({"RequestId": "turn-rid", "Error": {"message": "denied"}})
    response = await client.post("/api/sessions/s/prompt", json={"text": "synthetic"})
    assert "requestId" not in json.loads(response.text.splitlines()[-1])["error"]
    assert len(state["requests"]) == 2


@pytest.mark.asyncio
async def test_load_socket_failure_retains_pop_id_and_retry_count(wire):
    client, state = wire
    state.update(abort=True, sse=sse({"RequestId": "load-pop"}, {"Method": "session/update", "Params": {}}))
    response = await client.post("/d/standalone/sessions/s/load")
    assert response.json()["requestId"] == "load-pop"
    assert len(state["requests"]) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("request_id", [None, "x" * 257])
async def test_events_never_forward_card_id_or_invalid_header(wire, request_id):
    client, state = wire
    state["headers"] = {} if request_id is None else {"x-acs-request-id": request_id}
    state["sse"] = sse({"type": "permission_request", "data": {"sessionId": "s", "requestId": "card-id"}})
    response = await client.get("/d/session/s/events")
    assert response.status_code == 200 and "x-acs-request-id" not in response.headers
    assert "card-id" in response.text


@pytest.mark.asyncio
async def test_http_200_header_fallback_for_missing_result(wire):
    client, state = wire
    state.update(body={"JsonRpcResponse": {}}, headers={"X-ACS-Request-ID": "header-pop", "Authorization": "HIDDEN"})
    response = await client.post("/d/standalone/sessions", json={})
    assert response.json() == {"error": "CreateAgentSession: missing JsonRpcResponse.Result", "code": "create_failed", "requestId": "header-pop"}
    assert "HIDDEN" not in response.text


@pytest.mark.asyncio
async def test_events_first_payload_parse_failure_is_precommit_json(wire):
    client, state = wire
    state.update(headers={"x-acs-request-id": "events-pop"}, sse="data: broken-json\n\n")
    response = await client.get("/d/session/s/events")
    assert response.status_code == 502
    assert response.json()["requestId"] == "events-pop"
    assert response.json()["code"] == "events_upstream_error"


@pytest.mark.parametrize("value,expected", [
    ("  pop-id  ", "pop-id"), ("x" * 256, "x" * 256),
    ("  x\r\n ", None), ("é", None), ("中文", None), ("x y", None),
    ("\tpop-id", None), ("x\x7f", None), (" " * 3, None),
])
def test_header_safe_id_validation(value, expected):
    from das_python.errors import safe_request_id
    assert safe_request_id(value) == expected
    assert api_error("rpc_error", "unchanged", requestId=value).requestId == expected


@pytest.mark.asyncio
async def test_events_header_is_trimmed_before_response_construction(wire):
    client, state = wire
    state.update(headers={"x-acs-request-id": "  header-pop  "}, sse=sse({"RequestId": "different-ack"}))
    response = await client.get("/d/session/s/events")
    assert response.headers["x-acs-request-id"] == "header-pop"


@pytest.mark.asyncio
async def test_sse_header_wins_over_later_sdk_exception_id():
    from types import SimpleNamespace
    from das_python.live import LiveContext, _initial_prompt_frames, _load_stream

    class Client:
        async def prompt_agent_session_with_sse_async(self, *args):
            yield SimpleNamespace(headers={"x-acs-request-id": "header-pop"},
                body=SimpleNamespace(to_map=lambda: {"RequestId": "different-ack"}))
            raise ClientException(status_code=403, message="denied", request_id="exception-pop")

        load_agent_session_with_sse_async = prompt_agent_session_with_sse_async

    ctx = LiveContext(Client(), config())
    for stream in (_initial_prompt_frames(ctx, "s", "text", "rpc-id", []),
                   _load_stream(ctx, "s", "rpc-id", None, 1000, [])):
        with pytest.raises(SdkError) as caught:
            _ = [frame async for frame in stream]
        assert caught.value.api_error.requestId == "header-pop"


@pytest.mark.asyncio
async def test_later_pop_ack_cannot_override_observed_sse_header():
    from types import SimpleNamespace
    from das_python.live import LiveContext, _initial_prompt_frames, _load_stream

    class Client:
        async def prompt_agent_session_with_sse_async(self, *args):
            for headers, body in [({"x-acs-request-id": "header-pop"}, {"RequestId": "ack-one"}),
                                  ({}, {"RequestId": "ack-two"})]:
                yield SimpleNamespace(headers=headers, body=SimpleNamespace(to_map=lambda body=body: body))

        load_agent_session_with_sse_async = prompt_agent_session_with_sse_async

    ctx = LiveContext(Client(), config())
    for load in (False, True):
        ids = []
        source = _load_stream(ctx, "s", "rpc-id", None, 1000, ids) if load else _initial_prompt_frames(ctx, "s", "text", "rpc-id", ids)
        assert [frame async for frame in source] == []
        assert ids == ["header-pop"]


@pytest.mark.parametrize("body,expected", [
    ({"RequestId": "  pop-id  "}, "pop-id"),
    ({"requestId": "pop-id", "timestamp": 1}, "pop-id"),
    ({"data": {"RequestId": "pop-id", "Timestamp": 1}}, "pop-id"),
    ({"RequestId": "turn-rid", "Id": "rpc-id"}, None),
    ({"requestId": "turn-rid", "id": "rpc-id"}, None),
    ({"RequestId": "turn-rid", "Id": None}, None),
    ({"RequestId": "turn-rid", "id": ""}, None),
    ({"RequestId": "turn-rid", "Params": {}}, None),
    ({"RequestId": "turn-rid", "Jsonrpc": "2.0"}, None),
    ({"RequestId": "pop-id", "unexpected": True}, None),
    ({"RequestId": "bad\r\n"}, None),
    ({"RequestId": "中文"}, None),
    ({"RequestId": "x" * 257}, None),
])
def test_pop_ack_requires_pure_receipt_without_rpc_id(body, expected):
    from das_python.frames import pop_ack_request_id
    assert pop_ack_request_id(body) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("header", [None, "header-pop"])
async def test_sse_missing_acp_payload_with_id_is_not_a_pop_ack(wire, header):
    client, state = wire
    state["headers"] = {} if header is None else {"x-acs-request-id": header}
    state["sse"] = sse({"Id": "rpc-id", "RequestId": "turn-rid"})
    response = await client.post("/api/sessions/s/prompt", json={"text": "synthetic"})
    error = json.loads(response.text.splitlines()[-1])["error"]
    if header:
        assert error["requestId"] == header
    else:
        assert "requestId" not in error
    response = await client.post("/d/standalone/sessions/s/load")
    if header:
        assert response.json()["requestId"] == header
    else:
        assert "requestId" not in response.json()


@pytest.mark.asyncio
async def test_normal_rpc_top_level_id_does_not_disqualify_pop_request_id(wire):
    client, state = wire
    state["body"] = {"Id": "rpc-id", "RequestId": "rpc-pop", "JsonRpcResponse": {"Error": {"Message": "denied"}}}
    response = await client.post("/d/standalone/sessions", json={})
    assert response.json()["requestId"] == "rpc-pop"


@pytest.mark.asyncio
@pytest.mark.parametrize("load1_source", ["header", "ack"])
@pytest.mark.parametrize("load2_id", [None, "load2-pop"])
async def test_prompt_recovery_ndjson_does_not_reuse_load1_id_for_load2_403(wire, load1_source, load2_id):
    client, state = wire
    chunk = {"Jsonrpc": "2.0", "RequestId": "original-turn", "Method": "session/update",
             "Params": {"sessionId": "s", "_meta": {"offset": 7},
                        "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "synthetic"}}}}
    state["responses"] = [
        {"headers": {"x-acs-request-id": "prompt-pop"}, "sse": sse(chunk)},
        {"headers": {"x-acs-request-id": "load1-header"} if load1_source == "header" else {},
         "sse": sse({"RequestId": "load1-ack"})},
        {"status": 403, "body": {"Code": "Forbidden", "Message": "synthetic Load2 denied",
                                 **({"RequestId": load2_id} if load2_id else {})}},
    ]
    response = await client.post("/api/sessions/s/prompt", json={"text": "synthetic"})
    events = [json.loads(line) for line in response.text.splitlines()]
    error = events[-1]["error"]
    assert [event["body"] for event in events if event["type"] == "frame"] == [chunk]
    assert [event["type"] for event in events if event["type"] in ("done", "error")] == ["error"]
    assert error["upstreamStatus"] == 403 and error["retryable"] is False
    if load2_id:
        assert error["requestId"] == load2_id
    else:
        assert "requestId" not in error
    assert [action for action, _ in state["requests"]] == ["PromptAgentSession", "LoadAgentSession", "LoadAgentSession"]
    for _, form in state["requests"][1:]:
        assert json.loads(form["Params"])["Meta"]["BeginLogOffset"] == 7
    assert state["responses"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["exception", "frame", "load-control"])
async def test_prompt_recovery_closes_previous_rpc_before_resetting_current_diagnostic_ids(failure):
    from types import SimpleNamespace
    from das_python.live import LiveContext, _prompt_frames
    from das_python.pipeline import PipelineInput, to_wire_events

    ids = ["stale-before-prompt"]
    closed = []
    loads = 0

    def response(body, header=None):
        return SimpleNamespace(headers={"x-acs-request-id": header} if header else {},
                               body=SimpleNamespace(to_map=lambda: body))

    class Client:
        async def prompt_agent_session_with_sse_async(self, *args):
            assert ids == []
            try:
                yield response({"Jsonrpc": "2.0", "RequestId": "original-turn", "Params": {
                    "sessionId": "s", "_meta": {"offset": 7}}}, "prompt-header")
            finally:
                ids.append("prompt-close-id")
                closed.append("prompt")

        async def load_agent_session_with_sse_async(self, request, *args):
            nonlocal loads
            loads += 1
            assert ids == []
            if loads == 1:
                assert closed == ["prompt"]
                try:
                    yield response({"RequestId": "load1-ack"}, "load1-header")
                finally:
                    ids.append("load1-close-id")
                    closed.append("load1")
            else:
                assert loads == 2 and closed == ["prompt", "load1"]
                if failure == "exception":
                    raise ClientException(status_code=403, message="synthetic Load2 denied")
                yield response({"Jsonrpc": "2.0", **({"Id": request.id} if failure == "load-control" else {"RequestId": "original-turn"}),
                                "Error": {"code": 403, "message": "synthetic Load2 denied"}})

    ctx = LiveContext(Client(), config())
    events = [event async for event in to_wire_events(PipelineInput(
        _prompt_frames(ctx, "s", "synthetic", ids), sessionId="s", mock=False, startedAt=0,
        apiName="PromptAgentSession", popRequestIds=ids))]
    assert events[-1]["type"] == "error"
    assert "requestId" not in events[-1]["error"]
    assert not any(event["type"] == "done" for event in events)
    assert closed == ["prompt", "load1"] and loads == 2 and ids == []
