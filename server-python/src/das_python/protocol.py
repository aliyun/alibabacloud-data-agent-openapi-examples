"""前后端之间的流式 wire 协议：NDJSON，一行一个 JSON 对象。

为什么不用 SSE：前端无论如何都要手解（EventSource 不支持 POST body），SSE 的
`data:` 转义是纯负担；更关键的是 SSE 的 `id:`/`Last-Event-ID` 语义**暗示可以断点续传**，
而 BeginLogOffset 实测是死参数、服务端根本没有增量续传——用 SSE 等于在协议层撒谎。

帧一律**原样透传**（body 就是上游那一帧，不重塑、不改名），这样 wire 形状与录制
fixture 同形，live 与 mock 才能共用同一个 reducer。后端唯一加工的地方是错误归一化。
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, is_dataclass
from typing import Any

WIRE_CONTENT_TYPE = "application/x-ndjson"


@dataclass
class WireMeta:
    """流的第一条：告诉前端这一轮的 rid 与校验码。"""

    rid: str
    sessionId: str
    mock: bool
    startedAt: int
    type: str = "meta"


@dataclass
class WireFrame:
    """帧原样透传：body 就是上游那一帧。offset 可能缺失，绝不持久化。"""

    rid: str
    offset: int | None
    body: dict[str, Any]
    type: str = "frame"


@dataclass
class WireHeartbeat:
    """心跳：防中间层空闲回收连接，同时给前端一个判活信号（存活判定不能挂在 rAF 上）。"""

    t: int
    type: str = "hb"


@dataclass
class WireError:
    rid: str
    error: dict[str, Any]
    type: str = "error"


@dataclass
class WireDone:
    """流最后一条。stopReason 为空表示上游给了 Result 但原因不认识。"""

    rid: str
    stopReason: str | None
    rawStopReason: str | None
    frameCount: int
    type: str = "done"


WireEvent = WireMeta | WireFrame | WireHeartbeat | WireError | WireDone


def serialize(event: WireEvent) -> str:
    """事件 → 一行 NDJSON（不含换行符）。

    与 Node 的 JSON.stringify 字节级对齐：undefined 字段被省略而不是输出 null
    （比如未拿到 offset 的 WireFrame 没有 offset 键、终态未知的 done 没有 stopReason 键）。
    只剥事件顶层的 None；body（上游帧原样透传）里的 null 是上游数据，照常输出。
    """
    raw = asdict(event) if is_dataclass(event) else event
    data = {k: v for k, v in raw.items() if v is not None}
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


def parse_wire_line(line: str) -> dict[str, Any] | None:
    """解析一行 wire 数据；不是合法对象或 type 不认识时返回 None。"""
    trimmed = line.strip()
    if not trimmed:
        return None
    try:
        value = json.loads(trimmed)
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(value, dict):
        return None
    if value.get("type") not in ("meta", "frame", "hb", "error", "done"):
        return None
    return value
