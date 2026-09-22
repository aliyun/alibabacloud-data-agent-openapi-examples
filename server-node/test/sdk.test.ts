import { describe, expect, it } from 'vitest';

import * as $dara from '@darabonba/typescript';

import { DEFAULT_READ_TIMEOUT_MS } from '@das/shared';

import type { AppConfig } from '../src/config.js';
import { SdkError, assertSseCapable, createSdkClient, runtimeFor } from '../src/sdk.js';

/**
 * SDK 客户端的构造约束。
 *
 * 这里钉的是**一条会静默失效的保险**：prompt 是写操作（建表、跑 SQL、发布节点），
 * 一旦 SDK 替我们重试，同一个写操作就执行两遍，而失败形态恰好是"断流"——
 * 用户看到的是回答断了，实际是后端又发了一次。所以不能只断言"我们设了某个字段"，
 * 要断言 SDK 真正用来判重试的那个函数在我们的配置下返回 false。
 */
function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mock: false,
    mockRealtime: false,
    mockSpeed: 4,
    port: 3000,
    corsOrigin: ['http://localhost:5173'],
    regionId: 'cn-shanghai',
    endpoint: undefined,
    agentName: 'dataworks_data_agent',
    sessionSource: 'data-agent-openapi-demo',
    resourceGroupId: undefined,
    accessKeyId: 'LTAIfakefakefakefake1',
    accessKeySecret: 'fake-secret-value',
    serverHost: '127.0.0.1',
    webDist: undefined,
    ...overrides,
  };
}

describe('createSdkClient：重试必须关死', () => {
  const client = createSdkClient(config());
  // 类型写成非可选：字段存在本身就是被测断言，缺了由下面的 toBeInstanceOf 兜住
  const retryOptions = (client as unknown as { _retryOptions: $dara.RetryOptions })._retryOptions;

  it('Config 上显式写了 retryOptions.retryable=false', () => {
    expect(retryOptions).toBeInstanceOf($dara.RetryOptions);
    expect(retryOptions.retryable).toBe(false);
  });

  /**
   * 这条断言的是"SDK 的重试闸门真的读我们这份配置"，并且闸门是**敏感的**：
   * 喂一份 retryable:true + 匹配的 retryCondition 时它返回 true，
   * 所以我们这份返回 false 是配置在起作用，不是这个函数恒 false。
   *
   * 但它单独证明不了"我们设了字段"——实测把 `retryOptions` 整行删掉，
   * `shouldRetry(undefined, ctx)` 同样返回 false（源码里 `!options` 就短路），
   * 这条仍然是绿的。所以上一条断言不可省：真正的风险是 SDK 某天给
   * `config.retryOptions` 一个可重试的默认值，那时只有"我们显式写了 false"能挡住。
   *
   * `shouldRetry` 在 retriesAttempted===0 时恒 true（第一次总要试），
   * 之后才看 retryable——所以这里必须传 1 才是"会不会重发"的答案。
   */
  it('shouldRetry 读我们的配置：这份返回 false，一份可重试的配置返回 true', () => {
    const ctx = (name: string) =>
      ({ retriesAttempted: 1, exception: { name, code: 'InternalError' } }) as unknown as $dara.RetryPolicyContext;

    expect($dara.shouldRetry(retryOptions, ctx('ResponseError'))).toBe(false);

    const permissive = new $dara.RetryOptions({
      retryable: true,
      retryCondition: [{ exception: ['ResponseError'], errorCode: [], maxAttempts: 3 }],
    });
    expect($dara.shouldRetry(permissive, ctx('ResponseError'))).toBe(true);
  });

  it('两个 SSE 变体都在（缺了就会静默退化成整体 buffer，长轮必然超时）', () => {
    const record = client as unknown as Record<string, unknown>;
    expect(typeof record.promptAgentSessionWithSSE).toBe('function');
    expect(typeof record.loadAgentSessionWithSSE).toBe('function');
    expect(() => assertSseCapable(client)).not.toThrow();
  });
});

describe('createSdkClient：END_POINT 覆盖上游域名', () => {
  /**
   * 钉的是一条"留空 vs 覆盖"二选一、错一面就会**静默打到错误环境**的开关：
   * 预发/日常网关不在 SDK 的 `_endpointMap` 里，不显式覆盖就永远推导成生产域名，
   * 而请求照样能通、签名照样有效——你只会发现"怎么改的是生产数据"。
   */
  it('endpoint 非空 ⇒ 直接当 host（_endpoint 就是它），绕过 region 内置映射', () => {
    // 用假 host 测"覆盖"行为本身；真实预发网关值不进仓库（公共发布红线）
    const client = createSdkClient(config({ endpoint: 'gw-pre.example-gateway.test' }));
    expect((client as unknown as { _endpoint: string })._endpoint).toBe(
      'gw-pre.example-gateway.test',
    );
  });

  it('endpoint 留空 ⇒ 构造时按 region 推导出生产域名（预发不填 END_POINT 就会打到生产）', () => {
    const client = createSdkClient(config({ endpoint: undefined, regionId: 'cn-hangzhou' }));
    // 实测：SDK 在构造期就用 _endpointRule='regional' + _endpointMap 把 _endpoint 解析好，
    // 留空得到的是 dataworks.{region}.aliyuncs.com，不是空值。这正是要显式覆盖的原因。
    expect((client as unknown as { _endpoint: string })._endpoint).toBe(
      'dataworks.cn-hangzhou.aliyuncs.com',
    );
  });
});

describe('createSdkClient：缺凭证时如实报错且不回显任何片段', () => {
  it('抛 SdkError(kind=transport)，message 里只有环境变量名', () => {
    let caught: unknown;
    try {
      createSdkClient(config({ accessKeyId: undefined, accessKeySecret: undefined }));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SdkError);
    const apiError = (caught as SdkError).apiError;
    expect(apiError.kind).toBe('transport');
    expect(apiError.message).toContain('ALIBABA_CLOUD_ACCESS_KEY_ID');
    expect(apiError.message).toContain('ALIBABA_CLOUD_ACCESS_KEY_SECRET');
  });

  it('只缺 secret 也拦下来（半套凭证签不出有效签名，放过去只会得到一条 401）', () => {
    expect(() => createSdkClient(config({ accessKeySecret: '' }))).toThrow(SdkError);
  });
});

describe('assertSseCapable：SDK 太旧要在启动时说清楚', () => {
  it('缺变体时点名缺哪个、要求哪个版本下限', () => {
    let caught: unknown;
    try {
      assertSseCapable({} as never);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SdkError);
    const message = (caught as SdkError).apiError.message;
    expect(message).toContain('promptAgentSessionWithSSE');
    expect(message).toContain('loadAgentSessionWithSSE');
    expect(message).toContain('8.2.0');
  });
});

describe('runtimeFor：超时按调用点给，不按全局给', () => {
  it('默认走 DEFAULT_READ_TIMEOUT_MS，显式传值时覆盖（load 要一个远小的独立超时）', () => {
    expect(runtimeFor().readTimeout).toBe(DEFAULT_READ_TIMEOUT_MS);
    expect(runtimeFor(30_000).readTimeout).toBe(30_000);
    expect(runtimeFor(30_000).connectTimeout).toBe(10_000);
  });

  it('每次调用是新实例（共用一个的话，某个调用点改超时会影响其他调用点）', () => {
    expect(runtimeFor()).not.toBe(runtimeFor());
  });
});
