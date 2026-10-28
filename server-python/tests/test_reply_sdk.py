"""Exercise actual SDK models for Reply construction; no cloud requests."""
import pytest
from alibabacloud_dataworks_public20240518 import models

from das_python.live import LiveContext, _reply_result
from test_pop_adaptation import config


@pytest.mark.asyncio
@pytest.mark.parametrize('input_,outcome,answers', [
    ({'permissionRequestId': 'permission', 'outcome': 'selected', 'optionId': 'allow_once'},
     {'Outcome': 'selected', 'OptionId': 'allow_once'}, None),
    ({'permissionRequestId': 'permission', 'outcome': 'selected', 'answers': {'0': 'A'}, 'optionId': None},
     {'Outcome': 'selected'}, {'0': 'A'}),
    ({'permissionRequestId': 'permission', 'outcome': 'cancelled', 'optionId': None},
     {'Outcome': 'cancelled'}, None),
])
async def test_reply_real_sdk_model_serializes_option_id(input_, outcome, answers):
    captured = []

    class Client:
        async def reply_agent_session_with_options_async(self, request, runtime):
            assert isinstance(request, models.ReplyAgentSessionRequest)
            assert isinstance(request.params.outcome, models.ReplyAgentSessionRequestParamsOutcome)
            captured.append(request.to_map())
            return models.ReplyAgentSessionResponse().from_map({
                'statusCode': 200,
                'body': {'RequestId': 'synthetic-request', 'JsonRpcResponse': {'Result': {'Accepted': True}}},
            })

    result = await _reply_result(LiveContext(Client(), config()), 's', input_)
    assert result['accepted'] is True and len(captured) == 1
    params = captured[0]['Params']
    assert params['SessionId'] == 's'
    assert params['PermissionRequestId'] == 'permission'
    assert params['Outcome'] == outcome
    assert params.get('Answers') == answers
    assert 'optionId' not in params['Outcome'] and 'option_id' not in params['Outcome']
