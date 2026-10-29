import { describe, expect, it, vi } from 'vitest';
import * as dara from '@darabonba/typescript';
import { CreateAgentSessionResponse } from '@alicloud/dataworks-public20240518';
import { readNonStreamBody, toApiError } from '../src/normalize.js';
import { callOpenApi } from '../src/openapi.js';
import type { SdkClient } from '../src/sdk.js';

const target = 'INVALID_SESSION_INITIAL_CONFIG';
const reasons = ['capabilities_unavailable', 'ambiguous_model', 'model_not_available', 'reasoning_not_available'];
const cases = [
  ...reasons.flatMap(reason => [
    { errorCode: target, message: 'invalid configuration', data: { reason, secret: 'PRIVATE_DATA' }, expected: reason },
    { message: target, data: { reason, secret: 'PRIVATE_DATA' }, expected: reason },
  ]),
  ...[undefined, null, 'PRIVATE_DATA', [], { reason: 'PRIVATE_DATA' }, { reason: ['ambiguous_model'] },
    { reason: { secret: 'PRIVATE_DATA' } }, { reason: 1 }, { reason: ' ambiguous_model' },
    { reason: 'AMBIGUOUS_MODEL' }, { nested: { reason: 'ambiguous_model' } }]
    .map(data => ({ errorCode: target, message: target, data, expected: undefined })),
  ...['unrelated', `prefix ${target}`, `${target} suffix`, target.toLowerCase()]
    .map(message => ({ errorCode: message, message, data: { reason: 'ambiguous_model' }, expected: undefined })),
  { code: -32602, message: 'unrelated', data: { reason: 'ambiguous_model' }, expected: undefined },
];

// Exercise the installed generated SDK's real cast, and generic POP wire parsing.
for (const path of ['generatedSDK', 'genericPOP'] as const) {
  describe(`${path} initial config reason boundary`, () => {
    it.each(cases)('safely renders case %#', async ({ expected, ...error }) => {
      const wireError = Object.fromEntries(Object.entries(error).map(([key, value]) => [key[0]!.toUpperCase() + key.slice(1), value]));
      const wire = { RequestId: 'body-rid', JsonRpcResponse: { Error: wireError } };
      let caught: unknown;
      try {
        if (path === 'generatedSDK') {
          const response = dara.cast({ body: wire, headers: { 'x-acs-request-id': 'header-rid' }, statusCode: 200 }, new CreateAgentSessionResponse());
          readNonStreamBody(response);
        } else {
          await callOpenApi({ callApi: vi.fn().mockResolvedValue({ body: wire, statusCode: 200,
            headers: { 'x-acs-request-id': 'header-rid' } }) } as unknown as SdkClient, 'CreateAgentSession', {});
        }
      } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      const api = toApiError(caught, 'CreateAgentSession');
      expect(api.requestId).toBe('body-rid');
      expect(api.message.includes('reason=')).toBe(expected !== undefined);
      if (expected) expect(api.message).toContain(`reason=${expected}`);
      expect(JSON.stringify(api)).not.toContain('PRIVATE_DATA');
      expect(api).not.toHaveProperty('data');
    });

    it('retains the header requestId when body has no requestId', async () => {
      const wire = { JsonRpcResponse: { Error: { Message: target, Data: { reason: 'ambiguous_model' } } } };
      let caught: unknown;
      try {
        if (path === 'generatedSDK') readNonStreamBody(dara.cast({ body: wire, headers: { 'x-acs-request-id': 'header-rid' } }, new CreateAgentSessionResponse()));
        else await callOpenApi({ callApi: vi.fn().mockResolvedValue({ body: wire, headers: { 'x-acs-request-id': 'header-rid' } }) } as unknown as SdkClient, 'CreateAgentSession', {});
      } catch (error) { caught = error; }
      expect(toApiError(caught, 'CreateAgentSession').requestId).toBe('header-rid');
    });
  });
}

it('does not treat generic POP Code as ErrorCode', async () => {
  const client = { callApi: vi.fn().mockResolvedValue({ body: { RequestId: 'rid', JsonRpcResponse: {
    Error: { Code: target, Message: 'unrelated', Data: { reason: 'ambiguous_model' } },
  } }, statusCode: 200 }) } as unknown as SdkClient;
  await expect(callOpenApi(client, 'CreateAgentSession', {})).rejects.toMatchObject({ message: 'unrelated', requestId: 'rid' });
});
