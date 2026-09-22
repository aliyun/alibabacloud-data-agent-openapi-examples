"""daemon prompt 准入与后台轮次。与 Node 实现的 server/daemon/runner.ts、
Java 实现的 Runner.java 同源同语义。

所有校验都在**还没碰到上游**之前完成（写操作纪律），通过后立刻返回 202 所需的
{promptId, lastEventId}，轮次在后台跑、事件写 journal、SSE 分发。

这是与 `/api/sessions/:id/prompt`（上游流直连客户端）最大的架构差异：
客户端连接的存亡从此不影响上游那一轮的收尾。
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, AsyncGenerator

from ..config import AppConfig
from ..errors import classify_error, prompt_not_dispatched, redact_api_error, stream_break_without_terminal
from ..frames import error_of, request_id_of, session_update_of, terminal_of, text_of
from ..inflight import Acquired, Rejected as InflightRejected, try_acquire
from ..live import LiveContext, _prompt_frames
from ..mock_fixtures import find_scenario, read_fixture_frames
from ..mock_replay import replay_frames
from ..normalize import to_api_error
from .events import prompt_cancelled_event, session_update_event, turn_complete_event, turn_error_event
from .registry import SessionRecord
from .translate import frame_to_permission_event, frame_to_session_update


@dataclass
class PendingTurn:
    """202 准入通过后的后台轮次包——由路由层交给进程级 worker 一族执行。

    为什么不能直接 asyncio.create_task(run_turn(...))：Starlette 的 anyio
    请求任务组会在响应完成后 cancel 掉 handler 里 spawn 的任务（本仓实测：
    首个事件入 journal 后 asyncio.sleep 即抛 CancelledError）。
    轮次必须挂在**与 app 同寿命**的 worker task 上，请求只负责进队。
    """

    cfg: Any
    live: Any
    record: Any
    client_facing_id: str
    prompt_id: str
    outbound: str
    client_id: Any
    acquired: Any
    started_at: int


@dataclass
class Admitted:
    prompt_id: str
    last_event_id: int
    pending: PendingTurn


@dataclass
class Rejected:
    status: int
    error: str
    code: str


Admission = Admitted | Rejected


# 与 app 同寿命的轮次队列与 worker。但队列与工作线程都**写死在创建它们的事件循环上**
# ——测试逐个换 uvicorn 实例时，新实例的 loop 会用旧的队列，队列与死 loop 绑定断裂
# （实测：getter = self._get_loop() 直接 RuntimeError，worker 死在 get() 上）。
# 解法：loop 变了就让它们整组重建；队列里还没消化的轮次与上一条 loop 共灭
# （测试语境里没有跨实例的"丢不掉轮次"语义包袱）。
_turn_queue: asyncio.Queue[PendingTurn] | None = None
_turn_worker_task: asyncio.Task | None = None
_turn_loop: asyncio.AbstractEventLoop | None = None


def submit_turn(loop: asyncio.AbstractEventLoop, pending: PendingTurn) -> None:
    """202 之后由路由层调用：把轮次压进队列，后台 worker 拿个执行。"""
    global _turn_queue, _turn_worker_task, _turn_loop
    if _turn_loop is not loop:
        _turn_queue = None
        _turn_worker_task = None
        _turn_loop = loop
    if _turn_queue is None:
        _turn_queue = asyncio.Queue()
    if _turn_worker_task is None or _turn_worker_task.done():
        _turn_worker_task = loop.create_task(_turn_worker_loop())
    _turn_queue.put_nowait(pending)


async def _turn_worker_loop() -> None:
    """worker 主循环：逐个执行队列里的轮次。它的寿命与 app 同——这才是
    web-shell 模型要的核心保证（响应完成后的轮次不会死）。"""
    assert _turn_queue is not None
    while True:
        pending = await _turn_queue.get()
        try:
            await run_turn(
                pending.cfg,
                pending.live,
                pending.record,
                pending.client_facing_id,
                pending.prompt_id,
                pending.outbound,
                pending.client_id,
                pending.acquired,
                pending.started_at,
            )
        except Exception:  # noqa: BLE001
            # run_turn 内部已兜所有已知路径；这里只防"兜底本身抛了"这种把 worker 带走的形态。
            print(f"[daemon-runner] 后台轮次异常退出 session={pending.record.real_id} prompt={pending.prompt_id}")


def admit_prompt(
    cfg: AppConfig,
    live: LiveContext | None,
    record: SessionRecord,
    client_facing_id: str,
    prompt_blocks: Any,
    client_id: str | None,
) -> Admission:
    if not isinstance(prompt_blocks, list) or len(prompt_blocks) == 0:
        return Rejected(400, 'prompt 需要至少一个 content block（{type:"text",text}）', "empty_prompt")
    texts: list[str] = []
    for block in prompt_blocks:
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
            texts.append(block["text"])
            continue
        block_type = block.get("type") if isinstance(block, dict) else None
        # 上游 PromptAgentSession 只收文本块；图片块如实拒绝而不是静默丢弃（缺口见 OPENAPI-GAPS）
        return Rejected(400, f"不支持的 prompt content block（type={block_type}）：上游 data agent OpenAPI 仅接受文本", "unsupported_prompt_content")
    text = "".join(texts).strip()
    if not text:
        return Rejected(400, "prompt 文本为空", "empty_prompt")

    # marker 归属校验已退役（2026-09-20）：不再注入校验码，prompt 原文即 outbound。
    outbound = text

    acquired = try_acquire(record.real_id)
    if isinstance(acquired, InflightRejected):
        return Rejected(409, acquired.error.message, "session_concurrent_operation_in_progress")
    assert isinstance(acquired, Acquired)

    prompt_id = str(uuid.uuid4())
    journal = record.journal
    journal.active_prompt = True
    journal.active_prompt_id = prompt_id
    # 202 的 lastEventId 必须在后台任务可能追加任何事件**之前**取——
    # 客户端拿它做 SSE 游标起点，晚了就漏掉这一轮的头几帧。
    last_event_id = journal.last_id()

    started_at = int(time.time() * 1000)
    # 轮次不进 handler 的 anyio 任务组（会被 cancel）：路由层拿 pending 去 submit_turn。
    return Admitted(
        prompt_id=prompt_id,
        last_event_id=last_event_id,
        pending=PendingTurn(
            cfg=cfg,
            live=live,
            record=record,
            client_facing_id=client_facing_id,
            prompt_id=prompt_id,
            outbound=outbound,
            client_id=client_id,
            acquired=acquired,
            started_at=started_at,
        ),
    )


async def run_turn(
    cfg: AppConfig,
    live: LiveContext | None,
    record: SessionRecord,
    client_facing_id: str,
    prompt_id: str,
    outbound: str,
    client_id: str | None,
    acquired: Acquired,
    started_at: int,
) -> None:
    """后台轮次：帧源（live=SDK SSE / mock=录制件回放）→ 翻译 → journal。

    收尾分类与 pipeline 同源：
      · 帧内 Error → 首个错误归一成 turn_error（后续帧继续收）；
      · Result.stopReason → turn_complete；
      · 无终态：有帧 ⇒ stream_break（绝不重发）；零帧+有回执 ⇒ prompt_not_dispatched。
    不设整轮硬上限；等待真实终态或明确传输错误。
    """
    journal = record.journal
    print(json.dumps({"event": "prompt_stream_start", "backend": "python", "pid": os.getpid(),
                      "sessionId": record.real_id, "promptId": prompt_id, "startedAt": started_at}), flush=True)
    acks: list[str] = []

    frames: AsyncGenerator[dict[str, Any], None]
    if live:
        frames = _prompt_frames(live, record.real_id, outbound, acks)
    else:
        scenario = find_scenario(record.real_id)
        frames = replay_frames(
            read_fixture_frames(scenario.promptFixture) if scenario and scenario.promptFixture else [],
            realtime=cfg.mockRealtime,
            speed=cfg.mockSpeed,
        )
        if scenario and scenario.popAck:
            acks.append(scenario.popAck)

    frame_count = 0
    last_frame_at = None
    outcome = "eof_without_terminal"
    exception_types = []
    error_sent = False
    terminal: dict[str, Any] | None = None
    rid_backfilled = False
    user_text = ""

    try:
        async for frame in frames:
            frame_count += 1
            last_frame_at = int(time.time() * 1000)
            if not rid_backfilled:
                rid = request_id_of(frame)
                if rid is not None:
                    rid_backfilled = True
                    # 在途锁条目的 rid 回填：撞锁的日志要能报出"正在跑的是哪一轮"
                    acquired.entry.rid = rid
            if not error_sent:
                # permission 通知帧先于 session_update 处理（到达序的真实顺序）；
                # 此前这些帧被整帧丢弃就在这条线被吞掉的——「没有弹框」的根因。
                permission_event = frame_to_permission_event(frame, client_facing_id)
                if permission_event is not None:
                    journal.append(permission_event)
                    request_id = permission_event.get("data", {}).get("requestId")
                    if isinstance(request_id, str):
                        if permission_event["type"] == "permission_request":
                            record.pending_permissions[request_id] = permission_event
                        else:
                            record.pending_permissions.pop(request_id, None)
            if not error_sent:
                event = frame_to_session_update(frame, client_facing_id, strip_marker=True, originator_client_id=client_id)
                duplicate_user_chunk = False
                if event is not None:
                    update = event["data"]["update"]
                    kind = update.get("sessionUpdate")
                    if kind == "user_message_chunk":
                        text = text_of(update)
                        if text and text == user_text:
                            duplicate_user_chunk = True
                        else:
                            user_text += text
                    # agent 思考/回答的 chunk 文本原样透传（marker 剥离机制已退役，不再有任何剥除器）
                if event is not None and not duplicate_user_chunk:
                    journal.append(event)
            # errorSent 之后只消费不投喂：turn_error 是本轮事件流的终态（daemon 语义），
            # 上游断流前还会再吐少量帧（实测 mock-break 录制件错误帧后仍有收尾帧），
            # 迟到的 session_update 会在 web-shell 里变成"终态之后的孤儿内容"。

            frame_error = error_of(frame)
            if frame_error is not None and not error_sent:
                error_sent = True
                outcome = "upstream_error_frame"
                api = redact_api_error(
                    classify_error(
                        message=frame_error.get("message") if isinstance(frame_error.get("message"), str) else None,
                        code=frame_error.get("code") if isinstance(frame_error.get("code"), int) else None,
                        errorCode=frame_error.get("errorCode") if isinstance(frame_error.get("errorCode"), str) else None,
                    )
                )
                journal.append(turn_error_event(client_facing_id, api.message, prompt_id=prompt_id, code=api.kind, error_kind=api.kind))
            if terminal is None:
                terminal = terminal_of(frame)
            if terminal is not None:
                break  # Protocol terminal, not HTTP EOF, ends the turn.

        if not error_sent:
            if terminal is not None:
                journal.append(turn_complete_event(client_facing_id, terminal.get("rawStopReason") or "end_turn", prompt_id))
            else:
                error_sent = True
                if frame_count == 0 and acks:
                    outcome = "ack_without_frames"
                api = (
                    prompt_not_dispatched(acks[0] if acks else None, int(time.time() * 1000) - started_at)
                    if frame_count == 0 and acks
                    else stream_break_without_terminal(frame_count)
                )
                journal.append(turn_error_event(client_facing_id, api.message, prompt_id=prompt_id, code=api.kind, error_kind=api.kind))
    except Exception as err:  # noqa: BLE001
        cause = err
        while cause is not None and len(exception_types) < 4:
            exception_types.append(type(cause).__name__)
            cause = cause.__cause__ or cause.__context__
        if not error_sent and terminal is not None:
            journal.append(turn_complete_event(client_facing_id, terminal.get("rawStopReason") or "end_turn", prompt_id))
        elif not error_sent:
            outcome = "transport_exception"
            error_sent = True
            api = to_api_error(err if isinstance(err, Exception) else RuntimeError(str(err)), "PromptAgentSession")
            journal.append(turn_error_event(client_facing_id, api.message, prompt_id=prompt_id, code=api.kind, error_kind=api.kind))
    except asyncio.CancelledError:
        outcome = "task_cancelled"
        raise
    finally:
        acquired.release()
        journal.active_prompt = False
        journal.active_prompt_id = None
        ended_at = int(time.time() * 1000)
        print(json.dumps({"event": "prompt_stream_end", "backend": "python", "pid": os.getpid(),
            "sessionId": record.real_id, "promptId": prompt_id, "startedAt": started_at,
            "endedAt": ended_at, "lastFrameAt": last_frame_at, "idleMs": ended_at - (last_frame_at or started_at),
            "frames": frame_count, "upstreamRequestId": acquired.entry.rid, "popRequestId": acks[0] if acks else None,
            "pendingPermissions": len(record.pending_permissions), "exceptionTypes": exception_types,
            "outcome": "terminal" if terminal is not None and not error_sent else outcome}), flush=True)
