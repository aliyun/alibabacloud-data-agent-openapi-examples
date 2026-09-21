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


# ------------------------------------------------------------------
# permission：上游 `_qwen/notify` 帧 → daemon `permission_request` / `permission_resolved`
# （事件类型名与 data 键名以 @qwen-code/sdk 的事件契约为准；toolCall 原样透传含
#  _meta.toolName / rawInput，options 映射成 web-shell 期望的 {optionId,label,raw:{kind}}）。
# ------------------------------------------------------------------


def _pick_option_kind(option: dict[str, Any]) -> str:
    """合成 raw.kind（web-shell 提交按钮只认 allow_once/allow_always/reject_once/reject_always）。
    上游 DataAgent 选项不带 kind 字段，按 optionId 文本语义合成：
    cancel/reject/deny → reject_once；含 always → allow_always；其它一律 allow_once
    （没它"提交"按钮恒 disabled——「提交选项不可用」的真正根因）。"""
    if option.get("kind"):
        return option["kind"]
    option_id = str(option.get("optionId") or "").lower()
    if any(token in option_id for token in ("cancel", "reject", "deny")):
        return "reject_once"
    if "always" in option_id:
        return "allow_always"
    return "allow_once"


def permission_request_event(
    session_id: str,
    request_id: str,
    tool_call: dict[str, Any] | None,
    title: Any,
    options: list[dict[str, Any]],
) -> DaemonEvent:
    data: dict[str, Any] = {
        "requestId": request_id,
        "sessionId": session_id,
        "toolCall": tool_call,
        "options": [
            {
                "optionId": option["optionId"],
                "label": option.get("name") or option["optionId"],
                "raw": {"kind": _pick_option_kind(option)},
            }
            for option in options
            if option.get("optionId")
        ],
    }
    if title is not None:
        data["title"] = title
    return _event("permission_request", data)


def permission_resolved_event(session_id: str, request_id: str, outcome: dict[str, Any]) -> DaemonEvent:
    return _event("permission_resolved", {"requestId": request_id, "sessionId": session_id, "outcome": outcome})
