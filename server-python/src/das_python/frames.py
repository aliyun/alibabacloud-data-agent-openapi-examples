"""上游 ACP JSON-RPC 帧：解析、归一化、访问器。与 Node 实现的 shared/frames.ts 同源同语义。

移植纪律：Node 侧 shared/frames.ts 的行为变更必须同步到这里——
两个 server 服务的都是同一个前端，同一帧在两种实现下解析出不同形状就是 bug。
"""

from __future__ import annotations

import json
from typing import Any

from .constants import STOP_REASONS

# ---------------------------------------------------------------------------
# 宽松帧形状
# ---------------------------------------------------------------------------

# 刻意用宽松 dict（所有键可选）：真实帧里键会缺（900/977 帧没有 RequestId）、
# 会多（_qwen/notify 排队帧）、形状会分叉（content 既可能是对象也可能是数组）。
# 严格类型只会带来假安全感——所有取值都走下面的 helper，helper 里做运行时判断。
Frame = dict[str, Any]


def is_object(value: Any) -> bool:
    return isinstance(value, dict)


# ---------------------------------------------------------------------------
# SDK 响应体 → 线格式帧
# ---------------------------------------------------------------------------

# SDK 的 *WithSSE() 交出来的 resp.body 与线格式**不同名**。
# Python 侧：模型属性是 snake_case，但 `to_map()` 产出的是线格式（PascalCase）键——
# 与 Node 侧 camelCase 的 cast 行为不同，但同样要处理"模型未声明的键被静默丢掉"的风险。
# 两条必须守住的性质（与 Node shared/frames.ts 相同）：
#  1. 缺的键不写（rid 过滤判据是键是否存在，写 undefined 会把污染帧全放进来）；
#  2. 两种大小写都认（线格式与 SDK 形状都可能是输入），live 与 mock 才能共用同一个 reducer。
SDK_TO_WIRE: list[tuple[str, str]] = [
    ("Jsonrpc", "jsonrpc"),
    ("Method", "method"),
    ("Id", "id"),
    ("Params", "params"),
    ("Result", "result"),
    ("Error", "error"),
    ("RequestId", "requestId"),
    ("Timestamp", "timestamp"),
]

_WIRE_KEYS = {w for w, _ in SDK_TO_WIRE}
_SDK_KEYS = {s for _, s in SDK_TO_WIRE}

# 只有这些键不足以构成一个 ACP 帧。
# 实测依据：①全部录制件里 100% 的帧都带 Jsonrpc；②真实链路上 PromptAgentSession
# 只回一个 {"RequestId":"…"} 的 POP 层回执就关流。早先只要命中任意已知键就当帧，
# 于是那个回执被当成帧、还被 requestIdOf 当成本轮 rid——拿它过滤历史必然一无所获。
POP_ONLY_KEYS = {"RequestId", "requestId", "Timestamp", "timestamp", "Id", "id"}


def unwrap_envelope(value: Any) -> Any:
    """剥掉录制件外层的 data 信封。

    fixture 是抓的原始 SSE，每行形如 {"data":{…帧…}}；而 SDK 的 *WithSSE() yield
    出来的 resp.body 已经是剥好壳的帧。这个函数让两条路径收敛成同一个形状。
    """
    if is_object(value):
        keys = list(value.keys())
        if len(keys) == 1 and keys[0] == "data":
            return value["data"]
    return value


def frame_from_sdk_body(body: Any) -> Frame | None:
    """SDK 响应体 → 线格式帧。返回 None 表示"这不是一个帧"。"""
    inner = unwrap_envelope(body)
    if not is_object(inner):
        return None

    frame: Frame = {}
    acp_keys = 0
    for wire, sdk in SDK_TO_WIRE:
        if wire in inner:
            frame[wire] = inner[wire]
            if wire not in POP_ONLY_KEYS:
                acp_keys += 1
        elif sdk in inner:
            frame[wire] = inner[sdk]
            if wire not in POP_ONLY_KEYS:
                acp_keys += 1
    # 一个 ACP 层键都没有 ⇒ 不是帧。两种成因：只有 RequestId 的 POP 回执；
    # 或载荷外还有一层信封被 cast 反解后字段全丢。两种都必须显式失败。
    if acp_keys == 0:
        return None

    for key, value in inner.items():
        if key in _WIRE_KEYS or key in _SDK_KEYS or key in frame:
            continue
        frame[key] = value
    return frame


def pop_ack_request_id(body: Any) -> str | None:
    """从"只有 POP 回执"的载荷里把 RequestId 捞出来。

    它不是 rid（不能用来过滤历史），但在零帧场景下是唯一还能拿去查这次调用的线索。
    """
    inner = unwrap_envelope(body)
    if not is_object(inner):
        return None
    value = inner.get("RequestId", inner.get("requestId"))
    return value if isinstance(value, str) and value else None


def parse_recorded_line(line: str) -> Frame | None:
    """解析一行录制件（带信封）为帧；无法解析或不是对象时返回 None。"""
    trimmed = line.strip()
    if not trimmed:
        return None
    try:
        parsed = json.loads(trimmed)
    except (json.JSONDecodeError, ValueError):
        return None
    inner = unwrap_envelope(parsed)
    return inner if is_object(inner) else None


# ---------------------------------------------------------------------------
# 访问器（全部做运行时判断，不信任帧的形状）
# ---------------------------------------------------------------------------


def has_request_id(frame: Frame) -> bool:
    # 判据必须是**键是否存在**：实测 977 行的 load 回放里有 900 行压根没有这个键，
    # 而 "RequestId": "" 命中 0 行。用值的真假判断会得到完全错误的过滤结果。
    return "RequestId" in frame


def request_id_of(frame: Frame) -> str | None:
    if has_request_id(frame) and isinstance(frame["RequestId"], str):
        return frame["RequestId"]
    return None


def params_of(frame: Frame) -> dict[str, Any] | None:
    return frame["Params"] if is_object(frame.get("Params")) else None


def update_of(frame: Frame) -> dict[str, Any] | None:
    params = params_of(frame)
    update = params.get("update") if params else None
    return update if is_object(update) else None


def session_update_of(frame: Frame) -> str | None:
    update = update_of(frame)
    if update is None:
        return None
    kind = update.get("sessionUpdate")
    return kind if isinstance(kind, str) else None


def offset_of(frame: Frame) -> int | None:
    meta = params_of(frame)
    meta = meta.get("_meta") if meta else None
    if is_object(meta):
        offset = meta.get("offset")
        if isinstance(offset, int) and not isinstance(offset, bool):
            return offset
    return None


def timestamp_of(frame: Frame) -> int | None:
    value = frame.get("Timestamp")
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def session_id_of(frame: Frame) -> str | None:
    params = params_of(frame)
    value = params.get("sessionId") if params else None
    return value if isinstance(value, str) else None


def error_of(frame: Frame) -> dict[str, Any] | None:
    return frame["Error"] if is_object(frame.get("Error")) else None


def terminal_of(frame: Frame) -> dict[str, Any] | None:
    """轮次终态。只看顶层 Result.stopReason——服务端状态字段问不出运行态（恒 RELEASED）。

    `Result:{}`（有响应壳但没有 stopReason）**不算终态**：把它当终态会让静默截断
    被报成"本轮正常结束"。判不出终态时上层归 stream_break。
    """
    result = frame.get("Result")
    if not is_object(result):
        return None
    raw = result.get("stopReason")
    if not isinstance(raw, str) or raw == "":
        return None
    return {"stopReason": raw if raw in STOP_REASONS else None, "rawStopReason": raw}


def text_of(update: dict[str, Any] | None) -> str:
    """取文本内容，同时处理两种真实形状。

    直接读 content.text 在 tool_call_update 完成帧上会得到空串——那一帧的 content
    是数组，文本在 content[0].content.text（双层嵌套）。
    """
    content = update.get("content") if update else None
    if isinstance(content, str):
        return content
    if is_object(content):
        text = content.get("text")
        return text if isinstance(text, str) else ""
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
                continue
            if is_object(item):
                nested = item.get("content") if is_object(item.get("content")) else item
                text = nested.get("text") if is_object(nested) else None
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return ""


def tool_result_text(update: dict[str, Any] | None) -> str | None:
    """工具执行结果文本：优先双层嵌套 content[0].content.text，退同级 rawOutput。"""
    from_content = text_of(update)
    if from_content:
        return from_content
    raw = update.get("rawOutput") if update else None
    if isinstance(raw, str) and raw:
        return raw
    if is_object(raw) and isinstance(raw.get("text"), str) and raw["text"]:
        return raw["text"]
    return None


def token_usage_of(update: dict[str, Any] | None) -> dict[str, Any] | None:
    meta = update.get("_meta") if update else None
    usage = meta.get("usage") if is_object(meta) else None
    return usage if is_object(usage) else None


def tool_name_of(update: dict[str, Any] | None) -> str | None:
    meta = update.get("_meta") if update else None
    name = meta.get("toolName") if is_object(meta) else None
    return name if isinstance(name, str) and name else None


def locations_of(update: dict[str, Any] | None) -> list[str]:
    """工具操作的对象位置。全部录制件里这个键恒为空数组；宽松解析，上游填上就直接显示。"""
    raw = update.get("locations") if update else None
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        if isinstance(item, str):
            if item:
                out.append(item)
            continue
        if not is_object(item):
            continue
        for key in ("path", "pathname", "uri", "name"):
            value = item.get(key)
            if isinstance(value, str) and value:
                out.append(value)
                break
    return out


# ---------------------------------------------------------------------------
# 人卡交互（permission_request / permission_resolved）
# ---------------------------------------------------------------------------


def pending_interaction_of(frame: Frame) -> dict[str, Any] | None:
    """从 _qwen/notify 帧里解析人卡请求；不是权限请求帧时返回 None。

    【LIVE 09-17】实测协议：两类交互走同一个通知通道——_qwen/notify 帧、
    Params.kind='permission_request'、Params.data.requestId 是回覆要用的 permissionRequestId：
      · 工具授权：data.options[] 是 ACP 标准选项（optionId 如 proceed_once/proceed_always/cancel）；
      · ask_user_question：data.toolCall._meta.qwenInteractionKind='user_question'，
        问题与选项在 qwenQuestions[]/rawInput.questions[]（没有 optionId）——回覆走 answers。
    """
    params = params_of(frame)
    if not params or params.get("kind") != "permission_request":
        return None
    data = params.get("data") if is_object(params.get("data")) else None
    request_id = data.get("requestId") if data else None
    if not isinstance(request_id, str) or not request_id:
        return None

    tool_call = data.get("toolCall") if data and is_object(data.get("toolCall")) else None
    meta = tool_call.get("_meta") if tool_call and is_object(tool_call.get("_meta")) else None
    tool_name = meta.get("toolName") if meta and isinstance(meta.get("toolName"), str) else None
    interaction_kind = (
        "user_question"
        if meta and meta.get("qwenInteractionKind") == "user_question"
        else "permission"
    )

    questions: list[dict[str, Any]] = []
    raw_questions = None
    if tool_call and is_object(tool_call.get("rawInput")) and isinstance(tool_call["rawInput"].get("questions"), list):
        raw_questions = tool_call["rawInput"]["questions"]
    elif meta and isinstance(meta.get("qwenQuestions"), list):
        raw_questions = meta["qwenQuestions"]
    if raw_questions:
        for q in raw_questions:
            if not is_object(q) or not isinstance(q.get("question"), str):
                continue
            opts: list[dict[str, Any]] = []
            if isinstance(q.get("options"), list):
                for o in q["options"]:
                    if is_object(o) and isinstance(o.get("label"), str):
                        opts.append(
                            {
                                "label": o["label"],
                                **({"description": o["description"]} if isinstance(o.get("description"), str) else {}),
                            }
                        )
            questions.append(
                {
                    "question": q["question"],
                    **({"header": q["header"]} if isinstance(q.get("header"), str) else {}),
                    "options": opts,
                }
            )

    options: list[dict[str, Any]] = []
    if data and isinstance(data.get("options"), list):
        for o in data["options"]:
            if is_object(o) and isinstance(o.get("optionId"), str) and o["optionId"]:
                options.append(
                    {
                        "optionId": o["optionId"],
                        **({"name": o["name"]} if isinstance(o.get("name"), str) else {}),
                        **({"kind": o["kind"]} if isinstance(o.get("kind"), str) else {}),
                    }
                )

    return {
        "requestId": request_id,
        "sessionId": data.get("sessionId") if data and isinstance(data.get("sessionId"), str) else None,
        "toolName": tool_name,
        "interactionKind": interaction_kind,
        "toolCallTitle": tool_call.get("title") if tool_call and isinstance(tool_call.get("title"), str) else None,
        "toolCallId": tool_call.get("toolCallId") if tool_call and isinstance(tool_call.get("toolCallId"), str) else None,
        "questions": questions,
        "options": options,
    }


def permission_resolved_of(frame: Frame) -> dict[str, str] | None:
    """permission_resolved 通知：daemon 确认某个人卡交互已被回覆（回执在原流上）。"""
    params = params_of(frame)
    if not params or params.get("kind") != "permission_resolved":
        return None
    data = params.get("data") if is_object(params.get("data")) else None
    request_id = data.get("requestId") if data else None
    return {"requestId": request_id} if isinstance(request_id, str) and request_id else None
