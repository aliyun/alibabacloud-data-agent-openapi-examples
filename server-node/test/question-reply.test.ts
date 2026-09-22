import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { AcpFrame } from '@das/shared';
import type { AppConfig } from '../src/config.js';
import * as live from '../src/live.js';
import { permissionRequestEvent, OPENAPI_ANSWERS_OPTION } from '../src/daemon/events.js';
import { registerDaemonRoutes } from '../src/daemon/routes.js';

const frames: AcpFrame[] = readFileSync(new URL('./fixtures/prompt-permission.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line).data);

afterEach(() => vi.restoreAllMocks());

describe('OpenAPI answers-only question compatibility', () => {
  it('never invents approval for ordinary tool permissions; preserves upstream question options', () => {
    expect(permissionRequestEvent('s', { requestId: 'r', toolCall: { _meta: { toolName: 'shell' } }, options: [] }).data.options).toEqual([]);
    const event = permissionRequestEvent('s', { requestId: 'r', toolCall: { _meta: { toolName: 'ask_user_question' } },
      options: [{ optionId: 'real-allow', kind: 'allow_once' }] });
    expect(event.data.options).toEqual([{ optionId: 'real-allow', label: 'real-allow', kind: 'allow_once' }]);
    expect(event.data.openApiAnswersOnly).toBeUndefined();
  });

  it('restores a question after load and sends answers without the UI-only option to OpenAPI', async () => {
    vi.spyOn(live, 'liveLoadFrames').mockResolvedValue(frames);
    const reply = vi.spyOn(live, 'liveReply').mockResolvedValue({ ok: true, result: { accepted: true } } as Awaited<ReturnType<typeof live.liveReply>>);
    const app = Fastify();
    const cfg = { mock: false, corsOrigin: [], regionId: 'test', agentName: 'test' } as unknown as AppConfig;
    await registerDaemonRoutes(app, cfg, {} as live.LiveContext['client']);
    const id = '00000000-0000-4000-8000-000000000001';
    try {
      const loaded = await app.inject({ method: 'POST', url: `/d/standalone/sessions/${id}/load`, payload: {} });
      expect(loaded.statusCode).toBe(200);
      const question = loaded.json().compactedReplay.find((e: { type: string }) => e.type === 'permission_request');
      expect(question.data.options).toContainEqual({ optionId: OPENAPI_ANSWERS_OPTION, label: '提交回答', kind: 'allow_once' });
      const url = `/d/session/${id}/permission/req-keep-1`;
      const outcome = { outcome: 'selected', optionId: OPENAPI_ANSWERS_OPTION };
      expect((await app.inject({ method: 'POST', url, payload: { outcome } })).statusCode).toBe(400);
      expect(reply).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'POST', url, payload: { outcome, answers: { '0': '先列大纲' } } })).statusCode).toBe(200);
      expect(reply).toHaveBeenCalledWith(expect.anything(), id, {
        permissionRequestId: 'req-keep-1', outcome: 'selected', answers: { '0': '先列大纲' }, optionId: undefined,
      });
      expect((await app.inject({ method: 'POST', url, payload: { outcome, answers: { '0': '先列大纲' } } })).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it('keeps the question replyable after the upstream prompt stream aborts', async () => {
    vi.spyOn(live, 'livePromptFrames').mockImplementation(async function* () {
      yield frames[0]!;
      yield frames[1]!;
      throw new Error('aborted');
    });
    const reply = vi.spyOn(live, 'liveReply').mockResolvedValue({ ok: true, result: { accepted: true } } as Awaited<ReturnType<typeof live.liveReply>>);
    const app = Fastify();
    const cfg = { mock: false, corsOrigin: [], regionId: 'test', agentName: 'test' } as unknown as AppConfig;
    await registerDaemonRoutes(app, cfg, {} as live.LiveContext['client']);
    const id = '00000000-0000-4000-8000-000000000002';
    try {
      expect((await app.inject({ method: 'POST', url: `/d/session/${id}/prompt`,
        payload: { prompt: [{ type: 'text', text: 'Ask a question' }] } })).statusCode).toBe(202);
      await vi.waitFor(async () => {
        const transcript = (await app.inject({ method: 'GET', url: `/d/session/${id}/transcript` })).json();
        expect(transcript.events.some((e: { type: string }) => e.type === 'turn_error')).toBe(true);
      });
      expect((await app.inject({ method: 'POST', url: `/d/session/${id}/permission/req-keep-1`, payload: {
        outcome: { outcome: 'selected', optionId: OPENAPI_ANSWERS_OPTION }, answers: { '0': '先列大纲' },
      } })).statusCode).toBe(200);
      expect(reply).toHaveBeenCalledWith(expect.anything(), id, expect.objectContaining({ optionId: undefined, answers: { '0': '先列大纲' } }));
    } finally { await app.close(); }
  });
});
