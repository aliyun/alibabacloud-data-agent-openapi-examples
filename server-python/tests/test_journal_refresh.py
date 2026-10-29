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
