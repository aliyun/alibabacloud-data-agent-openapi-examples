import { ResponseError } from '@darabonba/typescript';

import { apiError, classifyError, type ApiError } from '@das/shared';

import { SdkError } from './sdk.js';

/** openapi-core 抛的错误都在 ResponseError 之下，并额外带 POP 层的 RequestId 与鉴权明细。 */
interface UpstreamError extends ResponseError {
  requestId?: string;
  detail?: unknown;
  /** 只有 ThrottlingError 带：取自响应头 `x-acs-retry-after`，单位上游没说，原值透传。 */
  retryAfter?: number;
  /** 只有 4xx 的 ClientError 可能带：上游给的鉴权明细（缺哪条 action、什么类型的拒绝）。 */
  accessDeniedDetail?: unknown;
}

/**
 * 把 SDK / 传输层抛出的一切东西归一成 `ApiError`。
 *
 * 这一层存在的理由是一条实测事实：**上游的业务错误恒以 HTTP 200 返回**，
 * 真正的错误在响应体的 `JsonRpcResponse.Error` 里；而非 2xx 只在传输/鉴权/限流时出现。
 * 所以"看状态码分支"和"看异常分支"都不够，两条路都要走，且最后交给同一个分类器
 * （shared/classifyError），保证前后端对同一个 `-32603` 得出同一个 kind。
 */
export function toApiError(err: unknown, apiName: string): ApiError {
  return redactApiError(withApi(raw(err), apiName));
}

function raw(err: unknown): ApiError {
  if (err instanceof SdkError) return err.apiError;

  if (isUpstreamHttpError(err)) {
    return fromResponseError(err);
  }

  if (err instanceof Error) {
    // readTimeout / socket hang up / getaddrinfo 之类都落在这里。
    // 归 transport ⇒ retryable=true，但 prompt 那条路**不允许**照这个 retryable 重发：
    // 重发等于把同一个写操作执行两遍，见 routes/prompt.ts。
    return apiError('transport', `${err.message || '未知传输故障'}`);
  }

  return apiError('transport', String(err));
}

/**
 * 认"上游 HTTP 错误"只能按形状认，**不能只写 `instanceof ResponseError`**——
 * 因为同名类在两家里的行为恰好相反（都已实测，2026-09-16，装的是
 * `@darabonba/typescript@1.0.5` + `@alicloud/openapi-core`）：
 *
 *  · `@darabonba/typescript` 自己的 `ResponseError`：编译到 ES5，`__extends` 里写着
 *    `var _this = _super.call(this, msg) || this;`。在 ES2015+ 的 Error 语义下
 *    `Error.call(this, msg)` 会**返回一个新的普通 Error**（而不是复用 this），
 *    于是 `_this` 成了那个普通 Error：实测原型链只剩 `Error → Object`，
 *    `e instanceof ResponseError === false`。但赋到 `_this` 上的字段都还在
 *    （`e.name === 'ResponseError'`、`e.statusCode === 401`，后者来自 `map.data.statusCode`）。
 *  · `@alicloud/openapi-core` 的 `AlibabaCloudError` 及其三个子类
 *    （`ClientError` / `ServerError` / `ThrottlingError`）：是真正的 ES class，
 *    构造函数里还显式调了 `Object.setPrototypeOf(this, …prototype)`，
 *    所以 `e instanceof ResponseError === true`，`name` 是子类名，
 *    `statusCode` 直接来自 `map.statusCode`。**上游真实的 401/403/422/429/5xx 走的是这一家。**
 *
 * 也就是说 instanceof 只能兜住后一家；只写它，传输层抛出的那种裸 ResponseError
 * 会掉进下面的 `instanceof Error` 分支。反过来只看 `name === 'ResponseError'`
 * 也漏——openapi-core 那三个的 name 是子类名。所以这里两条判据取并集：
 * name 命中裸 ResponseError，`statusCode` 是数字则命中 openapi-core 的 HTTP 错误。
 *
 * 漏判的后果不是"少一个分支"那么轻：所有上游非 2xx 都会被归成 `transport`
 * 且 `retryable: true`、`upstreamStatus` 恒为 undefined，
 * "重发一次 401 只会再得到一次 401"这条语义会被反过来写成"可以重试"。
 */
function isUpstreamHttpError(err: unknown): err is UpstreamError {
  if (!(err instanceof Error)) return false;
  const candidate = err as UpstreamError;
  return candidate.name === 'ResponseError' || typeof candidate.statusCode === 'number';
}

/**
 * 调用方身份标识的两种形态：长期 AK 是 `LTAI` 前缀，STS 临时凭证是 `STS.` 前缀。
 * Secret 从不出现在报文里，但这两种 id 都会（见下面 redact 的说明）。
 */
const ACCESS_KEY_ID = /(?:LTAI|STS\.)[A-Za-z0-9]+/g;

/**
 * 上游的鉴权类报文会**把调用方的 AccessKeyId 原文回显出来**——实测 401 的 Message 形如
 * `Deny: LTAI…|source ip: 203.0.113.7`。而 `toApiError` 的产物既要打到终端、又要经
 * `/api/check` 渲染进前端，等于把凭据标识抄进了日志与页面。
 *
 * 脱敏放在这一层（而不是各个调用点）是因为它是一条**报文级**事实：任何接口、任何错误分支
 * 都可能带上这段文本，逐点处理必然漏。保留 "Deny … | source ip" 的语义不变，
 * 只把 AK 本身换掉——那条信息正是判断"是否被身份级安全管控拦下"的依据，不能一起抹掉。
 *
 * 导出是因为归一化错误有**两条出口**：异常路径（`toApiError`，这里已内置）与
 * 帧内错误路径（`pipeline.ts` 里 `classifyError` 的产物，直接进 wire 事件）。
 * 少过一条，AK 就从那条路漏进前端与日志。
 */
export function redactApiError(error: ApiError): ApiError {
  // 不能用 ACCESS_KEY_ID.test() 先判一次：带 /g 的正则 .test() 会推进 lastIndex，
  // 隔次调用就漏匹配。replace 对 /g 正则会自行复位，所以直接替换再比对结果。
  const message = error.message.replace(ACCESS_KEY_ID, '<AccessKeyId 已隐去>');
  return message === error.message ? error : { ...error, message };
}

function fromResponseError(err: UpstreamError): ApiError {
  const detail = describeResponseError(err);
  const upstreamStatus = err.statusCode;

  // 422 = 会话幽灵化：约 1s 返回，这个会话不能再用，唯一动作是新建。
  // classifyError 认 `upstream_status=422` 文本，这里把真实状态码也一并给它。
  const classified = classifyError({ message: detail, upstreamStatus });

  /**
   * 认不出文本特征、且连 HTTP 状态码都没有 ⇒ 是网络层的事（DNS、连接被拒、TLS），
   * 归 transport 而不是 rpc_error：前者 retryable，后者不是，这个区别对用户有用。
   * 反之只要带了状态码（403 无权限、429 限流），就按上游给的业务事实报，
   * 并且不可原样重试——重发一次 403 只会再得到一次 403。
   */
  if (classified.kind === 'rpc_error' && upstreamStatus === undefined) {
    return apiError('transport', detail);
  }
  return classified;
}

function describeResponseError(err: UpstreamError): string {
  const parts: string[] = [];
  if (err.message) parts.push(err.message);
  if (err.code) parts.push(`code=${err.code}`);
  // 上游有时把 description 给成字面量字符串 "undefined"，原样拼上去只会多出 `| undefined |` 噪音段
  const description = err.description === undefined ? '' : String(err.description).trim();
  if (description && description !== 'undefined') parts.push(description);
  if (err.statusCode !== undefined) parts.push(`status=${err.statusCode}`);
  /**
   * 429 时上游用响应头 `x-acs-retry-after` 给出建议等待量，SDK 解析成 retryAfter。
   * **单位上游没写、SDK 也没换算**，所以这里原值透传并说明来源，不替它编一个"秒/毫秒"。
   */
  if (typeof err.retryAfter === 'number') {
    parts.push(`retryAfter=${err.retryAfter}（上游 x-acs-retry-after 原值，单位未标注）`);
  }
  // 403 的鉴权明细是"到底缺哪条权限"的唯一线索，比 message 里那句 no privilege 有用得多
  if (err.accessDeniedDetail !== undefined && err.accessDeniedDetail !== null) {
    parts.push(`accessDeniedDetail=${safeStringify(err.accessDeniedDetail)}`);
  }
  if (err.requestId) parts.push(`requestId=${err.requestId}`);
  return parts.length > 0 ? parts.join(' | ') : '上游返回了一个没有描述的错误';
}

/** 明细里可能带循环引用；这里只是拼给人看，序列化失败就退回 String()，不该让它把整条错误吞掉。 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function withApi(error: ApiError, apiName: string): ApiError {
  return error.message.includes(apiName) ? error : { ...error, message: `${apiName}: ${error.message}` };
}

// ---------------------------------------------------------------------------
// 非流式响应体
// ---------------------------------------------------------------------------

export interface NonStreamBody {
  statusCode: number | undefined;
  /** POP 层的 RequestId。业务错误详情被丢弃时，这是唯一还能拿去查的线索。 */
  requestId: string | undefined;
  /** `JsonRpcResponse.Result`；缺失即代表这一调用没拿到业务结果。 */
  result: Record<string, unknown> | undefined;
}

/**
 * 读非流式响应体。
 *
 * **这里有一条必须如实交代的限制**：非流式的响应模型
 * （`CreateAgentSessionResponseBodyJsonRpcResponse` 等）只声明了 `{id, jsonrpc, result}`，
 * **没有 error 字段**。SDK 内部用 `$dara.cast` 把线格式转成模型实例，而 cast 会
 * **静默丢弃模型未声明的键**——实测把含 `JsonRpcResponse.Error` 的响应体过一遍 cast，
 * Error 整个消失，只剩 `{"jsonRpcResponse":{"id":"1","jsonrpc":"2.0"}}`；
 * 响应体为空时则 cast 成 `{}`。
 *
 * 后果：非流式调用的"业务错误"与"空响应体"在 SDK 层**不可区分**。
 * 所以本函数绝不编造 code/message，只报告"Result 缺失"+ RequestId。
 * 流式那两个接口（prompt/load）的响应模型声明了 error，不受此限制——
 * 它们的错误走 `shared/frameFromSdkBody` + `classifyError`。
 */
export function readNonStreamBody(resp: unknown): NonStreamBody {
  const envelope = resp as {
    statusCode?: number;
    body?: { requestId?: string; jsonRpcResponse?: { result?: unknown } };
  } | null;

  const body = envelope?.body;
  const result = body?.jsonRpcResponse?.result;
  return {
    statusCode: envelope?.statusCode,
    requestId: typeof body?.requestId === 'string' ? body.requestId : undefined,
    result: isPlainObject(result) ? result : undefined,
  };
}

/** Result 缺失时的统一说法：不猜原因，只给出可查的线索。 */
export function missingResultError(apiName: string, body: NonStreamBody): ApiError {
  return apiError(
    'rpc_error',
    `${apiName} 返回 HTTP ${body.statusCode ?? '?'}，但响应体里没有 JsonRpcResponse.Result。` +
      '非流式响应模型未声明 Error 字段，SDK 的 cast 已把错误详情丢弃，所以这里拿不到 code 与 message' +
      (body.requestId ? `。可用 RequestId ${body.requestId} 到控制台或工单查这次调用` : '') +
      '。',
    { upstreamStatus: body.statusCode },
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
