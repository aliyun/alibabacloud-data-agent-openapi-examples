"""会话注册表：始终以 OpenAPI 返回的真实 sessionId 为身份。"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from ..config import AppConfig
from ..live import LiveContext, _list_sessions_result
from ..marker import strip_marker_instruction
from ..mock_fixtures import mock_sessions
from .journal import SessionJournal

WORKSPACE_CWD = "/data-agent"


def _iso(ms: Any) -> str:
    ms = ms if isinstance(ms, (int, float)) else 0
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms / 1000)) + f".{int(ms % 1000):03d}Z"


@dataclass
class SessionRecord:
    """上游真实 SessionId——一切上游调用都用它。"""

    real_id: str
    # daemon 分配的客户端身份：create/load 响应里回显（session.clientId），客户端发
    # prompt 时经 X-Qwen-Client-Id 带回——我们再盖上 user 回显事件的 originatorClientId，
    # web-shell 的 suppressOwnUserEcho 靠它精确匹配抑制自己的回显。
    client_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    journal: SessionJournal = field(default_factory=SessionJournal)
    # 在途 permission 请求：requestId → permission_request 的事件本体。
    # 用户点卡时 /session/:id/permission/:requestId 共享这份状态；回覆成功或上游 resolved 时删除。
    pending_permissions: dict[str, dict[str, Any]] = field(default_factory=dict)
    # rename 覆盖（进程级：上游没有改名接口，SessionTitle 恒为首条 prompt 原文）。
    display_name: str | None = None
    archived: bool = False
    # 本地删除标记（上游没有删除接口，只能挡住列表展示，进程级）。
    deleted: bool = False
    created_at: int = field(default_factory=lambda: int(time.time() * 1000))
    # 最近一次列表拉取缓存的上游摘要（createdAt / 标题等真实值），单会话 lookup 兜底用。
    cached_summary: dict[str, Any] | None = None


StandaloneSummary = dict[str, Any]


class SessionRegistry:
    def __init__(self) -> None:
        self._by_key: dict[str, SessionRecord] = {}
        # 记录集合，用于统计与本地元数据视图。
        self._records: list[SessionRecord] = []

    def resolve(self, session_id: str) -> SessionRecord | None:
        return self._by_key.get(session_id.lower())

    def ensure(self, real_id: str) -> SessionRecord:
        key = real_id.lower()
        record = self._by_key.get(key)
        if record is None:
            record = SessionRecord(real_id=real_id)
            self._by_key[key] = record
            self._records.append(record)
        return record

    def all_records(self) -> list[SessionRecord]:
        return list(self._records)

    def stats(self) -> dict[str, int]:
        active = sum(1 for r in self._records if r.journal.active_prompt)
        return {"sessions": len(self._records), "activePrompts": active}

    # ------------------------------------------------------------------
    # 会话摘要（web-shell 语义下的 standalone summary）
    # ------------------------------------------------------------------

    async def list_summaries(self, cfg: AppConfig, live: LiveContext | None) -> list[StandaloneSummary]:
        """会话摘要列表（侧栏数据源）。上游失败时返回空列表——空侧栏比 500 诚实。"""
        if live:
            try:
                base = (await _list_sessions_result(live))["sessions"]
            except Exception:  # noqa: BLE001
                return []
        else:
            base = mock_sessions(cfg.sessionSource)["sessions"]

        out: list[StandaloneSummary] = []
        for summary in base:
            record = self.resolve(summary["sessionId"])
            if record is not None and (record.deleted or record.archived):
                continue
            standalone = self._to_standalone(summary, record)
            if record is not None:
                record.cached_summary = standalone
            out.append(standalone)
        return out

    def _to_standalone(self, summary: dict[str, Any], record: SessionRecord | None) -> StandaloneSummary:
        """web-shell 会话摘要：必填字段钉死在 SDK 的 parseStandaloneSummary 校验器上。"""
        title = strip_marker_instruction(summary.get("title") or "")
        out: StandaloneSummary = {
            "sessionId": summary["sessionId"],
            "workspaceCwd": WORKSPACE_CWD,
            "createdAt": _iso(summary.get("createdAt")),
            "updatedAt": _iso(summary.get("updatedAt")),
            "displayName": record.display_name
            if record is not None and record.display_name
            else (title or str(summary["sessionId"])[:8]),
            "clientCount": 0,
            "hasActivePrompt": record.journal.active_prompt if record is not None else False,
            "isWaitingForPermission": False,
            "sourceType": "standalone",
            "context": {"kind": "standalone"},
        }
        if summary.get("mockScenario") is not None:
            out["mockScenario"] = summary["mockScenario"]
        return out

    def archived_summaries(self) -> list[StandaloneSummary]:
        """归档视图（`?archiveState=archived`）：注册表里 archived 且未删除的记录。"""
        out: list[StandaloneSummary] = []
        for record in self._records:
            if not record.archived or record.deleted:
                continue
            out.append(self.summary_for(record, record.real_id))
        return out

    def summary_for(self, record: SessionRecord, client_facing_id: str) -> StandaloneSummary:
        """单会话 lookup（GET /standalone/sessions/:id）：优先列表缓存，没有就最小可用形状。"""
        cached = record.cached_summary
        if cached:
            out = dict(cached)
            out["sessionId"] = client_facing_id
            out["displayName"] = record.display_name or cached["displayName"]
            out["hasActivePrompt"] = record.journal.active_prompt
            return out
        return {
            "sessionId": client_facing_id,
            "workspaceCwd": WORKSPACE_CWD,
            "createdAt": _iso(record.created_at),
            "updatedAt": _iso(record.created_at),
            "displayName": record.display_name or client_facing_id[:8],
            "clientCount": 0,
            "hasActivePrompt": record.journal.active_prompt,
            "isWaitingForPermission": False,
            "sourceType": "standalone",
            "context": {"kind": "standalone"},
        }


def rebuild_pending_permissions(record: SessionRecord) -> None:
    """**重启/置换场景**：用 journal 里的事件量重新看清 `pending_permissions`。

    后端重启后 journal 丢光，pending_permissions 自然也丢。用户重开会话时 load 会把
    上游历史播种回来——里面可能含着**仍然待解答**的 permission_request。
    不重建的话，那张卡的 DOM requestId 会向一个空表回应 → 404「无法 response」。
    重建规则：按 requestId 配对，permission_request 加，permission_resolved 减。
    """
    record.pending_permissions.clear()
    for entry in record.journal.all():
        ev = entry.event
        type_ = ev.get("type")
        data = ev.get("data") or {}
        request_id = data.get("requestId")
        if not isinstance(request_id, str):
            continue
        if type_ == "permission_request":
            record.pending_permissions[request_id] = ev
        elif type_ in ("permission_resolved", "permission_already_resolved"):
            record.pending_permissions.pop(request_id, None)
