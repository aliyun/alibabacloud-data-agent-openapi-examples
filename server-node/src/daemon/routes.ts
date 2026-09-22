import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { STREAM_HARD_LIMIT_MS, type AcpFrame } from '@das/shared';

import type { AppConfig } from '../config.js';
import { liveCancel, liveCreateSession, liveLoadFrames, liveReply, type LiveContext } from '../live.js';
import { findScenario, mockCreateSession, readFixtureFrames } from '../mock/fixtures.js';
import { toApiError } from '../normalize.js';
import type { SdkClient } from '../sdk.js';
import { OPENAPI_ANSWERS_OPTION, permissionResolvedEvent, promptCancelledEvent } from './events.js';
import { rebuildPendingPermissions, SessionRegistry, WORKSPACE_CWD, type SessionRecord } from './registry.js';
import { admitPrompt, type PromptDeps } from './runner.js';
import { streamSse } from './sse.js';
import { historyFramesToEvents } from './translate.js';

/**
 * daemon 兼容层：把 @qwen-code/web-shell 说的话翻译成 data agent OpenAPI 的 8 个上游调用。
 *
 * 挂载在 `/d` 前缀下——DaemonClient 是 `baseUrl + path` 字符串拼接，所以前端把
 * baseUrl 指到 `<origin>/d` 即可，与现有 `/api/*`、SPA 回退互不干扰。
 *
 * 实现面（对齐 qwen-code 官方契约 + sdk 校验器）：
 *  · capabilities / standalone session-options（两个 feature 标签是 standalone 模式的启动门）
 *  · standalone 会话 CRUD（创建直接返回 OpenAPI 的真实 sessionId）
 *  · load/resume（历史帧过滤后灌 journal，回放放 compactedReplay / liveJournal）
 *  · prompt 202 + SSE events（Last-Event-ID 续传）+ cancel / heartbeat / transcript
 *  · permission：`_qwen/notify` → permission_request/resolved 事件（弹卡的唯一通道），
 *    回覆走 ReplyAgentSession（200 受理 / 404 未知·已被处理，与 web-shell SDK 契约对齐）
 *  · 未知端点 404 并**记日志**——那是 OPENAPI-GAPS.md 的证据来源
 */
export async function registerDaemonRoutes(
  app: FastifyInstance,
  cfg: AppConfig,
  client: SdkClient | undefined,
): Promise<void> {
  const live: LiveContext | undefined = client ? { client, cfg, log: app.log } : undefined;
  const registry = new SessionRegistry();
  /** 进程级事件纪元：重启即变；客户端凭它判断游标属于"上一个进程"并触发 resync。 */
  const epoch = randomUUID();
  const promptDeps: PromptDeps = { cfg, live, log: app.log };
  /** 当前活跃 SSE 连接数（daemon/status 的 transport.restSseActive）。 */
  let sseActive = 0;

  /**
   * 解析会话：使用 OpenAPI 真实 sessionId。LIVE 下未知 id 也放行（深链/重启后直接发话，
   * 存在性交给上游判）；MOCK 下必须是已知场景（与 /api 的行为对齐：不认的 id 明确 404）。
   */
  function resolveSession(id: string): SessionRecord | undefined {
    const known = registry.resolve(id);
    if (known) return known;
    if (live) return registry.ensure(id);
    return findScenario(id) ? registry.ensure(id) : undefined;
  }

  function notFound(reply: FastifyReply, id: string): unknown {
    return reply.code(404).send({
      error: `没有这个会话：${id}`,
      code: 'standalone_session_not_found',
    });
  }

  await app.register(
    async (d) => {
      // ---- 发现 ----

      d.get('/health', async () => ({ status: 'ok' }));

      d.get('/capabilities', async () => ({
        v: 1,
        mode: 'standalone',
        features: ['standalone_sessions_v1', 'standalone_session_options_v1', 'session_permission_vote'],
        modelServices: ['data-agent'],
        workspaces: [],
        policy: {},
        // webshell 按这个间隔轮询会话目录 live-state；每次轮询在 LIVE 下都是一次
        // 真实 ListAgentSessions（约 0.4s、上游无增量游标）——30s 是负载与新鲜度的折中
        sessionLiveStatePollIntervalMs: 30_000,
      }));

      /**
       * daemon 状态报告（webshell 的「Daemon 状态」面板）。
       *
       * 全部字段是**本地真实状态**（不依赖上游），形状对齐 sdk 的 DaemonStatusReport：
       * 之前 404 会让面板显示"连接状态：错误"，像是坏了一样——其实只是没实现。
       * journal 上限与 promptDeadline 对齐本仓实测常量，让面板显示的是真约束。
       */
      d.get<{ Querystring: { detail?: string } }>('/daemon/status', async (request) => {
        const detail = request.query?.detail === 'full' ? 'full' : 'summary';
        const stats = registry.stats();
        return {
          v: 1,
          detail,
          generatedAt: new Date().toISOString(),
          status: 'ok',
          issues: [],
          daemon: {
            pid: process.pid,
            uptimeMs: Math.round(process.uptime() * 1000),
            mode: 'standalone',
            workspaceCwd: WORKSPACE_CWD,
          },
          security: {
            tokenConfigured: false,
            requireAuth: false,
            loopbackBind: cfg.serverHost === '127.0.0.1',
            allowOriginConfigured: cfg.corsOrigin.length > 0,
            allowOriginMode: cfg.corsOrigin.join(','),
            sessionShellCommandEnabled: false,
          },
          limits: {
            maxSessions: null,
            maxTotalSessions: null,
            // 上游在途锁：同一会话同时只能一轮（session_concurrent_operation_in_progress）
            maxPendingPromptsPerSession: 1,
            listenerMaxConnections: null,
            eventRingSize: 20_000,
            promptDeadlineMs: STREAM_HARD_LIMIT_MS,
            writerIdleTimeoutMs: null,
            channelIdleTimeoutMs: 0,
            sessionIdleTimeoutMs: 0,
            acpConnectionCap: null,
            compactedReplayMaxBytes: 0,
            maxJournalEvents: 20_000,
            maxJournalBytes: 0,
          },
          capabilities: {
            protocolVersions: { current: '1', supported: ['1'] },
            features: ['standalone_sessions_v1', 'standalone_session_options_v1', 'session_permission_vote'],
          },
          runtime: {
            sessions: { active: stats.sessions },
            permissions: { pending: 0, policy: 'upstream-none' },
            channel: { live: false },
            channelWorker: { enabled: false, state: 'disabled', channels: [] },
            // 状态面板无条件读 process.rss / heapUsed（内存行）
            process: {
              rss: process.memoryUsage().rss,
              heapUsed: process.memoryUsage().heapUsed,
            },
            transport: {
              restSseActive: sseActive,
              acp: {
                enabled: false,
                connections: 0,
                connectionStreams: 0,
                sessionStreams: 0,
                sseStreams: 0,
                wsStreams: 0,
                pendingClientRequests: 0,
              },
            },
            rateLimit: { enabled: false, rejectedSinceStart: {} },
          },
        };
      });

      d.get('/standalone/session-options', async () => ({
        v: 1,
        initialized: true,
        providers: [
          {
            kind: 'model_provider',
            status: 'ok',
            authType: 'none',
            current: true,
            models: [
              {
                modelId: 'data-agent',
                baseModelId: 'data-agent',
                name: 'DataWorks Data Agent',
                isCurrent: true,
                isRuntime: false,
              },
            ],
          },
        ],
        errors: [],
      }));

      // ---- standalone 会话目录 ----

      d.get<{ Querystring: { archiveState?: string; size?: string; cursor?: string } }>(
        '/standalone/sessions',
        async (request) => {
          if (request.query?.archiveState === 'archived') {
            return { sessions: registry.archivedSummaries() };
          }
          return { sessions: await registry.listSummaries(cfg, live, app.log) };
        },
      );

      d.post<{ Body: { sessionId?: unknown; modelServiceId?: unknown; approvalMode?: unknown } }>(
        '/standalone/sessions',
        async (request, reply) => {
          let realId: string;
          if (live) {
            const created = await liveCreateSession(live);
            if (!created.ok) {
              return reply.code(502).send({ error: created.error.message, code: 'create_failed' });
            }
            realId = created.result.sessionId;
          } else {
            realId = mockCreateSession('新建会话').sessionId;
          }
          const record = registry.ensure(realId);
          app.log.info({ sessionId: realId, mock: !live }, 'daemon 兼容层新建会话');
          return standaloneSessionBody(record, realId);
        },
      );

      d.get<{ Params: { id: string } }>('/standalone/sessions/:id', async (request, reply) => {
        const record = resolveSession(request.params.id);
        if (!record || record.deleted) return notFound(reply, request.params.id);
        return registry.summaryFor(record, request.params.id);
      });

      d.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
        '/standalone/sessions/:id/load',
        async (request, reply) => loadSession(request.params.id, 'load', reply),
      );

      d.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
        '/standalone/sessions/:id/resume',
        async (request, reply) => loadSession(request.params.id, 'resume', reply),
      );

      d.patch<{ Params: { id: string }; Body: { displayName?: unknown } }>(
        '/standalone/sessions/:id/metadata',
        async (request, reply) => renameSession(request.params.id, request.body?.displayName, reply),
      );

      d.post<{ Body: { sessionIds?: unknown } }>('/standalone/sessions/archive', async (request) =>
        batchMutate('archive', request.body?.sessionIds),
      );
      d.post<{ Body: { sessionIds?: unknown } }>('/standalone/sessions/unarchive', async (request) =>
        batchMutate('unarchive', request.body?.sessionIds),
      );
      d.post<{ Body: { sessionIds?: unknown } }>('/standalone/sessions/delete', async (request) =>
        batchMutate('delete', request.body?.sessionIds),
      );

      // ---- 会话内：prompt / 事件流 / 生命周期 ----

      d.post<{ Params: { id: string }; Body: { prompt?: unknown } }>('/session/:id/prompt', async (request, reply) => {
        const id = request.params.id;
        const clientId = headerString(request.headers['x-qwen-client-id']);
        const record = resolveSession(id);
        if (!record) return notFound(reply, id);
        const admission = admitPrompt(promptDeps, record, id, request.body?.prompt, clientId);
        if (!admission.ok) {
          return reply.code(admission.status).send({ error: admission.error, code: admission.code });
        }
        // 202 严格契约（additionalProperties:false）：只有这三个键
        return reply.code(202).send({
          promptId: admission.promptId,
          lastEventId: admission.lastEventId,
          eventEpoch: epoch,
        });
      });

      d.post<{ Params: { id: string } }>('/session/:id/cancel', async (request, reply) => {
        const id = request.params.id;
        const record = resolveSession(id);
        if (!record) return notFound(reply, id);
        if (live) await liveCancel(live, record.realId);
        const activePromptId = record.journal.activePromptId;
        if (activePromptId !== undefined) {
          // 上游流随后会以 stopReason=cancelled 终态收场 → turn_complete(cancelled) 也会到
          record.journal.append(promptCancelledEvent(id, activePromptId));
        }
        return reply.code(204).send();
      });

      d.get<{
        Params: { id: string };
        Querystring: { snapshot?: string; maxQueued?: string; connectReason?: string; previousStreamId?: string };
      }>('/session/:id/events', async (request, reply) => {
        const id = request.params.id;
        const record = resolveSession(id);
        if (!record) return notFound(reply, id);
        const lastRaw = headerString(request.headers['last-event-id']);
        const parsed = lastRaw !== undefined ? Number.parseInt(lastRaw, 10) : Number.NaN;
        const snapshot = request.query?.snapshot === '1' || request.query?.snapshot === 'true';
        sseActive += 1;
        try {
          await streamSse(reply, {
            journal: record.journal,
            sessionId: id,
            epoch,
            streamId: randomUUID(),
            lastEventId: Number.isFinite(parsed) ? parsed : undefined,
            snapshot,
          });
        } finally {
          sseActive -= 1;
        }
        return reply;
      });

      d.post<{ Params: { id: string } }>('/session/:id/heartbeat', async (request, reply) => {
        const record = resolveSession(request.params.id);
        if (!record) return notFound(reply, request.params.id);
        // 上游没有心跳接口；会话亲和是临时的（qwen-daemon 绑定闲置即失效），
        // 这里只回 204 维持客户端记账，不做任何上游调用。
        return reply.code(204).send();
      });

      d.get<{ Params: { id: string }; Querystring: { limit?: string; beforeRecordId?: string } }>(
        '/session/:id/transcript',
        async (request, reply) => {
          const id = request.params.id;
          const record = resolveSession(id);
          if (!record) return notFound(reply, id);
          // 上游 load 无增量游标（BeginLogOffset 是死参数），整份 journal 即全部历史
          return {
            v: 1,
            sessionId: id,
            events: record.journal.all().map((entry) => entry.event),
            hasMore: false,
          };
        },
      );

      d.get<{ Params: { id: string } }>('/session/:id/status', async (request, reply) => {
        const id = request.params.id;
        const record = resolveSession(id);
        if (!record) return notFound(reply, id);
        return {
          sessionId: id,
          attached: false,
          hasActivePrompt: record.journal.activePrompt,
          clientCount: 0,
        };
      });

      d.patch<{ Params: { id: string }; Body: { displayName?: unknown } }>(
        '/session/:id/metadata',
        async (request, reply) => renameSession(request.params.id, request.body?.displayName, reply),
      );

      d.delete<{ Params: { id: string } }>('/session/:id', async (request, reply) => {
        const record = resolveSession(request.params.id);
        if (!record) return notFound(reply, request.params.id);
        // 上游没有删除接口：本地标记隐藏（journal 保留，深链重开还能看到），重启后恢复
        record.deleted = true;
        return reply.code(204).send();
      });

      // ---- permission：弹卡的回覆通道（与 /api/sessions/:id/reply 同一上游 ReplyAgentSession） ----
      //
      // 契约（@qwen-code/sdk respondToSessionPermission）：200 = 已受理；404 = 未知/已被处理
      // （多客户端赛跑输给了别人），SDK 的 boolean 回执按此语义分发。

      async function respondPermission(request: FastifyRequest, reply: FastifyReply, sessionId: string, requestId: string) {
        const record = resolveSession(sessionId);
        if (!record) return notFound(reply, sessionId);
        const pending = record.pendingPermissions.get(requestId);
        if (!pending) {
          return reply.code(404).send({
            error: `没有这个待处理的人卡请求（requestId=${requestId}，未知/已被处理）`,
            code: 'permission_not_found',
          });
        }

        const body = request.body as
          | { outcome?: { outcome?: string; optionId?: string }; answers?: Record<string, string> }
          | undefined;
        const outcomeKind = body?.outcome?.outcome === 'cancelled' ? 'cancelled' : 'selected';
        let optionId = typeof body?.outcome?.optionId === 'string' ? body.outcome.optionId.trim() : '';
        const answers = body?.answers && typeof body.answers === 'object' ? body.answers : undefined;
        if (optionId === OPENAPI_ANSWERS_OPTION) {
          if (typeof pending !== 'object' || !('openApiAnswersOnly' in pending) ||
              pending.openApiAnswersOnly !== true || outcomeKind !== 'selected' ||
              !answers || Object.keys(answers).length === 0) {
            return reply.code(400).send({ error: '问答提交必须包含 answers', code: 'invalid_permission_response' });
          }
          optionId = ''; // Never send a UI-only option identifier to OpenAPI.
        }
        if (outcomeKind === 'selected' && optionId === '' && (!answers || Object.keys(answers).length === 0)) {
          return reply.code(400).send({
            error: 'outcome=selected 时必须带 optionId 或 answers（与 /api/sessions/:id/reply 同一契约）',
            code: 'invalid_permission_response',
          });
        }

        if (live) {
          try {
            const result = await liveReply(live, record.realId, {
              permissionRequestId: requestId,
              answers,
              optionId: optionId !== '' ? optionId : undefined,
              outcome: outcomeKind,
            });
            if (result.ok && result.result.accepted) {
              record.pendingPermissions.delete(requestId);
              record.journal.append(
                permissionResolvedEvent(record.realId, requestId, {
                  outcome: outcomeKind,
                  ...(optionId !== '' ? { optionId } : {}),
                }),
              );
              return reply.code(200).send({});
            }
            // 上游明确不接：按赛跑失败对待——本地移除并走 404 语义让客户端刷新
            record.pendingPermissions.delete(requestId);
            return reply.code(404).send({
              error: result.ok
                ? '上游明确 accepted=false（requestId 可能已过期或已被他人回覆）'
                : `回覆被拒：${result.error.message}`,
              code: 'permission_not_accepted',
            });
          } catch (err) {
            app.log.warn({ err, sessionId: record.realId, requestId }, 'daemon permission 回覆上游失败');
            return reply.code(502).send({
              error: `回覆上游失败：${String(err instanceof Error ? err.message : err)}`,
              code: 'permission_upstream_error',
            });
          }
        }

        // MOCK：回覆是本地教学闭环——上游无真通道，直接当已受理（/api 的 mock reply 是拒绝语义，
        // 那是对 LIVE-only 行为的如实交代；这里的演示价值在"点卡 → 卡片消失 → 事件归档"）
        record.pendingPermissions.delete(requestId);
        record.journal.append(
          permissionResolvedEvent(record.realId, requestId, {
            outcome: outcomeKind,
            ...(optionId !== '' ? { optionId } : {}),
          }),
        );
        return reply.code(200).send({});
      }

      d.post<{ Params: { id: string; requestId: string } }>(
        '/session/:id/permission/:requestId',
        async (request, reply) => respondPermission(request, reply, request.params.id, request.params.requestId),
      );

      d.post<{ Params: { requestId: string } }>('/permission/:requestId', async (request, reply) => {
        // 历史兼容路由（SDK 的 respondToPermission legacy 版）：requestId 在全注册表里反查会话
        const entry = registry
          .allRecords()
          .find((record) => record.pendingPermissions.has(request.params.requestId));
        if (!entry) {
          return reply.code(404).send({
            error: `没有这个待处理的人卡请求（requestId=${request.params.requestId}，未知/已被处理）`,
            code: 'permission_not_found',
          });
        }
        return respondPermission(request, reply, entry.realId, request.params.requestId);
      });

      // ---- 降级端点 ----

      d.get('/workspace/tools', async () => ({ tools: [] }));

      /**
       * 兜底 404：**记日志**。webshell 打到这里的就是 daemon 有、而我们（因为上游
       * OpenAPI 缺接口或尚未实现）给不了的端点——这份日志是 OPENAPI-GAPS.md 的证据链。
       */
      d.setNotFoundHandler((request, reply) => {
        app.log.info({ method: request.method, url: request.url }, 'daemon-compat 未实现端点（缺口候选）');
        return reply
          .code(404)
          .send({ error: `daemon 兼容层未实现该端点：${request.method} ${request.url}`, code: 'not_implemented' });
      });

      // ---- 内部实现 ----

      async function loadSession(id: string, mode: 'load' | 'resume', reply: FastifyReply): Promise<unknown> {
        const record = resolveSession(id);
        if (!record || record.deleted) return notFound(reply, id);

        // An active prompt owns the live journal. Upstream load can block awaiting its reply.
        if (mode === 'load' && !record.journal.activePrompt) {
          let frames: AcpFrame[] = [];
          if (live) {
            try {
              frames = await liveLoadFrames(live, record.realId);
            } catch (err) {
              const api = toApiError(err, 'LoadAgentSession');
              return reply.code(api.kind === 'transport' ? 502 : 404).send({
                error: api.message,
                code: 'standalone_session_not_found',
              });
            }
          } else {
            const scenario = findScenario(record.realId);
            frames = scenario?.historyFixture ? readFixtureFrames(scenario.historyFixture) : [];
          }
          // 过滤 + 去重判据与 reduceHistory 同源（rid-less 污染 / load 伪轮次 /
          // bridge-echo 重复回显都不进 journal）
          const events = historyFramesToEvents(frames, id);
          record.journal.seed(events);
          // 用种子事件重建 pending：重启后这张卡能真正回得上去（这个调用必须每次都做——
          // seed 幂等轮到时也要兜底；pendingPermissions 的因果跟着 journal 变化走）
          rebuildPendingPermissions(record);
        }

        return {
          ...standaloneSessionBody(record, id),
          state: {
            models: [
              {
                modelId: 'data-agent',
                baseModelId: 'data-agent',
                name: 'DataWorks Data Agent',
                isCurrent: true,
                isRuntime: false,
              },
            ],
            modes: {},
            configOptions: null,
          },
          compactedReplay: record.journal.compacted().map((entry) => entry.event),
          liveJournal: record.journal.live().map((entry) => entry.event),
          lastEventId: record.journal.lastId(),
          eventEpoch: epoch,
          historyHasMore: false,
        };
      }

      async function renameSession(id: string, displayName: unknown, reply: FastifyReply): Promise<unknown> {
        const record = resolveSession(id);
        if (!record) return notFound(reply, id);
        const name = typeof displayName === 'string' ? displayName.trim() : '';
        if (!name) {
          return reply.code(400).send({ error: 'displayName 不能为空', code: 'invalid_metadata' });
        }
        // 进程级：上游没有改名接口（SessionTitle 恒为首条 prompt 原文），重启即失
        record.displayName = name;
        return { sessionId: id, displayName: name };
      }

      function batchMutate(
        action: 'archive' | 'unarchive' | 'delete',
        rawIds: unknown,
      ): Record<string, unknown> {
        const ids = (Array.isArray(rawIds) ? rawIds : []).filter((v): v is string => typeof v === 'string');
        const done: string[] = [];
        const skipped: string[] = [];
        const notFoundIds: string[] = [];
        const errors: Array<{ sessionId: string; code: string; message: string }> = [];
        for (const raw of ids) {
          const id = raw.toLowerCase();
          const record = registry.resolve(id);
          if (!record) {
            notFoundIds.push(id);
            continue;
          }
          if (action === 'archive') {
            if (record.archived) skipped.push(id);
            else {
              record.archived = true;
              done.push(id);
            }
          } else if (action === 'unarchive') {
            if (record.archived) {
              record.archived = false;
              done.push(id);
            } else skipped.push(id);
          } else {
            // 上游没有删除接口：本地隐藏标记（journal 保留），重启后恢复可见
            record.deleted = true;
            done.push(id);
          }
        }
        if (action === 'archive') return { archived: done, alreadyArchived: skipped, notFound: notFoundIds, errors };
        if (action === 'unarchive') return { unarchived: done, alreadyActive: skipped, notFound: notFoundIds, errors };
        return { removed: done, notFound: notFoundIds, errors, fileCleanupPending: [] };
      }

      function standaloneSessionBody(record: SessionRecord, clientFacingId: string): Record<string, unknown> {
        return {
          sessionId: clientFacingId,
          // daemon 分配的客户端身份：客户端随 prompt 以 X-Qwen-Client-Id 带回，
          // 我们据此盖 originatorClientId（suppressOwnUserEcho 的匹配键）
          clientId: record.clientId,
          workspaceCwd: WORKSPACE_CWD,
          attached: false,
          createdAt: new Date(record.createdAt).toISOString(),
          sourceType: 'standalone',
          context: { kind: 'standalone' },
          projectlessOutputDirectory: `${WORKSPACE_CWD}/out/${clientFacingId}`,
          workingDirectory: { state: 'ready' },
        };
      }
    },
    { prefix: '/d' },
  );
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
