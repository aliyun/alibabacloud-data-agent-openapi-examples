import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerAttachmentRoutes } from '../src/daemon/attachments.js';
import type { SdkClient } from '../src/sdk.js';

it('requires a trusted OSS origin before exposing attachment uploads', async () => {
  const app = Fastify();
  try {
    await expect(registerAttachmentRoutes(app, {} as SdkClient)).rejects.toThrow('DAS_SESSION_ATTACHMENT_OSS_ORIGIN');
    await expect(registerAttachmentRoutes(app, {} as SdkClient, 'http://bucket.test')).rejects.toThrow('HTTPS origin');
  } finally { await app.close(); }
});

it.each([5, 10 * 1024 * 1024])('uploads %i bytes through OSS and completes with metadata only', async size => {
  const app = Fastify();
  const origin = 'https://attachments.example.test';
  const id = 'b'.repeat(32);
  const content = Buffer.alloc(size, 0xff);
  const md5 = createHash('md5').update(content).digest();
  const name = '数据.bin';
  const receipt = { id, name, relativePath: `upload/session-1_${id}.bin`, size };
  const prepared = { UploadId: id, Signature: {
    Url: `${origin}/staged?x-oss-signature-version=OSS4-HMAC-SHA256&x-oss-additional-headers=content-length&x-oss-signature=test`,
    Headers: { 'Content-Type': 'application/octet-stream', 'Content-MD5': md5.toString('base64'), 'Content-Length': String(size),
      'x-oss-object-acl': 'private', 'x-oss-forbid-overwrite': 'true' },
  } };
  const callApi = vi.fn().mockResolvedValueOnce({ body: { JsonRpcResponse: { Result: prepared } } })
    .mockResolvedValueOnce({ body: { JsonRpcResponse: { Result: receipt } } });
  const put = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  const upload = (payload: Buffer, filename = name) => app.inject({ method: 'POST', url: '/openapi/sessions/session-1/attachments',
    headers: { 'content-type': 'application/octet-stream', 'x-attachment-name': encodeURIComponent(filename) }, payload });
  try {
    await registerAttachmentRoutes(app, { callApi } as unknown as SdkClient, origin);
    expect((await upload(Buffer.alloc(10 * 1024 * 1024 + 1))).statusCode).toBe(413);
    expect((await upload(content, '../invalid.bin')).statusCode).toBe(400);
    expect(callApi).not.toHaveBeenCalled();
    const result = await upload(content);
    expect(result.statusCode).toBe(201);
    expect(result.json()).toEqual(receipt);
    const controls = callApi.mock.calls.map(([, request]) => JSON.parse(request.body.Params));
    expect(controls).toEqual([
      { SessionId: 'session-1', Name: name, UploadMode: 'prepare', Size: size, ContentMd5: md5.toString('hex') },
      { SessionId: 'session-1', Name: name, UploadMode: 'complete', Size: size, ContentMd5: md5.toString('hex'), UploadId: id },
    ]);
    expect(callApi.mock.calls.every(([action]) => action.action === 'UploadAgentSessionFile')).toBe(true);
    expect(callApi.mock.calls[1]?.[2]).toMatchObject({ readTimeout: 65_000, autoretry: false, maxAttempts: 1 });
    expect(put).toHaveBeenCalledTimes(1);
    const sent = put.mock.calls[0]?.[1];
    expect(sent?.body).toBeInstanceOf(ArrayBuffer);
    expect(Buffer.from(sent!.body as ArrayBuffer).equals(content)).toBe(true);
    expect(sent?.redirect).toBe('error');
    expect(Object.fromEntries(new Headers(sent?.headers))).toEqual(Object.fromEntries(new Headers(prepared.Signature.Headers)));

    for (const signature of [
      { ...prepared.Signature, Url: 'https://other.example.test/staged?signature=test' },
      { ...prepared.Signature, Url: `${origin}/staged?x-oss-signature-version=OSS4-HMAC-SHA256` },
      { Url: prepared.Signature.Url },
      { ...prepared.Signature, Headers: { ...prepared.Signature.Headers, 'Content-Length': '1' } },
    ]) {
      callApi.mockResolvedValueOnce({ body: { JsonRpcResponse: { Result: { ...prepared, Signature: signature } } } });
      expect((await upload(content)).statusCode).toBe(502);
      expect(put).toHaveBeenCalledTimes(1);
    }

    const calls = callApi.mock.calls.length;
    callApi.mockResolvedValueOnce({ body: { JsonRpcResponse: { Result: prepared } } });
    put.mockRejectedValueOnce(new Error('lost PUT response'));
    expect((await upload(content)).statusCode).toBe(502);
    expect(callApi).toHaveBeenCalledTimes(calls + 1);
    expect(put).toHaveBeenCalledTimes(2);

    callApi.mockRejectedValueOnce(new Error('lost prepare response'));
    expect((await upload(content)).statusCode).toBe(502);
    expect(callApi).toHaveBeenCalledTimes(calls + 2);
    expect(put).toHaveBeenCalledTimes(2);
  } finally {
    put.mockRestore();
    await app.close();
  }
});
