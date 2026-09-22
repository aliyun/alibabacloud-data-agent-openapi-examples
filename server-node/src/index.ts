import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';

import { apiError, type ApiResult } from '@das/shared';

import { describeConfig, loadConfig, type AppConfig } from './config.js';
import { registerDaemonRoutes } from './daemon/routes.js';
import { registerPromptRoutes } from './routes/prompt.js';
import { registerRestRoutes } from './routes/rest.js';
import { createSdkClient } from './sdk.js';

/** 只接受本机回环的 Host。见下面 onRequest 钩子里的解释。 */
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export async function buildServer(cfg: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    /**
     * Node 的 `server.requestTimeout`（18 起默认 300000）约束的是**从客户端收完整个请求**
     * 的时长，不管响应写多久，所以它并不是长轮的天敌；真正会掐长响应的是
     * `server.timeout`（socket 不活动超时，Node 13 起默认 0）与反向代理的 read timeout。
     * 这里仍显式写 0（与 Fastify 默认一致），下面断言的则是 `server.timeout`。
     * 反代需允许长流；空闲超时应与心跳配合，不设置响应总时长上限。
     */
    requestTimeout: 0,
  });

  /**
   * Host 白名单——**只在本地开发模式生效**（SERVER_HOST 为默认 127.0.0.1）。
   *
   * 只绑 127.0.0.1 **挡不住 DNS rebinding**：攻击者把自己的域名解析到 127.0.0.1，
   * 受害者浏览器就会带着 `Host: attacker.example` 向这个进程发请求，而进程手里
   * 握着 AK/SK、能代用户建会话、发 prompt（写操作）。校验 Host 是最便宜的一道闸。
   * 跨源读取另有 CORS 兜着，但 CORS 只管"能不能读到响应"，管不住"请求已经发出去了"。
   *
   * 容器/内网部署（SERVER_HOST=0.0.0.0）时跳过：探活与流量来自 pod IP/集群域名，
   * Host 无法枚举；此时信任边界是部署网络本身（集群外进不来），白名单失去意义。
   */
  const localMode = cfg.serverHost === '127.0.0.1';
  if (localMode) {
    app.addHook('onRequest', async (request, reply) => {
      const raw = request.headers.host ?? '';
      // IPv6 字面量形如 [::1]:3000，先去掉端口再比
      const hostname = raw.replace(/:\d+$/, '');
      if (!ALLOWED_HOSTS.has(hostname)) {
        request.log.warn({ host: raw }, '拒绝：Host 不在白名单内（可能是 DNS rebinding）');
        return reply.code(403).send({
          ok: false,
          error: apiError(
            'transport',
            `拒绝处理 Host 为 ${raw || '(缺失)'} 的请求。这个代理持有云凭证并能发起写操作，` +
              `只接受 ${[...ALLOWED_HOSTS].join(' / ')} 的 Host；请通过 http://127.0.0.1:${cfg.port} 访问。`,
          ),
        } satisfies ApiResult<never>);
      }
    });
  }

  await app.register(cors, {
    origin: cfg.corsOrigin,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // application/x-ndjson 不是简单类型，浏览器会先发预检；
    // 这里不放开 credentials，前端不带 cookie，AK/SK 只在后端进程里。
    // 其余头是 daemon 兼容层（/d）的需要：@qwen-code/sdk 发的请求头必须放行预检，
    // 它要读的响应头（事件纪元 / SSE 流 id / 重试提示）必须显式 expose。
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-qwen-client-id',
      'last-event-id',
      'x-qwen-event-epoch',
    ],
    exposedHeaders: ['retry-after', 'x-qwen-event-epoch', 'x-qwen-sse-stream-id'],
  });

  /**
   * MOCK 模式下**绝不**构造 Client。
   *
   * 这不是省一次对象分配：只要进程里存在一个能用的 Client，
   * "以为在测真实链路、其实在看录像"这类自欺就少了一道屏障。
   * LIVE 模式下构造失败（缺凭证、SDK 太旧没有 SSE 变体）就让进程直接起不来——
   * 带病启动比启动失败难查得多。
   */
  const client = cfg.mock ? undefined : createSdkClient(cfg);
  if (client) {
    app.log.info({ region: cfg.regionId }, 'SDK Client 已构造（LIVE 模式，两个 *WithSSE 变体已断言存在）');
  }

  await registerRestRoutes(app, cfg, client);
  await registerPromptRoutes(app, cfg, client);
  await registerDaemonRoutes(app, cfg, client);

  /**
   * 同源托管前端构建产物（单容器交付 UI+API）。
   *
   * 只在 web/dist 存在时挂载（本地 dev 不构建前端，走了 Vite dev server）；
   * SPA 回退：非 /api 的 GET 一律回 index.html，刷新 /session/xxx 这类深链不 404。
   * API 404 仍走 Fastify 默认 JSON 404——在注册静态**之前**的路由不受影响。
   */
  if (cfg.webDist && existsSync(cfg.webDist)) {
    await app.register(fastifyStatic, { root: cfg.webDist, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      // /d/ 是 daemon 兼容层（plugin 内有自己的 404 handler，不会走到这）；
      // 这里的排除是防御：万一前缀路由没接住，也别把 API 404 回成 index.html
      if (request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/d/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ ok: false, error: apiError('transport', `not found: ${request.url}`) });
    });
    app.log.info({ webDist: cfg.webDist }, '同源托管前端构建产物（SPA 回退已开启）');
  }


  /**
   * `server.timeout` 是 socket **不活动**超时（Node 13 起默认 0）。它才是能静默掐断长响应的那个：
   * 15s 心跳能让 socket 一直有活动，所以正常情况下撞不到；但一旦有人把它设成小于心跳间隔，
   * 或者中间层先断，用户看到的就是"流莫名断掉"——最难查的一类问题，所以启动时点名一次。
   */
  if (app.server.timeout !== 0) {
    app.log.warn(
      { serverTimeout: app.server.timeout },
      'http server timeout 非 0：socket 不活动超过这个时长会被静默断开，长轮响应可能被掐（本工程心跳 15s）',
    );
  }

  return app;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = await buildServer(cfg);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      void app.close().then(() => process.exit(0));
    });
  }

  // 绑定地址：本地开发绑 127.0.0.1（这个进程持有 AK/SK 并能代你调写操作，
  // 暴露到局域网等于把凭证的使用权一起暴露；需要远程访问请自己加认证层）。
  // 容器/内网部署设 SERVER_HOST=0.0.0.0，信任边界换成部署网络。
  await app.listen({ port: cfg.port, host: cfg.serverHost });

  process.stdout.write(`\n${describeConfig(cfg)}\n\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`\n启动失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n\n`);
  process.exit(1);
});
