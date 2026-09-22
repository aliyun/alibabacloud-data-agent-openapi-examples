"""MOCK 模式的数据源：`server-node/test/fixtures/` 下的样例帧流。

单测读的是同一批文件，所以"mock 下能跑通"与"单测绿"指向同一份数据，
不会出现两套真相。与 Node 实现的 server-node/mock/fixtures.ts 同源同语义。
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from .constants import DEFAULT_SESSION_SOURCE
from .frames import parse_recorded_line

# fixtures 在 Node server 的测试目录里（同一仓库、同一份数据，不复制第二份）。
FIXTURE_DIR = Path(__file__).resolve().parents[3] / "server-node" / "test" / "fixtures"


def read_fixture_frames(name: str) -> list[dict[str, Any]]:
    raw = (FIXTURE_DIR / name).read_text(encoding="utf8")
    frames: list[dict[str, Any]] = []
    for line in raw.split("\n"):
        if not line.strip():
            continue
        frame = parse_recorded_line(line)
        if frame is None:
            raise ValueError(f"fixture {name} 有一行解析不出帧")
        frames.append(frame)
    return frames


def read_fixture_result(name: str) -> dict[str, Any]:
    """非流式录制件：形如 {JsonRpcResponse:{Result:{…}}, RequestId:'…'}。"""
    envelope = read_fixture_envelope(name)
    if envelope["result"] is None:
        raise ValueError(f"fixture {name} 里没有 JsonRpcResponse.Result")
    return envelope["result"]


def read_fixture_envelope(name: str) -> dict[str, Any]:
    parsed = json.loads((FIXTURE_DIR / name).read_text(encoding="utf8"))
    rpc = parsed.get("JsonRpcResponse") or {}
    return {
        "result": rpc.get("Result"),
        "requestId": parsed.get("RequestId"),
        "error": rpc.get("Error"),
    }


class MockScenario:
    def __init__(
        self,
        sessionId: str,  # noqa: N803
        title: str,
        promptFixture: str | None,  # noqa: N803
        historyFixture: str | None,  # noqa: N803
        frameCount: int,  # noqa: N803
        teaches: str,
        createdAt: int,  # noqa: N803
        popAck: str | None = None,  # noqa: N803
        sourceOverride: str | None = None,  # noqa: N815
    ) -> None:
        self.sessionId = sessionId
        self.title = title
        self.promptFixture = promptFixture
        self.historyFixture = historyFixture
        self.popAck = popAck
        self.frameCount = frameCount
        self.teaches = teaches
        self.createdAt = createdAt
        self.sourceOverride = sourceOverride


_SHORT, _TOOLS, _LONG = "mock-short", "mock-tools", "mock-long"
_BREAK, _GHOST, _CONCURRENT, _ACK, _RENDER = (
    "mock-break",
    "mock-ghost",
    "mock-concurrent",
    "mock-ack-only",
    "mock-render",
)

# 八条演示会话：七条各对一份样例帧流（ack-only 那条没有，它演示的正是"零帧"），
# 一条是合成渲染样例（mock-render，非样例录制件）。
MOCK_SCENARIOS: list[MockScenario] = [
    MockScenario(
        sessionId=_SHORT,
        title="[MOCK] 短轮 · end_turn",
        promptFixture="prompt-short.jsonl",
        historyFixture="load-clean.jsonl",
        frameCount=22,
        teaches="最短闭环：一问一答、无工具调用、正常 end_turn",
        createdAt=1_789_026_610_000,
    ),
    MockScenario(
        # marker 注入已退役：标题不再带校验码说明。
        sessionId=_TOOLS,
        title="[MOCK] 工具轮 · 6 次调用",
        promptFixture="prompt-tools.jsonl",
        historyFixture="load-clean.jsonl",
        frameCount=392,
        teaches="工具状态机：6 次调用（5 completed + 1 failed）",
        createdAt=1_789_029_139_000,
    ),
    MockScenario(
        sessionId=_LONG,
        title="[MOCK] 多步分析 · 10 次调用",
        promptFixture="prompt-long.jsonl",
        historyFixture="load-polluted.jsonl",
        frameCount=901,
        teaches="多步分析；历史包含缺少 RequestId 的污染帧",
        createdAt=1_789_027_001_000,
    ),
    MockScenario(
        sessionId=_BREAK,
        title="[MOCK] 断流 · -32603",
        promptFixture="error-stream-break.jsonl",
        historyFixture="load-polluted.jsonl",
        frameCount=1201,
        teaches="SSE 断流：部分回复后收尾 -32603，任务可能仍在服务端跑",
        createdAt=1_788_787_752_000,
    ),
    MockScenario(
        sessionId=_GHOST,
        title="[MOCK] 会话幽灵化 · 422 · 单帧",
        promptFixture="error-session-ghost.jsonl",
        historyFixture=None,
        frameCount=1,
        teaches="会话失效：1s 内单帧 -32603 / 422，不能再发，只能新建",
        createdAt=1_788_790_920_000,
    ),
    MockScenario(
        sessionId=_CONCURRENT,
        title="[MOCK] 并发被拒 · 单帧",
        promptFixture="error-concurrent-rejected.jsonl",
        historyFixture="load-clean.jsonl",
        frameCount=1,
        teaches="同一会话同时只能跑一轮，第二次请求被服务端直接拒绝",
        createdAt=1_788_276_326_000,
    ),
    MockScenario(
        sessionId=_ACK,
        title="[MOCK] prompt 不派发 · 零帧 · 只有 POP 回执",
        promptFixture=None,  # 这一轮一个 ACP 帧都没有，上游只回了一个 POP 层回执就关流
        popAck="0dd3b146c75bf132a65efa7a3080e7cd",
        historyFixture=None,
        frameCount=0,
        teaches="prompt 根本没派发：只有 POP 回执、零帧；与断流不同，任务没在跑",
        createdAt=1_789_483_174_000,
    ),
    MockScenario(
        sessionId=_RENDER,
        title="[MOCK] 渲染覆盖 · 代码块 + mermaid（合成）",
        promptFixture="synthetic-render.jsonl",
        historyFixture="synthetic-render.jsonl",
        frameCount=4,
        teaches="合成样例：覆盖代码块高亮与 mermaid 图渲染（非样例录制件）",
        createdAt=1_789_500_000_000,
    ),
    # 人卡交互（合成）：权限/ask_user_question 弹卡与回覆。
    MockScenario(
        sessionId="mock-permission",
        title="[MOCK] 人卡交互 · 弹卡 + 回覆",
        promptFixture="prompt-permission.jsonl",
        historyFixture="load-clean.jsonl",
        frameCount=3,
        teaches="权限/ask_user_question 弹卡出现，回覆后卡片消失",
        createdAt=1_789_600_000_000,
    ),
]

# 两条"别的来源"的会话，用于证明 SessionSource 过滤真的生效。
_OTHER_SOURCE = "recorded-somewhere-else"
_OTHER_SOURCE_SCENARIOS = [
    MockScenario(
        sessionId="mock-other-source-1",
        title="[MOCK] 别的来源 · 应被过滤掉",
        promptFixture="prompt-short.jsonl",
        historyFixture=None,
        frameCount=22,
        teaches="这条不该出现在列表里。",
        createdAt=1_788_313_631_000,
        sourceOverride=_OTHER_SOURCE,
    ),
    MockScenario(
        sessionId="mock-other-source-2",
        title="[MOCK] 别的来源 · 也应被过滤掉",
        promptFixture="prompt-short.jsonl",
        historyFixture=None,
        frameCount=22,
        teaches="这条也不该出现在列表里。",
        createdAt=1_788_313_630_000,
        sourceOverride=_OTHER_SOURCE,
    ),
]

# MOCK 模式下"新建会话"登记在这里（进程级，重启即清空）。
_created_scenarios: list[MockScenario] = []


def find_scenario(session_id: str) -> MockScenario | None:
    for s in [*_created_scenarios, *MOCK_SCENARIOS]:
        if s.sessionId == session_id:
            return s
    return None


def mock_sessions(session_source: str) -> dict[str, Any]:
    """MOCK 模式的会话列表。

    上游字段一律照真实形状给（SessionStatus 恒 RELEASED、UpdatedAt===CreatedAt），
    因为这两个"没用的字段"本身就是要教的内容：运行态问不出来，只能靠前端流。
    """
    all_scenarios = [*_created_scenarios, *MOCK_SCENARIOS, *_OTHER_SOURCE_SCENARIOS]
    sessions = []
    for s in all_scenarios:
        source = s.sourceOverride or session_source
        sessions.append(
            {
                "sessionId": s.sessionId,
                "title": s.title,
                "createdAt": s.createdAt,
                "updatedAt": s.createdAt,
                "status": "RELEASED",
                "source": source,
                "tags": [] if s.sourceOverride else ["mock"],
                "mockScenario": s.teaches,
            }
        )
    kept = [s for s in sessions if s["source"] == session_source]
    return {
        "sessions": kept,
        "filteredOut": len(sessions) - len(kept),
        "total": len(sessions),
    }


def mock_create_session(title: str) -> dict[str, str]:
    """新建会话（MOCK）。成功判据与 live 完全一致：只有 SessionId 非空。"""
    session_id = f"{_SHORT}-{format(int(time.time() * 1000), 'x')}"
    _created_scenarios.insert(
        0,
        MockScenario(
            sessionId=session_id,
            # SessionTitle = 首条 prompt 原文（含注入的校验码说明），与 live 行为一致
            title=title,
            promptFixture="prompt-short.jsonl",
            historyFixture="load-clean.jsonl",
            frameCount=22,
            teaches="MOCK 下新建的会话，回放短轮样例（end_turn）。",
            createdAt=int(time.time() * 1000),
        ),
    )
    return {"sessionId": session_id}
