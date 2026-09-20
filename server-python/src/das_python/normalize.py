"""SDK / 传输层异常 → ApiError 的归一化。与 Node 实现的 server-node/normalize.ts 同源同语义。

实测事实：**上游的业务错误恒以 HTTP 200 返回**，真正的错误在响应体的
`JsonRpcResponse.Error` 里；而非 2xx 只在传输/鉴权/限流时出现。
两条路（状态码分支 + 异常分支）都要走，最后交给同一个分类器（errors.classify_error）。

Python 侧的两族异常（与 Node 的 ResponseError/AlibabaCloudError 对应）：
  · `alibabacloud_tea_openapi.exceptions`：ClientException / ServerException / ThrottlingException
    （基类 AlibabaCloudException；属性 status_code / code(str) / message / description /
    request_id / retry_after / data / access_denied_detail）——上游真实的 401/403/422/429/5xx 走这一族；
  · `darabonba.exceptions`：TeaException / ResponseException / UnretryableException（基类 DaraException）
    ——runtime 层的超时与不可重试错误走这一族。
"""

from __future__ import annotations

import json
from typing import Any

from alibabacloud_tea_openapi import exceptions as openapi_exceptions
from darabonba.exceptions import DaraException

from .errors import ApiError, classify_error, redact_api_error


class SdkError(Exception):
    """把 ApiError 挂到异常上，让路由层能原样取出归一化错误。"""

    def __init__(self, api_error: ApiError) -> None:
        super().__init__(api_error.message)
        self.api_error = api_error


def to_api_error(err: Exception, api_name: str) -> ApiError:
    """SDK / 传输层抛出的一切 → ApiError（已脱敏、已带 API 名）。"""
    return redact_api_error(_with_api(_raw(err), api_name))


def _raw(err: Exception) -> ApiError:
    if isinstance(err, SdkError):
        return err.api_error

    # 上游 HTTP 错误按形状认（status/code 属性），两条异常族取并集——
    # 与 Node 侧 normalize.ts 的"instanceof + name 双判据"同源同语义。
    status = _upstream_status(err)
    if status is not None or isinstance(err, DaraException | openapi_exceptions.AlibabaCloudException):
        return _from_upstream_exception(err, status)

    # readTimeout / socket hang up / getaddrinfo 之类都归 transport。
    # 归 transport ⇒ retryable=true，但 prompt 那条路**不允许**照这个 retryable 重发：
    # 重发等于把同一个写操作执行两遍。
    message = str(err) or "未知传输故障"
    from .errors import api_error

    return api_error("transport", message)


def _upstream_status(err: Exception) -> int | None:
    for attr in ("status_code", "status", "statusCode"):
        value = getattr(err, attr, None)
        if isinstance(value, int):
            return value
    code = getattr(err, "code", None)
    return code if isinstance(code, int) else None


def _describe_upstream(err: Exception) -> str:
    parts: list[str] = []
    message = getattr(err, "message", None)
    if message:
        parts.append(str(message))
    code = getattr(err, "code", None)
    if code:
        parts.append(f"code={code}")
    description = getattr(err, "description", None)
    if description is not None:
        text = str(description).strip()
        if text and text != "undefined":
            parts.append(text)
    data = getattr(err, "data", None)
    if isinstance(data, dict):
        status = data.get("statusCode")
        if isinstance(status, int):
            parts.append(f"status={status}")
        access_denied = data.get("accessDeniedDetail")
        if access_denied is not None:
            try:
                parts.append(f"accessDeniedDetail={json.dumps(access_denied, ensure_ascii=False)}")
            except (TypeError, ValueError):
                parts.append(f"accessDeniedDetail={access_denied}")
    request_id = getattr(err, "request_id", None) or (data.get("requestId") if isinstance(data, dict) else None)
    if request_id:
        parts.append(f"requestId={request_id}")
    retry_after = getattr(err, "retry_after", None)
    if isinstance(retry_after, int):
        # 429 时上游用响应头 x-acs-retry-after 给出建议等待量。**单位上游没写、SDK 也没换算**，
        # 原值透传并说明来源，不替它编一个"秒/毫秒"。
        parts.append(f"retryAfter={retry_after}（上游 x-acs-retry-after 原值，单位未标注）")
    return " | ".join(parts) if parts else "上游返回了一个没有描述的错误"


def _from_upstream_exception(err: Exception, status: int | None) -> ApiError:
    detail = _describe_upstream(err)

    # 422 = 会话幽灵化：约 1s 返回，这个会话不能再用，唯一动作是新建。
    # classify_error 认 `upstream_status=422` 文本，这里把真实状态码也一并给它。
    classified = classify_error(message=detail, upstreamStatus=status)

    # 认不出文本特征、且连 HTTP 状态码都没有 ⇒ 是网络层的事（DNS、连接被拒、TLS），
    # 归 transport 而不是 rpc_error：前者 retryable，后者不是。
    if classified.kind == "rpc_error" and status is None:
        from .errors import api_error

        return api_error("transport", detail)
    return classified


def _with_api(error: ApiError, api_name: str) -> ApiError:
    from dataclasses import replace

    return error if api_name in error.message else replace(error, message=f"{api_name}: {error.message}")


# ---------------------------------------------------------------------------
# 非流式响应体
# ---------------------------------------------------------------------------


def lower_first_keys(value: Any) -> Any:
    """把 SDK to_map 的 PascalCase 线格式键递归改成小写首字母——

    与 Node/Java 的模型属性读取行为对齐（sessionId / promptTokens / sessionTitle）。
    没有这层归一，Python 侧按 camelCase 读 Result 就永远拿不到值（Live 实测：
    to_map 一律给出 PascalCase 键）。
    """
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            key = (k[:1].lower() + k[1:]) if isinstance(k, str) and k[:1].isupper() else k
            out[key] = lower_first_keys(v)
        return out
    if isinstance(value, list):
        return [lower_first_keys(v) for v in value]
    return value


def read_non_stream_body(resp: Any) -> dict[str, Any]:
    """读非流式响应体。

    **必须如实交代的一条限制**：非流式的响应模型只声明了 {id, jsonrpc, result}，
    没有 error 字段，SDK 的 cast 会**静默丢弃模型未声明的键**——实测含
    `JsonRpcResponse.Error` 的响应体过一遍 cast，Error 整个消失。
    后果：非流式调用的"业务错误"与"空响应体"在 SDK 层**不可区分**。
    所以这里绝不编造 code/message，只报告"Result 缺失"+ RequestId。

    Python 侧用 `body.to_map()` 取线格式 dict（PascalCase 键），Result 一律
    过 lower_first_keys 归一为 camelCase——与 Node 读 resp.body 的字段访问等价；
    to_map 不可用时退属性访问（属性本身就是模型声明的 camelCase 名，无需转换）。
    """
    body = getattr(resp, "body", None)
    request_id: Any = getattr(body, "request_id", None) if body is not None else None
    rpc = getattr(body, "jsonRpcResponse", None) or getattr(body, "json_rpc_response", None)
    result: Any = getattr(rpc, "result", None) if rpc is not None else None

    to_map = getattr(body, "to_map", None)
    mapped = to_map() if callable(to_map) else None
    if isinstance(mapped, dict):
        request_id = mapped.get("RequestId") or request_id
        rpc_map = mapped.get("JsonRpcResponse") or {}
        if isinstance(rpc_map, dict) and rpc_map.get("Result") is not None:
            result = lower_first_keys(rpc_map["Result"])

    status = getattr(resp, "status_code", None)
    if not isinstance(status, int):
        status = getattr(resp, "status", None)

    return {
        "statusCode": status,
        "requestId": request_id if isinstance(request_id, str) else None,
        "result": result if isinstance(result, dict) else None,
    }


def missing_result_error(api_name: str, body: dict[str, Any]) -> SdkError:
    """Result 缺失时的统一说法：不猜原因，只给出可查的线索。

    返回 SdkError：调用方一律 `raise` 使用，**ApiError 不是 BaseException 的子类，
    `raise api_error(...)` 会在运行期直接 TypeError**（LIVE-only 路径的第五处）。
    """
    from .errors import api_error

    status = body.get("statusCode")
    request_id = body.get("requestId")
    return SdkError(
        api_error(
            "rpc_error",
            f"{api_name} 返回 HTTP {status if status is not None else '?'}，但响应体里没有 JsonRpcResponse.Result。"
            "非流式响应模型未声明 Error 字段，SDK 的 cast 已把错误详情丢弃，所以这里拿不到 code 与 message"
            + (f"。可用 RequestId {request_id} 到控制台或工单查这次调用" if request_id else "")
            + ".",
        )
    )
