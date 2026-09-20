"""FastAPI 应用：与 Node 实现同一 HTTP/NDJSON 契约的路由装配。

一条贯穿全部路由的约定：**业务错误也用 HTTP 200 承载**，响应体是
`{ok:false, error:{...}}`；只有传输层故障（后端连不上上游）才用 5xx。
这不是风格偏好——上游 OpenAPI 本身就是这样，前端如果按状态码分支，
会把所有业务错误当成成功。
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from . import mock_fixtures as mf
from .config import AppConfig, describe_config, load_config
from .errors import ApiError, api_error, redact_api_error
from .inflight import Acquired, try_acquire
from .live import (
    LiveContext,
    create_sdk_client,
)
from .live import (
    _agents_result as live_agents_result,
)
from .live import (
    _artifacts_result as live_artifacts_result,
)
from .live import (
    _cancel_result as live_cancel_result,
)
from .live import (
    _create_session_result as live_create_session_result,
)
from .live import (
    _list_sessions_result as live_list_sessions_result,
)
from .live import (
    _load_frames as live_load_frames,
)
from .live import (
    _probe_result as live_probe_result,
)
from .live import (
    _prompt_frames as live_prompt_frames,
)
from .live import (
    _reply_result as live_reply_result,
)
from .live import (
    _usage_result as live_usage_result,
)
from .mock_replay import replay_frames
from .turn import reduce_history
from .normalize import SdkError, to_api_error
from .pipeline import PipelineInput, to_wire_events
from .protocol import WIRE_CONTENT_TYPE, serialize

HEARTBEAT_S = 15
HARD_LIMIT_S = 330  # 对齐实测 218~258s 的断流墙（STREAM_HARD_LIMIT_MS）


def create_app(cfg: AppConfig | None = None) -> FastAPI:
    cfg = cfg or load_config()
    client = None
    if not cfg.mock:
        client = create_sdk_client(cfg)
    live = LiveContext(client=client, cfg=cfg) if client else None

    app = FastAPI(title="DataAgent OpenAPI 示例工程 · Python server", docs_url=None, redoc_url=None, openapi_url=None)

    def send(result: dict[str, Any]) -> JSONResponse:
        """统一响应出口：业务错误 200，传输层故障 502。

        前端只按 error.kind 分支，状态码只用于区分"链路断了"和"业务结论"。
        """
        ok = result.get("ok", True)
        status = 502 if (not ok and (result.get("error") or {}).get("kind") == "transport") else 200
        return JSONResponse(result, status_code=status)

    def ok(result: Any) -> dict[str, Any]:
        return {"ok": True, "result": result}

    def err(error: ApiError) -> dict[str, Any]:
        return {"ok": False, "error": error.to_dict()}

    def live_error(exc: Exception, api_name: str) -> dict[str, Any]:
        error = exc.api_error if isinstance(exc, SdkError) else redact_api_error(to_api_error(exc, api_name))
        return {"ok": False, "error": error.to_dict()}

    # ------------------------------------------------------------------
    # health
    # ------------------------------------------------------------------

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        result: dict[str, Any] = {
            "mock": cfg.mock,
            "region": cfg.regionId,
            "agent": cfg.agentName,
            "sessionSource": cfg.sessionSource,
            "resourceGroupIdConfigured": cfg.resourceGroupId is not None,
            # 只说"有没有"，不说"是什么"：health 是前端启动时第一个请求，
            # 内容会进浏览器 network 面板、日志和截图。
            "credentials": "present" if cfg.accessKeyId and cfg.accessKeySecret else "missing",
        }
        if cfg.mock:
            result["mockReplay"] = "真实时间间隔" if cfg.mockRealtime else f"压平 + {cfg.mockSpeed}x 倍速"
        return {"ok": True, "result": result}

    # ------------------------------------------------------------------
    # 会话列表 / 建会话
    # ------------------------------------------------------------------

    @app.get("/api/sessions")
    async def sessions() -> JSONResponse:
        if live:
            try:
                return send(ok(await live_list_sessions_result(live)))
            except Exception as exc:  # noqa: BLE001
                return send(live_error(exc, "ListAgentSessions"))
        return send(ok(mf.mock_sessions(cfg.sessionSource)))

    @app.post("/api/sessions")
    async def create_session(request: Request) -> Any:
        body = await _json_body(request)
        raw_mode = body.get("mode") if isinstance(body.get("mode"), str) else None
        mode = raw_mode if raw_mode in ("default", "yolo") else None
        if raw_mode is not None and mode is None:
            return send(err(api_error("rpc_error", f"mode 只接受 'yolo' | 'default'，收到：{raw_mode}")))
        if live:
            try:
                return send(ok(await live_create_session_result(live, mode or "yolo")))
            except Exception as exc:  # noqa: BLE001
                return send(live_error(exc, "CreateAgentSession"))
        title = body.get("title") if isinstance(body.get("title"), str) else "新建会话"
        return send(ok(mf.mock_create_session(title)))

    # ------------------------------------------------------------------
    # 人卡回覆（ReplyAgentSession）
    #
    # 用 POST 不只是风格：回覆会真实改变服务端那一轮的执行走向，
    # GET 属 CORS 简单请求，任意网页都能跨源打一发。
    # ------------------------------------------------------------------

    @app.post("/api/sessions/{session_id}/reply")
    async def reply(session_id: str, request: Request) -> JSONResponse:
        body = await _json_body(request)
        permission_request_id = body.get("permissionRequestId") if isinstance(body.get("permissionRequestId"), str) else ""
        permission_request_id = permission_request_id.strip()
        if not permission_request_id:
            return send(
                err(
                    api_error(
                        "rpc_error",
                        "reply 需要 permissionRequestId（来自流上 _qwen/notify permission_request 帧的 data.requestId）",
                    )
                )
            )
        outcome = "cancelled" if body.get("outcome") == "cancelled" else "selected"
        option_id = body.get("optionId") if isinstance(body.get("optionId"), str) and body.get("optionId").strip() else None
        answers: dict[str, str] | None = None
        if body.get("answers") is not None:
            raw_answers = body.get("answers")
            if not isinstance(raw_answers, dict):
                return send(err(api_error("rpc_error", 'answers 必须是 { "0": "答案文本" } 形状的对象（索引键 → 答案）')))
            answers = {}
            for key, value in raw_answers.items():
                if not isinstance(value, str):
                    return send(err(api_error("rpc_error", f'answers["{key}"] 必须是字符串')))
                answers[key] = value
        if outcome == "selected" and not option_id and not answers:
            return send(
                err(
                    api_error(
                        "rpc_error",
                        "outcome=selected 时必须带 optionId（工具授权）或 answers（ask_user_question）；"
                        "只回 selected 会以 proceed_once 解除阻塞但 agent 收不到答案",
                    )
                )
            )

        if live:
            try:
                return send(
                    ok(
                        await live_reply_result(
                            live,
                            session_id,
                            {
                                "permissionRequestId": permission_request_id,
                                "answers": answers,
                                "optionId": option_id,
                                "outcome": outcome,
                            },
                        )
                    )
                )
            except Exception as exc:  # noqa: BLE001
                return send(live_error(exc, "ReplyAgentSession"))
        # MOCK 分支没有可回覆的真实交互，如实拒绝。
        return send(err(api_error("rpc_error", "MOCK 模式回放的是样例，没有可回覆的真实交互；人卡请切 LIVE 模式")))

    # ------------------------------------------------------------------
    # 历史 / usage / artifacts / cancel / probe
    # ------------------------------------------------------------------

    @app.get("/api/sessions/{session_id}/history")
    async def history(session_id: str) -> JSONResponse:
        started_ms = int(time.time() * 1000)
        if live:
            try:
                frames = await live_load_frames(live, session_id)
                reduced = reduce_history(frames)
                reduced["elapsedMs"] = int(time.time() * 1000) - started_ms
                return send(ok(reduced))
            except Exception as exc:  # noqa: BLE001
                return send(live_error(exc, "LoadAgentSession"))

        scenario = mf.find_scenario(session_id)
        if not scenario:
            return send(err(api_error("rpc_error", f"MOCK 模式下没有这个会话：{session_id}")))
        frames = mf.read_fixture_frames(scenario.historyFixture) if scenario.historyFixture else []
        reduced = reduce_history(frames)
        reduced["elapsedMs"] = int(time.time() * 1000) - started_ms
        return send(ok(reduced))

    @app.get("/api/sessions/{session_id}/usage")
    async def usage(session_id: str) -> JSONResponse:
        started_ms = int(time.time() * 1000)
        if live:
            try:
                return send(ok(await live_usage_result(live, session_id)))
            except Exception as exc:  # noqa: BLE001
                return send(live_error(exc, "GetAgentSessionTokenUsage"))
        # MOCK 也要校验会话存在：不校验的话任意 id 都返回同一份样例数据，
        # 而 LIVE 下这个 id 会真报错——那样"MOCK 下验收通过"就推广不到真实链路。
        if not mf.find_scenario(session_id):
            return send(err(api_error("rpc_error", f"MOCK 模式下没有这个会话：{session_id}")))
        recorded = mf.read_fixture_result("rest-token-usage.json")
        return send(
            ok(
                {
                    "promptTokens": recorded.get("PromptTokens"),
                    "completionTokens": recorded.get("CompletionTokens"),
                    "totalTokens": recorded.get("TotalTokens"),
                    "cachedTokens": recorded.get("CachedTokens"),
                    "thoughtsTokens": recorded.get("ThoughtsTokens"),
                    "elapsedMs": int(time.time() * 1000) - started_ms,
                }
            )
        )

    @app.get("/api/sessions/{session_id}/artifacts")
    async def artifacts(session_id: str) -> JSONResponse:
        started_ms = int(time.time() * 1000)
        if live:
            try:
                return send(ok(await live_artifacts_result(live, session_id)))
            except Exception as exc:  # noqa: BLE001
                return send(live_error(exc, "ListAgentSessionArtifacts"))
        if not mf.find_scenario(session_id):
            return send(err(api_error("rpc_error", f"MOCK 模式下没有这个会话：{session_id}")))
        # elapsedMs 恒为 0 是真的：MOCK 下这一路不发任何请求。
        return send(ok({"artifacts": [], "elapsedMs": 0}))

    @app.post("/api/sessions/{session_id}/cancel")
    async def cancel(session_id: str) -> JSONResponse:
        if live:
            try:
                return send(ok(await live_cancel_result(live, session_id)))
            except Exception as exc:  # noqa: BLE001
                return send(live_error(exc, "CancelAgentSession"))
        # MOCK 分支是 no-op：回放没有可取消的执行，delivered:false 在 MOCK 下是准确的。
        return send(
            ok(
                {
                    "delivered": False,
                    "warning": "mock-replay-uncancellable",
                    "detail": "MOCK 模式回放的是样例，没有可取消的执行——delivered:false 在 MOCK 下是准确的。",
                }
            )
        )

    @app.get("/api/sessions/{session_id}/probe")
    async def probe(session_id: str, rid: str = "", tokens: str = "") -> JSONResponse:
        rid = rid.strip()
        if not rid:
            return send(err(api_error("rpc_error", "probe 需要 rid 参数：探测的对象是断流的那一轮，rid 是它唯一的标识")))
        baseline_tokens: float | None = None
        if tokens.strip():
            try:
                value = float(tokens.strip())
                if value > 0:
                    baseline_tokens = value
            except ValueError:
                baseline_tokens = None
        if live:
            try:
                return send(ok(await live_probe_result(live, session_id, rid, baseline_tokens)))
            except Exception as exc:  # noqa: BLE001
                return send(live_error(exc, "LoadAgentSession(probe)"))

        scenario = mf.find_scenario(session_id)
        if not scenario or not scenario.historyFixture:
            return send(err(api_error("rpc_error", f"MOCK 模式下这个会话没有可回放的历史：{session_id}")))
        frames = mf.read_fixture_frames(scenario.historyFixture)
        frames_for_rid = sum(1 for f in frames if f.get("RequestId") == rid)
        usage_envelope = mf.read_fixture_envelope("rest-token-usage.json")
        total_tokens = (usage_envelope["result"] or {}).get("TotalTokens")
        by: list[str] = []
        if frames_for_rid > 2:
            by.append("frames")
        if baseline_tokens is not None and isinstance(total_tokens, (int, float)) and total_tokens > baseline_tokens:
            by.append("tokens")
        # MOCK 只读本地 fixture，loadsIssued 是 0——写成 1 会让这个数字失去意义。
        return send(
            ok({"done": len(by) > 0, "by": by, "framesForRid": frames_for_rid, "totalTokens": total_tokens, "loadsIssued": 0, "elapsedMs": 0})
        )

    # ------------------------------------------------------------------
    # prompt（唯一的流式路由，也是唯一一处"写操作"）
    #
    # 顺序因此是硬的：校验参数 → 拿在途锁 → 进流。
    # 把锁放在流开始之前，被拒的那一方还能拿到一个普通 JSON 响应。
    # ------------------------------------------------------------------

    @app.post("/api/sessions/{session_id}/prompt")
    async def prompt(session_id: str, request: Request) -> Any:
        body = await _json_body(request)
        text = body.get("text") if isinstance(body.get("text"), str) else ""
        text = text.strip()

        if not text:
            return send(err(api_error("rpc_error", "prompt 文本为空")))

        # marker 归属校验已退役（2026-09-20）：不再注入校验码，prompt 原文即 outbound。
        outbound = text

        def build_stream(frames_source: AsyncGenerator[dict[str, Any], None], pop_request_ids: list[str]) -> StreamingResponse | JSONResponse:
            acquired_or = try_acquire(session_id)
            if isinstance(acquired_or, Acquired):
                acquired: Acquired | None = acquired_or
            else:
                acquired = None
            if acquired is None:
                rejected = acquired_or  # Rejected
                return send({"ok": False, "error": rejected.error.to_dict()})

            async def stream() -> AsyncGenerator[bytes, None]:
                """wire 事件 + 心跳 + 硬上限，全部在生成器里完成。

                FastAPI 的 StreamingResponse 是 pull 模型：客户端断开时生成器被取消
                （GeneratorExit），finally 释放在途锁与上游迭代器——不重发、不 cancel。
                """
                release = acquired.release
                deadline = asyncio.get_event_loop().time() + HARD_LIMIT_S
                last_activity = asyncio.get_event_loop().time()
                try:
                    events = to_wire_events(
                        PipelineInput(
                            frames=frames_source,
                            sessionId=session_id,
                            mock=live is None,
                            startedAt=int(time.time() * 1000),
                            apiName="PromptAgentSession",
                            popRequestIds=pop_request_ids,
                        )
                    )
                    iterator = events.__aiter__()
                    while True:
                        now = asyncio.get_event_loop().time()
                        if now - last_activity >= HEARTBEAT_S:
                            yield (serialize({"type": "hb", "t": int(time.time() * 1000)}) + "\n").encode()
                            last_activity = asyncio.get_event_loop().time()
                        if asyncio.get_event_loop().time() >= deadline:
                            # 硬上限：对齐实测断流墙，主动收尾成 stream_break，而不是无限挂着。
                            yield (
                                serialize(
                                    {
                                        "type": "error",
                                        "rid": "",
                                        "error": {
                                            "kind": "stream_break",
                                            "code": None,
                                            "errorCode": None,
                                            "message": "session stream ended without turn terminal (hard limit reached)",
                                            "retryable": False,
                                            "fatalForSession": False,
                                            "upstreamStatus": None,
                                        },
                                    }
                                )
                                + "\n"
                            ).encode()
                            break
                        try:
                            event = await asyncio.wait_for(iterator.__anext__(), timeout=max(0.5, HEARTBEAT_S))
                        except StopAsyncIteration:
                            break
                        except asyncio.TimeoutError:
                            # 上游 next() 迟迟不返回：发心跳保活，继续等（与 Node 的 heartbeat 语义一致）
                            yield (serialize({"type": "hb", "t": int(time.time() * 1000)}) + "\n").encode()
                            last_activity = asyncio.get_event_loop().time()
                            continue
                        yield (serialize(event) + "\n").encode()
                        last_activity = asyncio.get_event_loop().time()
                finally:
                    # 客户端断开（GeneratorExit）时释放上游迭代器：不 cancel、不重发——
                    # 服务端那一轮还在跑，重发等于写两遍。
                    release()

            headers = {
                "content-type": f"{WIRE_CONTENT_TYPE}; charset=utf-8",
                "cache-control": "no-store, no-transform",
                "connection": "keep-alive",
                "x-accel-buffering": "no",
            }
            return StreamingResponse(stream(), status_code=200, headers=headers, media_type=WIRE_CONTENT_TYPE)

        if live:
            pop_request_ids: list[str] = []
            frames_source = live_prompt_frames(live, session_id, outbound, pop_request_ids)
            return build_stream(frames_source, pop_request_ids)

        scenario = mf.find_scenario(session_id)
        if not scenario:
            return send(err(api_error("rpc_error", f"MOCK 模式下没有这个会话：{session_id}")))
        # ack-only 场景没有样例帧：回放空帧列表 ⇒ 与 live 走同一条收尾分类
        # （零帧 + 有回执 ⇒ prompt_not_dispatched）。
        frames = mf.read_fixture_frames(scenario.promptFixture) if scenario.promptFixture else []
        frames_source = replay_frames(frames, realtime=cfg.mockRealtime, speed=cfg.mockSpeed)
        return build_stream(frames_source, [scenario.popAck] if scenario.popAck else [])

    # ------------------------------------------------------------------
    # SPA 回退 + 静态前端托管（web/dist 存在时同源交付，与 Node 行为对齐）
    # ------------------------------------------------------------------

    # daemon 兼容层（/d）：web-shell 前端说话的对象。必须早于 SPA 回退注册——
    # `/{full_path:path}` 兜底盘算 /d/*，谁先注册谁赢。
    from .daemon.routes import register_daemon_routes

    register_daemon_routes(app, cfg, live)

    web_dist = Path(cfg.webDist) if cfg.webDist else None
    if web_dist is not None and web_dist.exists():

        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa(full_path: str) -> Any:
            candidate = (web_dist / full_path).resolve()
            if candidate.is_file() and str(candidate).startswith(str(web_dist.resolve())):
                return FileResponse(candidate)
            index = web_dist / "index.html"
            if index.exists():
                return FileResponse(index)
            return JSONResponse({"ok": False, "error": {"kind": "transport", "message": f"not found: {full_path}"}}, status_code=404)

    app.state.cfg = cfg
    return app


async def _json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return {}
    return body if isinstance(body, dict) else {}


def main() -> None:  # pragma: no cover - 手工启动入口
    import uvicorn

    cfg = load_config()
    print(describe_config(cfg))
    app = create_app(cfg)
    uvicorn.run(app, host=cfg.serverHost, port=cfg.port, log_level="info")


if __name__ == "__main__":
    main()
