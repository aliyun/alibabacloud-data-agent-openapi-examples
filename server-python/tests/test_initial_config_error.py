"""Reason allowlist across the installed generated SDK and generic POP paths."""
from types import SimpleNamespace

import pytest
from alibabacloud_dataworks_public20240518.models import CreateAgentSessionResponse

from das_python.normalize import read_non_stream_body, to_api_error
from das_python.pop import rpc

TARGET = "INVALID_SESSION_INITIAL_CONFIG"
REASONS = ["capabilities_unavailable", "ambiguous_model", "model_not_available", "reasoning_not_available"]
CASES = [
    *[(error, reason) for reason in REASONS for error in (
        {"ErrorCode": TARGET, "Message": "invalid configuration", "Data": {"reason": reason, "secret": "PRIVATE_DATA"}},
        {"Message": TARGET, "Data": {"reason": reason, "secret": "PRIVATE_DATA"}},
    )],
    *[({"ErrorCode": TARGET, "Message": TARGET, "Data": data}, None) for data in (
        None, "PRIVATE_DATA", [], {"reason": "PRIVATE_DATA"}, {"reason": ["ambiguous_model"]},
        {"reason": {"secret": "PRIVATE_DATA"}}, {"reason": 1}, {"reason": " ambiguous_model"},
        {"reason": "AMBIGUOUS_MODEL"}, {"nested": {"reason": "ambiguous_model"}},
    )],
    *[({"ErrorCode": message, "Message": message, "Data": {"reason": "ambiguous_model"}}, None)
      for message in ("unrelated", f"prefix {TARGET}", f"{TARGET} suffix", TARGET.lower())],
    ({"Code": TARGET, "Message": "unrelated", "Data": {"reason": "ambiguous_model"}}, None),
    ({"Message": TARGET}, None),
]


@pytest.mark.parametrize("path", ["generatedSDK", "genericPOP"])
@pytest.mark.parametrize("error,expected", CASES)
@pytest.mark.asyncio
async def test_initial_config_reason_boundary(path, error, expected):
    wire = {"RequestId": "body-rid", "JsonRpcResponse": {"Error": error}}
    response = {"body": wire, "headers": {"x-acs-request-id": "header-rid"}, "statusCode": 200}

    class Client:
        async def call_api_async(self, *args):
            return response

    with pytest.raises(Exception) as caught:
        if path == "generatedSDK":
            read_non_stream_body(CreateAgentSessionResponse().from_map(response))
        else:
            await rpc(SimpleNamespace(client=Client()), "CreateAgentSession", {})
    api = to_api_error(caught.value, "CreateAgentSession")
    assert api.requestId == "body-rid"
    assert ("reason=" in api.message) == (expected is not None)
    if expected:
        assert f"reason={expected}" in api.message
    assert "PRIVATE_DATA" not in str(api.to_dict())
    assert "data" not in api.to_dict()


@pytest.mark.parametrize("path", ["generatedSDK", "genericPOP"])
@pytest.mark.asyncio
async def test_reason_preserves_header_request_id(path):
    response = {"body": {"JsonRpcResponse": {"Error": {"Message": TARGET, "Data": {"reason": "ambiguous_model"}}}},
                "headers": {"x-acs-request-id": "header-rid"}}

    class Client:
        async def call_api_async(self, *args):
            return response

    with pytest.raises(Exception) as caught:
        if path == "generatedSDK":
            read_non_stream_body(CreateAgentSessionResponse().from_map(response))
        else:
            await rpc(SimpleNamespace(client=Client()), "CreateAgentSession", {})
    assert to_api_error(caught.value, "CreateAgentSession").requestId == "header-rid"
