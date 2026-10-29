import { expect, it } from 'vitest';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { formatApiError, formatSessionError } from '../src/api-error';

it.each([
  [{ error: { message: 'denied', requestId: 'POP-1' } }, 'denied (requestId=POP-1)'],
  [{ error: 'denied', requestId: 'POP-1' }, 'denied (requestId=POP-1)'],
  [{ error: { message: 'denied (requestId=POP-1)', requestId: 'POP-1' } }, 'denied (requestId=POP-1)'],
  [{ error: { message: 'denied POP-1', requestId: 'POP-1' } }, 'denied POP-1'],
  [{ error: { requestId: 'POP-1' } }, 'fallback (requestId=POP-1)'],
  [{ error: { message: 'denied', requestId: 'POP-1' }, requestId: 'other' }, 'denied (requestId=POP-1)'],
  [{ error: 'denied', requestId: 123 }, 'denied'],
  [{ error: 'denied', requestId: '  ' }, 'denied'],
  [{ error: 'denied', requestId: 'id\r\nheader' }, 'denied'],
  [{ error: 'denied', requestId: 'x'.repeat(257) }, 'denied'],
  [{ error: { message: 'denied', permissionRequestId: 'permission', rid: 'rpc', id: 'event' }, rid: 'rpc', id: 1, permissionRequestId: 'permission' }, 'denied'],
  [{ error: { message: { secret: 'hidden' } }, body: 'hidden', token: 'hidden' }, 'fallback'],
  ['<html>hidden</html>', 'fallback'],
  [{ error: 'denied POP-10', requestId: 'POP-1' }, 'denied POP-10 (requestId=POP-1)'],
  [{ error: 'denied [POP.(1)]', requestId: 'POP.(1)' }, 'denied [POP.(1)]'],
  [{ error: 'denied XPOP-1', requestId: 'POP-1' }, 'denied XPOP-1 (requestId=POP-1)'],
  [{ error: 'denied POPx(1)', requestId: 'POP.(1)' }, 'denied POPx(1) (requestId=POP.(1))'],
  [null, 'fallback'],
  [[], 'fallback'],
])('formats only explicit error fields: %j', (body, expected) => {
  expect(formatApiError(body, 'fallback')).toBe(expected);
});

it('preserves SDK error identity/status/body and formats idempotently', () => {
  const body = { error: 'denied', requestId: 'POP-load' };
  const error = new DaemonHttpError(403, body, 'SDK request failed');
  expect(formatSessionError(error)).toBe(error);
  expect(formatSessionError(error)).toBe(error);
  expect(error.message).toBe('denied (requestId=POP-load)');
  expect(error.status).toBe(403);
  expect(error.body).toBe(body);
});

it('preserves message-only SDK failures without inventing a requestId', () => {
  const error = new DaemonHttpError(502, undefined, 'SDK upstream failed requestId=already-provided');
  expect(formatSessionError(error)).toBe(error);
  expect(error.message).toBe('SDK upstream failed requestId=already-provided');
});
