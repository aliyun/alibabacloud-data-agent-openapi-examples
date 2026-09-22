import { DaemonHttpError, type DaemonClient, type DaemonStandaloneSession } from '@qwen-code/sdk/daemon';

/** The daemon SDK requires a caller-generated UUID. OpenAPI owns session IDs,
 * so adapt only creation; load, prompt, SSE and permissions retain the SDK flow.
 * Do not retry an ambiguous POST: OpenAPI creation is not idempotent.
 */
export function installOpenApiSessionCreation(client: DaemonClient, baseUrl: string): () => void {
  const original = client.createStandaloneSession;
  client.createStandaloneSession = async (options = {}) => {
    const { modelServiceId, approvalMode } = options;
    const response = await fetch(`${baseUrl}/standalone/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelServiceId, approvalMode }),
      signal: AbortSignal.timeout(120_000),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      throw new DaemonHttpError(response.status, body, '创建 OpenAPI 会话失败');
    }
    if (!isStandaloneSession(body)) throw new Error('创建会话返回了无效的 OpenAPI session');
    return body;
  };
  return () => { client.createStandaloneSession = original; };
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


export interface SessionLoadNotice { sessionId: string; message?: string }

/** Keep a failed history request visible while the shell reconnects. */
export function installSessionLoadNotice(client: DaemonClient, notify: (notice: SessionLoadNotice) => void): () => void {
  const original = client.loadStandaloneSession;
  client.loadStandaloneSession = async (sessionId, request, clientId) => {
    try {
      const restored = await original.call(client, sessionId, {
        ...request, timeoutMs: request?.timeoutMs && request.timeoutMs > 0 ? Math.min(request.timeoutMs, 35_000) : 35_000,
      }, clientId);
      notify({ sessionId });
      return restored;
    } catch (error) {
      const status = error instanceof DaemonHttpError ? `（HTTP ${error.status}）` : '';
      notify({ sessionId, message: `会话历史加载失败${status}，正在重试。若持续失败，请向管理员提供会话 ID：${sessionId}。` });
      throw error;
    }
  };
  return () => { client.loadStandaloneSession = original; };
}
