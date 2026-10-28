import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import {
  ListAgentsRequest, LoadAgentSessionRequest, LoadAgentSessionRequestParams,
  PromptAgentSessionRequest, PromptAgentSessionRequestParams,
} from '@alicloud/dataworks-public20240518';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { describeConfig, loadConfig } from '../src/config.js';
import { callOpenApi, openSessionEvents } from '../src/openapi.js';
import { createSdkClient, runtimeFor, runtimeForSse, SdkError } from '../src/sdk.js';

// Never load the workspace's credentials; all requests use a loopback endpoint.
vi.mock('dotenv', () => ({ config: vi.fn() }));
const AK = 'synthetic-access-key';
const SK = 'synthetic-access-secret';
const TOKEN = 'synthetic-security-token';

beforeEach(() => {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    vi.stubEnv(key, '');
  }
  vi.stubEnv('NO_PROXY', '127.0.0.1');
  vi.stubEnv('no_proxy', '127.0.0.1');
  vi.stubEnv('DAS_ENV', '');
  vi.stubEnv('MOCK', '0');
  vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_ID', AK);
  vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_SECRET', SK);
  vi.stubEnv('ALIBABA_CLOUD_SECURITY_TOKEN', undefined);
});
afterEach(() => vi.unstubAllEnvs());

interface Captured {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Independently verify the wire signature, including the secret and signed token. */
function verifySignature(request: Captured, token: string | undefined) {
  expect(request.headers['x-acs-security-token']).toBe(token);
  const auth = String(request.headers.authorization);
  const match = /^ACS3-HMAC-SHA256 Credential=([^,]+),SignedHeaders=([^,]+),Signature=([a-f0-9]{64})$/.exec(auth);
  expect(match).not.toBeNull();
  expect(match![1]).toBe(AK);
  const signed = match![2]!;
  expect(signed.split(';').includes('x-acs-security-token')).toBe(token !== undefined);
  const url = new URL(request.url, 'http://127.0.0.1');
  const query = [...url.searchParams].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  const canonicalHeaders = signed.split(';').map(key => `${key}:${String(request.headers[key]).trim()}\n`).join('');
  const payloadHash = sha256(request.body);
  expect(request.headers['x-acs-content-sha256']).toBe(payloadHash);
  const canonical = [request.method, url.pathname, query, canonicalHeaders, signed, payloadHash].join('\n');
  const signature = createHmac('sha256', SK).update(`ACS3-HMAC-SHA256\n${sha256(canonical)}`).digest('hex');
  expect(match![3]).toBe(signature);
}

it.each([undefined, '', ' \t ', ` ${TOKEN} `])('passes configured credentials through every transport (token=%j)', async rawToken => {
  vi.stubEnv('ALIBABA_CLOUD_SECURITY_TOKEN', rawToken);
  const cfg = loadConfig();
  const token = rawToken?.trim() || undefined;
  expect(cfg.securityToken).toBe(token);
  for (const secret of [AK, SK, TOKEN]) expect(describeConfig(cfg)).not.toContain(secret);

  const requests: Captured[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
    const action = req.headers['x-acs-action'];
    const streaming = ['PromptAgentSession', 'LoadAgentSession', 'GetAgentSessionEvents'].includes(String(action));
    res.writeHead(200, { 'content-type': streaming ? 'text/event-stream' : 'application/json' });
    res.end(streaming
      ? 'data: {"JsonRpcResponse":{"Result":{"stopReason":"end_turn"}}}\n\n'
      : '{"RequestId":"loopback","JsonRpcResponse":{"Result":{"Agents":[],"AgentSessions":[]}}}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    cfg.endpoint = `127.0.0.1:${(server.address() as { port: number }).port}`;
    // Construction/signing must use cfg, even when ambient credentials differ.
    vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_ID', 'ambient-key-must-not-be-used');
    vi.stubEnv('ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ambient-secret-must-not-be-used');
    vi.stubEnv('ALIBABA_CLOUD_SECURITY_TOKEN', 'ambient-token-must-not-be-used');
    const client = createSdkClient(cfg);
    client._protocol = 'http';
    await client.listAgentsWithOptions(new ListAgentsRequest({ id: 'test', jsonrpc: '2.0' }), runtimeFor(2000));
    let frames = 0;
    for await (const _ of client.promptAgentSessionWithSSE(new PromptAgentSessionRequest({ id: 'test', jsonrpc: '2.0',
      params: new PromptAgentSessionRequestParams({ sessionId: 'synthetic-session' }) }), runtimeForSse(2000))) frames++;
    expect(frames).toBe(1);
    frames = 0;
    for await (const _ of client.loadAgentSessionWithSSE(new LoadAgentSessionRequest({ id: 'test', jsonrpc: '2.0',
      params: new LoadAgentSessionRequestParams({ sessionId: 'synthetic-session' }) }), runtimeForSse(2000))) frames++;
    expect(frames).toBe(1);
    await callOpenApi(client, 'ListAgentSessions', { AgentName: 'synthetic-agent' });
    const events = await openSessionEvents(client, 'synthetic-session');
    for await (const _ of events.body) { /* Consume and close the raw POP stream. */ }
    expect(requests.map(request => request.headers['x-acs-action'])).toEqual([
      'ListAgents', 'PromptAgentSession', 'LoadAgentSession', 'ListAgentSessions', 'GetAgentSessionEvents',
    ]);
    for (const request of requests) verifySignature(request, token);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it.each(['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET'])('a token cannot replace missing %s', key => {
  vi.stubEnv('ALIBABA_CLOUD_SECURITY_TOKEN', TOKEN);
  const cfg = loadConfig();
  expect(() => createSdkClient({ ...cfg, [key.endsWith('_ID') ? 'accessKeyId' : 'accessKeySecret']: undefined })).toThrow(SdkError);
  vi.stubEnv(key, '');
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('expected startup exit'); });
  try {
    expect(() => loadConfig()).toThrow('expected startup exit');
    expect(exit).toHaveBeenCalledWith(1);
    for (const secret of [AK, SK, TOKEN]) expect(stderr.mock.calls.flat().join('')).not.toContain(secret);
  } finally {
    stderr.mockRestore();
    exit.mockRestore();
  }
});
