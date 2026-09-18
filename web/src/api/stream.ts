import { WIRE_CONTENT_TYPE, parseWireLine, transportError, type ApiError, type WireEvent } from '@das/shared';

import { API_BASE } from './client';

/**
 * 用 fetch + ReadableStream 手解 NDJSON。
 *
 * 为什么不用 EventSource：它只支持 GET，而 prompt 必须带 POST body；
 * 也不该用 SSE：SSE 的 `id:` / `Last-Event-ID` 语义暗示可以断点续传，
 * 而 BeginLogOffset 实测是死参数，服务端没有增量续传能力。
 *
 * 这里刻意**不在传输层判断成败**：业务错误也是 HTTP 200 承载的，真正的错误是
 * 流里的 `error` 事件。只有连接根本建立不起来（fetch 抛、5xx、非 NDJSON 响应体）
 * 才由这里合成一个 error 事件，让上层只有一条处理路径。
 */
export async function* openPromptStream(
  sessionId: string,
  text: string,
  signal?: AbortSignal,
): AsyncGenerator<WireEvent, void, undefined> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: WIRE_CONTENT_TYPE },
      body: JSON.stringify({ text }),
      signal,
    });
  } catch (err) {
    // 主动 abort 不是错误：那是"停止接收"，由调用方自己落 phase
    if (signal?.aborted) return;
    yield {
      type: 'error',
      rid: '',
      error: transportError(err instanceof Error ? err.message : 'fetch failed'),
    };
    return;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.includes(WIRE_CONTENT_TYPE)) {
    yield { type: 'error', rid: '', error: await errorFromBody(response) };
    return;
  }
  if (!response.body) {
    yield {
      type: 'error',
      rid: '',
      error: transportError('响应没有 body，无法读取流', response.status),
    };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // 一行可能跨多个 chunk 到达；只按 '\n' 切，最后一段留在 buffer 里等下一个 chunk
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const event = parseWireLine(line);
        // 解不出来的行直接丢：多一行垃圾不该让整条流崩掉
        if (event) yield event;
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    const tail = parseWireLine(buffer);
    if (tail) yield tail;
  } finally {
    // 提前 return（用户点了停止接收）时释放 reader，否则连接会挂着不关
    await reader.cancel().catch(() => undefined);
  }
}

/** 连接层的失败（5xx、反代插了个 HTML 错误页）也要归一成 ApiError。 */
async function errorFromBody(response: Response): Promise<ApiError> {
  try {
    const body = (await response.clone().json()) as { ok?: boolean; error?: ApiError };
    // 后端对"还没接入的端点"刻意返回 501 + 一个诚实的 error envelope，
    // 那条 message 才是用户该看到的内容，不能被状态码盖掉。
    if (body && body.ok === false && body.error) return body.error;
  } catch {
    // 不是 JSON（反代错误页、连接被掐），落到下面的文本兜底
  }
  let text = '';
  try {
    text = (await response.text()).slice(0, 200);
  } catch {
    // 读不出来就算了，状态码已经够定位
  }
  return transportError(`HTTP ${response.status}${text ? `：${text}` : ''}`, response.status);
}
