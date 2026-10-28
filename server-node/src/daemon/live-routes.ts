import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { stripMarkerInstruction, type SessionSummary } from '@das/shared';
import type { AppConfig } from '../config.js';
import { liveCancel, liveCreateSession, liveListSessions, liveLoadFrames, liveReply, liveSessionMutation, type LiveContext } from '../live.js';
import { toApiError } from '../normalize.js';
import { optionalAgentName, publicSessionOptions, sessionOptions } from '../session-options.js';
import type { SdkClient } from '../sdk.js';
import { OPENAPI_ANSWERS_OPTION } from './events.js';
import { streamRemoteEvents } from './remote-events.js';
import { historyFramesToEvents } from './translate.js';

const WORKSPACE_CWD = '/data-agent';
const unavailable = (reply: FastifyReply) => reply.code(404).send({ error: '上游未提供可靠的会话运行状态', code: 'not_implemented' });

/** Protocol identity only: the opaque clientId is never stored or used to claim upstream event ownership. */
function sessionBody(sessionId: string) {
  return { sessionId, clientId: randomUUID(), workspaceCwd: WORKSPACE_CWD, attached: false,
    sourceType: 'standalone', context: { kind: 'standalone' },
    projectlessOutputDirectory: `${WORKSPACE_CWD}/out/${sessionId}`, workingDirectory: { state: 'ready' } };
}
function summary(row: SessionSummary) {
  return { sessionId: row.sessionId, workspaceCwd: WORKSPACE_CWD, sourceType: 'standalone', context: { kind: 'standalone' },
    createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
    displayName: stripMarkerInstruction(row.title) || row.sessionId.slice(0, 8) };
}

/** LIVE is a request-scoped projection of POP. No Registry, journal, completion bus or per-session cache. */
export async function registerLiveDaemonRoutes(app: FastifyInstance, cfg: AppConfig, client: SdkClient): Promise<void> {
  const live: LiveContext = { client, cfg, log: app.log };
  const forAgent = (value: unknown): LiveContext => ({ ...live, cfg: { ...cfg, agentName: optionalAgentName(value) ?? cfg.agentName } });
  await app.register(async d => {
    d.get('/health', async () => ({ status: 'ok' }));
    d.get('/openapi/session-options', async () => ({ ...publicSessionOptions(cfg), promptTransport: 'http-stream' }));
    d.get('/capabilities', async () => ({ v: 1, mode: 'standalone',
      features: ['standalone_sessions_v1', 'standalone_session_options_v1', 'session_permission_vote'],
      modelServices: ['data-agent'], workspaces: [], policy: {}, sessionLiveStatePollIntervalMs: 30_000 }));
    d.get('/daemon/status', async (_request, reply) => unavailable(reply));
    d.get('/session/:id/status', async (_request, reply) => unavailable(reply));
    d.post('/session/:id/heartbeat', async (_request, reply) => reply.code(204).send());
    d.get('/standalone/session-options', async () => ({ v: 1, initialized: true, approvalMode: cfg.mode ?? 'yolo',
      providers: [{ kind: 'model_provider', status: 'ok', authType: 'none', current: true,
        models: (publicSessionOptions(cfg).models.length ? publicSessionOptions(cfg).models : ['data-agent']).map(modelId => ({
          modelId, baseModelId: modelId, name: modelId === 'data-agent' ? '默认模型' : modelId,
          isCurrent: modelId === (cfg.model ?? 'data-agent'), isRuntime: false,
        })) }], errors: [] }));

    d.get<{ Querystring: { archiveState?: string; agentName?: unknown } }>('/standalone/sessions', async (request, reply) => {
      let context: LiveContext;
      try { context = forAgent(request.query?.agentName); }
      catch (error) { return reply.code(400).send({ error: (error as Error).message, code: 'invalid_agent_name' }); }
      const result = await liveListSessions(context, request.query?.archiveState === 'archived');
      if (!result.ok) return reply.code(502).send({ error: result.error.message, code: 'list_failed' });
      return { sessions: result.result.sessions.map(summary), truncated: result.result.truncated === true };
    });
    d.post<{ Body: Record<string, unknown> }>('/standalone/sessions', async (request, reply) => {
      let options;
      try { options = sessionOptions(cfg, request.body ?? {}); }
      catch (error) { return reply.code(400).send({ error: (error as Error).message, code: 'invalid_session_options' }); }
      const result = await liveCreateSession(live, options);
      if (!result.ok) return reply.code(502).send({ error: result.error.message, code: 'create_failed' });
      return sessionBody(result.result.sessionId);
    });
    d.get<{ Params: { id: string }; Querystring: { agentName?: unknown } }>('/standalone/sessions/:id', async (request, reply) => {
      let context: LiveContext;
      try { context = forAgent(request.query?.agentName); }
      catch (error) { return reply.code(400).send({ error: (error as Error).message, code: 'invalid_agent_name' }); }
      let truncated = false;
      for (const archived of [false, true]) {
        const result = await liveListSessions(context, archived);
        if (!result.ok) return reply.code(502).send({ error: result.error.message, code: 'lookup_failed' });
        const row = result.result.sessions.find(row => row.sessionId === request.params.id);
        if (row) return summary(row);
        truncated ||= result.result.truncated === true;
      }
      return reply.code(truncated ? 503 : 404).send({ error: truncated ? '上游列表未取完，无法确认会话是否存在' : '没有这个会话',
        code: truncated ? 'lookup_incomplete' : 'standalone_session_not_found' });
    });
    async function load(id: string, reply: FastifyReply) {
      try {
        const frames = await liveLoadFrames(live, id);
        return { ...sessionBody(id), state: { models: { currentModelId: null, availableModels: [] }, modes: {}, configOptions: null },
          compactedReplay: historyFramesToEvents(frames, id), liveJournal: [], historyHasMore: false,
          eventEpoch: `openapi:${cfg.regionId}:${id}` };
      } catch (error) {
        const api = toApiError(error, 'LoadAgentSession');
        return reply.code(api.kind === 'transport' ? 502 : 404).send({ error: api.message, code: 'load_failed' });
      }
    }
    for (const operation of ['load', 'resume']) {
      d.post<{ Params: { id: string } }>(`/standalone/sessions/:id/${operation}`, async (request, reply) => load(request.params.id, reply));
    }
    d.get<{ Params: { id: string } }>('/session/:id/transcript', async (request, reply) => {
      try { return { v: 1, sessionId: request.params.id, events: historyFramesToEvents(await liveLoadFrames(live, request.params.id), request.params.id), hasMore: false }; }
      catch (error) { return reply.code(502).send({ error: toApiError(error, 'LoadAgentSession').message, code: 'history_failed' }); }
    });
    async function rename(id: string, value: unknown, reply: FastifyReply) {
      const name = typeof value === 'string' ? value.trim() : '';
      if (!name || name.length > 512) return reply.code(400).send({ error: 'displayName 不能为空且最多512字符', code: 'invalid_metadata' });
      const result = await liveSessionMutation(live, 'UpdateAgentSessionTitle', id, { Title: name });
      if (!result.ok) return reply.code(502).send({ error: result.error.message, code: 'rename_failed' });
      return { sessionId: id, displayName: name };
    }
    for (const path of ['/session/:id/metadata', '/standalone/sessions/:id/metadata']) {
      d.patch<{ Params: { id: string }; Body: { displayName?: unknown } }>(path, async (request, reply) => rename(request.params.id, request.body?.displayName, reply));
    }
    for (const action of ['archive', 'unarchive', 'delete'] as const) {
      d.post<{ Body: { sessionIds?: unknown } }>(`/standalone/sessions/${action}`, async request => {
        const ids = (Array.isArray(request.body?.sessionIds) ? request.body.sessionIds : []).filter((id): id is string => typeof id === 'string');
        const done: string[] = []; const errors: Array<{ sessionId: string; code: string; message: string }> = [];
        for (const id of ids) {
          const result = await liveSessionMutation(live, action === 'delete' ? 'DeleteAgentSession' : 'ArchiveAgentSession', id,
            action === 'delete' ? {} : { Archived: action === 'archive' });
          if (result.ok) done.push(id);
          else errors.push({ sessionId: id, code: result.error.kind, message: result.error.message });
        }
        return action === 'delete' ? { removed: done, notFound: [], errors, fileCleanupPending: [] }
          : action === 'archive' ? { archived: done, alreadyArchived: [], notFound: [], errors }
          : { unarchived: done, alreadyActive: [], notFound: [], errors };
      });
    }
    d.delete<{ Params: { id: string } }>('/session/:id', async (request, reply) => {
      const result = await liveSessionMutation(live, 'DeleteAgentSession', request.params.id);
      return result.ok ? reply.code(204).send() : reply.code(502).send({ error: result.error.message, code: 'delete_failed' });
    });
    d.post<{ Params: { id: string } }>('/session/:id/cancel', async (request, reply) => {
      const result = await liveCancel(live, request.params.id);
      if (!result.ok || (!result.result.delivered && !result.result.noop && !result.result.accepted)) {
        return reply.code(502).send({ error: result.ok ? result.result.detail : result.error.message, code: 'cancel_failed' });
      }
      return reply.code(204).send();
    });
    // The only LIVE Prompt implementation is POST /api/sessions/:id/prompt (NDJSON).
    for (const path of ['/session/:id/prompt', '/session/:id/openapi-prompt/:promptId/receipt']) {
      d.post(path, async (_request, reply) => reply.code(410).send({ error: '请使用 /api/sessions/:id/prompt 的请求流终态', code: 'http_stream_required' }));
    }
    d.get<{ Params: { id: string } }>('/session/:id/events', async (request, reply) => {
      const header = request.headers['last-event-id'];
      const cursor = Array.isArray(header) ? header[0] : header;
      if (cursor !== undefined && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) {
        return reply.code(400).send({ error: '无效的事件游标', code: 'invalid_cursor' });
      }
      try { await streamRemoteEvents(reply, live, request.params.id, cursor); }
      catch (error) {
        if (!reply.sent) return reply.code(502).send({ error: toApiError(error, 'GetAgentSessionEvents').message, code: 'events_upstream_failed' });
        app.log.warn({ sessionId: request.params.id }, '远端 Events 流结束；不重发 Prompt');
      }
      return reply;
    });
    d.post<{ Params: { id: string; requestId: string }; Body: { outcome?: { outcome?: string; optionId?: string }; answers?: Record<string, string> } }>(
      '/session/:id/permission/:requestId', async (request, reply) => {
        const kind = request.body?.outcome?.outcome === 'cancelled' ? 'cancelled' : 'selected';
        let optionId = typeof request.body?.outcome?.optionId === 'string' ? request.body.outcome.optionId.trim() : '';
        const answers = request.body?.answers && typeof request.body.answers === 'object' && !Array.isArray(request.body.answers) ? request.body.answers : undefined;
        if (optionId === OPENAPI_ANSWERS_OPTION) {
          if (kind !== 'selected' || !answers || !Object.keys(answers).length) return reply.code(400).send({ error: '问答提交必须包含 answers', code: 'invalid_permission_response' });
          optionId = '';
        }
        if (kind === 'selected' && !optionId && (!answers || !Object.keys(answers).length)) return reply.code(400).send({ error: '需要 optionId 或 answers', code: 'invalid_permission_response' });
        const result = await liveReply(live, request.params.id, { permissionRequestId: request.params.requestId, outcome: kind, answers,
          ...(optionId ? { optionId } : {}) });
        if (!result.ok) return reply.code(502).send({ error: result.error.message, code: 'permission_upstream_error' });
        return result.result.accepted ? reply.send({}) : reply.code(404).send({ error: '上游未接受此回覆', code: 'permission_not_accepted' });
      });
    d.post('/permission/:requestId', async (_request, reply) => reply.code(410).send({ error: 'LIVE 回覆必须提供 sessionId', code: 'session_id_required' }));
    for (const operation of ['model', 'approval-mode', 'config-option']) {
      d.post(`/session/:id/${operation}`, async (_request, reply) => reply.code(409).send({ error: '配置仅在创建时生效，请新建会话', code: 'new_session_required' }));
    }
    d.get('/workspace/tools', async () => ({ tools: [] }));
    d.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: '此 OpenAPI 协议能力不可用', code: 'not_implemented' }));
  }, { prefix: '/d' });
}
