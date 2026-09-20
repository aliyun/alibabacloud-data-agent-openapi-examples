"""错误归一化：与 Node 实现的 shared/errors.ts 同源同语义。

贯穿全仓的约定：上游业务错误恒以 HTTP 200 返回，真正的错误在响应体的
`JsonRpcResponse.Error` 里；而非 2xx 只在传输/鉴权/限流时出现。
所以前端拿到的永远是分好类的 ApiError，不再自己看状态码或 code 猜。
"""

from __future__ import annotations

import re

from dataclasses import dataclass, field, replace
from typing import Any

from .constants import CONCURRENT_REJECTED_TEXT, ERROR_KINDS, UPSTREAM_STATUS_GHOST

STREAM_ENDED_TEXT = "session stream ended without turn terminal"
PROMPT_NOT_DISPATCHED_TEXT = "prompt accepted but never dispatched to an executor"


@dataclass(frozen=True)
class ApiError:
    """归一化后的错误。前端只按 kind 分支，不自己看状态码或 code 猜。"""

    kind: str
    message: str
    code: int | None = None
    errorCode: str | None = None  # noqa: N815 — 线格式键名，保持与 Node 侧一致
    retryable: bool = False
    fatalForSession: bool = False
    upstreamStatus: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "code": self.code,
            "errorCode": self.errorCode,
            "message": self.message,
            "retryable": self.retryable,
            "fatalForSession": self.fatalForSession,
            "upstreamStatus": self.upstreamStatus,
        }


# 每种 kind 的重试语义。断流一律不可原样重试：重发等于把同一个写操作执行两遍。
RETRY_POLICY: dict[str, dict[str, bool]] = {
    "stream_break": {"retryable": False, "fatalForSession": False},
    # retryable=false 的理由不是"怕重复写入"（实测这一轮压根没落地），
    # 而是原样重发只会再得到一次同样的 POP 回执：5/5 次实测同形，没有信息增量。
    "prompt_not_dispatched": {"retryable": False, "fatalForSession": False},
    "session_ghost": {"retryable": False, "fatalForSession": True},
    "concurrent_rejected": {"retryable": True, "fatalForSession": False},
    "rpc_error": {"retryable": False, "fatalForSession": False},
    "transport": {"retryable": True, "fatalForSession": False},
    "create_empty_body": {"retryable": False, "fatalForSession": False},
}

# 面向用户的文案，按 kind 一处定义（与 Node 侧 shared/errors.ts 同文）。
ERROR_COPY: dict[str, dict[str, str]] = {
    "stream_break": {
        "title": "回复通道已中断，任务可能仍在服务端执行",
        "detail": (
            "实测 SSE 连接在 218~258 秒之间会被掐断，断流只关掉回复通道，不会停掉正在跑的任务。"
            "这里不会自动重发——重发会让同一个写操作执行两遍。可以先探测这一轮是否已经完成，或直接拉取历史接管结果。"
        ),
        "tone": "amber",
    },
    "prompt_not_dispatched": {
        "title": "上游收下了这一轮，但没有派发给执行端",
        "detail": (
            "SSE 只回了一个 POP 层回执（一个 RequestId）就在 1 秒内关流，整轮没有收到任何 ACP 内容帧。"
            "实测这种形态下 LoadAgentSession 回看，历史里只有一个 end_turn 空轮次：没有你这句话的回显，也没有任何回答。"
            "这与「断流」恰好相反——断流是任务可能还在跑，这里是根本没开始，所以别去探测是否完成。"
            "稳妥的顺序是：先拉取历史确认这一轮确实没留下内容，确认之后再重发（重发是写操作，本工程不会自动做）。"
            "已排除的调用方因素：换 wire 形状、换 User-Agent、换会话、甚至用一个不存在的 SessionId，响应逐字相同。"
        ),
        "tone": "amber",
    },
    "session_ghost": {
        "title": "该会话已失效",
        "detail": "这个会话在服务端已经不能再用（上游返回 422，通常 1 秒内就回一帧错误）。唯一可行的动作是新建会话。",
        "tone": "red",
    },
    "concurrent_rejected": {
        "title": "上一轮还没结束",
        "detail": "同一个会话同时只能跑一轮，第二次请求会被服务端直接拒绝。等上一轮出终态之后再发即可。",
        "tone": "muted",
    },
    "rpc_error": {
        "title": "接口返回错误",
        "detail": "业务错误也是以 HTTP 200 返回的，真正的错误在响应体的 JsonRpcResponse.Error 里。",
        "tone": "red",
    },
    "transport": {
        "title": "连不上后端或上游",
        "detail": "先确认后端进程在跑，再检查 .env 里的 region 与凭证。",
        "tone": "red",
    },
    "create_empty_body": {
        "title": "建会话返回了空响应体",
        "detail": (
            "HTTP 200 但响应体是空的，拿不到 SessionId。实测最常见的原因是账号下没有运行中的 DataWorks 实例，"
            "或者该账号需要 RESOURCE_GROUP_ID 而没配。注意：ResourceGroupId 填了也不校验有效性。"
        ),
        "tone": "amber",
    },
}


def api_error(kind: str, message: str, **input: Any) -> ApiError:
    """手工造一个归一化错误（重试语义仍由 kind 决定，不由调用方拍脑袋给）。"""
    if kind not in ERROR_KINDS:
        raise ValueError(f"未知错误 kind：{kind}")
    return _build(kind, {"message": message, **input}, message)


def _build(kind: str, input_: dict[str, Any], message: str) -> ApiError:
    policy = RETRY_POLICY[kind]
    return ApiError(
        kind=kind,
        code=input_.get("code"),
        errorCode=input_.get("errorCode"),
        message=message,
        retryable=policy["retryable"],
        fatalForSession=policy["fatalForSession"],
        upstreamStatus=input_.get("upstreamStatus"),
    )


def classify_error(
    message: str | None = None,
    code: int | None = None,
    errorCode: str | None = None,  # noqa: N803
    upstreamStatus: int | None = None,  # noqa: N803
) -> ApiError:
    """把帧内 / JsonRpcResponse 里的 Error 分成六类。

    不能只看 code：实测断流、会话幽灵化、并发被拒三种处境的 code **全是 -32603**，
    只有 message 文本能区分。三条形态都来自真实抓包（见 shared/errors.ts 的注释）。
    """
    input_ = {"code": code, "errorCode": errorCode, "upstreamStatus": upstreamStatus}
    msg = message or ""

    if upstreamStatus == UPSTREAM_STATUS_GHOST or f"upstream_status={UPSTREAM_STATUS_GHOST}" in msg:
        return _build("session_ghost", input_, msg or "upstream returned 422")
    if CONCURRENT_REJECTED_TEXT in msg:
        return _build("concurrent_rejected", input_, msg)
    if STREAM_ENDED_TEXT in msg:
        return _build("stream_break", input_, msg)
    return _build("rpc_error", input_, msg or "upstream returned an error without message")


def stream_break_without_terminal(frame_count: int) -> ApiError:
    """流式生成器正常结束、却从头到尾没出现过 Result.stopReason ⇒ 必须算断流而不是成功。"""
    return _build(
        "stream_break",
        {"message": STREAM_ENDED_TEXT},
        f"{STREAM_ENDED_TEXT} (received {frame_count} frames, no Result.stopReason)",
    )


def prompt_not_dispatched(pop_request_id: str | None = None, elapsed_ms: int | None = None) -> ApiError:
    """整轮**一个 ACP 内容帧都没收到**：上游只回了 POP 层回执（或什么都没回）就关流。"""
    clues = "，".join(
        [
            f"{elapsed_ms}ms" if elapsed_ms is not None else None,
            f"POP RequestId {pop_request_id}" if pop_request_id else "上游未给出 RequestId",
        ]
    )
    return _build(
        "prompt_not_dispatched",
        {"message": PROMPT_NOT_DISPATCHED_TEXT},
        f"{PROMPT_NOT_DISPATCHED_TEXT}（{clues}）。整轮没有收到任何 ACP 帧，也没有 Result.stopReason。",
    )


def transport_error(message: str, upstream_status: int | None = None) -> ApiError:
    return _build("transport", {"message": message, "upstreamStatus": upstream_status}, message)


def create_empty_body_error(detail: str | None = None) -> ApiError:
    detail = detail or "empty response body"
    return _build("create_empty_body", {"message": detail}, detail)


def redact_api_error(error: ApiError) -> ApiError:
    """上游鉴权类报文会把调用方的 AccessKeyId 原文回显，统一在这里脱敏。

    保留 "Deny … | source ip" 的语义不变，只把 AK 本身换掉——
    那条信息正是判断"是否被身份级安全管控拦下"的依据，不能一起抹掉。
    """
    message = re.sub(r"(?:LTAI|STS\.)[A-Za-z0-9]+", "<AccessKeyId 已隐去>", error.message)
    return replace(error, message=message) if message != error.message else error


# 帧内错误路径（pipeline）与异常路径（normalize）都要过脱敏：少过一条，AK 就漏进前端。
def classify_frame_error(error: dict[str, Any]) -> ApiError:
    """帧内 Error（dict 形状）→ ApiError，已内置脱敏。"""
    code = error.get("code") if isinstance(error.get("code"), int) else None
    err_code = error.get("errorCode") if isinstance(error.get("errorCode"), str) else None
    msg = error.get("message") if isinstance(error.get("message"), str) else None
    return redact_api_error(classify_error(message=msg, code=code, errorCode=err_code))


def with_api_name(error: ApiError, api_name: str) -> ApiError:
    return error if api_name in error.message else replace(error, message=f"{api_name}: {error.message}")
