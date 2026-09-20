"""轮次聚合与历史归约。与 Node 实现的 shared/turn.ts 同源同语义。

这是全工程唯一的帧解释点：后端拉历史用它、前端渲染在途流用它、mock 回放也用它。
只存聚合结果、不存原始帧——实测 901 帧/191 秒，存原始帧会让内存随轮次长度线性膨胀。
"""

from __future__ import annotations

from typing import Any

from .constants import OBSERVED_SESSION_UPDATES, OBSERVED_TOOL_STATUSES
from .frames import (
    error_of,
    locations_of,
    offset_of,
    params_of,
    request_id_of,
    session_id_of,
    session_update_of,
    terminal_of,
    text_of,
    timestamp_of,
    token_usage_of,
    tool_name_of,
    tool_result_text,
    update_of,
)
from .rid import partition_by_rid

KNOWN_UPDATES = set(OBSERVED_SESSION_UPDATES)
KNOWN_TOOL_STATUSES = set(OBSERVED_TOOL_STATUSES)


def create_turn(rid: str | None = None) -> dict[str, Any]:
    return {
        "rid": rid,
        "sessionId": None,
        "userText": "",
        "thoughtText": "",
        "messageText": "",
        "tools": [],
        "contextUsage": None,
        "tokenUsage": None,
        "terminated": False,
        "stopReason": None,
        "rawStopReason": None,
        "error": None,
        "frameCount": 0,
        "firstTimestamp": None,
        "lastTimestamp": None,
        "minOffset": None,
        "maxOffset": None,
        "queuedNotices": 0,
        "unrecognizedUpdates": [],
    }


def _find_tool(turn: dict[str, Any], tool_call_id: str) -> dict[str, Any] | None:
    for tool in turn["tools"]:
        if tool["toolCallId"] == tool_call_id:
            return tool
    return None


def _note_unrecognized(turn: dict[str, Any], label: str) -> None:
    if label not in turn["unrecognizedUpdates"]:
        turn["unrecognizedUpdates"].append(label)


def apply_frame(turn: dict[str, Any], frame: dict[str, Any]) -> None:
    """把一帧并入轮次聚合。这是全工程唯一的帧解释点（前端/后端/mock 同源）。"""
    turn["frameCount"] += 1

    if turn["rid"] is None:
        turn["rid"] = request_id_of(frame)
    if turn["sessionId"] is None:
        turn["sessionId"] = session_id_of(frame)

    timestamp = timestamp_of(frame)
    if timestamp is not None:
        if turn["firstTimestamp"] is None or timestamp < turn["firstTimestamp"]:
            turn["firstTimestamp"] = timestamp
        if turn["lastTimestamp"] is None or timestamp > turn["lastTimestamp"]:
            turn["lastTimestamp"] = timestamp

    offset = offset_of(frame)
    if offset is not None:
        if turn["minOffset"] is None or offset < turn["minOffset"]:
            turn["minOffset"] = offset
        if turn["maxOffset"] is None or offset > turn["maxOffset"]:
            turn["maxOffset"] = offset

    error = error_of(frame)
    if error:
        # 错误帧不产出内容。同一轮的帧仍会继续到达（断流前已有 1200 帧），
        # 所以这里只记录、不终止聚合。
        turn["error"] = error
        return

    terminal = terminal_of(frame)
    if terminal:
        turn["terminated"] = True
        turn["stopReason"] = terminal["stopReason"]
        turn["rawStopReason"] = terminal["rawStopReason"]
        return

    update = update_of(frame)
    if not update:
        # 排队通知帧（Method="_qwen/notify"，Params.kind="pending_prompt_added"）没有 update，
        # 它是"你的提示词排上了"的信号，不是内容。
        notice_kind = (params_of(frame) or {}).get("kind")
        if isinstance(notice_kind, str):
            turn["queuedNotices"] += 1
            return
        _note_unrecognized(turn, "<no update>")
        return

    kind = session_update_of(frame)
    if kind is None:
        # update 存在但没有 sessionUpdate。容忍并计数，不抛。
        _note_unrecognized(turn, "<missing sessionUpdate>")
        return
    if kind not in KNOWN_UPDATES:
        _note_unrecognized(turn, kind)

    if kind == "user_message_chunk":
        text = text_of(update)
        # 归档态里同一句提示词会出现两条完全相同的 user_message_chunk（实测两份 load 回放皆然），
        # 不去重界面上就会把提示词显示两遍。
        if text and text != turn["userText"]:
            turn["userText"] += text
    elif kind == "agent_thought_chunk":
        # 按 token 分片，必须拼接；末尾可能有空串收尾片，追加空串本身无害
        turn["thoughtText"] += text_of(update)
    elif kind == "agent_message_chunk":
        turn["messageText"] += text_of(update)
        usage = token_usage_of(update)
        if usage:
            turn["tokenUsage"] = usage
    elif kind in ("tool_call", "tool_call_update"):
        _apply_tool_frame(turn, update, offset, timestamp)
    elif kind == "usage_update":
        size = update.get("size") if isinstance(update.get("size"), int) else None
        used = update.get("used") if isinstance(update.get("used"), int) else None
        if size is not None or used is not None:
            turn["contextUsage"] = {
                "size": size if size is not None else (turn["contextUsage"] or {}).get("size", 0),
                "used": used if used is not None else (turn["contextUsage"] or {}).get("used", 0),
            }
    # config_option_update 等：已经记进 unrecognizedUpdates，不当内容处理


def _apply_tool_frame(
    turn: dict[str, Any],
    update: dict[str, Any],
    offset: int | None,
    timestamp: int | None,
) -> None:
    tool_call_id = update.get("toolCallId") if isinstance(update.get("toolCallId"), str) else None
    if not tool_call_id:
        _note_unrecognized(turn, "<tool frame without toolCallId>")
        return

    status_raw = update.get("status") if isinstance(update.get("status"), str) else None
    status = status_raw if status_raw in KNOWN_TOOL_STATUSES else "unknown"

    tool = _find_tool(turn, tool_call_id)
    if not tool:
        tool = {
            "toolCallId": tool_call_id,
            "name": None,
            "title": None,
            "status": "unknown",
            "command": None,
            "description": None,
            "rawInput": None,
            "locations": [],
            "resultText": None,
            "firstOffset": offset,
            "lastOffset": offset,
            "firstTimestamp": timestamp,
            "lastTimestamp": timestamp,
        }
        turn["tools"].append(tool)

    # 一律"有值才覆盖"：completed 帧不带 title/rawInput.command，
    # 无脑赋值会把 in_progress 阶段拿到的信息擦掉。
    name = tool_name_of(update)
    if name:
        tool["name"] = name
    if isinstance(update.get("title"), str) and update["title"]:
        tool["title"] = update["title"]
    if status != "unknown":
        tool["status"] = status
    command = (update.get("rawInput") or {}).get("command") if isinstance(update.get("rawInput"), dict) else None
    if isinstance(command, str) and command:
        tool["command"] = command
    description = (update.get("rawInput") or {}).get("description") if isinstance(update.get("rawInput"), dict) else None
    if isinstance(description, str) and description:
        tool["description"] = description

    # rawInput 增量合并而不是整包替换：pending 帧的 rawInput 是 `{}`，
    # 替换会把前一帧拿到的参数擦成空。只在真的有新键时才建对象。
    raw_input = update.get("rawInput")
    if isinstance(raw_input, dict) and len(raw_input) > 0:
        tool["rawInput"] = {**(tool["rawInput"] or {}), **raw_input}

    locations = locations_of(update)
    if locations:
        tool["locations"] = locations

    result_text = tool_result_text(update)
    if result_text:
        tool["resultText"] = result_text
    if offset is not None:
        tool["lastOffset"] = offset
    if timestamp is not None:
        if tool["firstTimestamp"] is None or timestamp < tool["firstTimestamp"]:
            tool["firstTimestamp"] = timestamp
        if tool["lastTimestamp"] is None or timestamp > tool["lastTimestamp"]:
            tool["lastTimestamp"] = timestamp


def reduce_frames(frames: list[dict[str, Any]], rid: str | None = None) -> dict[str, Any]:
    """把一串帧聚合成一个轮次。"""
    turn = create_turn(rid)
    for frame in frames:
        apply_frame(turn, frame)
    return turn


def reduce_history(frames: list[dict[str, Any]]) -> dict[str, Any]:
    """把 load（拉历史）的帧流还原成轮次列表。

    轮次判据：该 rid 名下至少有一条 user_message_chunk。
    只有 load 自己的 rid 与配置帧不满足这条，正好被排除。
    """
    partition = partition_by_rid(frames)
    turns: list[dict[str, Any]] = []
    non_turn_rids: list[str] = []
    rids: dict[str, int] = {}

    for rid, group in partition.byRid.items():
        rids[rid] = len(group)
        is_turn = any(session_update_of(f) == "user_message_chunk" for f in group)
        if is_turn:
            turns.append(reduce_frames(group, rid))
        else:
            non_turn_rids.append(rid)

    return {
        "turns": turns,
        "droppedRidLess": len(partition.ridLess),
        "rids": rids,
        "nonTurnRids": non_turn_rids,
        "totalFrames": partition.total,
    }
