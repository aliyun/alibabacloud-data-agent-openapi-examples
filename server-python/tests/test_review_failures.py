"""Offline regressions for cancellation, concurrent Load, and dead SSE feeds."""
import asyncio
import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from das_python import main
from das_python.daemon import routes, runner
from das_python.daemon.events import turn_complete_event
from das_python.daemon.registry import SessionRecord, rebuild_pending_permissions
from das_python.live import LiveContext, _cancel_result
from test_pop_adaptation import config, FakeEvents, FakePop


class CancelBackend(FakePop):
    def __init__(self, outcome):
        super().__init__()
        self.outcome = outcome

    async def call_api_async(self, descriptor, request, runtime):
        response = await super().call_api_async(descriptor, request, runtime)
        if descriptor.action != 'CancelAgentSession':
            return response
        if self.outcome == 'transport':
            raise ConnectionError('synthetic cancel transport failure')
        envelope = response['body']['JsonRpcResponse']
        if self.outcome == 'rpc_error':
            envelope.clear()
            envelope['Error'] = {'Code': -1, 'Message': 'synthetic cancel denied'}
        else:
            envelope['Result'] = {
                'accepted': {'Delivered': True},
                'idle': {'Delivered': False, 'Noop': True, 'Reason': 'session_idle'},
                'undelivered': {'Delivered': False, 'Noop': False},
                'missing_flags': {},
                'invalid_flags': {'Delivered': True, 'Noop': 'true'},
            }[self.outcome]
        return response


@pytest.mark.parametrize('outcome', ['transport', 'rpc_error', 'undelivered', 'missing_flags', 'invalid_flags', 'accepted'])
def test_live_cancel_never_confirms_failure_or_fabricates_cancelled(monkeypatch, outcome):
    backend = CancelBackend(outcome)
    monkeypatch.setattr(main, 'create_sdk_client', lambda cfg: backend)
    http = TestClient(main.create_app(config(mock=False)))
    response = http.post('/d/session/s/cancel')
    assert response.status_code == (204 if outcome == 'accepted' else 502)
    if outcome != 'accepted':
        assert response.json()['code'] == 'cancel_failed'
    assert [call[0].action for call in backend.calls] == ['CancelAgentSession']


@pytest.mark.asyncio
async def test_idle_cancel_is_a_verified_noop_not_delivery(monkeypatch):
    backend = CancelBackend('idle')
    selected = config(mock=False)
    result = await _cancel_result(LiveContext(backend, selected), 's')
    assert result['delivered'] is False and result['noop'] is True
    assert result['warning'] == 'cancel-noop'
    monkeypatch.setattr(main, 'create_sdk_client', lambda cfg: backend)
    http = TestClient(main.create_app(selected))
    assert http.post('/d/session/s/cancel').status_code == 204


@pytest.mark.asyncio
async def test_remote_events_error_closes_without_waiting_for_a_local_receipt():
    from das_python.daemon.live_routes import _remote_sse_stream
    class Broken:
        async def call_sseapi_async(self, *args):
            raise ConnectionError('synthetic remote failure')
            yield
    stream = _remote_sse_stream(LiveContext(Broken(), config()), 's', None)
    try:
        assert 'events_upstream_error' in await asyncio.wait_for(anext(stream), .2)
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(anext(stream), .2)
    finally:
        await stream.aclose()


@pytest.mark.asyncio
async def test_normal_events_eof_returns_immediately_without_admission_grace():
    from das_python.daemon.live_routes import _remote_sse_stream
    backend = FakeEvents([])
    stream = _remote_sse_stream(LiveContext(backend, config()), 's', None)
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(stream), .2)
    assert backend.closed
