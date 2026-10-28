import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { registerDaemonRoutes } from '../src/daemon/routes.js';
import { buildCreateSessionRequest } from '../src/live.js';
import { registerRestRoutes } from '../src/routes/rest.js';
import { sessionOptions } from '../src/session-options.js';
import type { SdkClient } from '../src/sdk.js';

const cfg: AppConfig = Object.freeze({ mock: false, mockRealtime: false, mockSpeed: 1, port: 0, corsOrigin: [],
  regionId: 'cn-beijing', endpoint: undefined, agentName: 'configured-agent', sessionSource: 'test-source',
  resourceGroupId: undefined, accessKeyId: undefined, accessKeySecret: undefined, serverHost: '127.0.0.1', webDist: undefined });
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function setup(archivedOnly = false) {
  const callApi = vi.fn(async (action: { action: string }, request: { body: { Params: string } }) => {
    const params = JSON.parse(request.body.Params);
    const row = { SessionId: 'sid', SessionTitle: 'remote title', SessionCreatedAt: 1, SessionUpdatedAt: 2 };
    return { body: { JsonRpcResponse: { Result: action.action === 'CreateAgentSession' ? { SessionId: 'sid' }
      : { AgentSessions: archivedOnly && !params.Archived ? [] : [row], TotalCount: 1 } } } };
  });
  const app = Fastify(); apps.push(app);
  const client = { callApi } as unknown as SdkClient;
  await registerDaemonRoutes(app, cfg, client);
  await registerRestRoutes(app, cfg, client);
  return { app, callApi, params: () => callApi.mock.calls.map(([, request]) => JSON.parse(request.body.Params)) };
}

describe('request-scoped Agent selection', () => {
  it('uses a trimmed creation override only in Meta.Agent.AgentName and otherwise keeps cfg default', () => {
    const options = sessionOptions(cfg, { agentName: '  selected-agent  ' });
    expect(options.agentName).toBe('selected-agent');
    expect(buildCreateSessionRequest(cfg, options).toMap().Params.Meta.Agent.AgentName).toBe('selected-agent');
    expect(buildCreateSessionRequest(cfg).toMap().Params.Meta.Agent.AgentName).toBe(cfg.agentName);
    expect(buildCreateSessionRequest(cfg, { agentName: 'a'.repeat(128) }).toMap().Params.Meta.Agent.AgentName).toBe('a'.repeat(128));
    expect(cfg.agentName).toBe('configured-agent');
  });

  it.each(['', '   ', 'a'.repeat(129), 'bad\nagent', 'bad\ragent', 'bad\tagent', 'bad\u0000agent', 'bad\u007fagent', 'bad\u0085agent', null, 42, [], {}])(
    'rejects an invalid creation Agent before dispatch: %j', async agentName => {
      expect(() => sessionOptions(cfg, { agentName })).toThrow('agentName');
      const { app, callApi } = await setup();
      for (const url of ['/d/standalone/sessions', '/api/sessions']) {
        const response = await app.inject({ method: 'POST', url, payload: { agentName } });
        if (url === '/api/sessions') {
          expect(response.statusCode).toBe(200); // Existing ApiResult business-error envelope.
          expect(response.json()).toMatchObject({ ok: false, error: { message: expect.stringContaining('agentName') } });
        } else expect(response.statusCode).toBe(400);
      }
      expect(callApi).not.toHaveBeenCalled();
    });

  it.each(['/d/standalone/sessions', '/api/sessions'])('forwards creation selection without changing the next default (%s)', async url => {
    const { app, params } = await setup();
    expect((await app.inject({ method: 'POST', url, payload: { agentName: '  selected-agent  ' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(200);
    expect(params().map(value => value.Meta.Agent.AgentName)).toEqual(['selected-agent', 'configured-agent']);
  });

  it('forwards list Agent and archive selection per request and preserves cfg and capability defaults', async () => {
    const { app, params } = await setup();
    for (const query of ['?agentName=%20selected-agent%20', '?agentName=other-agent&archiveState=archived', '']) {
      expect((await app.inject(`/d/standalone/sessions${query}`)).statusCode).toBe(200);
    }
    expect(params().map(value => [value.AgentName, value.Archived])).toEqual([
      ['selected-agent', false], ['other-agent', true], ['configured-agent', false],
    ]);
    expect((await app.inject('/d/openapi/session-options')).json().agentName).toBe('configured-agent');
    expect(cfg.agentName).toBe('configured-agent');
  });

  it('uses the SID snapshot Agent throughout active and archived lookup without caching it', async () => {
    const { app, params } = await setup(true);
    expect((await app.inject('/d/standalone/sessions/sid?agentName=%20snapshot-agent%20')).statusCode).toBe(200);
    expect((await app.inject('/d/standalone/sessions/sid')).statusCode).toBe(200);
    expect(params().map(value => [value.AgentName, value.Archived])).toEqual([
      ['snapshot-agent', false], ['snapshot-agent', true], ['configured-agent', false], ['configured-agent', true],
    ]);
  });

  it.each(['agentName=', 'agentName=%20%20', `agentName=${'a'.repeat(129)}`, 'agentName=bad%0Aagent', 'agentName=bad%00agent', 'agentName=one&agentName=two'])(
    'rejects invalid Agent query without a remote call: %s', async query => {
      const { app, callApi } = await setup();
      for (const path of ['/d/standalone/sessions', '/d/standalone/sessions/sid']) {
        expect((await app.inject(`${path}?${query}`)).statusCode).toBe(400);
      }
      expect(callApi).not.toHaveBeenCalled();
    });
});
