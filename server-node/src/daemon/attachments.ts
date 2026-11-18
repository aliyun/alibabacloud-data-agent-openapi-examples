import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { callOpenApi } from '../openapi.js';
import { readNonStreamBody, toApiError } from '../normalize.js';
import { runtimeForCreate, type SdkClient } from '../sdk.js';

const ACTION = 'UploadAgentSessionFile';
const MAX_STAGED_BYTES = 10 * 1024 * 1024;
// Allow the 60s BFF handler to return its own error before the SDK socket expires.
const UPLOAD_POP_TIMEOUT_MS = 65_000;

function callUpload(client: SdkClient, params: Record<string, unknown>) {
  return callOpenApi(client, ACTION, params, runtimeForCreate(UPLOAD_POP_TIMEOUT_MS));
}

function isUploadSizeRejection(error: unknown) {
  return toApiError(error, ACTION).upstreamStatus === 413 ||
    (error instanceof Error && 'code' in error && error.code === 'RequestFormTooLarge');
}

export function attachmentMaxBytes(): number {
  return MAX_STAGED_BYTES;
}

async function uploadThroughOss(client: SdkClient, origin: string, sessionId: string, name: string, content: Buffer) {
  const md5 = createHash('md5').update(content).digest();
  const metadata = { SessionId: sessionId, Name: name, Size: content.length, ContentMd5: md5.toString('hex') };
  const prepared = readNonStreamBody(await callUpload(client, { ...metadata, UploadMode: 'prepare' })).result;
  const signature = prepared?.signature;
  if (!prepared || typeof prepared.uploadId !== 'string' || !/^[a-f0-9]{32}$/.test(prepared.uploadId) ||
      !signature || typeof signature !== 'object' || !('url' in signature) || typeof signature.url !== 'string') {
    throw new Error('上传服务返回了无效的签发信息');
  }
  const url = new URL(signature.url);
  if (url.origin !== origin || url.username || url.password || url.hash || !url.search) {
    throw new Error('上传服务返回了非信任的对象地址');
  }
  if (url.searchParams.get('x-oss-signature-version') !== 'OSS4-HMAC-SHA256' ||
      !url.searchParams.get('x-oss-additional-headers')?.split(';').includes('content-length')) {
    throw new Error('上传地址未绑定文件大小');
  }
  if (!('headers' in signature) || !signature.headers || typeof signature.headers !== 'object' ||
      Array.isArray(signature.headers) || Object.values(signature.headers).some(value => typeof value !== 'string')) {
    throw new Error('上传服务未返回有效的签名请求头');
  }
  const headers = new Headers(signature.headers as Record<string, string>);
  const expectedHeaders = { 'content-type': 'application/octet-stream', 'content-md5': md5.toString('base64'),
    'content-length': String(content.length), 'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true' };
  if (Object.entries(expectedHeaders).some(([name, value]) => headers.get(name) !== value)) {
    throw new Error('上传服务返回的签名请求头与文件信息不一致');
  }
  let response: Response;
  try {
    response = await fetch(url, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers, body: new Uint8Array(content).buffer });
  } catch {
    throw new Error('附件写入对象存储失败');
  }
  await response.body?.cancel();
  if (!response.ok) throw new Error(`附件写入对象存储失败（HTTP ${response.status}）`);
  return callUpload(client, { ...metadata, UploadMode: 'complete', UploadId: prepared.uploadId });
}

export async function registerAttachmentRoutes(app: FastifyInstance, client: SdkClient, ossOrigin?: string): Promise<void> {
  if (!ossOrigin) throw new Error('启用附件上传时必须配置 DAS_SESSION_ATTACHMENT_OSS_ORIGIN');
  const configured = new URL(ossOrigin);
  if (configured.protocol !== 'https:' || configured.origin !== ossOrigin) {
    throw new Error('DAS_SESSION_ATTACHMENT_OSS_ORIGIN 必须是 HTTPS origin');
  }
  // The parser is encapsulated so other daemon endpoints keep their existing body handling.
  await app.register(async routes => {
    routes.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' },
      (_request, body, done) => done(null, body));
    routes.post<{ Params: { id: string }; Body: Buffer }>('/openapi/sessions/:id/attachments',
      { bodyLimit: attachmentMaxBytes() }, async (request, reply) => {
        const sessionId = request.params.id;
        const content = request.body;
        let name = '';
        try {
          name = decodeURIComponent(String(request.headers['x-attachment-name'] ?? ''));
        } catch {
          return reply.code(400).send({ error: '文件名编码无效' });
        }
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !Buffer.isBuffer(content) || !content.length ||
            !name.trim() || Buffer.byteLength(name) > 255 || /[/\\\u0000-\u001f\u007f]/u.test(name) ||
            name === '.' || name === '..') {
          return reply.code(400).send({ error: '会话、文件名或文件内容无效' });
        }
        try {
          const response = await uploadThroughOss(client, ossOrigin, sessionId, name, content);
          const result = readNonStreamBody(response).result;
          const extension = /\.[A-Za-z0-9]{1,12}$/.exec(name.slice(1))?.[0] ?? '';
          if (!result || typeof result.id !== 'string' || !/^[a-f0-9]{32}$/.test(result.id) || result.name !== name ||
              result.relativePath !== `upload/${sessionId}_${result.id}${extension}` || result.size !== content.length) {
            return reply.code(502).send({ error: '上传服务返回了无效的附件信息' });
          }
          return reply.code(201).send({ id: result.id, name, relativePath: result.relativePath, size: result.size });
        } catch (error) {
          const upstream = toApiError(error, ACTION);
          if (isUploadSizeRejection(error)) {
            return reply.code(413).send({ error: '文件编码后超过上传网关的单次请求大小限制', requestId: upstream.requestId });
          }
          return reply.code(502).send({ error: upstream.message, requestId: upstream.requestId });
        }
      });
  });
}
