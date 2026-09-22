from das_python.daemon.journal import SessionJournal


def event(text):
    return {'v': 1, 'type': 'session_update', 'data': {'text': text}}


def test_refresh_partial_snapshot_preserves_cursor_and_never_regresses():
    journal = SessionJournal()
    question, answer = event('question'), event('answer')
    journal.seed([question])
    journal.seed([question, answer])
    assert [e.id for e in journal.since(1)] == [2]
    journal.seed([question])
    journal.seed([question, answer])
    assert len(journal.compacted()) == 2
    journal.seed([event('different'), answer, event('extra')])
    assert journal.last_id() == 2
    journal.active_prompt = True
    journal.seed([question, answer, event('extra')])
    assert journal.last_id() == 2
    journal.active_prompt = False
    journal.append(event('live'))
    journal.seed([question, answer, event('extra'), event('more')])
    assert journal.last_id() == 3
    assert len(journal.live()) == 1


def test_active_load_preserves_question_without_waiting_on_upstream(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from das_python.daemon import routes
    from das_python.daemon.registry import SessionRegistry
    registry = SessionRegistry()
    record = registry.ensure('active-load')
    question = {'v': 1, 'type': 'permission_request', 'data': {'requestId': 'question'}}
    record.journal.append(question)
    record.journal.active_prompt = True
    record.pending_permissions['question'] = question['data']
    monkeypatch.setattr(routes, 'SessionRegistry', lambda: registry)
    load = AsyncMock(side_effect=RuntimeError('upstream busy'))
    monkeypatch.setattr(routes, '_load_frames', load)
    app = FastAPI()
    routes.register_daemon_routes(app, SimpleNamespace(), SimpleNamespace())
    with TestClient(app) as client:
        response = client.post('/d/standalone/sessions/active-load/load', json={})
        assert response.status_code == 200
        assert response.json()['liveJournal'] == [{**question, 'id': 1}]
        assert response.json()['lastEventId'] == 1
        assert 'question' in record.pending_permissions
        load.assert_not_called()
        record.journal.active_prompt = False
        assert client.post('/d/standalone/sessions/active-load/load', json={}).status_code != 200
        load.assert_awaited_once()
