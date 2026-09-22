import { createRequire } from 'node:module';

import { $OpenApiUtil } from '@alicloud/openapi-core';
import * as $dara from '@darabonba/typescript';
import * as DataWorksSdk from '@alicloud/dataworks-public20240518';

import { DEFAULT_READ_TIMEOUT_MS, apiError, type ApiError } from '@das/shared';

import type { AppConfig } from './config.js';

export type SdkClient = import('@alicloud/dataworks-public20240518').default;

/** 普通请求的连接超时；SSE 须避开 httpx 将其同时用作 socket 空闲超时的行为。 */
const CONNECT_TIMEOUT_MS = 10_000;

/** SSE 变体从 8.2.0 起才有；低于它就没有增量帧，只能整体 buffer 到超时。 */
const SDK_MIN_VERSION = '8.2.0';

const require = createRequire(import.meta.url);

/**
 * 构造 SDK Client 的唯一入口。全工程只在这里 new 一次。
 *
 * 三件必须写死的事：
 *  1. **凭证只从 cfg 来**：不读 `~/.aliyun/config.json`、不调 `aliyun` CLI、不挂任何
 *     默认凭证链。回落路径会让"我以为在用 A 身份、其实在用 B 身份"这类问题无从排查，
 *     而本机 CLI profile 恰好全是 OAuth 模式，SDK 的凭证链根本拾取不到。
 *  2. **endpoint 默认交给 SDK 推导，只在 cfg.endpoint 非空时显式覆盖**：
 *     `_endpointRule='regional'` + `_endpointMap` 已经把 `cn-hangzhou →
 *     dataworks.cn-hangzhou.aliyuncs.com` 这类映射内置了，生产 region 不用自己拼，
 *     省掉换 region 时要同步改的一处。但预发/日常网关（形如 `PRE-GATEWAY.example.com`，
 *     具体值见内部环境配置，不写进本仓库）
 *     **不在这张映射表里**，推导出来的永远是生产域名——这种情况必须靠 `END_POINT` 显式覆盖。
 *     已核实 openapi-core 的 client：`config.endpoint` 非空时直接赋给 `_endpoint` 当 host；
 *     留空时 SDK 在**构造期**就用 `_endpointRule='regional'` + `_endpointMap` 把 `_endpoint`
 *     解析成 `dataworks.{region}.aliyuncs.com`（生产域名）——所以"留空 = 行为不变"对生产 region 成立，
 *     但对预发是陷阱：不填 END_POINT，请求会静默打到生产（签名照样有效，你只会发现改错了数据）。
 *  3. **构造完立刻断言 SSE 变体存在**（见 assertSseCapable）。
 */
export function createSdkClient(cfg: AppConfig): SdkClient {
  if (!cfg.accessKeyId || !cfg.accessKeySecret) {
    throw withError(
      apiError('transport', '缺少 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET'),
    );
  }

  const ClientCtor = resolveClientConstructor();
  const client = new ClientCtor(
    new $OpenApiUtil.Config({
      accessKeyId: cfg.accessKeyId,
      accessKeySecret: cfg.accessKeySecret,
      regionId: cfg.regionId,
      // 留空时 SDK 按 regionId 走内置映射；非空时直接当 host，覆盖映射（预发/日常网关靠它）。
      endpoint: cfg.endpoint,
      // 不在这里设 readTimeout：Config 上的超时是全局的，而 load 需要一个远小于
      // 默认值的独立超时（见 HISTORY_READ_TIMEOUT_MS）。超时一律走 RuntimeOptions。
      connectTimeout: CONNECT_TIMEOUT_MS,
      /**
       * **关掉重试的唯一有效开关在这里，不在 RuntimeOptions 上。**
       *
       * 已核实（@alicloud/openapi-core 的 client.js）：`doRPCRequest` 与 `callSSEApi`
       * 组装 `_runtime` 时把 `retryOptions` 硬赋成 client 级的 `this._retryOptions`
       * （来自 `config.retryOptions`），**连 RuntimeOptions 上的同名字段都一并忽略**；
       * 重试循环的条件是 `$dara.shouldRetry(_runtime.retryOptions, ctx)`，
       * 它在 `retryOptions` 为 undefined 或 `retryable:false` 时从第二次尝试起返回 false。
       * 也就是说今天不重试的原因是"没人设过 retryOptions"，而不是我们设了什么——
       * SDK 升级把默认值改成可重试，prompt 就会被重发，那是同一个写操作执行两遍。
       * 所以这里显式写死 retryable:false，把"不重试"变成本工程自己的断言。
       */
      retryOptions: new $dara.RetryOptions({ retryable: false }),
    }),
  );

  assertSseCapable(client);
  return client;
}

/**
 * 每次调用现造一个 RuntimeOptions，而不是共用一个实例。这里唯一真正生效的是两个超时。
 *
 * `autoretry:false / maxAttempts:1` 在**当前 SDK 上是死字段**，别被它们骗了：
 * 已核实 `@alicloud/openapi-core` 的产物里这两个词出现 0 次，重试由
 * `$dara.shouldRetry(retryOptions, ctx)` 决定，而读 `autoretry/maxAttempts` 的
 * 是 `@darabonba/typescript` 的遗留 `allowRetry`，openapi-core 根本不调用它。
 * 真正关掉重试的开关是 createSdkClient 里 Config 上的 `retryOptions`。
 *
 * 留着这两个字段不是装饰：万一 SDK 换回 Tea 的 `allowRetry` 语义，
 * 默认重试会在 readTimeout / socket 错误时把 `PromptAgentSession` 这个写操作重发一遍
 * （建表、跑 SQL、发布节点都会重复做），而断流恰好是以"流中断"的形式出现的。
 */
export function runtimeFor(readTimeoutMs: number = DEFAULT_READ_TIMEOUT_MS): $dara.RuntimeOptions {
  return new $dara.RuntimeOptions({
    autoretry: false,
    maxAttempts: 1,
    readTimeout: readTimeoutMs,
    connectTimeout: CONNECT_TIMEOUT_MS,
  });
}

/**
 * httpx passes connectTimeout to node:http's socket timeout and never clears it
 * after connection. Keeping it at 10s aborts established SSE streams during a
 * question/model pause, even with a 600s readTimeout. Use the stream's budget
 * for both timers. This also allows connection setup to wait that long; retries
 * stay disabled and a real stream failure remains an error.
 */
export function runtimeForSse(readTimeoutMs: number = DEFAULT_READ_TIMEOUT_MS): $dara.RuntimeOptions {
  const runtime = runtimeFor(readTimeoutMs);
  runtime.connectTimeout = readTimeoutMs;
  return runtime;
}

/**
 * SDK 是 CJS，而 Node 的 ESM→CJS interop **不认 `__esModule`**：
 * `import DataWorks from '@alicloud/dataworks-public20240518'` 拿到的是整个
 * `module.exports` 命名空间（2316 个模型 + `default`），真正的 Client 类在
 * `.default` 上。直接 `new DataWorks(config)` 会抛 "is not a constructor"，
 * 而 TypeScript 按 .d.ts 里的 `export default class Client` 检查，编译期一声不响。
 */
function resolveClientConstructor(): new (config: $OpenApiUtil.Config) => SdkClient {
  const interop = (DataWorksSdk as { default?: unknown }).default;
  const ctor =
    typeof interop === 'function'
      ? interop
      : (interop as { default?: unknown } | undefined)?.default;
  if (typeof ctor !== 'function') {
    throw withError(
      apiError(
        'transport',
        `无法从 @alicloud/dataworks-public20240518 解析出 Client 构造函数（当前安装版本 ${installedSdkVersion()}）`,
      ),
    );
  }
  return ctor as new (config: $OpenApiUtil.Config) => SdkClient;
}

/**
 * 启动即断言两个 SSE 变体存在。
 *
 * 缺了它们的后果不是报错，而是**静默退化成整体 buffer**：普通
 * `promptAgentSessionWithOptions` 走 `callApi` + `bodyType:'json'`，
 * 一轮 7~220s 的调用会一直等到结束才返回，期间一帧也拿不到，最后必然超时。
 * 与其让用户对着"卡住不动"的界面猜，不如在启动时把版本要求说清楚。
 */
export function assertSseCapable(client: SdkClient): void {
  const missing = (['promptAgentSessionWithSSE', 'loadAgentSessionWithSSE'] as const).filter(
    (name) => typeof (client as unknown as Record<string, unknown>)[name] !== 'function',
  );
  if (missing.length > 0) {
    throw withError(
      apiError(
        'transport',
        `SDK 缺少 ${missing.join(' / ')}，需要 @alicloud/dataworks-public20240518 >= ${SDK_MIN_VERSION}` +
          `（当前安装版本 ${installedSdkVersion()}）。没有 SSE 变体就只能整体 buffer，长轮必然超时。`,
      ),
    );
  }
}

function installedSdkVersion(): string {
  try {
    const pkg = require('@alicloud/dataworks-public20240518/package.json') as { version?: string };
    return pkg.version ?? '未知';
  } catch {
    return '未知';
  }
}

/** 把 ApiError 挂到异常上，让路由层能原样取出归一化错误，不必再从字符串里反解。 */
export class SdkError extends Error {
  readonly apiError: ApiError;

  constructor(apiError: ApiError) {
    super(apiError.message);
    this.name = 'SdkError';
    this.apiError = apiError;
  }
}

function withError(apiError: ApiError): SdkError {
  return new SdkError(apiError);
}
