"""契约测试：与 Node 实现同一套断言，跑在 ASGI 进程内（httpx transport，无端口）。

这一份测试同时是 scripts/contract-test.sh 的 Python 断言蓝本：
三个 server 实现的"契约一致"由同一组 HTTP/NDJSON 断言保证。
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from das_python.config import AppConfig
from das_python.main import create_app


@pytest.fixture()
def mock_client() -> TestClient:
    cfg = AppConfig(
        mock=True,
        mockRealtime=False,
        mockSpeed=1000,  # 测试里用高倍速，压平回放等待
        port=0,
        corsOrigin=["http://localhost:5173"],
        regionId="cn-hangzhou",
        endpoint=None,
        agentName="dataworks_data_agent",
        sessionSource="data-agent-openapi-example",
        resourceGroupId=None,
        accessKeyId=None,
        accessKeySecret=None,
        serverHost="127.0.0.1",
        webDist=None,
    )
    return TestClient(create_app(cfg))


def test_health_shape_and_defaults(mock_client: TestClient) -> None:
    resp = mock_client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    result = body["result"]
    # 字段结构必须与 Node server 一致（前端按这套字段渲染）
    assert set(result.keys()) >= {"mock", "region", "agent", "sessionSource", "resourceGroupIdConfigured", "credentials"}
    assert result["mock"] is True
    assert result["credentials"] == "missing"
    assert result["region"] == "cn-hangzhou"


def test_mock_sessions_filtered_by_source(mock_client: TestClient) -> None:
    resp = mock_client.get("/api/sessions")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    result = body["result"]
    ids = [s["sessionId"] for s in result["sessions"]]
    # mock-short 在列；别的来源的两条被过滤掉
    assert "mock-short" in ids
    assert "mock-other-source-1" not in ids
    assert result["filteredOut"] >= 2
    # 上游字段照真实形状给：这两个"没用的字段"本身就是要教的内容
    short = next(s for s in result["sessions"] if s["sessionId"] == "mock-short")
    assert short["status"] == "RELEASED"
    assert short["updatedAt"] == short["createdAt"]
    assert short["mockScenario"]


def test_create_session_with_mode(mock_client: TestClient) -> None:
    resp = mock_client.post("/api/sessions", json={"title": "验证会话", "mode": "default"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    session_id = body["result"]["sessionId"]
    assert session_id.startswith("mock-short-")

    # 非法 mode 被拒绝（业务错误，HTTP 200 承载）
    bad = mock_client.post("/api/sessions", json={"mode": "bogus"})
    assert bad.status_code == 200
    assert bad.json()["ok"] is False
    assert bad.json()["error"]["kind"] == "rpc_error"


def test_prompt_stream_shape_and_marker(mock_client: TestClient) -> None:
    created = mock_client.post("/api/sessions", json={"title": "流验证"}).json()["result"]["sessionId"]
    with mock_client.stream("POST", f"/api/sessions/{created}/prompt", json={"text": "回复且只回复：你好"}) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/x-ndjson")
        lines = [line for line in resp.iter_lines() if line.strip()]
    events = [json.loads(line) for line in lines]

    # 帧序：meta 第一条；done 最后一条或 error 收尾；中间全是 frame/hb
    assert events[0]["type"] == "meta"
    # marker 归属校验已退役（2026-09-20）：meta 不再携带 marker 字段
    assert "marker" not in events[0]
    assert events[0]["sessionId"] == created
    types = [e["type"] for e in events]
    assert types[-1] in ("done", "error")
    assert "done" in types or "error" in types
    frames = [e for e in events if e["type"] == "frame"]
    assert len(frames) > 0
    # 帧原样透传：body 是上游那一帧（带 Jsonrpc 线格式键）
    assert all("body" in e and "Jsonrpc" in e["body"] or "Params" in e.get("body", {}) for e in frames)


def test_prompt_empty_text_rejected(mock_client: TestClient) -> None:
    created = mock_client.post("/api/sessions", json={}).json()["result"]["sessionId"]
    resp = mock_client.post(f"/api/sessions/{created}/prompt", json={"text": "   "})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["kind"] == "rpc_error"
    assert "prompt 文本为空" in body["error"]["message"]


def test_prompt_unknown_session_rejected(mock_client: TestClient) -> None:
    resp = mock_client.post("/api/sessions/does-not-exist/prompt", json={"text": "hi"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "does-not-exist" in body["error"]["message"]


def test_reply_requires_permission_request_id(mock_client: TestClient) -> None:
    resp = mock_client.post("/api/sessions/mock-short/reply", json={"answers": {"0": "A"}})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "permissionRequestId" in body["error"]["message"]


def test_reply_mock_honestly_rejects(mock_client: TestClient) -> None:
    resp = mock_client.post(
        "/api/sessions/mock-short/reply",
        json={"permissionRequestId": "req-x", "answers": {"0": "A"}, "outcome": {"outcome": "selected", "optionId": "proceed_once"}},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["kind"] == "rpc_error"
    assert "LIVE" in body["error"]["message"]


def test_reply_selected_requires_option_id_or_answers(mock_client: TestClient) -> None:
    resp = mock_client.post("/api/sessions/mock-short/reply", json={"permissionRequestId": "req-x", "outcome": {"outcome": "selected"}})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "optionId" in body["error"]["message"]


def test_cancel_mock_noop(mock_client: TestClient) -> None:
    resp = mock_client.post("/api/sessions/mock-short/cancel")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["result"]["delivered"] is False
    assert body["result"]["warning"] == "mock-replay-uncancellable"


def test_usage_and_artifacts_validation(mock_client: TestClient) -> None:
    unknown = mock_client.get("/api/sessions/does-not-exist/usage")
    assert unknown.status_code == 200
    assert unknown.json()["ok"] is False

    known = mock_client.get("/api/sessions/mock-short/usage")
    assert known.status_code == 200
    assert known.json()["ok"] is True

    artifacts = mock_client.get("/api/sessions/mock-short/artifacts")
    assert artifacts.status_code == 200
    assert artifacts.json()["result"]["artifacts"] == []
    # elapsedMs 恒为 0 是真的：MOCK 下这一路不发任何请求。
    assert artifacts.json()["result"]["elapsedMs"] == 0


def test_history_reduction(mock_client: TestClient) -> None:
    resp = mock_client.get("/api/sessions/mock-short/history")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    result = body["result"]
    assert result["totalFrames"] > 0
    assert len(result["turns"]) >= 1
    turn = result["turns"][0]
    # 轮次判据：该 rid 名下至少有一条 user_message_chunk
    assert turn["userText"]


def test_probe_requires_rid(mock_client: TestClient) -> None:
    resp = mock_client.get("/api/sessions/mock-break/probe")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "rid" in body["error"]["message"]


def test_break_scenario_stream_break(mock_client: TestClient) -> None:
    """断流场景：吐完帧后收尾 -32603 ⇒ error(stream_break)，不是 done。"""
    with mock_client.stream("POST", "/api/sessions/mock-break/prompt", json={"text": "hi"}) as resp:
        lines = [line for line in resp.iter_lines() if line.strip()]
    events = [json.loads(line) for line in lines]
    assert events[0]["type"] == "meta"
    assert "error" in [e["type"] for e in events]
    error_event = next(e for e in events if e["type"] == "error")
    assert error_event["error"]["kind"] == "stream_break"
    # 断流的收尾不是 done：静默截断不能当成功
    assert events[-1]["type"] == "error"


def test_ack_scenario_prompt_not_dispatched(mock_client: TestClient) -> None:
    """零帧场景：只有 POP 回执 ⇒ error(prompt_not_dispatched)，且回执号进 message。"""
    with mock_client.stream("POST", "/api/sessions/mock-ack-only/prompt", json={"text": "hi"}) as resp:
        lines = [line for line in resp.iter_lines() if line.strip()]
    events = [json.loads(line) for line in lines]
    error_event = next(e for e in events if e["type"] == "error")
    assert error_event["error"]["kind"] == "prompt_not_dispatched"
    # POP RequestId 是零帧场景下唯一还能拿去查的线索，必须出现在 message 里
    assert "0dd3b146c75bf132a65efa7a3080e7cd" in error_event["error"]["message"]
    # 没有 meta：rid 是上游给的，一帧没收到就不知道
    assert events[0]["type"] == "error"
