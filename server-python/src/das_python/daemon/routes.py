"""daemon 兼容层路由：把 @qwen-code/web-shell 说的话翻译成 data agent OpenAPI 的上游调用。
与 Node 实现的 server/daemon/routes.ts、Java 实现的 DaemonController.java 同源同语义。

挂在 `/d` 前缀下——DaemonClient 是 `baseUrl + path` 字符串拼接，所以前端把
baseUrl 指到 `<origin>/d` 即可，与 `/api/*`、SPA 回退互不干扰。
"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

from fastapi import FastAPI, HTTPException, Path, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from ..config import AppConfig
from ..constants import HEARTBEAT_MS, STREAM_HARD_LIMIT_MS
from ..live import LiveContext, _cancel_result, _create_session_result, _load_frames, _reply_result
from ..mock_fixtures import find_scenario, mock_create_session, read_fixture_frames
from ..normalize import to_api_error
from .events import OPENAPI_ANSWERS_OPTION, permission_resolved_event, prompt_cancelled_event, session_snapshot_event
from .journal import MAX_EVENTS, JournalEntry, SessionJournal
from .registry import WORKSPACE_CWD, SessionRecord, SessionRegistry, rebuild_pending_permissions
from .runner import admit_prompt, submit_turn
from .translate import history_frames_to_events

# 进程级事件纪元：重启即变；客户端凭它判断游标属于"上一个进程"并触发 resync。
EPOCH = uuid.uuid4().hex
_PROCESS_STARTED_AT = int(time.time() * 1000)


def _error(status: int, error: str, code: str) -> JSONResponse:
    return JSONResponse({"error": error, "code": code}, status_code=status)


def _not_found(session_id: str) -> JSONResponse:
    return _error(404, f"没有这个会话：{session_id}", "standalone_session_not_found")


def register_daemon_routes(app: FastAPI, cfg: AppConfig, live: LiveContext | None) -> None:
    registry = SessionRegistry()

    def resolve_session(session_id: str) -> SessionRecord | None:
        """使用 OpenAPI 真实 sessionId。LIVE 下未知 id 也放行（深链/重启后直接发话，存在性交给上游判）；
        MOCK 下必须是已知场景（与 /api 的行为对齐：不认的 id 明确 404）。"""
        known = registry.resolve(session_id)
        if known is not None:
            return known
        if live:
            return registry.ensure(session_id)
        return registry.ensure(session_id) if find_scenario(session_id) is not None else None

    def standalone_session_body(record: SessionRecord, client_facing_id: str) -> dict[str, Any]:
        return {
            "sessionId": client_facing_id,
            # daemon 分配的客户端身份：客户端随 prompt 以 X-Qwen-Client-Id 带回，
            # 我们据此盖 originatorClientId（suppressOwnUserEcho 的匹配键）
            "clientId": record.client_id,
            "workspaceCwd": WORKSPACE_CWD,
            "attached": False,
            "createdAt": _iso(record.created_at),
            "sourceType": "standalone",
            "context": {"kind": "standalone"},
            "projectlessOutputDirectory": f"{WORKSPACE_CWD}/out/{client_facing_id}",
            "workingDirectory": {"state": "ready"},
        }

    # ------------------------------------------------------------------
    # 发现
    # ------------------------------------------------------------------

    @app.get("/d/health")
    async def d_health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/d/capabilities")
    async def d_capabilities() -> dict[str, Any]:
        return {
            "v": 1,
            "mode": "standalone",
            "features": ["standalone_sessions_v1", "standalone_session_options_v1", "session_permission_vote"],
            "modelServices": ["data-agent"],
            "workspaces": [],
            "policy": {},
            # web-shell 按这个间隔轮询会话目录 live-state；每次轮询在 LIVE 下都是一次
            # 真实 ListAgentSessions（约 0.4s、上游无增量游标）——30s 是负载与新鲜度的折中
            "sessionLiveStatePollIntervalMs": 30_000,
        }

    @app.get("/d/daemon/status")
    async def d_daemon_status(detail: str | None = None) -> dict[str, Any]:
        """daemon 状态报告（web-shell 的「Daemon 状态」面板）。全部字段是**本地真实状态**（不依赖上游）。"""
        stats = registry.stats()
        return {
            "v": 1,
            "detail": "full" if detail == "full" else "summary",
            "generatedAt": _iso(int(time.time() * 1000)),
            "status": "ok",
            "issues": [],
            "daemon": {
                "pid": None,
                "uptimeMs": int(time.time() * 1000) - _PROCESS_STARTED_AT,
                "mode": "standalone",
                "workspaceCwd": WORKSPACE_CWD,
            },
            "security": {
                "tokenConfigured": False,
                "requireAuth": False,
                "loopbackBind": cfg.serverHost == "127.0.0.1",
                "allowOriginConfigured": len(cfg.corsOrigin) > 0,
                "allowOriginMode": ",".join(cfg.corsOrigin),
                "sessionShellCommandEnabled": False,
            },
            "limits": {
                "maxSessions": None,
                "maxTotalSessions": None,
                # 上游在途锁：同一会话同时只能一轮（session_concurrent_operation_in_progress）
                "maxPendingPromptsPerSession": 1,
                "listenerMaxConnections": None,
                "eventRingSize": MAX_EVENTS,
                "promptDeadlineMs": STREAM_HARD_LIMIT_MS,
                "writerIdleTimeoutMs": None,
                "channelIdleTimeoutMs": 0,
                "sessionIdleTimeoutMs": 0,
                "acpConnectionCap": None,
                "compactedReplayMaxBytes": 0,
                "maxJournalEvents": MAX_EVENTS,
                "maxJournalBytes": 0,
            },
            "capabilities": {
                "protocolVersions": {"current": "1", "supported": ["1"]},
                "features": ["standalone_sessions_v1", "standalone_session_options_v1", "session_permission_vote"],
            },
            "runtime": {
                "sessions": {"active": stats["sessions"]},
                "permissions": {"pending": 0, "policy": "upstream-none"},
                "channel": {"live": False},
                "channelWorker": {"enabled": False, "state": "disabled", "channels": []},
                "process": {"rss": None, "heapUsed": None},
                "transport": {
                    "restSseActive": 0,
                    "acp": {
                        "enabled": False,
                        "connections": 0,
                        "connectionStreams": 0,
                        "sessionStreams": 0,
                        "sseStreams": 0,
                        "wsStreams": 0,
                        "pendingClientRequests": 0,
                    },
                },
                "rateLimit": {"enabled": False, "rejectedSinceStart": {}},
            },
        }

    @app.get("/d/standalone/session-options")
    async def d_session_options() -> dict[str, Any]:
        model = {
            "modelId": "data-agent",
            "baseModelId": "data-agent",
            "name": "DataWorks Data Agent",
            "isCurrent": True,
            "isRuntime": False,
        }
        return {
            "v": 1,
            "initialized": True,
            "providers": [
                {
                    "kind": "model_provider",
                    "status": "ok",
                    "authType": "none",
                    "current": True,
                    "models": [model],
                }
            ],
            "errors": [],
        }

    # ------------------------------------------------------------------
    # standalone 会话目录
    # ------------------------------------------------------------------

    @app.get("/d/standalone/sessions")
    async def d_list_sessions(archiveState: str | None = None) -> dict[str, Any]:
        if archiveState == "archived":
            return {"sessions": registry.archived_summaries()}
        return {"sessions": await registry.list_summaries(cfg, live)}

    @app.post("/d/standalone/sessions")
    async def d_create_session(request: Request) -> Any:
        real_id: str
        if live:
            try:
                # _create_session_result 回的是结果字典 {sessionId, requestId}（信封由本层自己包）
                created = await _create_session_result(live, None)
                real_id = created["sessionId"]
            except Exception as exc:  # noqa: BLE001
                api = to_api_error(exc if isinstance(exc, Exception) else RuntimeError(str(exc)), "CreateAgentSession")
                return _error(502, api.message, "create_failed")
        else:
            real_id = mock_create_session("新建会话")["sessionId"]
        record = registry.ensure(real_id)
        return standalone_session_body(record, real_id)

    @app.get("/d/standalone/sessions/{session_id}")
    async def d_get_session(session_id: str = Path()) -> Any:
        record = resolve_session(session_id)
        if record is None or record.deleted:
            return _not_found(session_id)
        return registry.summary_for(record, session_id)

    @app.post("/d/standalone/sessions/{session_id}/load")
    async def d_load(session_id: str = Path()) -> Any:
        return await _load_response(session_id, "load")

    @app.post("/d/standalone/sessions/{session_id}/resume")
    async def d_resume(session_id: str = Path()) -> Any:
        return await _load_response(session_id, "resume")

    @app.patch("/d/standalone/sessions/{session_id}/metadata")
    async def d_rename_standalone(request: Request, session_id: str = Path()) -> Any:
        body = await _body(request) or {}
        return _rename(session_id, body.get("displayName"))

    @app.post("/d/standalone/sessions/archive")
    async def d_archive(request: Request) -> dict[str, Any]:
        return _batch_mutate("archive", (await _body(request) or {}).get("sessionIds"))

    @app.post("/d/standalone/sessions/unarchive")
    async def d_unarchive(request: Request) -> dict[str, Any]:
        return _batch_mutate("unarchive", (await _body(request) or {}).get("sessionIds"))

    @app.post("/d/standalone/sessions/delete")
    async def d_delete(request: Request) -> dict[str, Any]:
        return _batch_mutate("delete", (await _body(request) or {}).get("sessionIds"))

    # ------------------------------------------------------------------
    # 会话内：prompt / 事件流 / 生命周期
    # ------------------------------------------------------------------

    @app.post("/d/session/{session_id}/prompt")
    async def d_prompt(request: Request, session_id: str = Path()) -> Any:
        record = resolve_session(session_id)
        if record is None:
            return _not_found(session_id)
        body = await _body(request) or {}
        client_id = request.headers.get("x-qwen-client-id")
        admission = admit_prompt(cfg, live, record, session_id, body.get("prompt"), client_id)
        if hasattr(admission, "status"):
            return _error(admission.status, admission.error, admission.code)
        # 后台轮次不进 handler 的 anyio 任务组（Starlette 会在响应完成后 cancel）：
        # 压进与 app 同寿命的 worker，响应完成后的轮次照样跑完（详见 runner.submit_turn）。
        submit_turn(asyncio.get_running_loop(), admission.pending)
        # 202 严格契约（additionalProperties:false）：只有这三个键
        return JSONResponse(
            {"promptId": admission.prompt_id, "lastEventId": admission.last_event_id, "eventEpoch": EPOCH},
            status_code=202,
        )

    @app.post("/d/session/{session_id}/cancel")
    async def d_cancel(session_id: str = Path()) -> Any:
        record = resolve_session(session_id)
        if record is None:
            return _not_found(session_id)
        if live:
            try:
                await _cancel_result(live, record.real_id)
            except Exception:  # noqa: BLE001
                pass  # 照发本地 prompt_cancelled（与 Node/Java 对齐）
        active_prompt_id = record.journal.active_prompt_id
        if active_prompt_id is not None:
            # 上游流随后会以 stopReason=cancelled 终态收场 → turn_complete(cancelled) 也会到
            record.journal.append(prompt_cancelled_event(session_id, active_prompt_id))
        return Response(status_code=204)

    @app.get("/d/session/{session_id}/events")
    async def d_events(request: Request, session_id: str = Path()) -> Any:
        record = resolve_session(session_id)
        if record is None:
            return _not_found(session_id)
        last_raw = request.headers.get("last-event-id")
        try:
            last_event_id = int(last_raw) if last_raw is not None else None
        except ValueError:
            last_event_id = None
        snapshot = request.query_params.get("snapshot") in ("1", "true", "True")

        return StreamingResponse(
            _sse_stream(record.journal, session_id, last_event_id, snapshot),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-store, no-transform",
                "X-Accel-Buffering": "no",
                "X-Qwen-Event-Epoch": EPOCH,
                "X-Qwen-Sse-Stream-Id": uuid.uuid4().hex,
            },
        )

    @app.post("/d/session/{session_id}/heartbeat")
    async def d_heartbeat(session_id: str = Path()) -> Any:
        record = resolve_session(session_id)
        if record is None:
            return _not_found(session_id)
        # 上游没有心跳接口；这里只回 204 维持客户端记账，不做任何上游调用。
        return Response(status_code=204)

    @app.get("/d/session/{session_id}/transcript")
    async def d_transcript(session_id: str = Path()) -> Any:
        record = resolve_session(session_id)
        if record is None:
            return _not_found(session_id)
        # 上游 load 无增量游标（BeginLogOffset 是死参数），整份 journal 即全部历史
        return {
            "v": 1,
            "sessionId": session_id,
            "events": [entry.event for entry in record.journal.all()],
            "hasMore": False,
        }

    @app.get("/d/session/{session_id}/status")
    async def d_status(session_id: str = Path()) -> dict[str, Any]:
        record = resolve_session(session_id)
        if record is None:
            return _not_found(session_id)
        return {
            "sessionId": session_id,
            "attached": False,
            "hasActivePrompt": record.journal.active_prompt,
            "clientCount": 0,
        }

    @app.patch("/d/session/{session_id}/metadata")
    async def d_rename_session(request: Request, session_id: str = Path()) -> Any:
        body = await _body(request) or {}
        return _rename(session_id, body.get("displayName"))

    @app.delete("/d/session/{session_id}")
    async def d_delete_session(session_id: str = Path()) -> Any:
        record = resolve_session(session_id)
        if record is None:
            return _not_found(session_id)
        # 上游没有删除接口：本地标记隐藏（journal 保留，深链重开还能看到），重启后恢复
        record.deleted = True
        return Response(status_code=204)

    # ------------------------------------------------------------------
    # permission：弹卡的回覆通道（与 /api/sessions/:id/reply 同一上游 ReplyAgentSession）。
    # 契约：200 = 已受理；404 = 未知/已被处理（SDK 按赛跑语义分发）。
    # ------------------------------------------------------------------

    async def _respond_permission(record: Any, session_id: str, request_id: str, body: dict[str, Any] | None) -> Any:
        pending = record.pending_permissions.get(request_id)
        if not pending:
            return _error(404, f"没有这个待处理的人卡请求（requestId={request_id}，未知/已被处理）", "permission_not_found")

        outcome_raw = body.get("outcome") if isinstance(body, dict) and isinstance(body.get("outcome"), dict) else None
        outcome_kind = "cancelled" if outcome_raw and outcome_raw.get("outcome") == "cancelled" else "selected"
        option_id = (outcome_raw.get("optionId") or "").strip() if outcome_raw else ""
        answers = body.get("answers") if isinstance(body, dict) and isinstance(body.get("answers"), dict) else None
        if option_id == OPENAPI_ANSWERS_OPTION:
            if not pending.get("data", {}).get("openApiAnswersOnly") or outcome_kind != "selected" or not answers:
                return _error(400, "问答提交必须包含 answers", "invalid_permission_response")
            option_id = ""  # UI-only option must never reach OpenAPI.
        if outcome_kind == "selected" and not option_id and not answers:
            return _error(400, "outcome=selected 时必须带 optionId 或 answers（与 /api/sessions/:id/reply 同一契约）", "invalid_permission_response")

        if live:
            try:
                result = await _reply_result(live, record.real_id, {
                    "permissionRequestId": request_id,
                    "answers": answers,
                    "optionId": option_id or None,
                    "outcome": outcome_kind,
                })
                if result.get("accepted"):
                    record.pending_permissions.pop(request_id, None)
                    record.journal.append(permission_resolved_event(session_id, request_id, {
                        "outcome": outcome_kind,
                        **({"optionId": option_id} if option_id else {}),
                    }))
                    return {}
                # 上游明确不接：按赛跑失败对待——本地移除并走 404 语义
                record.pending_permissions.pop(request_id, None)
                return _error(404, "上游明确 accepted=false（requestId 可能已过期或已被他人回覆）", "permission_not_accepted")
            except Exception as exc:  # noqa: BLE001
                return JSONResponse({"error": f"回覆上游失败：{exc}", "code": "permission_upstream_error"}, status_code=502)

        # MOCK：回覆是本地教学闭环——上游无真通道，直接当已受理
        record.pending_permissions.pop(request_id, None)
        record.journal.append(permission_resolved_event(session_id, request_id, {
            "outcome": outcome_kind,
            **({"optionId": option_id} if option_id else {}),
        }))
        return {}

    @app.post("/d/session/{session_id}/permission/{request_id}")
    async def d_permission_on_session(request: Request, session_id: str, request_id: str) -> Any:
        record = resolve_session(session_id)
        if record is None:
            return _not_found(session_id)
        body = await _body(request) or {}
        return await _respond_permission(record, session_id, request_id, body)

    @app.post("/d/permission/{request_id}")
    async def d_permission_direct(request: Request, request_id: str) -> Any:
        # 历史兼容路由：requestId 在全注册表里反查会话
        entry = next((r for r in registry.all_records() if request_id in r.pending_permissions), None)
        if entry is None:
            return _error(404, f"没有这个待处理的人卡请求（requestId={request_id}，未知/已被处理）", "permission_not_found")
        body = await _body(request) or {}
        return await _respond_permission(entry, entry.real_id, request_id, body)

    # ------------------------------------------------------------------
    # 降级端点
    # ------------------------------------------------------------------

    @app.get("/d/workspace/tools")
    async def d_workspace_tools() -> dict[str, Any]:
        return {"tools": []}

    @app.api_route("/d/{path:path}", methods=["GET", "POST", "PATCH", "DELETE", "PUT"])
    async def d_not_implemented_fallback(request: Request) -> JSONResponse:
        """兜底 404。web-shell 打到这里的就是 daemon 有、而我们（因为上游 OpenAPI 缺接口
        或尚未实现）给不了的端点——记录进日志，是 OPENAPI-GAPS.md 的证据链。"""
        print(f"[daemon] 未实现端点（缺口候选）: {request.method} {request.url.path}")
        return _error(404, f"daemon 兼容层未实现该端点：{request.method} {request.url.path}", "not_implemented")

    # ------------------------------------------------------------------
    # 内部实现
    # ------------------------------------------------------------------

    async def _load_response(session_id: str, mode: str) -> Any:
        record = resolve_session(session_id)
        if record is None or record.deleted:
            return _not_found(session_id)

        # Restore the live journal immediately while upstream is awaiting a reply.
        if mode == "load" and not record.journal.active_prompt:
            frames: list[dict[str, Any]]
            if live:
                try:
                    frames = await _load_frames(live, record.real_id)
                except Exception as exc:  # noqa: BLE001
                    api = to_api_error(exc if isinstance(exc, Exception) else RuntimeError(str(exc)), "LoadAgentSession")
                    return _error(502 if api.kind == "transport" else 404, api.message, "standalone_session_not_found")
            else:
                scenario = find_scenario(record.real_id)
                frames = read_fixture_frames(scenario.historyFixture) if scenario and scenario.historyFixture else []
            # 过滤 + 去重判据与 reduce_history 同源（rid-less 污染 / load 伪轮次 /
            # bridge-echo 重复回显都不进 journal）
            events = history_frames_to_events(frames, session_id)
            record.journal.seed(events)
            rebuild_pending_permissions(record)

        return {
            **standalone_session_body(record, session_id),
            "state": {
                "models": [
                    {
                        "modelId": "data-agent",
                        "baseModelId": "data-agent",
                        "name": "DataWorks Data Agent",
                        "isCurrent": True,
                        "isRuntime": False,
                    }
                ],
                "modes": {},
                "configOptions": None,
            },
            "compactedReplay": [entry.event for entry in record.journal.compacted()],
            "liveJournal": [entry.event for entry in record.journal.live()],
            "lastEventId": record.journal.last_id(),
            "eventEpoch": EPOCH,
            "historyHasMore": False,
        }

    def _rename(session_id: str, display_name: Any) -> Any:
        record = resolve_session(session_id)
        if record is None:
            return _not_found(session_id)
        name = display_name.strip() if isinstance(display_name, str) else ""
        if not name:
            return _error(400, "displayName 不能为空", "invalid_metadata")
        # 进程级：上游没有改名接口（SessionTitle 恒为首条 prompt 原文），重启即失
        record.display_name = name
        return {"sessionId": session_id, "displayName": name}

    def _batch_mutate(action: str, raw_ids: Any) -> dict[str, Any]:
        ids = [v for v in raw_ids if isinstance(v, str)] if isinstance(raw_ids, list) else []
        done: list[str] = []
        skipped: list[str] = []
        not_found: list[str] = []
        errors: list[Any] = []
        for raw in ids:
            session_id = raw.lower()
            record = registry.resolve(session_id)
            if record is None:
                not_found.append(session_id)
                continue
            if action == "archive":
                if record.archived:
                    skipped.append(session_id)
                else:
                    record.archived = True
                    done.append(session_id)
            elif action == "unarchive":
                if record.archived:
                    record.archived = False
                    done.append(session_id)
                else:
                    skipped.append(session_id)
            else:
                # 上游没有删除接口：本地隐藏标记（journal 保留），重启后恢复可见
                record.deleted = True
                done.append(session_id)
        if action == "archive":
            return {"archived": done, "alreadyArchived": skipped, "notFound": not_found, "errors": errors}
        if action == "unarchive":
            return {"unarchived": done, "alreadyActive": skipped, "notFound": not_found, "errors": errors}
        return {"removed": done, "notFound": not_found, "errors": errors, "fileCleanupPending": []}


def _iso(ms: Any) -> str:
    ms = ms if isinstance(ms, (int, float)) else 0
    import time as _time

    return time.strftime("%Y-%m-%dT%H:%M:%S", _time.gmtime(ms / 1000)) + f".{int(ms % 1000):03d}Z"


async def _body(request: Request) -> dict[str, Any] | None:
    """每个端点的请求体读取：FastAPI 的 request.body 必须 await 才能拿到 bytes。"""
    import json

    try:
        raw = await request.body()
        parsed = json.loads(raw) if raw else {}
    except Exception:  # noqa: BLE001
        return {}
    return parsed if isinstance(parsed, dict) else {}


async def _sse_stream(journal: SessionJournal, session_id: str, last_event_id: int | None, snapshot: bool):
    """把 journal 分发成 SSE 事件流。帧格式对齐真 daemon：`id: <n>` + `event:` + `data:` 三行一帧。

    与 ndjson 泵的关键差异：journal 是纯内存，客户端断开只需停轮询；
    上游那一轮由 runner 独立消费，与这条连接无关。
    """
    # 游标落在已不存在的区间（journal 触顶丢弃 / 进程重启）。真 daemon 此处强制
    # resync；v1 先尽力续播——从现存最旧事件开始，丢段比整个会话打不开轻。
    if last_event_id is not None:
        if journal.last_id() > 0 and journal.first_id() > last_event_id + 1:
            cursor = journal.first_id() - 1
        else:
            cursor = last_event_id
    else:
        cursor = journal.last_id()

    if snapshot:
        event = session_snapshot_event(session_id)
        yield f"event: {event['type']}\ndata: {_json(event)}\n\n"

    while True:
        entries: list[JournalEntry] = await journal.wait_for_more(cursor, HEARTBEAT_MS)
        if not entries:
            # 心跳注释行：保活 + 让中间层别缓冲（不占事件 id 空间）。
            yield ": hb\n\n"
            continue
        for entry in entries:
            yield f"id: {entry.id}\nevent: {entry.event['type']}\ndata: {_json(entry.event)}\n\n"
            cursor = entry.id


def _json(value: Any) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
