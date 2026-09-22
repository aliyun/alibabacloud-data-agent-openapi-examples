import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from '../src/config.js';
import { registerDaemonRoutes } from '../src/daemon/routes.js';

function mockCfg(): AppConfig {
  return {
    mock: true,
    mockRealtime: false,
    mockSpeed: 4,
    port: 0,
    corsOrigin: ['http://localhost:5173'],
    regionId: 'cn-hangzhou',
    endpoint: undefined,
    agentName: 'dataworks_data_agent',
    sessionSource: 'data-agent-openapi-demo',
    resourceGroupId: undefined,
    accessKeyId: undefined,
    accessKeySecret: undefined,
    serverHost: '127.0.0.1',
    webDist: undefined,
  };
}

interface SseFrame {
  id: number | undefined;
  event: string;
  /** SSE `data:` 行 = 完整 DaemonEvent 信封（{v,type,data,id}），载荷在 envelope.data 里。 */
  envelope: { v: number; type: string; data: Record<string, unknown>; id?: number };
}

/** session_update 帧的 update 子类型（envelope.data.update.sessionUpdate）。 */
function updateKind(frame: SseFrame): string | undefined {
  const data = frame.envelope.data as { update?: { sessionUpdate?: string } } | undefined;
  return data?.update?.sessionUpdate;
}

function updateText(frame: SseFrame): string | undefined {
  const data = frame.envelope.data as { update?: { content?: { text?: string } } } | undefined;
  return data?.update?.content?.text;
}

/** 读 SSE 流直到满足条件（turn_complete 等），然后 abort。 */
async function readSseUntil(
  response: Response,
  stop: (frame: SseFrame) => boolean,
  controller: AbortController,
): Promise<SseFrame[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: SseFrame[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseSseBlock(block);
        if (frame) {
          frames.push(frame);
          if (stop(frame)) {
            controller.abort();
            return frames;
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch {
    // abort 引发的读中断是预期出口
  }
  return frames;
}

function parseSseBlock(block: string): SseFrame | undefined {
  let id: number | undefined;
  let event: string | undefined;
  let data: string | undefined;
  for (const line of block.split('\n')) {
    if (line.startsWith('id: ')) id = Number.parseInt(line.slice(4), 10);
    else if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data = line.slice(6);
  }
  if (event === undefined || data === undefined) return undefined;
  return { id, event, envelope: JSON.parse(data) as SseFrame['envelope'] };
}

/** 轮询 transcript 直到出现目标事件（后台轮次是异步收尾的）。 */
async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs = 8_000,
  intervalMs = 60,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > timeoutMs) throw new Error('waitUntil 超时');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('daemon 兼容层 /d（MOCK）', () => {
  let app: FastifyInstance;
  let base: string;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await registerDaemonRoutes(app, mockCfg(), undefined);
    await app.ready();
    base = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('capabilities：standalone 两个 feature 标签齐全（启动门）', async () => {
    const res = await app.inject({ method: 'GET', url: '/d/capabilities' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.v).toBe(1);
    expect(body.features).toContain('standalone_sessions_v1');
    expect(body.features).toContain('standalone_session_options_v1');
    expect(Array.isArray(body.modelServices)).toBe(true);
  });

  it('session-options：providers/models 的必填字段齐备', async () => {
    const res = await app.inject({ method: 'GET', url: '/d/standalone/session-options' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.v).toBe(1);
    expect(body.initialized).toBe(true);
    const provider = body.providers[0];
    expect(provider.kind).toBe('model_provider');
    expect(provider.status).toBe('ok');
    expect(typeof provider.authType).toBe('string');
    expect(provider.current).toBe(true);
    expect(provider.models[0].modelId).toBe('data-agent');
    expect(provider.models[0].isCurrent).toBe(true);
    expect(provider.models[0].isRuntime).toBe(false);
  });

  it('standalone 会话列表：MOCK 场景可见、每条带 standalone 字段', async () => {
    const res = await app.inject({ method: 'GET', url: '/d/standalone/sessions' });
    expect(res.statusCode).toBe(200);
    const sessions = res.json().sessions as Array<Record<string, unknown>>;
    expect(sessions.length).toBe(9); // 两条"别的来源"被过滤（8 场景 + mock-permission）
    for (const s of sessions) {
      expect(s.sourceType).toBe('standalone');
      expect(s.context).toEqual({ kind: 'standalone' });
      expect(typeof s.workspaceCwd).toBe('string');
      expect(String(s.workspaceCwd).length).toBeGreaterThan(0);
      expect(typeof s.createdAt).toBe('string');
    }
    expect(sessions.some((s) => s.sessionId === 'mock-short')).toBe(true);
  });

  it('创建会话：忽略客户端 ID，返回真实 ID，lookup 可解析', async () => {
    const aliasId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const created = await app.inject({
      method: 'POST',
      url: '/d/standalone/sessions',
      payload: { sessionId: aliasId },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(body.sessionId).not.toBe(aliasId);
    expect(body.sessionId).toBeTruthy();
    expect(body.sourceType).toBe('standalone');
    expect(body.context).toEqual({ kind: 'standalone' });
    expect(body.workingDirectory.state).toBe('ready');
    expect(typeof body.projectlessOutputDirectory).toBe('string');

    const lookup = await app.inject({ method: 'GET', url: `/d/standalone/sessions/${body.sessionId}` });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().sessionId).toBe(body.sessionId);
  });

  it('load：历史帧灌成 compactedReplay 种子，带 lastEventId 与 eventEpoch', async () => {
    const res = await app.inject({ method: 'POST', url: '/d/standalone/sessions/mock-short/load', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessionId).toBe('mock-short');
    expect(Array.isArray(body.compactedReplay)).toBe(true);
    expect(body.compactedReplay.length).toBeGreaterThan(0);
    expect(body.liveJournal).toEqual([]);
    expect(typeof body.lastEventId).toBe('number');
    expect(body.lastEventId).toBe(body.compactedReplay.at(-1)?.id);
    expect(typeof body.eventEpoch).toBe('string');
    expect(body.state.models).toEqual([
      {
        modelId: 'data-agent',
        baseModelId: 'data-agent',
        name: 'DataWorks Data Agent',
        isCurrent: true,
        isRuntime: false,
      },
    ]);
    expect(body.state.modes).toEqual({});
    expect(body.state.configOptions).toBeNull();
    expect(body.historyHasMore).toBe(false);
    // 种子里 user 回显必须已剥校验码说明
    const userChunks = body.compactedReplay.filter(
      (e: Record<string, unknown>) =>
        ((e.data as { update?: { sessionUpdate?: string } })?.update)?.sessionUpdate ===
        'user_message_chunk',
    );
    expect(userChunks.length).toBeGreaterThan(0);
    for (const chunk of userChunks) {
      const text = (chunk.data as { update?: { content?: { text?: string } } }).update?.content
        ?.text;
      expect(text).not.toContain('校验码');
    }
  });

  it('prompt 202 → SSE 从 lastEventId 续流出 session_update 序列并以 turn_complete 收尾', async () => {
    const promptRes = await fetch(`${base}/d/session/mock-short/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: [{ type: 'text', text: '你好' }] }),
    });
    expect(promptRes.status).toBe(202);
    const admission = (await promptRes.json()) as { promptId: string; lastEventId: number; eventEpoch: string };
    // 202 严格契约：只有这三个键（openapi additionalProperties:false）
    expect(Object.keys(admission).sort()).toEqual(['eventEpoch', 'lastEventId', 'promptId']);

    const controller = new AbortController();
    const sseRes = await fetch(`${base}/d/session/mock-short/events`, {
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(admission.lastEventId) },
      signal: controller.signal,
    });
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
    expect(sseRes.headers.get('x-qwen-event-epoch')).toBe(admission.eventEpoch);
    expect(sseRes.headers.get('x-qwen-sse-stream-id')).toBeTruthy();

    const frames = await readSseUntil(sseRes, (f) => f.event === 'turn_complete', controller);
    expect(frames.length).toBeGreaterThan(1);

    // 续传语义：所有帧的 id 都严格大于 202 里的 lastEventId
    for (const frame of frames) {
      if (frame.id !== undefined) expect(frame.id).toBeGreaterThan(admission.lastEventId);
    }

    // user 回显在流上也要剥掉校验码说明
    const userChunks = frames.filter((f) => f.event === 'session_update' && updateKind(f) === 'user_message_chunk');
    expect(userChunks.length).toBeGreaterThan(0);
    for (const chunk of userChunks) {
      expect(updateText(chunk)).not.toContain('校验码');
    }

    // agent 输出存在且终态正确
    const agentChunks = frames.filter((f) => f.event === 'session_update' && updateKind(f) === 'agent_message_chunk');
    expect(agentChunks.length).toBeGreaterThan(0);

    const turnComplete = frames.find((f) => f.event === 'turn_complete');
    expect(turnComplete).toBeDefined();
    expect((turnComplete?.envelope.data as { stopReason?: string }).stopReason).toBe('end_turn');
    expect((turnComplete?.envelope.data as { promptId?: string }).promptId).toBe(admission.promptId);

    // 等后台轮次完全收尾，避免泄漏定时器影响后续用例
    await waitUntil(async () => {
      const transcript = await app.inject({ method: 'GET', url: '/d/session/mock-short/transcript' });
      const events = transcript.json().events as Array<{ type: string }>;
      return events.some((e) => e.type === 'turn_complete');
    });
  });

  it('在途轮次未结束：第二个 prompt 被 409 拒绝（在途锁，未发往上游）', async () => {
    // 新建一个独立会话，避免与上一用例的 journal 相互干扰
    const created = await app.inject({ method: 'POST', url: '/d/standalone/sessions', payload: {} });
    const sessionId = created.json().sessionId as string;

    const first = await fetch(`${base}/d/session/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: [{ type: 'text', text: '第一轮' }] }),
    });
    expect(first.status).toBe(202);

    const second = await fetch(`${base}/d/session/${sessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: [{ type: 'text', text: '第二轮' }] }),
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe('session_concurrent_operation_in_progress');

    await waitUntil(async () => {
      const transcript = await app.inject({ method: 'GET', url: `/d/session/${sessionId}/transcript` });
      const events = transcript.json().events as Array<{ type: string }>;
      return events.some((e) => e.type === 'turn_complete');
    });
  });

  it('错误帧收尾：turn_error 是本轮事件流的最后一条（其后不再有 session_update）', async () => {
    const promptRes = await fetch(`${base}/d/session/mock-ghost/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: [{ type: 'text', text: '触发幽灵化' }] }),
    });
    expect(promptRes.status).toBe(202);
    await waitUntil(async () => {
      const transcript = await app.inject({ method: 'GET', url: '/d/session/mock-ghost/transcript' });
      const events = transcript.json().events as Array<{ type: string }>;
      return events.some((e) => e.type === 'turn_error');
    });
    const transcript = await app.inject({ method: 'GET', url: '/d/session/mock-ghost/transcript' });
    const events = transcript.json().events as Array<{ type: string }>;
    expect(events.at(-1)?.type).toBe('turn_error');
    expect(events.some((e) => e.type === 'turn_complete')).toBe(false);
  });

  it('不支持的 prompt 内容块：图片块 400（上游只收文本，如实拒绝）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/d/session/mock-render/prompt',
      payload: { prompt: [{ type: 'image', data: 'x', mimeType: 'image/png' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('unsupported_prompt_content');
  });

  it('未知会话：MOCK 下与 /api 行为对齐，明确 404', async () => {
    for (const [method, url] of [
      ['GET', '/d/standalone/sessions/no-such-session'],
      ['POST', '/d/standalone/sessions/no-such-session/load'],
      ['POST', '/d/session/no-such-session/prompt'],
      ['GET', '/d/session/no-such-session/transcript'],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json().code).toBe('standalone_session_not_found');
    }
  });

  it('permission：弹卡出现后回覆成功，卡片消失（回覆通道与 /api/reply 同源）', async () => {
    const which = 'mock-permission';
    // 1) prompt（fixture 里带一条 permission_request 通知）→ SSE：expect 权限事件 + turn_complete
    const promptRes = await fetch(`${base}/d/session/${which}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: [{ type: 'text', text: '请帮我起草一份上线公告' }] }),
    });
    expect(promptRes.status).toBe(202);
    const admission = (await promptRes.json()) as { promptId: string; lastEventId: number; eventEpoch: string };

    const controller = new AbortController();
    const sseRes = await fetch(`${base}/d/session/${which}/events`, {
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(admission.lastEventId) },
      signal: controller.signal,
    });
    const frames = await readSseUntil(sseRes, (f) => f.event === 'turn_complete', controller);
    const eventTypes = frames.map((f) => f.event);
    expect(eventTypes).toContain('permission_request');
    expect(eventTypes).toContain('turn_complete');
    const requestFrame = frames.find((f) => f.event === 'permission_request');
    expect(requestFrame).toBeDefined();
    const requestData = requestFrame!.envelope.data as {
      requestId: string; sessionId: string; toolCall: Record<string, unknown> | null;
      options: Array<{ optionId: string; kind: string }>;
    };
    expect(requestData.requestId).toBe('req-keep-1');
    expect(requestData.sessionId).toBe(which);
    expect(requestData.toolCall?._meta ?? null).not.toBeNull();
    const submit = requestData.options.find(option => option.kind === 'allow_once')!;
    expect(submit.optionId).toBe('__openapi_answers__');
    const invalid = await app.inject({ method: 'POST', url: `/d/session/${which}/permission/req-keep-1`,
      payload: { outcome: { outcome: 'selected', optionId: submit.optionId } } });
    expect(invalid.statusCode).toBe(400);

    await waitUntil(async () => {
      const transcript = (await app.inject({ method: 'GET', url: `/d/session/${which}/transcript` })).json();
      return (transcript.events as Array<{ type: string }>).some((e) => e.type === 'turn_complete');
    });

    // 2) 不认识的 requestId → 404
    const miss = await app.inject({
      method: 'POST',
      url: `/d/session/${which}/permission/req-unknown-1`,
      payload: { outcome: { outcome: 'selected', optionId: 'proceed_once' } },
    });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().code).toBe('permission_not_found');

    // 3) 回覆 → 200，journal 追加 permission_resolved
    const respond = await app.inject({
      method: 'POST',
      url: `/d/session/${which}/permission/req-keep-1`,
      payload: { outcome: { outcome: 'selected', optionId: submit.optionId }, answers: { '0': '先列大纲' } },
    });
    expect(respond.statusCode).toBe(200);

    await waitUntil(async () => {
      const transcript = (await app.inject({ method: 'GET', url: `/d/session/${which}/transcript` })).json();
      const events = transcript.events as Array<{ type: string; data: Record<string, unknown> }>;
      return events.some(
        (e) => e.type === 'permission_resolved' && e.data.requestId === 'req-keep-1',
      );
    });

    // 4) 已处理的 requestId 再次回覆 → 404
    const replayed = await app.inject({
      method: 'POST',
      url: `/d/session/${which}/permission/req-keep-1`,
      payload: { outcome: { outcome: 'selected', optionId: 'proceed_once' } },
    });
    expect(replayed.statusCode).toBe(404);
    expect(replayed.json().code).toBe('permission_not_found');
  });

  it('permission：legacy 路由反查 requestId 同样能回覆', async () => {
    const which = 'mock-permission';
    // 同一会话再起一轮：在途锁已在上轮 turn_complete 后释放
    const promptRes = await fetch(`${base}/d/session/${which}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: [{ type: 'text', text: '换个问题' }] }),
    });
    expect(promptRes.status).toBe(202);

    // 判据：第二个 turn_complete 落账 ⇒ 新一轮回放已把 permission_request 重新
    // set 进 pending（上轮 resolved 的存在不影响：runner 按 requestId 重 set）。
    await waitUntil(async () => {
      const transcript = (await app.inject({ method: 'GET', url: `/d/session/${which}/transcript` })).json();
      const completes = (transcript.events as Array<{ type: string }>).filter((e) => e.type === 'turn_complete');
      return completes.length >= 2;
    });

    const legacy = await app.inject({
      method: 'POST',
      url: '/d/permission/req-keep-1',
      payload: { outcome: { outcome: 'selected', optionId: 'proceed_once' } },
    });
    expect(legacy.statusCode).toBe(200);
  });

  it('heartbeat / cancel / delete：记账语义正确', async () => {
    const heartbeat = await app.inject({ method: 'POST', url: '/d/session/mock-short/heartbeat', payload: {} });
    expect(heartbeat.statusCode).toBe(204);

    const cancel = await app.inject({ method: 'POST', url: '/d/session/mock-short/cancel', payload: {} });
    expect(cancel.statusCode).toBe(204);

    const del = await app.inject({ method: 'DELETE', url: '/d/session/mock-concurrent' });
    expect(del.statusCode).toBe(204);
    // 本地删除后从列表消失（journal 保留，深链重开仍在）
    const list = await app.inject({ method: 'GET', url: '/d/standalone/sessions' });
    const ids = (list.json().sessions as Array<{ sessionId: string }>).map((s) => s.sessionId);
    expect(ids).not.toContain('mock-concurrent');
    const lookup = await app.inject({ method: 'GET', url: '/d/standalone/sessions/mock-concurrent' });
    expect(lookup.statusCode).toBe(404);
  });

  it('rename（进程级 displayName 覆盖）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/d/standalone/sessions/mock-break/metadata',
      payload: { displayName: '我的断流实验' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: 'mock-break', displayName: '我的断流实验' });
  });

  it('未实现端点：404 且错误体带 code（webshell 端的降级面）', async () => {
    const res = await app.inject({ method: 'GET', url: '/d/workspace/mcp' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_implemented');
  });
});
