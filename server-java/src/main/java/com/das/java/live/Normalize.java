package com.das.java.live;

import com.aliyun.sdk.gateway.pop.exception.PopClientException;
import com.aliyun.sdk.gateway.pop.exception.PopServerException;
import com.das.java.core.ApiError;
import darabonba.core.exception.ClientException;
import darabonba.core.exception.ServerException;
import java.net.SocketTimeoutException;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;

/**
 * SDK / 传输层异常 → ApiError 的归一化。与 Node 实现的 server-node/normalize.ts、
 * Python 实现的 normalize.py 同源同语义。
 *
 * 实测事实：上游的业务错误恒以 HTTP 200 返回（真正的错误在 JsonRpcResponse.Error 里），
 * 非 2xx 只在传输/鉴权/限流时出现。Java 侧对应官方异步 SDK 的异常族：
 * 5xx → PopServerException（继承 ServerException）；4xx → PopClientException
 * （继承 ClientException，**不是** ServerException 的子类）。两者都带
 * statusCode + POP 错误体字段（errCode/errMessage/requestId），两个家族都要认。
 */
public final class Normalize {
    private Normalize() {}

    /** 把 ApiError 挂到异常上,让路由层/管道原样取出归一化错误。 */
    public static final class DasApiException extends Exception {
        private final ApiError apiError;

        public DasApiException(ApiError error) {
            super(error.message());
            this.apiError = error;
        }

        public DasApiException(ApiError error, Throwable cause) {
            super(error.message(), cause);
            this.apiError = error;
        }

        public ApiError apiError() {
            return apiError;
        }
    }

    public static ApiError toApiError(Throwable err, String apiName) {
        return ApiError.redact(withApi(raw(unwrap(err)), apiName));
    }

    /** CompletableFuture join 出来的异常总被 Completion/ExecutionException 包着：先剥。 */
    static Throwable unwrap(Throwable t) {
        while ((t instanceof CompletionException || t instanceof ExecutionException) && t.getCause() != null) {
            t = t.getCause();
        }
        return t;
    }

    private static ApiError raw(Throwable err) {
        if (err instanceof DasApiException e) return e.apiError();

        Integer status = upstreamStatus(err);
        if (status != null || err instanceof ServerException || err instanceof ClientException) {
            return fromUpstreamException(err, status);
        }

        if (err instanceof SdkSseStream.SseException e) {
            if (e.statusCode() != null) return fromUpstreamException(e, e.statusCode());
            return ApiError.transport(e.getMessage() == null ? "未知传输故障" : e.getMessage());
        }

        Throwable cause = err instanceof RuntimeException && err.getCause() != null ? err.getCause() : err;
        // readTimeout / socket hang up / getaddrinfo 之类都归 transport。
        // 归 transport ⇒ retryable=true，但 prompt 那条路**不允许**照这个 retryable 重发。
        String message = cause.getMessage();
        if (cause instanceof SocketTimeoutException) message = "读取超时（" + message + "）";
        if (message == null || message.isEmpty()) message = "未知传输故障（" + cause.getClass().getSimpleName() + "）";
        return ApiError.transport(message);
    }

    static Integer upstreamStatus(Throwable err) {
        if (err instanceof ServerException e) {
            if (e.getStatusCode() != null) return e.getStatusCode();
        }
        if (err instanceof ClientException e) {
            if (e.getStatusCode() != null) return e.getStatusCode();
        }
        if (err instanceof SdkSseStream.SseException e) return e.statusCode();
        return null;
    }

    private static String describeUpstream(Throwable err) {
        if (err instanceof PopServerException e) {
            return popDescription(e.getErrMessage(), e.getErrCode(), e.getRequestId(), e.getStatusCode(), e.getMessage());
        }
        if (err instanceof PopClientException e) {
            return popDescription(e.getErrMessage(), e.getErrCode(), e.getRequestId(), e.getStatusCode(), e.getMessage());
        }
        StringBuilder parts = new StringBuilder();
        String message = err.getMessage();
        if (message != null && !message.isEmpty()) parts.append(message);
        if (err instanceof ServerException e && e.getStatusCode() != null) {
            parts.append(" | status=").append(e.getStatusCode());
        } else if (err instanceof ClientException e && e.getStatusCode() != null) {
            parts.append(" | status=").append(e.getStatusCode());
        }
        Throwable inner = err.getCause();
        if (inner != null && inner.getMessage() != null
            && !(err instanceof ServerException) && !(err instanceof ClientException)) {
            parts.append(" | cause=").append(inner.getMessage());
        }
        return parts.length() > 0 ? parts.toString() : "上游返回了一个没有描述的错误";
    }

    /** POP 错误体的结构化呈现：errMessage 是上游原文；空壳字段一律不出现（不编造）。 */
    private static String popDescription(String errMessage, String errCode, String requestId,
        Integer statusCode, String fallbackMessage) {
        StringBuilder parts = new StringBuilder();
        if (errMessage != null && !errMessage.isEmpty()) parts.append(errMessage);
        if (errCode != null && !errCode.isEmpty()) parts.append(" [").append(errCode).append(']');
        if (requestId != null && !requestId.isEmpty()) parts.append(" | requestId=").append(requestId);
        if (statusCode != null) parts.append(" | status=").append(statusCode);
        if (parts.length() == 0 && fallbackMessage != null) parts.append(fallbackMessage);
        return parts.length() > 0 ? parts.toString() : "上游返回了一个没有描述的错误";
    }

    private static ApiError fromUpstreamException(Throwable err, Integer status) {
        String detail = describeUpstream(err);
        // 422 = 会话幽灵化：约 1s 返回，这个会话不能再用，唯一动作是新建。
        // classify 认 upstream_status=422 文本，把真实状态码一并给它。
        ApiError classified = ApiError.classify(detail, null, null, status);
        // 认不出文本特征、且连 HTTP 状态码都没有 ⇒ 网络层的事，归 transport 而不是 rpc_error。
        if (classified.kind().equals("rpc_error") && status == null) {
            return ApiError.transport(detail);
        }
        return classified;
    }

    private static ApiError withApi(ApiError error, String apiName) {
        if (apiName == null || error.message().contains(apiName)) return error;
        return new ApiError(
            error.kind(), error.code(), error.errorCode(), apiName + ": " + error.message(),
            error.retryable(), error.fatalForSession(), error.upstreamStatus());
    }

    /**
     * 非流式响应的 Result 缺失统一说法（与 Node normalize.ts 同源）。
     *
     * 必须如实交代的限制：非流式的响应模型只声明了 {id, jsonrpc, result}，没有 error
     * 字段，SDK 的 cast 会**静默丢弃模型未声明的键**——业务错误与空响应体在 SDK 层
     * 不可区分。所以这里绝不编造 code/message，只报告 Result 缺失 + RequestId。
     */
    public static ApiError missingResultError(String apiName, Integer statusCode, String requestId) {
        return ApiError.apiError("rpc_error",
            apiName + " 返回 HTTP " + (statusCode != null ? statusCode : "?")
                + "，但响应体里没有 JsonRpcResponse.Result。"
                + "非流式响应模型未声明 Error 字段，SDK 的 cast 已把错误详情丢弃，所以这里拿不到 code 与 message"
                + (requestId != null ? "。可用 RequestId " + requestId + " 到控制台或工单查这次调用" : "")
                + ".");
    }
}
