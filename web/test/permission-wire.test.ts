import { describe, expect, it } from 'vitest';
import { normalizeDaemonEvent } from '@qwen-code/sdk/daemon';
import { permissionRequestEvent } from '../../server-node/src/daemon/events.js';

describe('question options through the actual daemon SDK', () => {
  it.each([
    ['OpenAPI question without permission options', []],
    ['OpenAPI question with Submit/Cancel options', [
      { optionId: 'proceed_once', name: 'Submit', kind: 'allow_once' },
      { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
    ]],
  ] as const)('%s remains submit-ready after SDK normalization', (_, options) => {
    const envelope = permissionRequestEvent('test-session', {
      requestId: 'test-question',
      toolCall: { _meta: { toolName: 'ask_user_question', qwenInteractionKind: 'user_question' } },
      options: [...options],
    });
    const normalized = normalizeDaemonEvent(envelope as Parameters<typeof normalizeDaemonEvent>[0]);
    const request = normalized.find(event => event.type === 'permission.request');
    expect(request?.type).toBe('permission.request');
    if (!request || request.type !== 'permission.request') throw new Error('missing question');
    // web-shell reads option.raw.kind AFTER the SDK wraps each wire option in raw.
    const submit = request.options.find(option =>
      (option.raw as { kind?: string }).kind === 'allow_once');
    expect(submit).toBeDefined();
    expect((submit!.raw as { raw?: unknown }).raw).toBeUndefined();
  });
});
