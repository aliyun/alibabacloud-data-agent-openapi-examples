"""Request-scoped Agent selection, verified at the SDK request boundary; no cloud calls."""
import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from das_python import config as config_module, main
from das_python.daemon import live_routes
from das_python.live import LiveContext, _create_session_result, _list_sessions_result
from das_python.session_options import creation_options
from test_pop_adaptation import FakePop, config


@pytest.mark.parametrize("name", ["other-agent", "  自定义_agent  ", "a" * 128])
@pytest.mark.asyncio
async def test_create_override_is_trimmed_in_agent_meta_only_and_does_not_change_config(name):
    pop = FakePop()
    cfg = config()
    ctx = LiveContext(pop, cfg)
    await _create_session_result(ctx, options={"agentName": name})
    params = pop.calls[-1][1]
    assert params["Meta"]["Agent"] == {"AgentName": name.strip()}
    assert "AgentName" not in params["Meta"]["InitialConfigOptions"]
    assert cfg.agentName == "configured-agent"
    await _create_session_result(ctx)
    assert pop.calls[-1][1]["Meta"]["Agent"] == {"AgentName": "configured-agent"}


@pytest.mark.parametrize("name", [None, 1, True, [], {}, "", "  ", "x" * 129,
                                  "agent\n", "\tagent", "a\x00b", "a\x7fb", "a\x85b", "a\u202eb"])
def test_invalid_agent_options_are_rejected(name):
    with pytest.raises(ValueError, match="agentName"):
        creation_options(config(), {"agentName": name})


def test_environment_agent_default_is_data_agent_and_env_still_wins(monkeypatch):
    monkeypatch.setattr(config_module, "_load_env_file", lambda: None)
    # Isolate configuration without loading a real env file or accessing credentials.
    monkeypatch.setattr(config_module.os, "environ", {"MOCK": "1"})
    cfg = config_module.load_config()
    assert cfg.agentName == "dataworks_data_agent"
    assert creation_options(cfg, {})["agentName"] == "dataworks_data_agent"
    config_module.os.environ["DATAAGENT_AGENT_NAME"] = "  environment-agent  "
    cfg = config_module.load_config()
    assert cfg.agentName == "environment-agent"
    assert creation_options(cfg, {})["agentName"] == "environment-agent"


def app_for(monkeypatch, pop=None):
    pop = pop or FakePop()
    monkeypatch.setattr(main, "create_sdk_client", lambda cfg: pop)
    return main.create_app(config(mock=False)), pop


@pytest.mark.parametrize("route", ["/d/standalone/sessions", "/api/sessions"])
def test_both_http_create_routes_forward_agent_and_preserve_default(monkeypatch, route):
    app, pop = app_for(monkeypatch)
    http = TestClient(app)
    assert http.post(route, json={"agentName": " custom "}).status_code == 200
    assert pop.calls[-1][1]["Meta"]["Agent"] == {"AgentName": "custom"}
    assert http.post(route, json={}).status_code == 200
    assert pop.calls[-1][1]["Meta"]["Agent"] == {"AgentName": "configured-agent"}
    assert http.get("/d/openapi/session-options").json()["agentName"] == "configured-agent"
    before = len(pop.calls)
    response = http.post(route, json={"agentName": "bad\nname"})
    if route.startswith("/api"):
        assert response.json()["ok"] is False
    else:
        assert response.status_code == 400
    assert len(pop.calls) == before


class DirectoryPop(FakePop):
    async def call_api_async(self, descriptor, request, runtime):
        response = await super().call_api_async(descriptor, request, runtime)
        params = self.calls[-1][1]
        if descriptor.action == "ListAgentSessions":
            # The custom session exists only in its remote Agent's archived directory.
            rows = response["body"]["JsonRpcResponse"]["Result"]["AgentSessions"]
            if params["AgentName"] != "custom" or not params["Archived"]:
                rows.clear()
        return response


def test_list_and_lookup_forward_agent_filter_and_archived_on_each_request(monkeypatch):
    app, pop = app_for(monkeypatch, DirectoryPop())
    http = TestClient(app)
    response = http.get("/d/standalone/sessions", params={"agentName": " custom ", "archiveState": "archived"})
    assert response.status_code == 200
    assert response.json()["sessions"][0]["sessionId"] == "Remote-ID"
    assert pop.calls[-1][1] == {"AgentName": "custom", "SessionSourceList": ["test"],
                               "MaxResults": 100, "Archived": True}
    before = len(pop.calls)
    assert http.get("/d/standalone/sessions/Remote-ID", params={"agentName": " custom "}).status_code == 200
    queries = [params for _, params, _ in pop.calls[before:]]
    assert [params["Archived"] for params in queries] == [False, True]
    assert {params["AgentName"] for params in queries} == {"custom"}
    assert http.get("/d/standalone/sessions").json()["sessions"] == []
    assert pop.calls[-1][1]["AgentName"] == "configured-agent"
    # Creation does not install a sid->Agent alias: default lookup still uses ENV.
    http.post("/d/standalone/sessions", json={"agentName": "custom"})
    assert http.get("/d/standalone/sessions/Remote-ID").status_code == 404
    assert pop.calls[-1][1]["AgentName"] == "configured-agent"


@pytest.mark.parametrize("route", ["/d/standalone/sessions", "/d/standalone/sessions/Remote-ID"])
@pytest.mark.parametrize("name", ["", " ", "a" * 129, "bad\nname", "bad\x7fname", "a\u202eb"])
def test_invalid_directory_query_is_400_before_sdk(monkeypatch, route, name):
    app, pop = app_for(monkeypatch)
    response = TestClient(app).get(route, params={"agentName": name})
    assert response.status_code == 400
    assert response.json()["code"] == "invalid_agent_name"
    assert not pop.calls


@pytest.mark.asyncio
async def test_pagination_keeps_request_agent_without_mutating_environment():
    class PagedPop(FakePop):
        async def call_api_async(self, descriptor, request, runtime):
            response = await super().call_api_async(descriptor, request, runtime)
            result = response["body"]["JsonRpcResponse"]["Result"]
            params = self.calls[-1][1]
            if "NextToken" not in params:
                result["NextToken"] = "next-page"
            return response
    pop = PagedPop()
    cfg = config()
    await _list_sessions_result(LiveContext(pop, cfg), agent_name=" custom ")
    assert len(pop.calls) == 2
    assert {params["AgentName"] for _, params, _ in pop.calls} == {"custom"}
    assert pop.calls[1][1]["NextToken"] == "next-page"
    assert cfg.agentName == "configured-agent"


@pytest.mark.asyncio
async def test_concurrent_agent_queries_have_no_shared_selection_state(monkeypatch):
    class YieldingPop(FakePop):
        async def call_api_async(self, descriptor, request, runtime):
            await asyncio.sleep(0)
            return await super().call_api_async(descriptor, request, runtime)
    app, pop = app_for(monkeypatch, YieldingPop())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
        responses = await asyncio.gather(*(http.get("/d/standalone/sessions", params={"agentName": name})
                                          for name in ("first", "second")))
        assert all(response.status_code == 200 for response in responses)
        assert {params["AgentName"] for _, params, _ in pop.calls} == {"first", "second"}
        await http.get("/d/standalone/sessions")
    assert pop.calls[-1][1]["AgentName"] == "configured-agent"


def test_prompt_and_load_remain_sid_only_after_agent_override(monkeypatch):
    app, pop = app_for(monkeypatch)
    seen = []

    async def frames(ctx, sid, text, *args):
        seen.append(("prompt", sid, text))
        yield {"RequestId": "owned-rid", "Result": {"stopReason": "end_turn"}}

    async def load(ctx, sid):
        seen.append(("load", sid))
        return []

    monkeypatch.setattr(main, "live_prompt_frames", frames)
    monkeypatch.setattr(live_routes, "_load_frames", load)
    http = TestClient(app)
    assert http.post("/d/standalone/sessions", json={"agentName": "custom"}).status_code == 200
    before = len(pop.calls)
    response = http.post("/api/sessions/Unseen-ID/prompt", params={"agentName": "different"}, json={"text": "synthetic"})
    assert response.status_code == 200
    assert any(json.loads(line).get("type") == "done" for line in response.text.splitlines() if line)
    assert http.post("/d/standalone/sessions/Unseen-ID/load", params={"agentName": "different"}).status_code == 200
    assert seen == [("prompt", "Unseen-ID", "synthetic"), ("load", "Unseen-ID")]
    assert len(pop.calls) == before
