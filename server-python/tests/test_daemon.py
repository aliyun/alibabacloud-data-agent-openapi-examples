"""daemon 兼容层（/d）的端到端契约：与 Node 实现的 server/test/daemon-routes.test.ts、
Java 实现的 DaemonRoutesTest 逐条同源。

**双形态测试**：无后台任务的端点跑在 starlette TestClient 上（快）；
带后台轮次（prompt/SSE/409/ghost）的用例**必须有真 uvicorn**——
starlette TestClient 的 anyio portal 会在响应完成后 cancel 掉 handler 里 spawn 的任务，
而 daemon 模型的核心保证恰恰是"响应完成后轮次照样跑完"（实测复现：
TestClient 下首个事件后 asyncio.sleep 必抛 CancelledError）。
"""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import time

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient

from das_python.config import AppConfig
from das_python.daemon import runner as daemon_runner
from das_python.main import create_app
from das_python.mock_fixtures import _created_scenarios


def _mock_cfg() -> AppConfig:
    return AppConfig(
        mock=True,
        mockRealtime=False,
        mockSpeed=1000,
        port=0,
        corsOrigin=["http://localhost:5173"],
        regionId="cn-hangzhou",
        endpoint=None,
        agentName="dataworks_data_agent",
        sessionSource="data-agent-openapi-demo",
        resourceGroupId=None,
        accessKeyId=None,
        accessKeySecret=None,
        serverHost="127.0.0.1",
        webDist=None,
    )


@pytest.fixture()
def fresh_created():
    """MOCK 新建会话登记表是模块全局的（跨 app 实例共享）：清零以便计数断言隔离。"""
    _created_scenarios.clear()
    yield
    _created_scenarios.clear()


@pytest.fixture()
def mock_client(fresh_created) -> TestClient:
    return TestClient(create_app(_mock_cfg()))


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture()
def live_url():
    port = _free_port()
    config = uvicorn.Config(create_app(_mock_cfg()), host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(60):
        if server.started:
            break
        time.sleep(0.1)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=8)


def _transcript_until(get, session_id: str, type_: str, timeout_s: float = 15.0) -> list[dict]:
    deadline = time.time() + timeout_s
    while True:
        events = get(f"/d/session/{session_id}/transcript").json()["events"]
        if any(e["type"] == type_ for e in events):
            return events
        assert time.time() < deadline, f"transcript 等待 {type_} 超时"
        time.sleep(0.08)


# ------------------------------------------------------------------
# 发现 / 会话目录
# ------------------------------------------------------------------


def test_capabilities_has_both_standalone_feature_tags(mock_client: TestClient) -> None:
    body = mock_client.get("/d/capabilities").json()
    assert body["v"] == 1
    assert body["mode"] == "standalone"
    assert "standalone_sessions_v1" in body["features"]
    assert "standalone_session_options_v1" in body["features"]


def test_session_options_has_required_provider_model_fields(mock_client: TestClient) -> None:
    body = mock_client.get("/d/standalone/session-options").json()
    assert body["initialized"] is True
    provider = body["providers"][0]
    assert provider["kind"] == "model_provider"
    assert provider["status"] == "ok"
    assert provider["authType"] == "none"
    assert provider["current"] is True
    model = provider["models"][0]
    assert model["modelId"] == "data-agent"
    assert model["isCurrent"] is True
    assert model["isRuntime"] is False


def test_standalone_sessions_list_has_standalone_fields(mock_client: TestClient) -> None:
    body = mock_client.get("/d/standalone/sessions").json()
    sessions = body["sessions"]
    assert len(sessions) == 9  # 两条"别的来源"被过滤（8 场景 + mock-permission）
    for s in sessions:
        assert s["sourceType"] == "standalone"
        assert s["context"] == {"kind": "standalone"}
        assert isinstance(s["workspaceCwd"], str) and s["workspaceCwd"]
        assert isinstance(s["createdAt"], str)
    assert any(s["sessionId"] == "mock-short" for s in sessions)


def test_create_returns_real_id_and_lookup_resolves(mock_client: TestClient) -> None:
    alias_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    body = mock_client.post("/d/standalone/sessions", json={"sessionId": alias_id}).json()
    assert body["sessionId"] and body["sessionId"] != alias_id
    assert body["sourceType"] == "standalone"
    assert body["context"] == {"kind": "standalone"}
    assert body["workingDirectory"] == {"state": "ready"}
    assert isinstance(body["projectlessOutputDirectory"], str)
    assert isinstance(body["clientId"], str)

    lookup = mock_client.get(f"/d/standalone/sessions/{body['sessionId']}")
    assert lookup.status_code == 200
    assert lookup.json()["sessionId"] == body["sessionId"]


def test_load_seeds_history_into_compacted_replay(mock_client: TestClient) -> None:
    body = mock_client.post("/d/standalone/sessions/mock-short/load", json={}).json()
    assert body["sessionId"] == "mock-short"
    compacted = body["compactedReplay"]
    assert len(compacted) > 0
    assert body["liveJournal"] == []
    assert body["lastEventId"] == compacted[-1]["id"]
    assert isinstance(body["eventEpoch"], str)
    assert body["state"]["models"] == [
        {
            "modelId": "data-agent",
            "baseModelId": "data-agent",
            "name": "DataWorks Data Agent",
            "isCurrent": True,
            "isRuntime": False,
        }
    ]
    assert body["state"]["modes"] == {}
    assert body["state"]["configOptions"] is None
    assert body["historyHasMore"] is False
    # 种子里 user 回显必须已剥校验码说明
    user_chunks = [e for e in compacted if e["data"]["update"].get("sessionUpdate") == "user_message_chunk"]
    assert user_chunks
    for chunk in user_chunks:
        assert "校验码" not in chunk["data"]["update"]["content"]["text"]


# ------------------------------------------------------------------
# prompt → SSE → turn_complete；后台并发与收尾
# ------------------------------------------------------------------


def _read_sse_until(live: str, session_id: str, last_event_id: int, admission: dict, stop_type: str) -> list[dict]:
    """读 SSE 直到出现 stop_type 事件或超时。同步读取（httpx stream 在后台轮次跑的 uvicorn 上逐帧到）。"""
    out: list[dict] = []
    with httpx.Client(timeout=httpx.Timeout(60.0, read=30.0)) as client:
        with client.stream(
            "GET",
            f"{live}/d/session/{session_id}/events",
            headers={"accept": "text/event-stream", "last-event-id": str(last_event_id)},
        ) as resp:
            assert resp.status_code == 200
            assert "text/event-stream" in resp.headers["content-type"]
            assert resp.headers.get("x-qwen-event-epoch") == admission["eventEpoch"]
            assert "x-qwen-sse-stream-id" in resp.headers
            event: str | None = None
            entry_id: int | None = None
            data: list[str] = []
            for line in resp.iter_lines():
                if line == "":
                    if event is not None and data:
                        out.append({"id": entry_id, "event": event, "envelope": json.loads("\n".join(data))})
                        if event == stop_type:
                            return out
                    event, entry_id, data = None, None, []
                elif line.startswith(":"):
                    continue
                elif line.startswith("id: "):
                    entry_id = int(line[4:])
                elif line.startswith("event: "):
                    event = line[7:]
                elif line.startswith("data: "):
                    data.append(line[6:])
    raise AssertionError(f"SSE 未在流结束前收到 {stop_type}（收到 {len(out)} 帧）")


def test_prompt_202_then_sse_streams_session_updates_to_turn_complete(live_url: str) -> None:
    which = "mock-tools"  # 392 帧：足够长以覆盖多轮 session_update 序列
    with httpx.Client(base_url=live_url, timeout=15.0) as client:
        admission = client.post(f"/d/session/{which}/prompt", json={"prompt": [{"type": "text", "text": "你好"}]})
        assert admission.status_code == 202
        body = admission.json()

        # 202 严格契约：只有这三个键
        assert set(body.keys()) == {"promptId", "lastEventId", "eventEpoch"}

        frames = _read_sse_until(live_url, which, body["lastEventId"], body, "turn_complete")
        assert len(frames) > 1

        # 续传语义：所有帧的 id 都严格大于 202 里的 lastEventId
        for frame in frames:
            if frame["id"] is not None:
                assert frame["id"] > body["lastEventId"]

        # user 回显在流上也要剥掉校验码说明
        user_chunks = [
            f for f in frames
            if f["event"] == "session_update" and f["envelope"]["data"]["update"].get("sessionUpdate") == "user_message_chunk"
        ]
        assert user_chunks
        for chunk in user_chunks:
            assert "校验码" not in chunk["envelope"]["data"]["update"]["content"]["text"]

        # agent 输出存在且终态正确
        kinds = {f["envelope"]["data"]["update"].get("sessionUpdate") for f in frames if f["event"] == "session_update"}
        assert "agent_message_chunk" in kinds

        complete = next(f for f in frames if f["event"] == "turn_complete")
        assert complete["envelope"]["data"]["stopReason"] == "end_turn"
        assert complete["envelope"]["data"]["promptId"] == body["promptId"]

        _transcript_until(client.get, which, "turn_complete")


def test_inflight_prompt_rejects_second_with_409(live_url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    # Hold the first replay open until the second request checks admission.
    # At mockSpeed=1000 a short public fixture can otherwise finish before it arrives.
    release = threading.Event()
    original_replay = daemon_runner.replay_frames

    async def held_replay(*args, **kwargs):
        assert await asyncio.to_thread(release.wait, 10), "test did not release the first turn"
        async for frame in original_replay(*args, **kwargs):
            yield frame

    monkeypatch.setattr(daemon_runner, "replay_frames", held_replay)
    with httpx.Client(base_url=live_url, timeout=15.0) as client:
        created = client.post("/d/standalone/sessions", json={}).json()
        session_id = created["sessionId"]
        try:
            first = client.post(f"/d/session/{session_id}/prompt", json={"prompt": [{"type": "text", "text": "第一轮"}]})
            assert first.status_code == 202
            second = client.post(f"/d/session/{session_id}/prompt", json={"prompt": [{"type": "text", "text": "第二轮"}]})
            assert second.status_code == 409
            assert second.json()["code"] == "session_concurrent_operation_in_progress"
        finally:
            release.set()
        _transcript_until(client.get, session_id, "turn_complete")


def test_error_frame_ends_with_turn_error_only(live_url: str) -> None:
    with httpx.Client(base_url=live_url, timeout=15.0) as client:
        admission = client.post(
            "/d/session/mock-ghost/prompt", json={"prompt": [{"type": "text", "text": "触发幽灵化"}]}
        )
        assert admission.status_code == 202
        events = _transcript_until(client.get, "mock-ghost", "turn_error")
        assert events[-1]["type"] == "turn_error"
        assert not any(e["type"] == "turn_complete" for e in events)


def test_unsupported_prompt_content_block_gets_400(mock_client: TestClient) -> None:
    resp = mock_client.post(
        "/d/session/mock-render/prompt",
        json={"prompt": [{"type": "image", "data": "x", "mimeType": "image/png"}]},
    )
    assert resp.status_code == 400
    assert resp.json()["code"] == "unsupported_prompt_content"


# ------------------------------------------------------------------
# 未知会话 / permission / 生命周期
# ------------------------------------------------------------------


def test_unknown_session_gets_404_aligned_with_api(mock_client: TestClient) -> None:
    for method, url in [
        ("post", "/d/standalone/sessions/no-such-session/load"),
        ("post", "/d/session/no-such-session/prompt"),
        ("get", "/d/session/no-such-session/transcript"),
        ("get", "/d/standalone/sessions/no-such-session"),
    ]:
        if method == "post":
            resp = mock_client.post(url, json={})
        else:
            resp = mock_client.get(url)
        assert resp.status_code == 404, url
        assert resp.json()["code"] == "standalone_session_not_found"


def test_permission_flow_respond_and_replay(live_url: str) -> None:
    which = "mock-permission"
    with httpx.Client(base_url=live_url, timeout=20.0) as client:
        # 1) prompt（fixture 带一条 permission_request 通知）→ SSE: permission_request + turn_complete
        admission = client.post(
            f"/d/session/{which}/prompt", json={"prompt": [{"type": "text", "text": "请帮我起草一份上线公告"}]}
        )
        assert admission.status_code == 202
        body = admission.json()

        frames = _read_sse_until(live_url, which, body["lastEventId"], body, "turn_complete")
        types = [f["event"] for f in frames]
        assert "permission_request" in types
        assert "turn_complete" in types
        request_data = next(f["envelope"]["data"] for f in frames if f["event"] == "permission_request")
        assert request_data["requestId"] == "req-keep-1"
        assert request_data["sessionId"] == which
        assert request_data.get("toolCall") is not None

        _transcript_until(client.get, which, "turn_complete")

        # 2) 未知 requestId → 404
        miss = client.post(
            f"/d/session/{which}/permission/req-unknown-1",
            json={"outcome": {"outcome": "selected", "optionId": "proceed_once"}},
        )
        assert miss.status_code == 404
        assert miss.json()["code"] == "permission_not_found"

        # 3) 回覆 → 200，journal 追加 permission_resolved
        respond = client.post(
            f"/d/session/{which}/permission/req-keep-1",
            json={"outcome": {"outcome": "selected", "optionId": "proceed_once"}},
        )
        assert respond.status_code == 200
        _transcript_until(client.get, which, "permission_resolved")

        # 4) 已处理的 requestId 再次回覆 → 404
        replayed = client.post(
            f"/d/session/{which}/permission/req-keep-1",
            json={"outcome": {"outcome": "selected", "optionId": "proceed_once"}},
        )
        assert replayed.status_code == 404
        assert replayed.json()["code"] == "permission_not_found"


def test_permission_legacy_route_also_works(live_url: str) -> None:
    which = "mock-permission"
    with httpx.Client(base_url=live_url, timeout=20.0) as client:
        # 同一会话再来一轮：replay 会把 permission_request 重新 set 成 pending
        admission = client.post(
            f"/d/session/{which}/prompt", json={"prompt": [{"type": "text", "text": "换个问题"}]}
        )
        assert admission.status_code == 202

        # 等本轮的 turn_complete：pending 在 permission_request 进流时被 worker 先建好，
        # 而 turn_complete 是 PendingTurn 生命末期的最后追加——到了它就说明 pending 已就位。
        # 不卡这一步，下面的回覆可能撞在 worker 还没 set pending 的窗口中。
        _transcript_until(client.get, which, "turn_complete")

        legacy = client.post(
            f"/d/permission/req-keep-1",
            json={"outcome": {"outcome": "selected", "optionId": "proceed_once"}},
        )
        assert legacy.status_code == 200


def test_heartbeat_cancel_delete_semantics(mock_client: TestClient) -> None:
    assert mock_client.post("/d/session/mock-short/heartbeat", json={}).status_code == 204
    assert mock_client.post("/d/session/mock-short/cancel", json={}).status_code == 204

    assert mock_client.delete("/d/session/mock-concurrent").status_code == 204
    ids = [s["sessionId"] for s in mock_client.get("/d/standalone/sessions").json()["sessions"]]
    assert "mock-concurrent" not in ids
    assert mock_client.get("/d/standalone/sessions/mock-concurrent").status_code == 404


def test_rename_overrides_display_name_process_locally(mock_client: TestClient) -> None:
    resp = mock_client.patch("/d/standalone/sessions/mock-break/metadata", json={"displayName": "我的断流实验"})
    assert resp.status_code == 200
    assert resp.json() == {"sessionId": "mock-break", "displayName": "我的断流实验"}


def test_unimplemented_endpoint_gets_404_with_code(mock_client: TestClient) -> None:
    resp = mock_client.get("/d/workspace/mcp")
    assert resp.status_code == 404
    assert resp.json()["code"] == "not_implemented"


def test_rebuild_pending_permissions_matches_request_resolution_pairs() -> None:
    """重启场景：pending 清空后，重建必须按 permission_request/resolved 成对恢复。"""
    from das_python.daemon.events import permission_request_event, permission_resolved_event
    from das_python.daemon.journal import SessionJournal
    from das_python.daemon.registry import SessionRegistry, rebuild_pending_permissions

    journal = SessionJournal()
    journal.append(
        permission_request_event("sess-1", "req-a", {"toolCallId": "tc-a"}, None, [{"optionId": "proceed_once", "name": "同意"}])
    )
    journal.append(
        permission_request_event("sess-1", "req-b", {"toolCallId": "tc-b"}, None, [{"optionId": "proceed_once", "name": "同意"}])
    )
    journal.append(permission_resolved_event("sess-1", "req-b", {"outcome": "selected"}))

    registry = SessionRegistry()
    record = registry.ensure("sess-1")
    record.journal = journal

    record.pending_permissions.clear()
    rebuild_pending_permissions(record)

    assert list(record.pending_permissions.keys()) == ["req-a"]
    assert record.pending_permissions["req-a"]["type"] == "permission_request"

    journal2 = SessionJournal()
    journal2.append(
        permission_request_event("sess-1", "req-x", {"toolCallId": "tc-x"}, None, [])
    )
    journal2.append(permission_resolved_event("sess-1", "req-x", {"outcome": "selected"}))
    record2 = registry.ensure("sess-2")
    record2.journal = journal2
    rebuild_pending_permissions(record2)
    assert record2.pending_permissions == {}


def test_rebuild_wipes_out_of_band_pending() -> None:
    """启动前残留的 requestId（非 journal 车友）必须被清出，不能骗人的程度。"""
    from das_python.daemon.events import permission_request_event
    from das_python.daemon.journal import SessionJournal
    from das_python.daemon.registry import SessionRegistry, rebuild_pending_permissions

    journal = SessionJournal()
    journal.append(permission_request_event("sess-1", "req-a", {"toolCallId": "tc-a"}, None, []))
    registry = SessionRegistry()
    record = registry.ensure("sess-1")
    record.journal = journal
    record.pending_permissions["req-ghost"] = permission_request_event("sess-1", "req-ghost", None, None, [])
    rebuild_pending_permissions(record)
    assert list(record.pending_permissions.keys()) == ["req-a"]
