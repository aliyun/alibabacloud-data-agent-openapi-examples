"""Completion ownership now belongs to the HTTP response, never Events or receipts."""
from fastapi.testclient import TestClient
from das_python import main
from test_pop_adaptation import config, FakePop


def test_retired_live_completion_handshake_never_replays_controls(monkeypatch):
    backend = FakePop()
    monkeypatch.setattr(main, "create_sdk_client", lambda cfg: backend)
    http = TestClient(main.create_app(config(mock=False)))
    for _ in range(2):
        assert http.post('/d/session/s/prompt', json={"prompt": []}).status_code == 410
        assert http.post('/d/session/s/openapi-prompt/previous/receipt', json={}).status_code == 410
    assert backend.calls == []


def test_mock_receipt_is_noop():
    http = TestClient(main.create_app(config()))
    assert http.post('/d/session/unknown/openapi-prompt/unknown/receipt', json={}).status_code == 204
