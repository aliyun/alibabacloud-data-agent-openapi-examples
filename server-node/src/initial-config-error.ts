const INVALID_INITIAL_CONFIG = 'INVALID_SESSION_INITIAL_CONFIG';
const REASONS = new Set([
  'capabilities_unavailable', 'ambiguous_model', 'model_not_available', 'reasoning_not_available',
]);

/** Only the documented reason enum may cross the error-data boundary. */
export function initialConfigErrorMessage(error: { message?: unknown; errorCode?: unknown; data?: unknown }, fallback: string): string {
  const message = typeof error.message === 'string' ? error.message : fallback;
  if (error.errorCode !== INVALID_INITIAL_CONFIG && error.message !== INVALID_INITIAL_CONFIG) return message;
  const data = error.data;
  const reason = data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>).reason : undefined;
  return typeof reason === 'string' && REASONS.has(reason) ? `${message} (reason=${reason})` : message;
}
