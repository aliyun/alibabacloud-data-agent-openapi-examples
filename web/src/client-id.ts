/** HTTP on a LAN IP has getRandomValues but no secure-context randomUUID.
 * This is a browser client identity for echo suppression, never an OpenAPI sessionId.
 */
function createClientId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function resolveClientId(): string {
  const key = 'das.clientId.v1';
  try {
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
  } catch { /* Storage can be unavailable in private browsing. */ }
  const id = createClientId();
  try { window.localStorage.setItem(key, id); } catch { /* Keep this tab's identity. */ }
  return id;
}
