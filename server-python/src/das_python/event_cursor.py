"""Native event identity and per-subscription replay proof; never a persisted history watermark."""
from __future__ import annotations

import re
from typing import Any


def cursor_of(frame: dict[str, Any], session_id: str | None = None) -> dict[str, str] | None:
    meta = frame.get("_meta", frame.get("Meta", frame.get("meta")))
    if not isinstance(meta, dict):
        return None
    raw = meta.get("eventCursor", meta.get("EventCursor"))
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("invalid native event cursor")
    cursor = {key: raw.get(key, raw.get(key[0].upper()+key[1:]))
              for key in ("sessionId", "eventEpoch", "eventId", "promptId", "eventType")}
    if (any(not isinstance(value, str) or not value for value in cursor.values())
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", cursor["eventEpoch"])
            or not re.fullmatch(r"[0-9]{1,16}", cursor["eventId"])
            or not 1 <= int(cursor["eventId"]) <= 2**53-1
            or session_id is not None and cursor["sessionId"] != session_id):
        raise ValueError("native cursor session/epoch/id mismatch")
    return cursor


def integer(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 2**53-1:
        raise ValueError("invalid native event number")
    return value


class ReplayState:
    def __init__(self, session_id: str, cursor: str | None, epoch: str | None):
        if epoch is not None and (cursor is None or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", epoch)):
            raise ValueError("epoch requires its cursor")
        self.session_id, self.epoch = session_id, epoch
        self.baseline = int(cursor) if cursor is not None else None
        if self.baseline is not None:
            integer(self.baseline)
        self.scanned = self.baseline
        self.native_session_id: str | None = None
        self.actual_epoch: str | None = None
        self.receipt = False
        self.count = 0

    def take(self, envelope: dict[str, Any]) -> None:
        event = envelope["data"]
        kind, data = event["type"], event.get("data", {})
        if not isinstance(data, dict):
            raise ValueError("event data must be an object")
        if kind in ("stream_open", "replay_complete", "slow_client_warning"):
            transport_id = envelope.get("transportCursor")
            if transport_id is not None and int(transport_id) != self.scanned:
                raise ValueError("control cursor advances or rewinds")
        if kind == "stream_open":
            epoch, native = data.get("eventEpoch"), data.get("nativeSessionId")
            if (self.actual_epoch is not None or data.get("sessionId") != self.session_id
                    or not isinstance(epoch, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", epoch)
                    or not isinstance(native, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", native)
                    or self.epoch is not None and self.epoch != epoch):
                raise ValueError("invalid native stream identity")
            self.actual_epoch, self.native_session_id = epoch, native
            return
        if self.actual_epoch is None or kind in ("stream_error", "state_resync_required", "client_evicted", "session_died"):
            raise ValueError("native subscription cannot continue")
        if kind == "replay_complete":
            count = integer(data.get("replayedCount"))
            last = [data[key] for key in ("lastReplayedEventId", "lastEventId") if key in data]
            if (self.receipt or count != self.count
                    or self.baseline is not None and self.scanned != self.baseline+count
                    or count == 0 and last or count > 0 and (not last or any(integer(value) != self.scanned for value in last))):
                raise ValueError("invalid replay receipt")
            self.receipt = True
            return
        if kind == "slow_client_warning":
            return
        number = integer(event.get("id"))
        if number == 0 or self.scanned is not None and number != self.scanned+1:
            raise ValueError("native event sequence gap")
        self.scanned = number
        if not self.receipt:
            self.count += 1
