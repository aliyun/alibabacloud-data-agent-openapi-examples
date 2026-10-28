import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DaemonClient, DaemonSessionClient } from '@qwen-code/sdk/daemon';
import { installOpenApiSessionCreation } from '../src/session-client';

beforeEach(() => vi.stubGlobal('window', { location: { href: 'http://fixture/' } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('rejects duplicate installation on one client before changing client methods or SDK factories', () => {
  const client = new DaemonClient({ baseUrl: 'http://fixture/d' });
  const methods = ['createStandaloneSession', 'getStandaloneSessionOptions', 'promptNonBlocking', 'subscribeEvents',
    'loadSession', 'resumeSession', 'loadStandaloneSession', 'resumeStandaloneSession'] as const;
  const restore = installOpenApiSessionCreation(client, 'http://fixture/d');
  const installedMethods = methods.map(method => client[method]);
  const installedFactories = restoreMethods.map(method => DaemonSessionClient[method]);
  let duplicateCleanup: (() => void) | undefined;
  try {
    expect(() => { duplicateCleanup = installOpenApiSessionCreation(client, 'http://other/d'); }).toThrow(/already installed/);
    expect(methods.map(method => client[method])).toEqual(installedMethods);
    expect(restoreMethods.map(method => DaemonSessionClient[method])).toEqual(installedFactories);
  } finally { duplicateCleanup?.(); restore(); client.dispose(); }
});

it('allows reinstall after cleanup and makes stale cleanup unable to undo the new installation', () => {
  const client = new DaemonClient({ baseUrl: 'http://fixture/d' });
  const originalCreate = client.createStandaloneSession;
  const originalFactories = restoreMethods.map(method => DaemonSessionClient[method]);
  const releaseFirst = installOpenApiSessionCreation(client, 'http://fixture/d');
  releaseFirst();
  const releaseSecond = installOpenApiSessionCreation(client, 'http://fixture/d');
  let duplicateCleanup: (() => void) | undefined;
  try {
    const installedCreate = client.createStandaloneSession;
    const installedFactories = restoreMethods.map(method => DaemonSessionClient[method]);
    releaseFirst(); releaseFirst();
    expect(client.createStandaloneSession).toBe(installedCreate);
    expect(restoreMethods.map(method => DaemonSessionClient[method])).toEqual(installedFactories);
    expect(() => { duplicateCleanup = installOpenApiSessionCreation(client, 'http://fixture/d'); }).toThrow(/already installed/);
  } finally { duplicateCleanup?.(); releaseSecond(); releaseSecond(); client.dispose(); }
  expect(client.createStandaloneSession).toBe(originalCreate);
  expect(restoreMethods.map(method => DaemonSessionClient[method])).toEqual(originalFactories);
});

const restoreMethods = ['load', 'resume', 'loadStandalone', 'resumeStandalone'] as const;
const restoreCases = restoreMethods.flatMap(method => [
  { method, watermark: undefined, explicitCursor: undefined, expectedHeader: null },
  { method, watermark: 0, explicitCursor: undefined, expectedHeader: '0' },
  { method, watermark: 37, explicitCursor: undefined, expectedHeader: '37' },
  { method, watermark: undefined, explicitCursor: 0, expectedHeader: '0' },
  { method, watermark: undefined, explicitCursor: 23, expectedHeader: '23' },
]);

it.each(restoreCases)('preserves restore cursor provenance through real SDK $method: server=$watermark explicit=$explicitCursor', async ({ method, watermark, explicitCursor, expectedHeader }) => {
  const headers: Array<string | null> = [];
  // Equal text in distinct records is intentional: restoration must not dedupe text.
  const history = ['record-a', 'record-b'].map(recordId => ({ v: 1, type: 'session_update', data: {
    sessionId: 'restored-session', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'same question' },
      _meta: { 'qwen.session.recordId': recordId } },
  } }));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/openapi/session-options')) return Response.json({ promptTransport: 'http-stream' });
    if (String(input).endsWith('/capabilities')) return Response.json({ v: 1, features: ['standalone_sessions_v1'] });
    if (String(input).includes('/events')) {
      headers.push(new Headers(init?.headers).get('Last-Event-ID'));
      return new Response('id: 41\nevent: session_update\ndata: {"v":1,"id":41,"type":"session_update","data":{"sessionId":"restored-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"live"}}}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ sessionId: 'restored-session', clientId: 'client', workspaceCwd: '/data-agent', attached: false,
      sourceType: 'standalone', context: { kind: 'standalone' }, projectlessOutputDirectory: '/data-agent/out/restored-session',
      workingDirectory: { state: 'ready' }, state: {}, hasActivePrompt: false, compactedReplay: history, liveJournal: [],
      ...(watermark !== undefined ? { lastEventId: watermark } : {}) });
  });
  const client = new DaemonClient({ baseUrl: 'http://fixture/d' });
  const restore = installOpenApiSessionCreation(client, 'http://fixture/d');
  try {
    const session = await DaemonSessionClient[method](client, 'restored-session');
    expect(session.lastEventId).toBe(watermark);
    if (method === 'load' || method === 'loadStandalone') expect(session.consumeReplaySnapshot().compactedReplay).toEqual(history);
    for await (const _event of session.events(explicitCursor === undefined ? {} : { lastEventId: explicitCursor })) { /* Read the real transport. */ }
    expect(headers).toEqual([expectedHeader]);
    expect(session.lastEventId).toBe(41);
    // Reconnect now uses a cursor actually observed from Events, never a local history ID.
    for await (const _event of session.events()) { /* Drain the finite fixture stream. */ }
    expect(headers).toEqual([expectedHeader, '41']);
  } finally { restore(); client.dispose(); }
});

it('scopes restore compatibility to adapted clients and restores public factories after the last adapter', async () => {
  const originalFactories = restoreMethods.map(method => DaemonSessionClient[method]);
  const response = { sessionId: 'restored-session', clientId: 'client', workspaceCwd: '/data-agent', attached: false,
    sourceType: 'standalone', context: { kind: 'standalone' }, projectlessOutputDirectory: '/data-agent/out/restored-session',
    workingDirectory: { state: 'ready' }, state: {}, compactedReplay: [], liveJournal: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => Response.json(String(input).endsWith('/capabilities')
    ? { v: 1, features: ['standalone_sessions_v1'] } : response));
  const first = new DaemonClient({ baseUrl: 'http://first/d' });
  const second = new DaemonClient({ baseUrl: 'http://second/d' });
  const unadapted = new DaemonClient({ baseUrl: 'http://other/d' });
  const releaseFirst = installOpenApiSessionCreation(first, 'http://first/d');
  const releaseSecond = installOpenApiSessionCreation(second, 'http://second/d');
  try {
    expect((await DaemonSessionClient.loadStandalone(unadapted, 'restored-session')).lastEventId).toBe(0);
    releaseFirst(); releaseFirst();
    expect((await DaemonSessionClient.loadStandalone(second, 'restored-session')).lastEventId).toBeUndefined();
  } finally {
    releaseFirst(); releaseSecond(); first.dispose(); second.dispose(); unadapted.dispose();
  }
  expect(restoreMethods.map(method => DaemonSessionClient[method])).toEqual(originalFactories);
});
