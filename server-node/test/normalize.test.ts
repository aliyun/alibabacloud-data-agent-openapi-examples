import { ClientError, ServerError, ThrottlingError } from '@alicloud/openapi-core';
import { ResponseError } from '@darabonba/typescript';
import { describe, expect, it } from 'vitest';

import { toApiError } from '../src/normalize.js';

/**
 * 上游鉴权类报文会把**调用方自己的 AccessKeyId 原文回显出来**，而 toApiError 的产物
 * 既打到终端又经 /api/check 渲染进前端。下面这个 AK 与 IP 都是假的
 * （IP 用 TEST-NET-3 文档段），报文结构逐字照抄 2026-09-15 真实抓到的那条 401。
 */
const FAKE_AK = 'LTAIfakefakefakefake1';
const CAPTURED_401 =
  'Please contact Alibaba Security Team via DingTalk. Dingtalk group ID: 22245043795. ' +
  `Deny: ${FAKE_AK}|source ip: 203.0.113.7 request id: 01A0A4F2-BD8E-59B4-972B-00E4CA265A0C`;

function unauthorized(): ResponseError {
  return new ResponseError({
    code: 'Unauthorized',
    message: CAPTURED_401,
    data: { statusCode: 401, Code: 'Unauthorized', Message: CAPTURED_401 },
  });
}

describe('toApiError：上游回显的 AccessKeyId 必须在出口被隐去', () => {
  it('message 里不再出现 AK，但 Deny 与来源 IP 的语义原样保留', () => {
    const err = toApiError(unauthorized(), 'ListAgentSessions');

    expect(err.message).not.toContain(FAKE_AK);
    expect(err.message).not.toMatch(/LTAI[A-Za-z0-9]+/);
    expect(err.message).toContain('<AccessKeyId 已隐去>');
    // 这两条是判断"是否被身份级安全管控拦下"的依据，脱敏不能把它们一起抹掉
    expect(err.message).toContain('Deny:');
    expect(err.message).toContain('source ip: 203.0.113.7');
  });

  /**
   * 回归：`/g` 正则的 `.test()` 会推进 lastIndex。曾经先 test 再 replace，
   * 结果是隔次调用漏匹配——第一次脱敏、第二次把 AK 原样放出去。
   * 交替断言三次，任何一次残留都会红。
   */
  it('连续调用不因为正则 lastIndex 状态而漏脱敏', () => {
    for (let i = 0; i < 3; i += 1) {
      const err = toApiError(unauthorized(), 'ListAgentSessions');
      expect(err.message, `第 ${i + 1} 次调用`).not.toContain(FAKE_AK);
      expect(err.message, `第 ${i + 1} 次调用`).toContain('<AccessKeyId 已隐去>');
    }
  });

  it('一条报文里出现多个 AK 也全部隐去', () => {
    const err = toApiError(
      new Error(`Deny: ${FAKE_AK} fallback LTAIanotheranother1`),
      'CreateAgentSession',
    );
    expect(err.message).not.toMatch(/LTAI[A-Za-z0-9]+/);
    expect(err.message.match(/<AccessKeyId 已隐去>/g)).toHaveLength(2);
  });

  it('不含 AK 的错误原样通过，不被误伤', () => {
    const plain = toApiError(new Error('socket hang up'), 'PromptAgentSession');

    expect(plain.message).toBe('PromptAgentSession: socket hang up');
    expect(plain.kind).toBe('transport');
    expect(plain.retryable).toBe(true);
    expect(plain.upstreamStatus).toBeUndefined();
  });

  /**
   * 修复前这条是红的：401 掉进 `instanceof Error` 分支被归成 transport、
   * retryable=true、upstreamStatus 丢失。语义上正好写反——重发一次 401 只会再得到一次 401。
   */
  it('401 归 rpc_error 且不可重试，状态码可见', () => {
    const err = toApiError(unauthorized(), 'ListAgentSessions');

    expect(err.kind).toBe('rpc_error');
    expect(err.retryable).toBe(false);
    expect(err.upstreamStatus).toBe(401);
  });

  it('422 走异常路径归 session_ghost，且这个会话判死', () => {
    const err = toApiError(
      new ResponseError({
        code: 'UnprocessableEntity',
        message: 'prompt forward failed, upstream_status=422',
        data: { statusCode: 422 },
      }),
      'PromptAgentSession',
    );

    expect(err.kind).toBe('session_ghost');
    expect(err.fatalForSession).toBe(true);
    expect(err.upstreamStatus).toBe(422);
  });
});

/**
 * 钉住 normalize.ts 为什么不能只写 `instanceof ResponseError`。
 *
 * `@darabonba/typescript@1.0.5` 编译到 ES5，`__extends` 里 `_super.call(this, msg) || this`
 * 在 ES2015+ 的 Error 语义下返回一个**新的普通 Error**，子类实例就此丢失原型链。
 * 所以传输层抛出的这种裸 ResponseError 用 instanceof 认不出来，会掉进 `instanceof Error`
 * 分支被归成 retryable 的 transport，`upstreamStatus` 也丢了。
 * （`@alicloud/openapi-core` 的子类是真正的 ES class，instanceof 反而为 true，见下一组用例。）
 * 没有这组断言，将来有人"顺手清理"成 instanceof 也不会红，而失败形态是静默的。
 */
describe('darabonba 那一家：ES5 继承陷阱让 instanceof ResponseError 为 false', () => {
  it('原型链上没有 ResponseError.prototype，但字段都在', () => {
    const err = unauthorized();

    expect(err instanceof ResponseError).toBe(false);
    expect(Object.getPrototypeOf(err)).toBe(Error.prototype);
    // 正因如此只能按形状认：这两个字段是 toApiError 认它的唯一依据
    expect(err.name).toBe('ResponseError');
    expect(err.statusCode).toBe(401);
  });
});

/**
 * 上游真实的 4xx/5xx/429 走的是 `@alicloud/openapi-core` 那一家（AlibabaCloudError 的三个子类），
 * 它们的 instanceof 行为与 darabonba 自己的 ResponseError **恰好相反**。
 * isUpstreamHttpError 取两条判据的并集就是为了同时兜住两家；
 * 没有这组断言，将来有人把它简化成单一判据不会红，而失败形态是静默的。
 */
describe('openapi-core 那一家：instanceof 为 true，且带着上游给的明细', () => {
  it('ClientError 的 instanceof / name / statusCode 与 darabonba 那一家相反', () => {
    const err = new ClientError({ statusCode: 403, code: 'Forbidden.RAM', message: 'no privilege' });

    expect(err instanceof ResponseError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe('ClientError');
    expect(err.statusCode).toBe(403);
  });

  it('403 归 rpc_error 不可重试，且 accessDeniedDetail 出现在摘要里', () => {
    const err = toApiError(
      new ClientError({
        statusCode: 403,
        code: 'Forbidden.RAM',
        message: 'code: 403, User not authorized to operate on the specified resource',
        accessDeniedDetail: { AuthAction: 'dataworks:ListAgentSessions', NoPermissionType: 'ImplicitDeny' },
        requestId: 'rid-403',
      }),
      'ListAgentSessions',
    );

    expect(err.kind).toBe('rpc_error');
    expect(err.retryable).toBe(false);
    expect(err.upstreamStatus).toBe(403);
    // "到底缺哪条权限"只有这段明细说得清，message 里那句 no privilege 不够
    expect(err.message).toContain('dataworks:ListAgentSessions');
    expect(err.message).toContain('ImplicitDeny');
    expect(err.message).toContain('requestId=rid-403');
  });

  it('429 把上游的 retryAfter 原值带上，并如实说明单位未标注', () => {
    const err = toApiError(
      new ThrottlingError({
        statusCode: 429,
        code: 'Throttling.User',
        message: 'code: 429, Request was denied due to user flow control',
        retryAfter: 3000,
        requestId: 'rid-429',
      }),
      'PromptAgentSession',
    );

    expect(err.upstreamStatus).toBe(429);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('retryAfter=3000');
    expect(err.message).toContain('单位未标注');
  });

  it('5xx 的 ServerError 同样按上游事实报，不掉进 transport', () => {
    const err = toApiError(
      new ServerError({ statusCode: 503, code: 'ServiceUnavailable', message: 'code: 503, try later' }),
      'CancelAgentSession',
    );

    expect(err.kind).toBe('rpc_error');
    expect(err.upstreamStatus).toBe(503);
  });
});

describe('脱敏覆盖 STS 临时凭证', () => {
  it('STS. 前缀的身份标识也被隐去', () => {
    const err = toApiError(new Error('Deny: STS.fakefakefakefake1|source ip: 203.0.113.8'), 'ListAgents');

    expect(err.message).not.toContain('STS.fakefakefakefake1');
    expect(err.message).toContain('<AccessKeyId 已隐去>');
    expect(err.message).toContain('source ip: 203.0.113.8');
  });
});
