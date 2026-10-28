"""Compatibility for verified legacy ACKs; synthetic clients, no cloud calls."""
import pytest
from fastapi.testclient import TestClient

from das_python import main
from das_python.daemon import routes
from das_python.live import LiveContext, _cancel_result
from test_pop_adaptation import config, FakePop


class CancelReply(FakePop):
    def __init__(self, result, error=False):
        super().__init__()
        self.result = result
        self.error = error

    async def call_api_async(self, descriptor, request, runtime):
        response = await super().call_api_async(descriptor, request, runtime)
        if descriptor.action == 'CancelAgentSession':
            envelope = {'Result': self.result}
            if self.error:
                envelope['Error'] = {'Code': -1, 'Message': 'synthetic denial'}
            response['body']['JsonRpcResponse'] = envelope
        return response


@pytest.mark.asyncio
async def test_matching_session_only_ack_is_acceptance_not_delivery_or_noop():
    backend = CancelReply({'SessionId': 's'})
    result = await _cancel_result(LiveContext(backend, config()), 's')
    assert result['accepted'] is True and result['delivered'] is False
    assert result['warning'] == 'cancel-accepted-legacy'
    assert 'noop' not in result
    assert 'stopReason' not in result and 'terminal' not in result


@pytest.mark.parametrize('result,error,expected', [
    ({'SessionId': 's'}, False, 204),
    ({'SessionId': 'different'}, False, 502),
    ({'SessionId': ''}, False, 502),
    ({}, False, 502),
    ({'SessionId': 's', 'Delivered': False, 'Noop': False}, False, 502),
    ({'SessionId': 's', 'Delivered': False}, False, 502),
    ({'SessionId': 's', 'Noop': False}, False, 502),
    ({'SessionId': 's', 'Delivered': None}, False, 502),
    ({'SessionId': 's', 'Accepted': False}, False, 502),
    ({'SessionId': 's'}, True, 502),
])
def test_cancel_legacy_route_requires_a_matching_unambiguous_ack(monkeypatch, result, error, expected):
    backend = CancelReply(result, error)
    monkeypatch.setattr(main, 'create_sdk_client', lambda cfg: backend)
    http = TestClient(main.create_app(config(mock=False)))
    response = http.post('/d/session/s/cancel')
    assert response.status_code == expected
    assert [call[0].action for call in backend.calls] == ['CancelAgentSession']
    assert 'turn_complete' not in response.text and 'cancelled' not in response.text


def test_legacy_api_reports_acceptance_without_claiming_delivery(monkeypatch):
    backend = CancelReply({'SessionId': 's'})
    monkeypatch.setattr(main, 'create_sdk_client', lambda cfg: backend)
    response = TestClient(main.create_app(config(mock=False))).post('/api/sessions/s/cancel')
    assert response.status_code == 200
    body = response.json()
    assert body['ok'] is True
    assert body['result']['accepted'] is True and body['result']['delivered'] is False
    assert body['result']['warning'] == 'cancel-accepted-legacy'
    assert 'noop' not in body['result'] and 'stopReason' not in body['result']
