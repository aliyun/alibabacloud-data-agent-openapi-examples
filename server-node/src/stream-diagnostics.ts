import { validRequestId, withRequestId, type ApiError } from '@das/shared';
import type { SdkClient } from './sdk.js';
import { headerRequestId } from './normalize.js';

export interface StreamTrace {
  requestId(): string | undefined;
  withError(error: ApiError): ApiError;
}
/** Pointer belongs to one browser request; replacing it starts a new upstream call. */
export interface StreamTraceScope { current?: StreamTrace }

/**
 * Keep generated request/response handling, but observe the raw SDK response before
 * its generated method JSON-decodes SSE. The receiver is local to one RPC: the
 * shared client is never mutated and delayed callbacks cannot overwrite another call.
 */
export function trackedSse(client: SdkClient, open: (receiver: SdkClient) => unknown) {
  let headerId: string | undefined;
  let acknowledgementId: string | undefined;
  const receiver = Object.create(client) as SdkClient;
  const capture = (response: unknown) => {
    if (response && typeof response === 'object')
      headerId ??= headerRequestId((response as { headers?: unknown }).headers);
  };
  if (typeof client.callSSEApi === 'function') {
    receiver.callSSEApi = (...args: Parameters<SdkClient['callSSEApi']>) => (async function* () {
      for await (const response of client.callSSEApi(...args)) {
        capture(response);
        yield response;
      }
    })();
  }
  return {
    stream: open(receiver),
    requestId: () => headerId ?? acknowledgementId,
    withError: (error: ApiError) => withRequestId(error, headerId ?? acknowledgementId, !!headerId),
    observe: capture,
    acknowledgement(value: unknown) { acknowledgementId ??= validRequestId(value); },
  };
}
