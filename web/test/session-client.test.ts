import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient, DaemonSessionClient } from '@qwen-code/sdk/daemon';
import { installOpenApiSessionCreation } from '../src/session-client';

const session = {
  sessionId: 'openapi-real-session-id', clientId: 'client-id', workspaceCwd: '/data-agent',
  attached: false, sourceType: 'standalone', context: { kind: 'standalone' },
  projectlessOutputDirectory: '/data-agent/out/openapi-real-session-id', workingDirectory: { state: 'ready' },
};
afterEach(() => vi.unstubAllGlobals());

describe('OpenAPI session creation with the actual SDK', () => {
  it('retains the server ID and uses it for subsequent SDK prompt requests', async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(url);
      if (url.endsWith('/standalone/sessions')) {
        expect(JSON.parse(init!.body as string)).toEqual({ modelServiceId: 'data-agent' });
        return Response.json(session);
      }
      if (url.endsWith('/openapi/session-options')) return Response.json({ promptTransport: 'daemon' });
      return Response.json({ stopReason: 'end_turn' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new DaemonClient({ baseUrl: 'http://localhost/d' });
    const restore = installOpenApiSessionCreation(client, 'http://localhost/d');
    const created = await DaemonSessionClient.createStandalone(client, { sessionId: 'unwanted-client-id', modelServiceId: 'data-agent' });
    expect(created.sessionId).toBe(session.sessionId);
    await created.prompt({ prompt: [{ type: 'text', text: 'hello' }] });
    expect(requests).toContain(`http://localhost/d/session/${session.sessionId}/prompt`);
    restore();
    client.dispose();
  });

  it('does not retry failed or malformed creation responses', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: 'upstream failed' }, { status: 502 }))
      .mockResolvedValueOnce(Response.json({ sessionId: '' }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new DaemonClient({ baseUrl: 'http://localhost/d' });
    installOpenApiSessionCreation(client, 'http://localhost/d');
    await expect(client.createStandaloneSession()).rejects.toThrow('创建 OpenAPI 会话失败');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(client.createStandaloneSession()).rejects.toThrow('无效');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it('submits all creation settings once and cancellation never sends a create request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(session));
    vi.stubGlobal('fetch', fetchMock);
    const client = new DaemonClient({ baseUrl: 'http://localhost/d' });
    let restore = installOpenApiSessionCreation(client, 'http://localhost/d', async () => ({
      modelServiceId: 'model-from-dialog', approvalMode: 'yolo', reasoningEffort: 'none',
    }));
    await client.createStandaloneSession();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ modelServiceId: 'model-from-dialog', approvalMode: 'yolo', reasoningEffort: 'none' });
    restore();
    restore = installOpenApiSessionCreation(client, 'http://localhost/d', async () => { throw new DOMException('cancel', 'AbortError'); });
    await expect(client.createStandaloneSession()).rejects.toThrow('cancel');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    restore(); client.dispose();
  });
  it('forwards selected Agent on create and scopes lists/lookups without changing SID operations', async () => {
    const requests: { url: string; body?: Record<string, unknown> }[] = [];
    let selected = 'agent-a';
    const discovered: [string, string][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const path = new URL(String(url)).pathname;
      if (init?.method === 'POST') return Response.json(session);
      if (path.endsWith('/standalone/sessions')) return Response.json({ sessions: [{ sessionId: 'listed-id' }] });
      return Response.json({ sessionId: session.sessionId });
    }));
    const client = new DaemonClient({ baseUrl: 'http://localhost/d' });
    const originalPage = client.listStandaloneSessionsPage;
    const restore = installOpenApiSessionCreation(client, 'http://localhost/d', async options => ({ ...options, agentName: selected }), {
      agentName: sid => sid ? 'original-agent' : selected,
      onDiscovered: (sid, agent) => { discovered.push([sid, agent]); },
    });
    await client.createStandaloneSession();
    expect(requests[0]?.body?.agentName).toBe('agent-a');
    selected = 'agent-b';
    await client.listStandaloneSessionsPage({ archiveState: 'archived', pageSize: 5 });
    const list = new URL(requests[1]!.url);
    expect(list.searchParams.get('agentName')).toBe('agent-b');
    expect(list.searchParams.get('archiveState')).toBe('archived');
    expect(list.searchParams.get('size')).toBe('5');
    await client.getStandaloneSession(session.sessionId);
    expect(new URL(requests[2]!.url).searchParams.get('agentName')).toBe('original-agent');
    expect(discovered).toEqual([['listed-id', 'agent-b'], [session.sessionId, 'original-agent']]);
    restore();
    expect(client.listStandaloneSessionsPage).toBe(originalPage);
    client.dispose();
  });

});
