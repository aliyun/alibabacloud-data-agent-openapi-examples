"""真实上游调用。**所有 LIVE 路径都在这里，一处也不散到路由里**。

与 Node 实现的 server-node/live.ts 同源同语义。贯穿全文件的约定：
 1. 每个函数都自己 try/except 并返回 ApiResult，业务错误一律 HTTP 200 承载。
 2. 拿不到的东西就说拿不到，绝不编造。
"""

from __future__ import annotations

import inspect
import time
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import Any

from alibabacloud_dataworks_public20240518.client import Client as SdkClient
from alibabacloud_dataworks_public20240518 import models as sdk_models
from alibabacloud_tea_openapi.models import Config
from darabonba.policy.retry import RetryOptions as DaraRetryOptions
from darabonba.runtime import RuntimeOptions

from .config import AppConfig
from .constants import DEFAULT_READ_TIMEOUT_MS, HISTORY_READ_TIMEOUT_MS
from .errors import api_error, create_empty_body_error, redact_api_error
from .frames import frame_from_sdk_body, pop_ack_request_id
from .normalize import SdkError, lower_first_keys, missing_result_error, read_non_stream_body, to_api_error
from .rid import count_frames_for_rid
from .turn import reduce_history

JSONRPC_VERSION = "2.0"
MAX_PAGES = 10  # 列表分页的硬上限。上游没承诺页数收敛，不设上限等于把死循环留给线上。
PAGE_SIZE = 100

_rpc_id_counter = 0


def _next_rpc_id() -> str:
    """上游要求 Id 存在；它是 JSON-RPC 的请求标识，与 RequestId（rid）不是一回事。"""
    global _rpc_id_counter  # noqa: PLW0603
    _rpc_id_counter += 1
    return str(_rpc_id_counter)


@dataclass
class LiveContext:
    client: SdkClient
    cfg: AppConfig


# ---------------------------------------------------------------------------
# SDK client / RuntimeOptions
# ---------------------------------------------------------------------------


def create_sdk_client(cfg: AppConfig) -> SdkClient:
    """构造 SDK Client 的唯一入口。全工程只在这里 new 一次。

    三件必须写死的事（与 Node 版 sdk.ts 相同）：
      1. 凭证只从 cfg 来：不读 ~/.aliyun/config.json、不挂默认凭证链；
      2. endpoint 留空交给 SDK 按 regionId 推导（生产 region 成立）；
         预发/日常网关不在映射表里，必须 END_POINT 显式覆盖；
      3. 构造完立刻断言两个 SSE 变体存在（assert_sse_capable）。
    """
    if not cfg.accessKeyId or not cfg.accessKeySecret:
        raise SdkError(_transport_error("缺少 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET"))

    # Config 在 alibabacloud_tea_openapi.models（**不在**产品包的 models 里）；
    # RetryOptions 在 darabonba.policy.retry。写成 sdk_models.Config 会在
    # 启动期直接 AttributeError——MOCK 契约套件不构造 client，盖不住这个错。
    client = SdkClient(
        Config(
            access_key_id=cfg.accessKeyId,
            access_key_secret=cfg.accessKeySecret,
            region_id=cfg.regionId,
            # 留空时 SDK 按 regionId 走内置映射；非空时直接当 host，覆盖映射（预发/日常网关靠它）。
            endpoint=cfg.endpoint,
            connect_timeout=10_000,
            # **关掉重试的唯一有效开关在这里**：重试循环由 retry_options 驱动，
            # 显式写死 retryable:false，把"不重试"变成本工程自己的断言——
            # 否则 SDK 升级改了默认值，prompt（写操作）就会被重发。
            retry_options=DaraRetryOptions(retryable=False),
        )
    )
    assert_sse_capable(client)
    return client


def runtime_for(read_timeout_ms: int = DEFAULT_READ_TIMEOUT_MS) -> RuntimeOptions:
    """每次调用现造一个 RuntimeOptions。真正生效的是两个超时；autoretry/maxAttempts 是死字段。"""
    return RuntimeOptions(autoretry=False, max_attempts=1, read_timeout=read_timeout_ms, connect_timeout=10_000)


def assert_sse_capable(client: SdkClient) -> None:
    """启动即断言两个 SSE 变体存在。

    缺了它们的后果不是报错，而是**静默退化成整体 buffer**：长轮 7~220s 一帧也拿不到，
    最后必然超时。与其让用户对着"卡住不动"的界面猜，不如启动时把版本要求说清楚。
    """
    missing = [name for name in ("prompt_agent_session_with_sse", "load_agent_session_with_sse") if not hasattr(client, name)]
    if missing:
        raise SdkError(
            _transport_error(
                f"SDK 缺少 {' / '.join(missing)}，需要 alibabacloud-dataworks-public20240518 >= 9.9.0"
                "（当前安装版本见 pip show）。没有 SSE 变体就只能整体 buffer，长轮必然超时。"
            )
        )


def _transport_error(message: str):
    from .errors import api_error

    return api_error("transport", message)


def _guard_async_iterable(value: Any, api_name: str) -> AsyncGenerator:
    """*WithSSE 的返回值在 .d.ts/.pyi 里偏宽松；拿到非可迭代对象时换成可读错误。"""
    if value is None or not inspect.isasyncgen(value) and not hasattr(value, "__aiter__"):
        raise SdkError(
            _transport_error(f"{api_name} 没有返回可迭代的 SSE 流（拿到 {type(value).__name__}）；SDK 版本或上游形态可能不匹配")
        )
    return value


def _str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _num(value: Any) -> float | None:
    return value if isinstance(value, (int, float)) else None


async def _agents_result(ctx: LiveContext) -> dict[str, Any]:
    api = "ListAgents"
    resp = await ctx.client.list_agents_with_options_async(
        sdk_models.ListAgentsRequest(id=_next_rpc_id(), jsonrpc=JSONRPC_VERSION, params=sdk_models.ListAgentsRequestParams(max_results=PAGE_SIZE)),
        runtime_for(),
    )
    body = read_non_stream_body(resp)
    if body["result"] is None:
        raise missing_result_error(api, body)
    agents = [_str(r.get("agentName")) for r in body["result"].get("agents", []) if isinstance(r, dict)]
    return {
        "agents": [a for a in agents if a],
        "totalCount": _num(body["result"].get("totalCount")),
        "requestId": body["requestId"],
    }


async def _list_sessions_result(ctx: LiveContext) -> dict[str, Any]:
    api = "ListAgentSessions"
    collected: list[dict[str, Any]] = []
    next_token: str | None = None
    total_count: int | None = None
    truncated = False

    for page in range(MAX_PAGES):
        resp = await ctx.client.list_agent_sessions_with_options_async(
            sdk_models.ListAgentSessionsRequest(
                id=_next_rpc_id(),
                jsonrpc=JSONRPC_VERSION,
                params=sdk_models.ListAgentSessionsRequestParams(
                    # AgentName 实测**必填**；SessionSourceList 是生效的过滤器；
                    # SessionTitle 过滤器被**静默忽略**——所以本端点不提供 q 参数。
                    agent_name=ctx.cfg.agentName,
                    session_source_list=[ctx.cfg.sessionSource],
                    max_results=PAGE_SIZE,
                    next_token=next_token,
                ),
            ),
            runtime_for(),
        )
        body = read_non_stream_body(resp)
        if body["result"] is None:
            raise missing_result_error(api, body)

        total_count = total_count if total_count is not None else _num(body["result"].get("totalCount"))
        for row in body["result"].get("agentSessions", []) or []:
            summary = _to_session_summary(row)
            if summary:
                collected.append(summary)

        next_token = _str(body["result"].get("nextToken"))
        if not next_token:
            break
        if page == MAX_PAGES - 1:
            truncated = True

    return {
        "sessions": collected,
        # TotalCount 与已收集条数之差。归因不唯一（分页上限截断时含"没取的页"），
        # 所以必须一并返回 truncated，不把差额说成"被过滤掉 N 条"。
        "filteredOut": max(0, (total_count or len(collected)) - len(collected)),
        "total": total_count if total_count is not None else len(collected),
        "truncated": truncated,
    }


def _to_session_summary(row: Any) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        row = _model_to_map(row)
        if row is None:
            return None
    session_id = _str(row.get("sessionId"))
    if not session_id:
        return None
    meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
    tags = [
        t.get("sessionTagCode")
        for t in (meta.get("sessionTagList") or [])
        if isinstance(t, dict) and isinstance(t.get("sessionTagCode"), str)
    ]
    created_at = row.get("sessionCreatedAt") if isinstance(row.get("sessionCreatedAt"), int) else 0
    return {
        "sessionId": session_id,
        # SessionTitle = 首条 prompt 原文（可能带注入的校验码说明），剥离由前端做。
        "title": _str(row.get("sessionTitle")) or _str(row.get("sessionDescription")) or "",
        "createdAt": created_at,
        # 恒等于 createdAt（实测 29/29）。照原样透传，运行态一律以前端流为准。
        "updatedAt": row.get("sessionUpdatedAt") if isinstance(row.get("sessionUpdatedAt"), int) else created_at,
        # 恒为 RELEASED，同样不能当运行态用。
        "status": _str(meta.get("sessionStatus")) or "UNKNOWN",
        "source": _str(meta.get("sessionSource")),
        "tags": tags,
    }


def _model_to_map(model: Any) -> dict[str, Any] | None:
    to_map = getattr(model, "to_map", None)
    mapped = to_map() if callable(to_map) else None
    return mapped if isinstance(mapped, dict) else None


async def _usage_result(ctx: LiveContext, session_id: str) -> dict[str, Any]:
    started_ms = int(time.time() * 1000)
    resp = await ctx.client.get_agent_session_token_usage_with_options_async(
        sdk_models.GetAgentSessionTokenUsageRequest(
            id=_next_rpc_id(), jsonrpc=JSONRPC_VERSION, params=sdk_models.GetAgentSessionTokenUsageRequestParams(session_id=session_id)
        ),
        runtime_for(),
    )
    body = read_non_stream_body(resp)
    if body["result"] is None:
        raise missing_result_error("GetAgentSessionTokenUsage", body)
    r = body["result"]
    return {
        "promptTokens": _num(r.get("promptTokens")),
        "completionTokens": _num(r.get("completionTokens")),
        "totalTokens": _num(r.get("totalTokens")),
        "cachedTokens": _num(r.get("cachedTokens")),
        "thoughtsTokens": _num(r.get("thoughtsTokens")),
        "elapsedMs": int(time.time() * 1000) - started_ms,
        "requestId": body["requestId"],
    }


async def _artifacts_result(ctx: LiveContext, session_id: str) -> dict[str, Any]:
    started_ms = int(time.time() * 1000)
    resp = await ctx.client.list_agent_session_artifacts_with_options_async(
        sdk_models.ListAgentSessionArtifactsRequest(
            id=_next_rpc_id(), jsonrpc=JSONRPC_VERSION, params=sdk_models.ListAgentSessionArtifactsRequestParams(session_id=session_id)
        ),
        runtime_for(),
    )
    body = read_non_stream_body(resp)
    if body["result"] is None:
        raise missing_result_error("ListAgentSessionArtifacts", body)
    artifacts = body["result"].get("artifacts")
    # **原样返回，不做兜底填充**：实测两个 artifact 接口恒返回空数组。
    return {"artifacts": artifacts if isinstance(artifacts, list) else [], "elapsedMs": int(time.time() * 1000) - started_ms}


async def _cancel_result(ctx: LiveContext, session_id: str) -> dict[str, Any]:
    """cancel。【LIVE 09-18】上游已会真正取消：HTTP 200 + 流以 stopReason=cancelled 收场。

    `delivered` = 上游接受了取消请求（HTTP 200）。取消失败的处置是让调用方知道
    "没取消成"，而不是收到一个 5xx——所以异常记进 detail 透给前端，不当异常抛。
    """
    api = "CancelAgentSession"
    upstream = "调用未返回"
    status: int | None = None
    try:
        resp = await ctx.client.cancel_agent_session_with_options_async(
            sdk_models.CancelAgentSessionRequest(
                id=_next_rpc_id(), jsonrpc=JSONRPC_VERSION, params=sdk_models.CancelAgentSessionRequestParams(session_id=session_id)
            ),
            runtime_for(),
        )
        body = read_non_stream_body(resp)
        status = body["statusCode"]
        upstream = f"HTTP {status if status is not None else '?'}"
    except Exception as err:  # noqa: BLE001
        upstream = to_api_error(err if isinstance(err, Exception) else RuntimeError(str(err)), api).message

    delivered = status == 200
    detail = (
        (
            f"已向上游发出 {api}（{upstream}），取消请求已被接受。"
            "若当时有执行中的轮次，流会以 `stopReason=cancelled` 终态收场"
            "（实测 3/3：1200 字长文在 432 字处被截断；空闲会话上取消是 no-op）。"
            "注意：cancelled 终态目前不落库——稍后 LoadAgentSession 里那一轮 "
            "`terminated=false`、无 stopReason，属上游已知缺口，不代表取消失败。"
        )
        if delivered
        else f"已向上游发出 {api} 但未获 200（本次结果：{upstream}）。取消未确认生效：那一轮可能仍在执行，结果稍后拉历史确认。"
    )
    return {"delivered": delivered, "warning": "cancel-accepted" if delivered else "cancel-upstream-error", "detail": detail}


async def _reply_result(ctx: LiveContext, session_id: str, input_: dict[str, Any]) -> dict[str, Any]:
    """回覆人卡交互。【LIVE 09-17】实测：accepted=true 后原 prompt 流继续，绝不重发 prompt。"""
    api = "ReplyAgentSession"
    resp = await ctx.client.reply_agent_session_with_options_async(
        sdk_models.ReplyAgentSessionRequest(
            id=_next_rpc_id(),
            jsonrpc=JSONRPC_VERSION,
            params=sdk_models.ReplyAgentSessionRequestParams(
                session_id=session_id,
                permission_request_id=input_["permissionRequestId"],
                **({"answers": input_["answers"]} if input_.get("answers") else {}),
                outcome=sdk_models.ReplyAgentSessionRequestParamsOutcome(
                    **({"option_id": input_["optionId"]} if input_.get("optionId") else {}),
                    outcome=input_["outcome"],
                ),
            ),
        ),
        runtime_for(),
    )
    # 与其它非流式调用不同：ReplyAgentSession 的响应模型声明了 Error 字段，
    # 业务错误能穿过 SDK 的 cast 被原样读出。
    body = getattr(resp, "body", None)
    rpc = getattr(body, "jsonRpcResponse", None) or getattr(body, "json_rpc_response", None)
    mapped = _model_to_map(body) or {}
    request_id = _str(mapped.get("RequestId")) or _str(getattr(body, "request_id", None))
    rpc_map = mapped.get("JsonRpcResponse") if isinstance(mapped.get("JsonRpcResponse"), dict) else {}
    # to_map 一律给 PascalCase 线格式键（{"Error":{"Message":…}}）：lower_first 归一为 camelCase 再读。
    error = lower_first_keys(rpc_map["Error"]) if isinstance(rpc_map.get("Error"), dict) else getattr(rpc, "error", None)
    result = lower_first_keys(rpc_map["Result"]) if isinstance(rpc_map.get("Result"), dict) else (
        getattr(rpc, "result", None) if rpc is not None else None)
    accepted = result.get("accepted") if isinstance(result, dict) and isinstance(result.get("accepted"), bool) else None

    if isinstance(error, dict):
        message = error.get("message") or "无 message"
        err_code = error.get("errorCode")
        code = error.get("code")
        # 回覆被上游拒绝：异常化（路由层 live_error 包信封），与其它非流式调用对齐。
        raise SdkError(
            redact_api_error(
                api_error(
                    "rpc_error",
                    f"{api} 被上游拒绝：{message}"
                    + (f" [{err_code}]" if isinstance(err_code, str) else "")
                    + (f" (code={code})" if isinstance(code, int) else "")
                    + (f"，RequestId {request_id}" if request_id else ""),
                )
            )
        )
    if accepted is None:
        raise SdkError(
            redact_api_error(
                api_error(
                    "rpc_error",
                    f"{api} 返回 HTTP 200 但没有 JsonRpcResponse.Result.accepted"
                    + (f"（RequestId {request_id}）" if request_id else ""),
                )
            )
        )
    # 一律回"结果字典"，信封 {ok,result} 由路由层包一次（双层包封会断前端与契约断言）。
    return {
        "accepted": accepted,
        "requestId": request_id,
        "detail": (
            "上游已接受回覆。后续执行事件从原 PromptAgentSession 流上继续收，不要重发 prompt。"
            if accepted
            else "上游明确返回 accepted=false：回覆未被采纳（requestId 可能已过期或已被他人回覆）。"
        ),
    }


async def _load_frames(ctx: LiveContext, session_id: str) -> list[dict[str, Any]]:
    """拉一整份历史帧。独立的 30s readTimeout（RUNNING 期 load 会阻塞到轮次结束）。

    Meta.BeginLogOffset 是**死参数**：传任何值都返回全量，服务端没有增量续传。
    """
    frames: list[dict[str, Any]] = []
    stream = ctx.client.load_agent_session_with_sse_async(
        sdk_models.LoadAgentSessionRequest(
            id=_next_rpc_id(),
            jsonrpc=JSONRPC_VERSION,
            params=sdk_models.LoadAgentSessionRequestParams(
                session_id=session_id, meta=sdk_models.LoadAgentSessionRequestParamsMeta(is_reload=True)
            ),
        ),
        runtime_for(HISTORY_READ_TIMEOUT_MS),
    )
    stream = await stream if hasattr(stream, "__await__") else stream
    async for resp in _guard_async_iterable(stream, "LoadAgentSession"):
        # SDK 的 resp.body 是模型对象，必须 to_map() 成线格式 dict——直接交给
        # frame_from_sdk_body 会被 is_object(dict) 拒掉，全部漏成 unrecognized（LIVE 实测）。
        mapped = _model_to_map(_body_of(resp))
        frame = frame_from_sdk_body(mapped)
        if frame:
            frames.append(frame)
    return frames


async def _probe_result(ctx: LiveContext, session_id: str, rid: str, baseline_tokens: float | None) -> dict[str, Any]:
    """探测"断流的那一轮到底跑完了没有"。两个判据都只能给"完成"信号。

    **绝不自动重发 prompt**——重发等于把同一个写操作执行两遍。
    """
    started_ms = int(time.time() * 1000)
    loads_issued = 0
    by: list[str] = []

    frames = await _load_frames(ctx, session_id)
    loads_issued = 1
    frames_for_rid = count_frames_for_rid(frames, rid)

    usage = await _usage_result(ctx, session_id)
    total_tokens = usage.get("totalTokens")

    frames_say = frames_for_rid > 2
    tokens_say = baseline_tokens is not None and total_tokens is not None and total_tokens > baseline_tokens
    if frames_say:
        by.append("frames")
    if tokens_say:
        by.append("tokens")

    return {
        "done": len(by) > 0,
        "by": by,
        "framesForRid": frames_for_rid,
        "totalTokens": total_tokens,
        "loadsIssued": loads_issued,
        "elapsedMs": int(time.time() * 1000) - started_ms,
    }


def _body_of(resp: Any) -> Any:
    return getattr(resp, "body", None)


async def _create_session_result(ctx: LiveContext, mode: str) -> dict[str, Any]:
    api = "CreateAgentSession"
    resp = await ctx.client.create_agent_session_with_options_async(_build_create_session_request(ctx.cfg, mode), runtime_for())
    body = read_non_stream_body(resp)
    if body["result"] is None:
        # 空响应体是这条接口最常见的失败形态，单独归一类：处置方式与其它 rpc_error 完全不同。
        # 包进 SdkError 再 raise：ApiError 不是 BaseException 的子类，裸 raise 会 TypeError。
        raise SdkError(create_empty_body_error(
            f"{api} 返回 HTTP {body['statusCode'] if body['statusCode'] is not None else '?'} 但没有 JsonRpcResponse.Result，拿不到 SessionId"
            + (f"（RequestId {body['requestId']}）" if body["requestId"] else "")
            + "。实测最常见的原因是账号下没有运行中的 DataWorks 实例，或者该账号需要 RESOURCE_GROUP_ID 而没配。"
        ))
    session_id = _str(body["result"].get("sessionId"))
    # **成功判据只有 SessionId 非空**。HTTP 200 + 有 Result 但 SessionId 为空，仍是失败。
    if not session_id:
        raise SdkError(create_empty_body_error(f"{api} 返回了 Result 但 SessionId 为空"))
    # 一律回"结果字典"，信封 {ok,result} 由路由层包一次（双层包封会断前端与契约断言）。
    return {"sessionId": session_id, "requestId": body["requestId"]}


def _build_create_session_request(cfg: AppConfig, mode: str) -> sdk_models.CreateAgentSessionRequest:
    """CreateAgentSession 的请求构造。

    嵌套关系是血泪教训：initialConfigOptions 只存在于 meta 之下，agentName 只存在于
    meta.agent 之下——直接往 params 上塞同名字段，to_map() 会按 names() 声明静默丢弃，
    wire 上就是 "Params": {} 的全空请求。
    """
    return sdk_models.CreateAgentSessionRequest(
        id=_next_rpc_id(),
        jsonrpc=JSONRPC_VERSION,
        params=sdk_models.CreateAgentSessionRequestParams(
            meta=sdk_models.CreateAgentSessionRequestParamsMeta(
                agent=sdk_models.CreateAgentSessionRequestParamsMetaAgent(agent_name=cfg.agentName),
                config=sdk_models.CreateAgentSessionRequestParamsMetaConfig(
                    session_source=cfg.sessionSource,
                    # 类型是 Array<{SessionTagCode}> 而不是 string[]：传字符串数组会被静默忽略。
                    session_tags=[sdk_models.CreateAgentSessionRequestParamsMetaConfigSessionTags(session_tag_code=cfg.sessionSource)],
                ),
                # ResourceGroupId 走 InitialConfigOptions，且上游**不校验有效性**。
                # mode：yolo 放行全部工具授权；default 停下等人（人卡，配 /reply 回覆）。
                initial_config_options=sdk_models.CreateAgentSessionRequestParamsMetaInitialConfigOptions(
                    resource_group_id=cfg.resourceGroupId, mode=mode
                ),
            ),
        ),
    )


async def _prompt_frames(
    ctx: LiveContext, session_id: str, outbound_text: str, acks: list[str] | None = None
) -> AsyncGenerator[dict[str, Any], None]:
    """发一轮 prompt，返回**线格式帧**的异步流。

    三件事在这里定死（与 Node 版 live.ts 相同）：
      1. 必须走 prompt_agent_session_with_sse（普通变体会整体 buffer，长轮必然超时）；
      2. 每帧过 frame_from_sdk_body（SDK 的 cast 键名与线格式不同名，不归一化下游全瞎）；
      3. 抛出的异常不在这里吞，交给流管道归一化。
    """
    stream = ctx.client.prompt_agent_session_with_sse_async(
        sdk_models.PromptAgentSessionRequest(
            id=_next_rpc_id(),
            jsonrpc=JSONRPC_VERSION,
            params=sdk_models.PromptAgentSessionRequestParams(
                session_id=session_id,
                prompt=[sdk_models.PromptAgentSessionRequestParamsPrompt(type="text", text=outbound_text)],
            ),
        ),
        runtime_for(),
    )
    stream = await stream if hasattr(stream, "__await__") else stream

    unrecognized = 0
    try:
        async for resp in _guard_async_iterable(stream, "PromptAgentSession"):
            # SDK 的 resp.body 是模型对象，必须 to_map() 成线格式 dict——直接交给
            # frame_from_sdk_body 会被 is_object(dict) 拒掉，全部漏成 unrecognized（LIVE 实测）。
            body = _model_to_map(_body_of(resp))
            frame = frame_from_sdk_body(body)
            if frame:
                yield frame
                continue
            # 不是帧的载荷两种：POP 回执（只有 RequestId，零帧场景唯一可查的线索）；
            # 真认不出来的形状（上游改了载荷，warn 一条）。
            ack = pop_ack_request_id(body)
            if ack:
                if acks is not None:
                    acks.append(ack)
                continue
            unrecognized += 1
    finally:
        # 放 finally：这条生成器最常见的结束方式是被外层 return() 掉（客户端断开/330s 硬上限）。
        if unrecognized > 0:
            pass  # 日志由路由层记（Python 侧没有注入 logger 的对称结构，保持契约即可）
