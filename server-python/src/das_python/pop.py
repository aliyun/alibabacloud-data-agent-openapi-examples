"""Shared POP response handling, including Actions absent from the product SDK.

Uses the same SDK client, credentials, endpoint and disabled retry policy. Wire
keys below are CloudSpec public names, not internal backend parameter names.
"""
from __future__ import annotations

import inspect
import json
from typing import Any

from alibabacloud_tea_openapi.utils_models import OpenApiRequest, Params

from .errors import api_error, initial_config_error_message, redact_api_error, safe_request_id
from .normalize import SdkError, lower_first_keys, remote_request_id, to_api_error, with_request_id
from .frames import pop_ack_request_id


def descriptor(action: str, method: str = "POST") -> Params:
    return Params(action=action, version="2024-05-18", protocol="HTTPS", pathname="/",
                  method=method, auth_type="AK", style="RPC", req_body_type="formData", body_type="json")


async def rpc(ctx: Any, action: str, params: dict[str, Any]) -> dict[str, Any]:
    from .live import _next_rpc_id, runtime_for
    request = OpenApiRequest(body={"Id": _next_rpc_id(), "Jsonrpc": "2.0",
                                   "Params": json.dumps(params, ensure_ascii=False, separators=(",", ":"))})
    response = await ctx.client.call_api_async(descriptor(action), request, runtime_for())
    body = response.get("body") if isinstance(response, dict) else None
    if not isinstance(body, dict):
        raise SdkError(api_error("rpc_error", f"{action}: missing response body", requestId=remote_request_id(response)))
    body = lower_first_keys(body)
    request_id = safe_request_id(body.get("requestId")) or remote_request_id(response)
    envelope = body.get("jsonRpcResponse")
    envelope = envelope if isinstance(envelope, dict) else {}
    error = envelope.get("error")
    if error is not None:
        message = initial_config_error_message(error, "unknown error") if isinstance(error, dict) else str(error)
        raise SdkError(redact_api_error(api_error("rpc_error", f"{action}: {message} (RequestId={request_id or ''})", requestId=request_id)))
    result = envelope.get("result")
    if not isinstance(result, dict):
        raise SdkError(api_error("rpc_error", f"{action}: missing JsonRpcResponse.Result", requestId=request_id))
    return {"result": result, "requestId": request_id}


def _event_object(value: Any) -> dict[str, Any] | None:
    if isinstance(value, str) and value.lstrip().startswith("{"):
        value = json.loads(value)
    return value if isinstance(value, dict) else None


def _safe_cursor(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ValueError("invalid Events cursor")
    cursor = str(value)
    if not cursor.isascii() or not cursor.isdecimal() or len(cursor) > 20 or int(cursor) > 2**53 - 1:
        raise ValueError("invalid Events cursor")
    return cursor


def _canonical_event(value: Any, name: str | None = None) -> dict[str, Any] | None:
    event = _event_object(value)
    if event is None:
        return None
    if isinstance(event.get("type"), str):
        return event
    # POP can expose only the daemon's data object. Normalize these verified
    # public shapes without discarding update fields or manufacturing a turn.
    flat = dict(event)
    for field in ("SessionId", "Update", "StopReason", "PromptId"):
        if field in flat:
            flat[field[:1].lower() + field[1:]] = flat.pop(field)
    if isinstance(flat.get("update"), dict):
        kind = "session_update"
    elif isinstance(flat.get("stopReason"), str):
        kind = "turn_complete"
    elif name and not name.lstrip().startswith("{"):
        kind = name
    else:
        return None
    return {"v": 1, "type": kind, "data": flat,
            **({"id": flat["id"]} if "id" in flat else {})}


def _parse_event(payload: Any, outer_id: Any, outer_event: str | None, session_id: str) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        raise ValueError("invalid Events envelope")
    body = {key[:1].lower() + key[1:]: value for key, value in payload.items()}
    if set(body) == {"requestId"} and isinstance(body["requestId"], str):
        return None  # POP acknowledgement, not a daemon event or cursor.
    name = body.get("event") if isinstance(body.get("event"), str) and not body["event"].lstrip().startswith("{") else None
    hint = name or (outer_event if outer_event not in (None, "message") else None)
    data = (_canonical_event(payload) or _canonical_event(body.get("event"), hint)
            or _canonical_event(body.get("data"), hint))
    if data is None and hint and "event" not in body and "data" not in body:
        data = _canonical_event(payload, hint)
    if data is None:
        raise ValueError("missing daemon event type")
    details = data.get("data")
    if isinstance(details, dict) and "sessionId" in details and details["sessionId"] != session_id:
        raise ValueError("Events payload belongs to another session")
    cursor = _safe_cursor(outer_id if outer_id not in (None, "") else
                          body.get("id") if body.get("id") not in (None, "") else data.get("id"))
    kind = name or (outer_event if outer_event not in (None, "message") else None) or data["type"]
    if not isinstance(kind, str) or not kind or "\n" in kind or "\r" in kind:
        raise ValueError("invalid Events event name")
    if cursor is not None:
        # Canonical daemon clients resume from the JSON envelope id, while SSE
        # also carries the wire id line. Both must identify the same POP event.
        data = {**data, "id": int(cursor)}
    return {"id": cursor, "event": kind, "data": data}


async def session_events(ctx: Any, session_id: str, last_event_id: str | None, *, expose_headers: bool = False):
    """Decode raw/POP SSE without product-model casting or journal cursors."""
    from .live import runtime_for
    last_event_id = _safe_cursor(last_event_id)
    request = OpenApiRequest(query={"SessionCode": session_id},
                             headers={"accept": "text/event-stream", **({"Last-Event-Id": last_event_id} if last_event_id else {})})
    stream = ctx.client.call_sseapi_async(descriptor("GetAgentSessionEvents", "GET"), request, runtime_for())
    stream = await stream if inspect.isawaitable(stream) else stream
    pop_id = None
    header_id = None
    announced = False
    try:
        async for response in stream:
            header_id = remote_request_id(response) or header_id
            pop_id = header_id or pop_id
            event = response.event
            if event is None or not event.data:
                parsed = {"heartbeat": True}
            else:
                payload = json.loads(event.data)
                pop_id = header_id or safe_request_id(pop_ack_request_id(payload)) or pop_id
                parsed = _parse_event(payload, event.id, event.event, session_id)
            if expose_headers and not announced:
                announced = True
                yield {"responseHeaders": {"x-acs-request-id": header_id} if header_id else {}}
            if parsed is not None:
                yield parsed
    except Exception as exc:
        if not pop_id:
            raise
        raise SdkError(with_request_id(to_api_error(exc, "GetAgentSessionEvents"), pop_id, prefer=bool(header_id))) from exc
    finally:
        close = getattr(stream, "aclose", None)
        if close:
            await close()
