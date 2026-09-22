import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient, DaemonSessionClient } from '@qwen-code/sdk/daemon';
import { installOpenApiSessionCreation, installSessionLoadNotice } from '../src/session-client';

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
});


it('exposes load failure without swallowing it and clears the notice after recovery', async () => {
  const client = new DaemonClient({ baseUrl: 'http://localhost/d' });
  const original = vi.spyOn(client, 'loadStandaloneSession')
    .mockRejectedValueOnce(new Error('upstream timeout'))
    .mockResolvedValueOnce({ ...session } as any);
  const notify = vi.fn();
  const restore = installSessionLoadNotice(client, notify);
  await expect(client.loadStandaloneSession('test-session')).rejects.toThrow('upstream timeout');
  expect(notify.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'test-session', message: expect.stringContaining('加载失败') });
  expect(original).toHaveBeenCalledWith('test-session', { timeoutMs: 35_000 }, undefined);
  await client.loadStandaloneSession('test-session');
  expect(notify).toHaveBeenLastCalledWith({ sessionId: 'test-session' });
  restore();
  expect(client.loadStandaloneSession).toBe(original);
  client.dispose();
});
