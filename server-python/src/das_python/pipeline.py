"""上游帧流 → wire 事件流。与 Node 实现的 server-node/pipeline.ts 同源同语义。

**live 与 mock 共用这一个函数**，这是"mock 下验收通过"能推广到真实链路的前提。

三条硬规则：
 1. 帧原样透传（body 就是上游那一帧，不重塑、不改名）；后端唯一的加工是错误归一化。
 2. 带 Error 的帧既当普通帧透传（前端 reducer 会记下它），又额外产出一条归一化的
    error 事件（UI 文案按 kind 走）。两者不冲突：FrameError 与 ApiError 形状不同。
 3. 生成器结束却从未出现 Result.stopReason ⇒ **不发 done**，按收到过几帧分两种收尾：
    有帧归 stream_break（任务可能还在跑），零帧归 prompt_not_dispatched（根本没开始）。
    静默截断当成成功，用户会以为那段回答是完整的。
"""

from __future__ import annotations

import time
from collections.abc import AsyncGenerator, AsyncIterator
from typing import Any

from .errors import (
    ApiError,
    classify_frame_error,
    prompt_not_dispatched,
    redact_api_error,
    stream_break_without_terminal,
)
from .frames import error_of, offset_of, request_id_of, terminal_of
from .normalize import SdkError, to_api_error


class PipelineInput:
    def __init__(
        self,
        frames: AsyncIterator[dict[str, Any]],
        sessionId: str,  # noqa: N803
        mock: bool,
        startedAt: int,  # noqa: N803
        apiName: str | None = None,  # noqa: N803
        popRequestIds: list[str] | None = None,  # noqa: N803
    ) -> None:
        self.frames = frames
        self.sessionId = sessionId
        self.mock = mock
        self.startedAt = startedAt
        self.apiName = apiName
        # 由帧源填充：上游只回 POP 回执、一个 ACP 帧都没给时，这里是那些回执的 RequestId。
        # 零帧场景下 rid 无从得知，这个值是用户唯一还能拿去查这次调用的线索。
        self.popRequestIds = popRequestIds


async def to_wire_events(input_: PipelineInput) -> AsyncGenerator[dict[str, Any], None]:
    rid: str | None = None
    meta_sent = False
    frame_count = 0
    terminal: dict[str, Any] | None = None
    error_sent = False

    try:
        async for frame in input_.frames:
            frame_count += 1

            if not meta_sent:
                if rid is None:
                    rid = request_id_of(frame)
                if rid is not None:
                    meta_sent = True
                    yield {
                        "type": "meta",
                        "rid": rid,
                        "sessionId": input_.sessionId,
                        "mock": input_.mock,
                        "startedAt": input_.startedAt,
                    }

            yield {"type": "frame", "rid": rid or "", "offset": offset_of(frame), "body": frame}

            frame_error = error_of(frame)
            if frame_error and not error_sent:
                error_sent = True
                # 这一条也要过脱敏：上游鉴权类报文会把调用方的 AccessKeyId 原文回显出来，
                # 而 wire 事件是要渲染进前端的。异常路径在 toApiError 里已内置，帧内路径在这里。
                yield {"type": "error", "rid": rid or "", "error": redact_api_error(classify_frame_error(frame_error)).to_dict()}

            terminal = terminal if terminal is not None else terminal_of(frame)
    except SdkError as err:
        # 帧源在迭代中途抛 SdkError（LIVE 下：鉴权失败、422 幽灵化、socket 被掐）。
        # 必须在这里捕获：走到这一步响应已经进入流式传输，异常再往上抛没有任何人能
        # 把它翻译成前端看得懂的东西。归一成一条 error 事件后直接结束。
        if not error_sent:
            yield {"type": "error", "rid": rid or "", "error": to_api_error(err, input_.apiName or "upstream").to_dict()}
        return
    except Exception as err:  # noqa: BLE001
        if not error_sent:
            api_err: ApiError = to_api_error(
                err if isinstance(err, Exception) else RuntimeError(str(err)), input_.apiName or "upstream"
            )
            yield {"type": "error", "rid": rid or "", "error": api_err.to_dict()}
        return

    if terminal and not error_sent:
        yield {
            "type": "done",
            "rid": rid or "",
            "stopReason": terminal["stopReason"],
            "rawStopReason": terminal["rawStopReason"],
            "frameCount": frame_count,
        }
        return

    if not error_sent:
        # 两种"没有终态"必须分开，处置完全相反：
        #  · 收到过帧 ⇒ 断流，任务很可能还在服务端跑，动作是探测/拉历史接管，绝不重发；
        #  · 一帧都没收到 ⇒ 上游收下了请求却没派发给执行端，任务**根本没开始**。
        error = (
            prompt_not_dispatched((input_.popRequestIds or [None])[0], int(time.time() * 1000) - input_.startedAt)
            if frame_count == 0
            else stream_break_without_terminal(frame_count)
        )
        yield {"type": "error", "rid": rid or "", "error": error.to_dict()}
