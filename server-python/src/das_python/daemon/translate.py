"""上游 ACP 帧 → daemon `session_update` 事件。与 Node 实现的 server/daemon/translate.ts、
Java 实现的 Translate.java 同源同语义。

update 载荷**整包透传**（与 pipeline「帧原样透传、不重塑」同一哲学）：
两边同出 ACP 血统，tool_call / tool_call_update / usage_update /
config_option_update 的字段名天然对得上 web-shell 的 normalizer；
未知 update 类型也原样带过——normalizer 容忍未知，重塑反而会把上游新字段静默丢掉。
"""

from __future__ import annotations

from typing import Any

from ..frames import params_of, pending_interaction_of, permission_resolved_of, session_update_of, text_of, update_of
from ..marker import strip_marker_instruction
from ..rid import partition_by_rid
from .events import DaemonEvent, permission_request_event, permission_resolved_event, session_update_event

Frame = dict[str, Any]


def frame_to_session_update(
    frame: Frame, session_id: str, strip_marker: bool = True, originator_client_id: str | None = None
) -> DaemonEvent | None:
    """帧 → session_update 事件；None 表示这帧不产出事件：排队通知帧（无 update）、
    update 缺 sessionUpdate 键、以及纯终态/错误帧（它们走 turn_complete/turn_error）。"""
    update = update_of(frame)
    if update is None:
        return None
    kind = session_update_of(frame)
    if kind is None:
        return None

    payload = dict(update)
    if kind == "user_message_chunk" and strip_marker:
        # 服务端注入的校验码说明会随上游回显一起回来，展示层必须剥掉。
        # content 重建为单文本块：回显的 content 形状一致（{type:'text',text}），重建即剥离。
        payload["content"] = {"type": "text", "text": strip_marker_instruction(text_of(update))}
    # agent 思考/回答的 chunk 文本在这一层**必须原样透传**（2026-09-19 定案）：
    # 逐 chunk 调整文 strip 会把 markdown 段落/代码块围栏的边界空白吃光——
    # token 剥离唯一正确的位置是紧随其后的流式 Scrubber（runner 与历史种子都已挂）。
    return session_update_event(session_id, payload, originator_client_id)


def filter_history_frames(frames: list[Frame]) -> list[Frame]:
    """历史帧过滤：与 `reduce_history` 同源的判据——按 rid 分组后，只有名下含
    `user_message_chunk` 的 rid 才是真实轮次。

    丢掉的两类都不能进 journal：
      · rid-less 帧：原始回放污染，是同一轮内容的第二份拷贝（实测 977 帧里 900 帧）；
      · 无 user_message_chunk 的 rid：典型是 load 调用自己的 rid（一个伪 end_turn 空轮次）。
    """
    partition = partition_by_rid(frames)
    out: list[Frame] = []
    for group in partition.byRid.values():
        if any(session_update_of(f) == "user_message_chunk" for f in group):
            out.extend(group)
    return out


def history_frames_to_events(frames: list[Frame], session_id: str) -> list[DaemonEvent]:
    """历史帧 → journal 种子事件：过滤（同 reduce_history 判据）+ 翻译 + user 回显去重。

    去重判据与 shared reducer 同源：归档态里同一句提示词会出现两条完全相同的
    user_message_chunk（一条 bridge-echo 拷贝），reducer 靠 `text != 已累积文本`
    跳过整块重复；journal 不做同样的事，web-shell 就会把提示词显示两遍
    （e2e 实测：mock-tools 历史里每个 prompt 都双份）。
    """
    partition = partition_by_rid(frames)
    out: list[DaemonEvent] = []
    for group in partition.byRid.values():
        if not any(session_update_of(f) == "user_message_chunk" for f in group):
            continue
        user_text = ""
        for frame in group:
            # permission 通知也进种子：刷新后要能还原 pending/pendingResolved 的由来。
            permission_event = frame_to_permission_event(frame, session_id)
            if permission_event is not None:
                out.append(permission_event)
                continue
            event = frame_to_session_update(frame, session_id, strip_marker=True)
            if event is None:
                continue
            update = event["data"]["update"]
            kind = update.get("sessionUpdate")
            if kind == "user_message_chunk":
                text = text_of(update)
                if text and text == user_text:
                    continue
                user_text += text
            # agent 思考/回答的 chunk 文本原样透传（marker 剥离机制已退役，不再有任何剥除器）
            out.append(event)
    return out


# ------------------------------------------------------------------
# permission：把 `_qwen/notify` 帧翻译成 daemon 的 permission 事件。
# 上游的通知不能当 session_update 发——它有专门的 permission 事件契约；
# 此前这些帧被整帧丢弃（update_of 拿不到 → return None），这就是「没有弹框」的根因。
# ------------------------------------------------------------------


def frame_to_permission_event(frame: Frame, session_id: str) -> DaemonEvent | None:
    pending = pending_interaction_of(frame)
    if pending is not None:
        params = params_of(frame)
        data = params.get("data") if params else None
        tool_call = data.get("toolCall") if isinstance(data, dict) and isinstance(data.get("toolCall"), dict) else None
        return permission_request_event(
            session_id,
            pending["requestId"],
            tool_call,
            pending.get("toolCallTitle"),
            pending.get("options") or [],
        )
    resolved = permission_resolved_of(frame)
    if resolved is not None:
        params = params_of(frame)
        data = params.get("data") if params else None
        outcome = data.get("outcome") if isinstance(data, dict) and isinstance(data.get("outcome"), dict) else {"outcome": "selected"}
        return permission_resolved_event(session_id, resolved["requestId"], outcome)
    return None
