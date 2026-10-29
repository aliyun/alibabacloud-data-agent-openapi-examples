import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import type { SdkClient } from './sdk.js';
import { runtimeFor, runtimeForSse } from './sdk.js';
import { headerRequestId } from './normalize.js';
import { validRequestId } from '@das/shared';
import { initialConfigErrorMessage } from './initial-config-error.js';

/** Shared POP response handling; also covers Actions still absent from the generated SDK. */
export async function callOpenApi(client: SdkClient, action: string, params: Record<string, unknown>) {
  const response = await client.callApi(new $OpenApiUtil.Params({ action, version: '2024-05-18', protocol: 'HTTPS',
    pathname: '/', method: 'POST', authType: 'AK', style: 'RPC', reqBodyType: 'formData', bodyType: 'json' }),
  new $OpenApiUtil.OpenApiRequest({ body: { Jsonrpc: '2.0', Id: randomUUID(), Params: JSON.stringify(params) } }), runtimeFor());
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, val]) => [key[0]!.toLowerCase() + key.slice(1), normalize(val)])) : value;
  const body = normalize(response.body) as { requestId?: string; jsonRpcResponse?: { error?: { code?: string | number; errorCode?: string; message?: string; data?: unknown } } };
  const requestId = validRequestId(body?.requestId) ?? headerRequestId(response.headers);
  if (body?.jsonRpcResponse?.error) {
    const error = body.jsonRpcResponse.error;
    throw Object.assign(new Error(initialConfigErrorMessage(error, `${action} failed`)), { code: error.code, errorCode: error.errorCode,
      statusCode: response.statusCode, requestId, data: { RequestId: requestId, Code: error.code, ErrorCode: error.errorCode } });
  }
  return { ...response, body };
}

export async function openSessionEvents(client: SdkClient, sessionId: string, lastEventId?: string) {
  const response = await client.callApi(new $OpenApiUtil.Params({ action: 'GetAgentSessionEvents', version: '2024-05-18',
    protocol: 'HTTPS', pathname: '/', method: 'GET', authType: 'AK', style: 'RPC', reqBodyType: 'formData', bodyType: 'binary' }),
  new $OpenApiUtil.OpenApiRequest({ headers: { accept: 'text/event-stream', ...(lastEventId ? { 'Last-Event-Id': lastEventId } : {}) },
    query: { SessionCode: sessionId } }), runtimeForSse());
  return { body: response.body as Readable, headers: response.headers as Record<string, string>, statusCode: response.statusCode as number };
}

export interface RawSseEvent { id?: string; event?: string; data: string }

/** Incremental UTF-8 and CRLF-safe SSE parser; comments/heartbeats never consume a cursor. */
export async function* parseSse(source: AsyncIterable<Buffer | string>): AsyncGenerator<RawSseEvent> {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let fields: string[] = [];
  let frameSize = 0;
  const parse = (lines: string[]): RawSseEvent | undefined => {
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of lines) {
      const colon = line.indexOf(':');
      const name = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (name === 'id' && !value.includes('\0')) id = value;
      if (name === 'event') event = value;
      if (name === 'data') data.push(value);
    }
    return data.length ? { id, event, data: data.join('\n') } : undefined;
  };
  for await (const chunk of source) {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    if (buffer.length > 4 * 1024 * 1024) throw new Error('SSE 帧超过大小限制');
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line) {
        frameSize += line.length;
        if (frameSize > 4 * 1024 * 1024) throw new Error('SSE 帧超过大小限制');
        fields.push(line);
      }
      else {
        const frame = parse(fields); fields = []; frameSize = 0;
        if (frame) yield frame;
      }
    }
  }
  buffer += decoder.end();
  // An unterminated SSE event is incomplete, not a successful frame.
}
