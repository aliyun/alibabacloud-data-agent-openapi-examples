import { DaemonHttpError, DaemonSessionClient, type DaemonClient, type DaemonStandaloneSession } from '@qwen-code/sdk/daemon';
import { installHttpPromptTransport, type PromptTransport } from './http-prompt-transport';

const cursorlessRestoreMetadata = new WeakSet<object>();
const installedClients = new WeakSet<DaemonClient>();
const decorators = new WeakMap<DaemonClient, (session: DaemonSessionClient) => void>();
const restoreFactories = ['load', 'resume', 'loadStandalone', 'resumeStandalone', 'createOrAttach', 'createStandalone'] as const;
let restoreCompatibilityUsers = 0;
let restoreCompatibilityCleanup: (() => void) | undefined;

/** Keep the response's missing-watermark provenance through the SDK's ?? 0 fallback. */
function preserveRestoreCursor<T extends { state: object; lastEventId?: number }>(response: T): T {
  if (response.lastEventId !== undefined) return response;
  // The SDK shallow-copies state. A unique nested public _meta object preserves
  // provenance through that copy without adding a wire field or guessing from 0.
  const metadata = { ...(response.state as { _meta?: Record<string, unknown> | null })._meta };
  const state = { ...response.state, _meta: metadata };
  cursorlessRestoreMetadata.add(metadata);
  return { ...response, state };
}

function installRestoreCursorCompatibility(): () => void {
  if (restoreCompatibilityUsers++ === 0) {
    const originals = {
      load: DaemonSessionClient.load, resume: DaemonSessionClient.resume,
      loadStandalone: DaemonSessionClient.loadStandalone, resumeStandalone: DaemonSessionClient.resumeStandalone,
      createOrAttach: DaemonSessionClient.createOrAttach, createStandalone: DaemonSessionClient.createStandalone,
    };
    const preserve = (client: DaemonClient, session: DaemonSessionClient) => {
      if (session.state._meta && cursorlessRestoreMetadata.has(session.state._meta)) session.setLastEventId(undefined);
      decorators.get(client)?.(session);
      return session;
    };
    // Only public factories and the public cursor setter are used. Other clients'
    // restores have no marked state and keep the SDK's original behavior.
    const wrappers: typeof originals = {
      load: async (...args) => preserve(args[0], await originals.load(...args)),
      resume: async (...args) => preserve(args[0], await originals.resume(...args)),
      loadStandalone: async (...args) => preserve(args[0], await originals.loadStandalone(...args)),
      resumeStandalone: async (...args) => preserve(args[0], await originals.resumeStandalone(...args)),
      createOrAttach: async (...args) => preserve(args[0], await originals.createOrAttach(...args)),
      createStandalone: async (...args) => preserve(args[0], await originals.createStandalone(...args)),
    };
    Object.assign(DaemonSessionClient, wrappers);
    restoreCompatibilityCleanup = () => {
      for (const method of restoreFactories) {
        if (DaemonSessionClient[method] === wrappers[method]) Object.assign(DaemonSessionClient, { [method]: originals[method] });
      }
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--restoreCompatibilityUsers === 0) { restoreCompatibilityCleanup?.(); restoreCompatibilityCleanup = undefined; }
  };
}

/** The daemon SDK requires a caller-generated UUID. OpenAPI owns session IDs,
 * so adapt only creation; load, prompt, SSE and permissions retain the SDK flow.
 * Do not retry an ambiguous POST: OpenAPI creation is not idempotent.
 */
export interface OpenApiCreateOptions { agentName?: string; modelServiceId?: string; approvalMode?: string; reasoningEffort?: string }
export interface SessionDefaults { agentName: string; model?: string; approvalMode: string; reasoningEffort?: string; models: string[]; promptTransport?: PromptTransport }

export function installOpenApiSessionCreation(client: DaemonClient, baseUrl: string,
  configure?: (options: OpenApiCreateOptions) => Promise<OpenApiCreateOptions>,
  hooks?: { onCreated?: (options: OpenApiCreateOptions, session: DaemonStandaloneSession) => void; onCreateError?: (error: Error) => void; defaults?: () => Promise<SessionDefaults>; agentName?: (sessionId?: string) => string | undefined | Promise<string | undefined>; onDiscovered?: (sid: string, agent: string) => void }): () => void {
  // Reject before changing client methods or the shared SDK factory shim.
  if (installedClients.has(client)) throw new Error('OpenAPI session adapter is already installed on this client');
  installedClients.add(client);
  const original = client.createStandaloneSession;
  const originalOptions = client.getStandaloneSessionOptions;
  const originalList = client.listStandaloneSessions;
  const originalPage = client.listStandaloneSessionsPage;
  const originalLookup = client.getStandaloneSession;
  if (hooks?.agentName) {
    const scopedGet = async (path: string, sid?: string) => {
      const url = new URL(`${baseUrl}${path}`);
      const agent = await hooks.agentName!(sid);
      if (agent) url.searchParams.set('agentName', agent);
      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });
      const body = await response.json();
      if (!response.ok) throw new DaemonHttpError(response.status, body, '读取 Agent 会话失败');
      return { body, agent };
    };
    client.listStandaloneSessionsPage = async options => {
      const query = new URLSearchParams();
      if (options?.pageSize !== undefined) query.set('size', String(options.pageSize));
      if (options?.cursor) query.set('cursor', options.cursor);
      if (options?.archiveState) query.set('archiveState', options.archiveState);
      const { body, agent } = await scopedGet(`/standalone/sessions?${query}`);
      if (!body || !Array.isArray(body.sessions) || body.sessions.some((row: unknown) => !row || typeof row !== 'object' || !('sessionId' in row) || typeof row.sessionId !== 'string')) throw new Error('无效的 Agent 会话列表');
      if (agent) for (const row of body.sessions) hooks.onDiscovered?.(row.sessionId, agent);
      return body;
    };
    client.listStandaloneSessions = async options => (await client.listStandaloneSessionsPage(options)).sessions;
    client.getStandaloneSession = async sid => {
      const { body, agent } = await scopedGet(`/standalone/sessions/${encodeURIComponent(sid)}`, sid);
      if (!body || body.sessionId !== sid) throw new Error('无效的 Agent 会话');
      if (agent) hooks.onDiscovered?.(sid, agent);
      return body;
    };
  }
  const originalLoad = client.loadSession;
  const originalResume = client.resumeSession;
  const originalLoadStandalone = client.loadStandaloneSession;
  const originalResumeStandalone = client.resumeStandaloneSession;
  const releaseRestoreCompatibility = installRestoreCursorCompatibility();
  client.loadSession = async (...args) => preserveRestoreCursor(await originalLoad.apply(client, args));
  client.resumeSession = async (...args) => preserveRestoreCursor(await originalResume.apply(client, args));
  client.loadStandaloneSession = async (...args) => preserveRestoreCursor(await originalLoadStandalone.apply(client, args));
  client.resumeStandaloneSession = async (...args) => preserveRestoreCursor(await originalResumeStandalone.apply(client, args));
  let disposed = false;
  let selectedTransport: Promise<PromptTransport> | undefined;
  const readTransport = () => selectedTransport ??= (async () => {
    let value: SessionDefaults;
    if (hooks?.defaults) value = await hooks.defaults();
    else {
      const response = await fetch(`${baseUrl}/openapi/session-options`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('无法读取后端 Prompt 协议');
      value = await response.json() as SessionDefaults;
    }
    if (value.promptTransport !== 'http-stream' && value.promptTransport !== 'daemon') throw new Error('后端未声明 Prompt 协议，请同步更新前后端。');
    return value.promptTransport;
  })();
  const http = installHttpPromptTransport(client, baseUrl, readTransport);
  decorators.set(client, http.decorate);
  if (hooks?.defaults) client.getStandaloneSessionOptions = async () => {
    const result = await originalOptions.call(client);
    const defaults = await hooks.defaults!();
    return { ...result, approvalMode: defaults.approvalMode as typeof result.approvalMode,
      providers: result.providers.map(provider => ({ ...provider,
        models: [...new Set([defaults.model, ...provider.models.map(model => model.modelId)].filter((value): value is string => !!value))]
          .map(modelId => ({ ...(provider.models.find(model => model.modelId === modelId) ?? { modelId, baseModelId: modelId, name: modelId, isRuntime: false }),
            isCurrent: modelId === (defaults.model ?? 'data-agent') })),
      })) };
  };
  client.createStandaloneSession = async (options = {}) => {
    try {
      const { agentName, modelServiceId, approvalMode, reasoningEffort } = configure ? await configure(options) : options as OpenApiCreateOptions;
      const response = await fetch(`${baseUrl}/standalone/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentName, modelServiceId, approvalMode, reasoningEffort }),
        signal: AbortSignal.timeout(120_000),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const detail = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? `：${body.error}` : '';
        throw new DaemonHttpError(response.status, body, `创建 OpenAPI 会话失败${detail}`);
      }
      if (!isStandaloneSession(body)) throw new Error('创建会话返回了无效的 OpenAPI session');
      hooks?.onCreated?.({ agentName, modelServiceId, approvalMode, reasoningEffort }, body);
      return body;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('创建会话请求失败');
      if (failure.name !== 'AbortError') hooks?.onCreateError?.(failure);
      throw error;
    }
  };
  return () => {
    if (disposed) return;
    disposed = true;
    http.dispose();
    decorators.delete(client);
    client.createStandaloneSession = original; client.getStandaloneSessionOptions = originalOptions;
    client.listStandaloneSessions = originalList; client.listStandaloneSessionsPage = originalPage; client.getStandaloneSession = originalLookup;
    client.loadSession = originalLoad; client.resumeSession = originalResume;
    client.loadStandaloneSession = originalLoadStandalone; client.resumeStandaloneSession = originalResumeStandalone;
    releaseRestoreCompatibility();
    installedClients.delete(client);
  };
}

function isStandaloneSession(value: unknown): value is DaemonStandaloneSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  const context = s.context as { kind?: unknown } | null;
  const directory = s.workingDirectory as { state?: unknown } | null;
  return typeof s.sessionId === 'string' && s.sessionId.trim().length > 0
    && typeof s.workspaceCwd === 'string' && s.workspaceCwd.length > 0
    && typeof s.attached === 'boolean'
    && typeof s.clientId === 'string' && s.clientId.length > 0
    && s.sourceType === 'standalone' && context?.kind === 'standalone'
    && typeof s.projectlessOutputDirectory === 'string'
    && (directory?.state === 'ready' || directory?.state === 'recreated');
}
