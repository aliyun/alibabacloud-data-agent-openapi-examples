import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import * as live from '../src/live.js';
import type { AppConfig } from '../src/config.js';
import { registerPromptRoutes } from '../src/routes/prompt.js';
import { exceptionFacts } from '../src/daemon/runner.js';

afterEach(() => vi.restoreAllMocks());
for (const completed of [true, false]) {
  it(`keeps ${completed ? 'protocol completion' : 'a pre-terminal reset as failure'}`, async () => {
    let advanced = false;
    vi.spyOn(live, 'livePromptFrames').mockImplementation(async function* () {
      if (completed) yield { Result: { stopReason: 'end_turn' } };
      advanced = true;
      throw Object.assign(new Error('secret prompt must not enter diagnostic metadata'), { code: 'ECONNRESET' });
    });
    const app = Fastify();
    const logs = vi.spyOn(app.log, 'info');
    await registerPromptRoutes(app, { mock: false, corsOrigin: [], regionId: 'test', agentName: 'test' } as unknown as AppConfig, {} as live.LiveContext['client']);
    const id = `00000000-0000-4000-8000-00000000000${completed ? 7 : 8}`;
    try {
      const response = await app.inject({ method: 'POST', url: `/api/sessions/${id}/prompt`, payload: { text: 'synthetic' } });
      expect(response.statusCode).toBe(200);
      const events = response.body.trim().split('\n').map(line => JSON.parse(line));
      expect(events.filter(event => ['done', 'error'].includes(event.type)).map(event => event.type))
        .toEqual([completed ? 'done' : 'error']);
      expect(advanced).toBe(!completed);
      const end = logs.mock.calls.find(call => call[1] === 'prompt 流结束')?.[0];
      expect(end).toMatchObject({ sessionId: id, stopReason: completed ? 'end_turn' : undefined,
        errorKind: completed ? undefined : 'transport' });
      expect(JSON.stringify(end)).not.toContain('secret prompt');
    } finally { await app.close(); }
  });
}
it('keeps bounded error codes and causes without messages or SDK request objects', () => {
  const err = Object.assign(new Error('token=private', { cause: Object.assign(new Error('private answer'), { code: 'ECONNRESET' }) }), { request: { secret: 'private' }, code: 'secret-token' });
  expect(exceptionFacts(Object.assign(new Error('private'), { name: 'RequestTimeoutError' }))).toEqual([{ name: 'RequestTimeoutError' }]);
  expect(exceptionFacts(err)).toEqual([{ name: 'Error' }, { name: 'Error', code: 'ECONNRESET' }]);
});
