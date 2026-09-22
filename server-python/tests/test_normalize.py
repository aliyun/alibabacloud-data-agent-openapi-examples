"""normalize 层的响应体键名行为（LIVE-only 教训的钉桩）：

to_map 在 Python SDK 1.x 一律给出 PascalCase 线格式键
（实测 Create/Usage/List/Reply 的 Result 全是 `{"SessionId":…}` / `{"PromptTokens":…}`），
Python 侧按 Node 的 camelCase 读 Result 会拿到 None——这条键大小写问题只能在 LIVE 直达 SDK 时看见，
契约套件（MOCK）盖不住，所以钉在这里。
"""

from __future__ import annotations

import pytest

from das_python.normalize import SdkError, lower_first_keys, missing_result_error, read_non_stream_body


class _FakeBody:
    def __init__(self, mapped: dict, request_id: str | None = None, result=None, json_rpc_response=None):
        self._mapped = mapped
        self.request_id = request_id
        self.json_rpc_response = json_rpc_response

    def to_map(self) -> dict:
        return self._mapped


class _FakeResp:
    def __init__(self, body: _FakeBody, status_code: int = 200):
        self.body = body
        self.status_code = status_code


def test_lower_first_keys_recurses_maps_and_lists() -> None:
    assert lower_first_keys({"SessionId": "x", "AgentSessions": [{"SessionTitle": "T"}], "accepted": True}) == {
        "sessionId": "x",
        "agentSessions": [{"sessionTitle": "T"}],
        "accepted": True,
    }


def test_read_non_stream_body_normalizes_result_keys() -> None:
    # Create 的真实形状：to_map 的 Result 是 {"SessionId": "…"}（LIVE 09-20 实测）
    resp = _FakeResp(_FakeBody({"RequestId": "r1", "JsonRpcResponse": {"Result": {"SessionId": "abc"}}}))
    body = read_non_stream_body(resp)
    assert body["result"] == {"sessionId": "abc"}
    assert body["requestId"] == "r1"
    assert body["statusCode"] == 200


def test_read_non_stream_body_falls_back_to_attribute_access() -> None:
    class Rpc:
        result = {"sessionId": "abc"}

    body = _FakeBody({}, json_rpc_response=Rpc())
    # to_map 返回空 dict → 走属性回退（属性即模型声明的 camelCase 名，无需转换）
    resp = _FakeResp(body)
    assert read_non_stream_body(resp)["result"] == {"sessionId": "abc"}


def test_missing_result_error_is_sdk_error_not_bare_api_error() -> None:
    err = missing_result_error("CreateAgentSession", {"statusCode": 200, "requestId": "r1", "result": None})
    assert isinstance(err, SdkError)
    assert isinstance(err, BaseException)  # 可以被 raise（裸 ApiError 不能）
    assert err.api_error.kind == "rpc_error"
    assert "JsonRpcResponse.Result" in err.api_error.message
