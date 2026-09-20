"""daemon 兼容层的事件信封与构造器。与 Node 实现的 server/daemon/events.ts 同源同语义。

形状对齐 qwen-code 的 daemon REST API 契约（EventEnvelope）：`{v:1, type, data, id?,
originatorClientId?, _meta?}`。消费方是 @qwen-code/web-shell（经 @qwen-code/sdk 的
RestSseTransport 解析），它按 type 分发 normalize、容忍未知字段，所以这里只保证
已知事件类型的 data 必填字段，其余原样带过。
"""

from __future__ import annotations

from typing import Any

DaemonEvent = dict[str, Any]


def _event(type_: str, data: dict[str, Any], originator_client_id: str | None = None) -> DaemonEvent:
    out: DaemonEvent = {"v": 1, "type": type_, "data": data}
    if originator_client_id is not None:
        out["originatorClientId"] = originator_client_id
    return out


def session_update_event(session_id: str, update: dict[str, Any], originator_client_id: str | None = None) -> DaemonEvent:
    """session_update：`data.update` 里是 ACP update 载荷（整包透传，不重塑）。

    data 形状对齐真 daemon：`{sessionId, update:{...}}`——web-shell 的
    `getSessionUpdatePayload` 优先读 `data.update`，读不到才退回 data 本体；
    若把 update 挂在别的键上，`data.sessionUpdate` 会被当成判别器读出对象而非
    字符串，整个事件退化成"未知块"渲染原始 JSON（e2e 实测过这个坑）。
    """
    return _event("session_update", {"sessionId": session_id, "update": update}, originator_client_id)


def turn_complete_event(session_id: str, stop_reason: str, prompt_id: str) -> DaemonEvent:
    return _event("turn_complete", {"sessionId": session_id, "stopReason": stop_reason, "promptId": prompt_id})


def turn_error_event(
    session_id: str, message: str, *, prompt_id: str | None = None, code: str | None = None, error_kind: str | None = None
) -> DaemonEvent:
    data: dict[str, Any] = {"sessionId": session_id, "message": message}
    if prompt_id is not None:
        data["promptId"] = prompt_id
    if code is not None:
        data["code"] = code
    if error_kind is not None:
        data["errorKind"] = error_kind
    return _event("turn_error", data)


def prompt_cancelled_event(session_id: str, prompt_id: str) -> DaemonEvent:
    return _event("prompt_cancelled", {"sessionId": session_id, "promptId": prompt_id})


def session_snapshot_event(session_id: str) -> DaemonEvent:
    """SSE `?snapshot=1` 时连接即附的快照（合成事件，不入 journal、不带 id）。"""
    return _event(
        "session_snapshot",
        {"sessionId": session_id, "currentModelId": "data-agent", "currentApprovalMode": None},
    )


def with_id(event: DaemonEvent, entry_id: int) -> DaemonEvent:
    """返回事件的副本并盖上 journal 序号（不可变语义：journal.id 是唯一注入 id 的地方）。"""
    out = dict(event)
    out["id"] = entry_id
    return out
