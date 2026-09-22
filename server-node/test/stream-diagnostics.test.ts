import { afterEach, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import * as live from '../src/live.js';
import type { AppConfig } from '../src/config.js';
import { registerDaemonRoutes } from '../src/daemon/routes.js';
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
    await registerDaemonRoutes(app, { mock: false, corsOrigin: [], regionId: 'test', agentName: 'test' } as unknown as AppConfig, {} as live.LiveContext['client']);
    const id = `00000000-0000-4000-8000-00000000000${completed ? 7 : 8}`;
    try {
      expect((await app.inject({ method: 'POST', url: `/d/session/${id}/prompt`, payload: { prompt: [{ type: 'text', text: 'synthetic' }] } })).statusCode).toBe(202);
      await vi.waitFor(async () => {
        const { events } = (await app.inject({ method: 'GET', url: `/d/session/${id}/transcript` })).json();
        expect(events.filter((e: { type: string }) => ['turn_complete', 'turn_error'].includes(e.type)).map((e: { type: string }) => e.type)).toEqual([completed ? 'turn_complete' : 'turn_error']);
      });
      expect(advanced).toBe(!completed);
      const end = logs.mock.calls.map(c => c[0]).find((v: any) => v?.event === 'prompt_stream_end');
      expect(end).toMatchObject({ outcome: completed ? 'terminal' : 'transport_exception', sessionId: id, backend: 'node' });
      expect(JSON.stringify(end)).not.toContain('secret prompt');
    } finally { await app.close(); }
  });
}
it('keeps bounded error codes and causes without messages or SDK request objects', () => {
  const err = Object.assign(new Error('token=private', { cause: Object.assign(new Error('private answer'), { code: 'ECONNRESET' }) }), { request: { secret: 'private' }, code: 'secret-token' });
  expect(exceptionFacts(Object.assign(new Error('private'), { name: 'RequestTimeoutError' }))).toEqual([{ name: 'RequestTimeoutError' }]);
  expect(exceptionFacts(err)).toEqual([{ name: 'Error' }, { name: 'Error', code: 'ECONNRESET' }]);
});
