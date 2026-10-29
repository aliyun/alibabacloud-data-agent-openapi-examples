"""Request-scoped LIVE daemon views. No session Registry, admission or receipt state."""
from __future__ import annotations

import hashlib
import uuid
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse

from ..config import AppConfig
from ..live import (LiveContext, _cancel_result, _create_session_result,
                    _list_sessions_result, _load_frames, _mutate_session_result, _reply_result)
from ..marker import strip_marker_instruction
from ..normalize import to_api_error
from ..pop import session_events
from ..session_options import creation_options, validate_agent_name
from .events import OPENAPI_ANSWERS_OPTION
from .registry import WORKSPACE_CWD
from .routes import _body, _error, _iso, _json, _not_found
from .translate import history_frames_to_events


def _remote_epoch(cfg: AppConfig, session_id: str) -> str:
    return hashlib.sha256(f"{cfg.endpoint or ''}|{cfg.regionId}|{session_id}".encode()).hexdigest()[:24]


def _session_body(session_id: str, created_at: Any = None) -> dict[str, Any]:
    # Protocol attachment context only: no lifetime or runtime state is inferred.
    return {"sessionId": session_id, "clientId": uuid.uuid4().hex,
            "workspaceCwd": WORKSPACE_CWD, "attached": False,
            "createdAt": _iso(created_at), "sourceType": "standalone",
            "context": {"kind": "standalone"},
            "projectlessOutputDirectory": f"{WORKSPACE_CWD}/out/{session_id}",
            "workingDirectory": {"state": "ready"}}


def _summary(summary: dict[str, Any]) -> dict[str, Any]:
    sid = summary["sessionId"]
    return {"sessionId": sid, "workspaceCwd": WORKSPACE_CWD,
            "createdAt": _iso(summary.get("createdAt")), "updatedAt": _iso(summary.get("updatedAt")),
            "displayName": strip_marker_instruction(summary.get("title") or "") or sid[:8],
            "sourceType": "standalone", "context": {"kind": "standalone"},
            **{key: summary[key] for key in ("hasActivePrompt", "isWaitingForPermission", "clientCount") if key in summary}}


def register_live_routes(app: FastAPI, cfg: AppConfig, live: LiveContext) -> None:
    @app.get("/d/standalone/sessions")
    async def list_sessions(archiveState: str | None = None, agentName: str | None = None) -> Any:
        try:
            selected_agent = validate_agent_name(cfg.agentName if agentName is None else agentName)
        except ValueError as exc:
            return _error(400, str(exc), "invalid_agent_name")
        try:
            result = await _list_sessions_result(live, archived=archiveState == "archived", agent_name=selected_agent)
            return {"sessions": [_summary(row) for row in result["sessions"]]}
        except Exception as exc:
            error = to_api_error(exc, "ListAgentSessions")
            return _error(502, error.message, "list_failed", error.requestId)

    @app.post("/d/standalone/sessions")
    async def create_session(request: Request) -> Any:
        body = await _body(request) or {}
        try:
            creation_options(cfg, body)
        except ValueError as exc:
            return _error(400, str(exc), "invalid_session_options")
        try:
            result = await _create_session_result(live, options=body)
            return _session_body(result["sessionId"], result.get("createdAt"))
        except Exception as exc:
            error = to_api_error(exc, "CreateAgentSession")
            return _error(502, error.message, "create_failed", error.requestId)

    @app.get("/d/standalone/sessions/{session_id}")
    async def get_session(session_id: str, agentName: str | None = None) -> Any:
        try:
            selected_agent = validate_agent_name(cfg.agentName if agentName is None else agentName)
        except ValueError as exc:
            return _error(400, str(exc), "invalid_agent_name")
        try:
            # The public API has no single-session metadata operation. Search both
            # remote directory views; never synthesize a known/existing sid locally.
            for archived in (False, True):
                result = await _list_sessions_result(live, archived=archived, agent_name=selected_agent)
                for summary in result["sessions"]:
                    if summary["sessionId"] == session_id:
                        return _summary(summary)
                if result.get("truncated"):
                    return _error(502, "Remote directory lookup was truncated", "lookup_incomplete")
            return _not_found(session_id)
        except Exception as exc:
            error = to_api_error(exc, "ListAgentSessions")
            return _error(502, error.message, "lookup_failed", error.requestId)

    async def load_history(session_id: str, transcript: bool = False) -> Any:
        try:
            frames = await _load_frames(live, session_id)
            events = history_frames_to_events(frames, session_id)
        except Exception as exc:
            error = to_api_error(exc, "LoadAgentSession")
            return _error(502 if error.kind == "transport" else 404, error.message, "load_failed", error.requestId)
        if transcript:
            return {"v": 1, "sessionId": session_id, "events": events, "hasMore": False}
        return {**_session_body(session_id),
                "state": {"models": {"availableModels": []}, "modes": {}, "configOptions": None},
                "compactedReplay": events, "liveJournal": [], "eventEpoch": _remote_epoch(cfg, session_id),
                "historyHasMore": False}

    @app.post("/d/standalone/sessions/{session_id}/load")
    @app.post("/d/standalone/sessions/{session_id}/resume")
    async def load_session(session_id: str) -> Any:
        return await load_history(session_id)

    @app.get("/d/session/{session_id}/transcript")
    async def transcript(session_id: str) -> Any:
        return await load_history(session_id, transcript=True)

    @app.patch("/d/standalone/sessions/{session_id}/metadata")
    @app.patch("/d/session/{session_id}/metadata")
    async def rename_session(request: Request, session_id: str) -> Any:
        body = await _body(request) or {}
        raw = body.get("displayName")
        title = raw.strip() if isinstance(raw, str) else ""
        if not title or len(title) > 512:
            return _error(400, "displayName length must be 1–512", "invalid_metadata")
        try:
            result = await _mutate_session_result(live, session_id, "UpdateAgentSessionTitle", title)
            return {"sessionId": session_id, "displayName": result.get("title", title)}
        except Exception as exc:
            error = to_api_error(exc, "UpdateAgentSessionTitle")
            return _error(502, error.message, "rename_failed", error.requestId)

    async def batch_mutate(action: str, request: Request) -> dict[str, Any]:
        raw_ids = (await _body(request) or {}).get("sessionIds")
        ids = [sid for sid in raw_ids if isinstance(sid, str) and sid] if isinstance(raw_ids, list) else []
        done, errors = [], []
        api = "DeleteAgentSession" if action == "delete" else "ArchiveAgentSession"
        for sid in ids:
            try:
                await _mutate_session_result(live, sid, api, action == "archive")
                done.append(sid)
            except Exception as exc:
                error = to_api_error(exc, api)
                errors.append({"sessionId": sid, "code": "upstream_error", "message": error.message,
                               **({"requestId": error.requestId} if error.requestId else {})})
        if action == "delete":
            return {"removed": done, "notFound": [], "errors": errors, "fileCleanupPending": []}
        key, already = ("archived", "alreadyArchived") if action == "archive" else ("unarchived", "alreadyActive")
        return {key: done, already: [], "notFound": [], "errors": errors}

    @app.post("/d/standalone/sessions/archive")
    async def archive(request: Request) -> Any:
        return await batch_mutate("archive", request)

    @app.post("/d/standalone/sessions/unarchive")
    async def unarchive(request: Request) -> Any:
        return await batch_mutate("unarchive", request)

    @app.post("/d/standalone/sessions/delete")
    async def delete_batch(request: Request) -> Any:
        return await batch_mutate("delete", request)

    @app.delete("/d/session/{session_id}")
    async def delete_session(session_id: str) -> Any:
        try:
            await _mutate_session_result(live, session_id, "DeleteAgentSession")
            return Response(status_code=204)
        except Exception as exc:
            error = to_api_error(exc, "DeleteAgentSession")
            return _error(502, error.message, "delete_failed", error.requestId)

    @app.post("/d/session/{session_id}/prompt")
    @app.post("/d/session/{session_id}/openapi-prompt/{prompt_id}/receipt")
    async def retired_prompt(session_id: str, prompt_id: str | None = None) -> Any:
        return _error(410, "Use POST /api/sessions/{sid}/prompt with text and consume its NDJSON result", "prompt_transport_retired")

    @app.post("/d/session/{session_id}/cancel")
    async def cancel(session_id: str) -> Any:
        try:
            result = await _cancel_result(live, session_id)
            if not any(result.get(flag) for flag in ("accepted", "delivered", "noop")):
                return _error(502, result.get("detail") or "Cancellation was not confirmed", "cancel_failed", result.get("requestId"))
            return Response(status_code=204)
        except Exception as exc:
            error = to_api_error(exc, "CancelAgentSession")
            return _error(502, error.message, "cancel_failed", error.requestId)

    @app.get("/d/session/{session_id}/events")
    async def events(request: Request, session_id: str) -> Any:
        cursor = request.headers.get("last-event-id")
        if cursor is not None and (not cursor.isascii() or not cursor.isdecimal()
                                   or len(cursor) > 20 or int(cursor) > 2**53 - 1):
            return _error(400, "Invalid Events cursor", "invalid_event_cursor")
        upstream = session_events(live, session_id, cursor, expose_headers=True)
        try:
            first = await anext(upstream, None)
        except Exception as exc:
            await upstream.aclose()
            error = to_api_error(exc, "GetAgentSessionEvents")
            return _error(502, error.message, "events_upstream_error", error.requestId)
        response_headers = first.get("responseHeaders", {}) if first else {}
        return StreamingResponse(_remote_sse_stream(live, session_id, cursor, upstream=upstream), media_type="text/event-stream", headers={
            **response_headers,
            "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no",
            "X-Qwen-Event-Epoch": _remote_epoch(cfg, session_id), "X-Qwen-Sse-Stream-Id": uuid.uuid4().hex})

    @app.post("/d/session/{session_id}/heartbeat")
    async def heartbeat(session_id: str) -> Response:
        return Response(status_code=204)

    @app.get("/d/session/{session_id}/status")
    async def status(session_id: str) -> Any:
        return _error(404, "No authoritative remote live-state API", "status_unavailable")

    @app.post("/d/session/{session_id}/permission/{request_id}")
    async def permission(request: Request, session_id: str, request_id: str) -> Any:
        body = await _body(request) or {}
        outcome = body.get("outcome")
        if not isinstance(outcome, dict) or outcome.get("outcome") not in ("selected", "cancelled"):
            return _error(400, "outcome must be selected or cancelled", "invalid_permission_response")
        kind = outcome["outcome"]
        option = outcome.get("optionId")
        answers = body.get("answers")
        if option is not None and not isinstance(option, str):
            return _error(400, "optionId must be a string", "invalid_permission_response")
        if answers is not None and (not isinstance(answers, dict) or any(not isinstance(v, str) for v in answers.values())):
            return _error(400, "answers must map indexes to strings", "invalid_permission_response")
        option = option.strip() if isinstance(option, str) else ""
        if option == OPENAPI_ANSWERS_OPTION:
            if kind != "selected" or not answers:
                return _error(400, "问答提交必须包含 answers", "invalid_permission_response")
            option = ""
        if kind == "selected" and not option and not answers:
            return _error(400, "selected requires optionId or answers", "invalid_permission_response")
        try:
            result = await _reply_result(live, session_id, {"permissionRequestId": request_id,
                "answers": answers, "optionId": option or None, "outcome": kind})
            return {} if result.get("accepted") else _error(404, "Remote permission was not accepted", "permission_not_accepted", result.get("requestId"))
        except Exception as exc:
            error = to_api_error(exc, "ReplyAgentSession")
            return _error(502, error.message, "permission_upstream_error", error.requestId)

    @app.post("/d/permission/{request_id}")
    async def sidless_permission(request_id: str) -> Any:
        return _error(400, "Use /d/session/{sid}/permission/{requestId}; session id is required", "session_id_required")

    @app.get("/d/workspace/tools")
    async def tools() -> dict[str, Any]:
        return {"tools": []}

    @app.api_route("/d/{path:path}", methods=["GET", "POST", "PATCH", "DELETE", "PUT"])
    async def unsupported(request: Request) -> Any:
        return _error(404, "Unsupported daemon route", "not_implemented")


async def _remote_sse_stream(live: LiveContext, session_id: str, last_event_id: str | None, *, upstream=None):
    # After commit, propagate disconnects; never manufacture a remote terminal.
    if upstream is None:
        upstream = session_events(live, session_id, last_event_id)
    try:
        async for envelope in upstream:
            if envelope.get("heartbeat"):
                yield ": hb\n\n"
                continue
            data = envelope["data"]
            cursor = envelope.get("id")
            event = envelope.get("event") or (data.get("type") if isinstance(data, dict) else "message")
            if not isinstance(event, str) or "\n" in event or "\r" in event:
                raise ValueError("invalid Events event name")
            prefix = f"id: {cursor}\n" if cursor is not None else ""
            yield f"{prefix}event: {event}\ndata: {_json(data)}\n\n"
    finally:
        await upstream.aclose()
