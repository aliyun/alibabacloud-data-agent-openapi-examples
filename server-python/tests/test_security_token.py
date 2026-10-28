"""Real SDK signing with fake credentials, isolated environment and loopback only."""
import hashlib
import hmac
import os
import re
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qsl, quote, urlsplit

import pytest
from aiohttp import web
from alibabacloud_dataworks_public20240518 import models

from das_python import config
from das_python.live import LiveContext, create_sdk_client, runtime_for
from das_python.normalize import SdkError
from das_python.pop import rpc, session_events

AK = "synthetic-access-key"
SK = "synthetic-access-secret"
TOKEN = "synthetic-security-token"


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    # Bypass dotenv entirely; do not read or print the workspace's credentials.
    monkeypatch.setattr(config, "_load_env_file", lambda: None)
    with patch.dict(os.environ, {
        "ALIBABA_CLOUD_ACCESS_KEY_ID": AK,
        "ALIBABA_CLOUD_ACCESS_KEY_SECRET": SK,
        "NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1",
    }, clear=True):
        yield


def verify_signature(method, url, headers, body, token):
    assert headers.get("x-acs-security-token") == token
    match = re.fullmatch(r"ACS3-HMAC-SHA256 Credential=([^,]+),SignedHeaders=([^,]+),Signature=([a-f0-9]{64})", headers["authorization"])
    assert match is not None
    access_key, signed, signature = match.groups()
    assert access_key == AK
    assert ("x-acs-security-token" in signed.split(";")) == (token is not None)
    parts = urlsplit(url)
    query = "&".join(f"{key}={quote(value, safe='~')}" for key, value in sorted(parse_qsl(parts.query)))
    canonical_headers = "".join(f"{key}:{headers[key].strip()}\n" for key in signed.split(";"))
    payload_hash = hashlib.sha256(body).hexdigest()
    assert headers["x-acs-content-sha256"] == payload_hash
    canonical = "\n".join([method, parts.path, query, canonical_headers, signed, payload_hash])
    string_to_sign = "ACS3-HMAC-SHA256\n" + hashlib.sha256(canonical.encode()).hexdigest()
    assert signature == hmac.new(SK.encode(), string_to_sign.encode(), hashlib.sha256).hexdigest()


@pytest.mark.asyncio
@pytest.mark.parametrize("raw_token", [None, "", " \t ", f" {TOKEN} "])
async def test_credentials_reach_all_transports(raw_token):
    if raw_token is not None:
        os.environ["ALIBABA_CLOUD_SECURITY_TOKEN"] = raw_token
    cfg = config.load_config()
    token = (raw_token or "").strip() or None
    assert cfg.securityToken == token
    for secret in (AK, SK, TOKEN):
        assert secret not in config.describe_config(cfg)

    requests = []

    async def handle(request):
        body = await request.read()
        requests.append((request.method, request.raw_path, request.headers, body))
        action = request.headers["x-acs-action"]
        if action == "GetAgentSessionEvents":
            return web.Response(content_type="text/event-stream", text='data: {"type":"turn_complete","data":{"sessionId":"synthetic-session","stopReason":"end_turn"}}\n\n')
        if action in ("PromptAgentSession", "LoadAgentSession"):
            return web.Response(content_type="text/event-stream", text='data: {"JsonRpcResponse":{"Result":{"stopReason":"end_turn"}}}\n\n')
        return web.json_response({"RequestId": "loopback", "JsonRpcResponse": {"Result": {"Agents": [], "AgentSessions": []}}})

    app = web.Application()
    app.router.add_route("*", "/", handle)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        cfg.endpoint = f"127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
        os.environ.update({
            "ALIBABA_CLOUD_ACCESS_KEY_ID": "ambient-key-must-not-be-used",
            "ALIBABA_CLOUD_ACCESS_KEY_SECRET": "ambient-secret-must-not-be-used",
            "ALIBABA_CLOUD_SECURITY_TOKEN": "ambient-token-must-not-be-used",
        })
        client = create_sdk_client(cfg)
        client._protocol = "http"
        await client.list_agents_with_options_async(models.ListAgentsRequest(id="test", jsonrpc="2.0"), runtime_for(2000))
        frames = [frame async for frame in client.prompt_agent_session_with_sse_async(
            models.PromptAgentSessionRequest(id="test", jsonrpc="2.0", params=models.PromptAgentSessionRequestParams(session_id="synthetic-session")), runtime_for(2000))]
        assert len(frames) == 1
        frames = [frame async for frame in client.load_agent_session_with_sse_async(
            models.LoadAgentSessionRequest(id="test", jsonrpc="2.0", params=models.LoadAgentSessionRequestParams(session_id="synthetic-session")), runtime_for(2000))]
        assert len(frames) == 1
        ctx = LiveContext(client, cfg)
        await rpc(ctx, "ListAgentSessions", {"AgentName": "synthetic-agent"})
        events = [event async for event in session_events(ctx, "synthetic-session", None)]
        assert len(events) == 1
        assert [headers["x-acs-action"] for _, _, headers, _ in requests] == [
            "ListAgents", "PromptAgentSession", "LoadAgentSession", "ListAgentSessions", "GetAgentSessionEvents",
        ]
        for method, url, headers, body in requests:
            verify_signature(method, url, headers, body, token)
    finally:
        await runner.cleanup()


@pytest.mark.parametrize("field,env", [
    ("accessKeyId", "ALIBABA_CLOUD_ACCESS_KEY_ID"),
    ("accessKeySecret", "ALIBABA_CLOUD_ACCESS_KEY_SECRET"),
])
def test_token_does_not_replace_missing_key(field, env, capsys):
    os.environ["ALIBABA_CLOUD_SECURITY_TOKEN"] = TOKEN
    cfg = config.load_config()
    setattr(cfg, field, None)
    with pytest.raises(SdkError):
        create_sdk_client(cfg)
    os.environ.pop(env)
    with pytest.raises(SystemExit) as exc:
        config.load_config()
    assert exc.value.code == 1
    output = capsys.readouterr().err
    for secret in (AK, SK, TOKEN):
        assert secret not in output


def test_existing_config_objects_without_optional_field_still_work():
    cfg = SimpleNamespace(accessKeyId=AK, accessKeySecret=SK, regionId="cn-hangzhou", endpoint="127.0.0.1:1")
    client = create_sdk_client(cfg)
    assert client._credential.get_credential().type == "access_key"
