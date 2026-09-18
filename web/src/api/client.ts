import { transportError, type ApiError, type ApiResult } from '@das/shared';

/**
 * 后端地址。刻意不走 Vite dev proxy：proxy 对 191s 量级的长连接有缓冲/超时的整类风险，
 * 而前端本来就要用 fetch + ReadableStream 手解 NDJSON，直连没有额外成本。
 */
export const API_BASE: string =
  (import.meta.env as Record<string, string | undefined>).VITE_API_BASE?.replace(/\/$/, '') ??
  'http://127.0.0.1:3000';

/** 拿到 `ok:false` 时抛出，让 react-query 走 error 分支。 */
export class ApiRequestError extends Error {
  constructor(readonly error: ApiError) {
    super(error.message);
    this.name = 'ApiRequestError';
  }
}

/**
 * 非流式端点的统一入口。响应契约是 shared/rest.ts 里的 `ApiResult`（前后端共用一份）。
 *
 * 判成败只看响应体的 `ok`，不看状态码：业务错误一律以 HTTP 200 承载
 * （上游 OpenAPI 就是这样，后端照实透传）。状态码只在"响应体压根不是这份契约"
 * 或"ok:true 却配了个 4xx/5xx"这种矛盾情况下才作为兜底依据。
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch (err) {
    throw new ApiRequestError(transportError(err instanceof Error ? err.message : 'fetch failed'));
  }

  let envelope: ApiResult<T>;
  try {
    envelope = (await response.json()) as ApiResult<T>;
  } catch {
    // 不是 JSON：反代错误页、连接被掐，只可能是传输层故障
    throw new ApiRequestError(
      transportError(`后端返回 ${response.status}，但响应体不是 JSON`, response.status),
    );
  }

  // 先判 ok 再看状态码：后端对尚未接入的端点刻意返回 501 + 一份诚实的 error envelope，
  // 那条 message 才是用户该看到的内容，不能被状态码盖掉。
  if (!envelope.ok) throw new ApiRequestError(envelope.error);
  if (response.status >= 400) {
    throw new ApiRequestError(transportError(`后端返回 ${response.status}`, response.status));
  }
  return envelope.result;
}

export function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: 'GET', signal });
}

export function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}
