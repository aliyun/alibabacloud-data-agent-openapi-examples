import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { validRequestId } from '@das/shared';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Only public error fields are displayable; never stringify an HTTP body or infer an ID. */
export function formatApiError(body: unknown, fallback: string): string {
  const envelope = record(body);
  const error = record(envelope?.error);
  const message = nonempty(error?.message) ?? nonempty(envelope?.error) ?? fallback;
  const requestId = validRequestId(error?.requestId) ?? validRequestId(envelope?.requestId);
  if (!requestId) return message;
  const escapedId = requestId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^|[^\\w-])${escapedId}(?=$|[^\\w-])`).test(message)) return message;
  return `${message} (requestId=${requestId})`;
}

export function apiHttpError(status: number, body: unknown, fallback: string): DaemonHttpError {
  const detail = formatApiError(body, fallback);
  return new DaemonHttpError(status, body, detail.startsWith(fallback) ? detail : `${fallback}：${detail}`);
}

/** SDK wrappers sometimes expose only message. Keep it intact when no body is available. */
export function formatSessionError(error: unknown): unknown {
  if (error instanceof DaemonHttpError) error.message = formatApiError(error.body, error.message);
  return error;
}
