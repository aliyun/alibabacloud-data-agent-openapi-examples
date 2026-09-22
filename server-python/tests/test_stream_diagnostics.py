import asyncio
import json
import time
from types import SimpleNamespace
from das_python.daemon import runner
from das_python.daemon.registry import SessionRecord
from das_python.inflight import try_acquire


def test_terminal_does_not_read_later_socket_reset(monkeypatch, capsys):
    advanced = []
    async def frames(*args):
        yield {"Result": {"stopReason": "end_turn"}}
        advanced.append(True)
        raise ConnectionResetError("private answer")
    monkeypatch.setattr(runner, "_prompt_frames", frames)
    record = SessionRecord(real_id="synthetic-terminal")
    acquired = try_acquire(record.real_id)
    asyncio.run(runner.run_turn(None, SimpleNamespace(), record, record.real_id, "prompt-test", "private prompt", None, acquired, int(time.time() * 1000)))
    assert not advanced
    assert [e.event["type"] for e in record.journal.all()] == ["turn_complete"]
    logs = capsys.readouterr().out
    assert "private" not in logs
    assert json.loads(logs.splitlines()[-1])["outcome"] == "terminal"


def test_pre_terminal_reset_stays_failure(monkeypatch, capsys):
    async def frames(*args):
        if False:
            yield {}
        raise ConnectionResetError("private answer")
    monkeypatch.setattr(runner, "_prompt_frames", frames)
    record = SessionRecord(real_id="synthetic-reset")
    asyncio.run(runner.run_turn(None, SimpleNamespace(), record, record.real_id, "prompt-reset", "private prompt", None, try_acquire(record.real_id), int(time.time() * 1000)))
    assert [e.event["type"] for e in record.journal.all()] == ["turn_error"]
    logs = capsys.readouterr().out
    assert "private" not in logs
    end = json.loads(logs.splitlines()[-1])
    assert end["outcome"] == "transport_exception"
    assert end["exceptionTypes"] == ["ConnectionResetError"]
