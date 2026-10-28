import type { OpenApiCreateOptions } from './session-client';

/** The selection sent on successful creation, not verified remote runtime state.
 * Missing fields mean Agent defaults; an unknown historical sid has no snapshot.
 * Call save only after creation succeeds, with the options actually submitted.
 */
export type SessionConfiguration = OpenApiCreateOptions;
type Persistence = 'browser' | 'memory';
type Bucket = { entries: Map<string, SessionConfiguration>; persistence: Persistence };

const MAX_ENTRIES = 100;
const MAX_SERIALIZED_CHARS = 1_000_000;
// A tuple keeps scopes such as ['a:b', 'c'] and ['a', 'b:c'] distinct.
// baseUrl must identify the backend/environment (including region when applicable).
const key = (baseUrl: string, agentName: string) =>
  `workbench.session-configuration.v1:${JSON.stringify([baseUrl, agentName])}`;
const memory = new Map<string, Bucket>();
const validId = (sid: unknown): sid is string => typeof sid === 'string' &&
  sid.trim().length > 0 && sid.length <= 512 && !/[\u0000-\u001f\u007f]/.test(sid);

/** A successful request snapshot is not a preference picker. Preserve model-specific
 * values instead of turning an accepted value outside the UI list into a default. */
function sanitizeConfiguration(raw: unknown): SessionConfiguration {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const selected: SessionConfiguration = {};
  for (const field of ['agentName', 'modelServiceId', 'approvalMode', 'reasoningEffort'] as const) {
    const value = input[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    const limit = field === 'modelServiceId' ? 512 : 128;
    if (!trimmed || trimmed.length > limit || /[\u0000-\u001f\u007f]/.test(trimmed)) continue;
    if (field === 'modelServiceId' && trimmed === 'data-agent') continue;
    selected[field] = trimmed;
  }
  return selected;
}

function parse(serialized: string | null): Map<string, SessionConfiguration> {
  const entries = new Map<string, SessionConfiguration>();
  if (!serialized || serialized.length > MAX_SERIALIZED_CHARS) return entries;
  try {
    const raw: unknown = JSON.parse(serialized);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return entries;
    const bucket = raw as { version?: unknown; entries?: unknown };
    if (bucket.version !== 1 || !Array.isArray(bucket.entries)) return entries;
    // Bound work on malformed/oversized stored collections as well as our writes.
    for (const entry of bucket.entries.slice(-MAX_ENTRIES)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const { sid, options } = entry as { sid?: unknown; options?: unknown };
      if (!validId(sid) || !options || typeof options !== 'object' || Array.isArray(options)) continue;
      entries.delete(sid);
      entries.set(sid, sanitizeConfiguration(options));
    }
  } catch { /* Corrupt storage is an empty bucket, not a storage outage. */ }
  return entries;
}

function readBucket(storageKey: string): Bucket {
  let state = memory.get(storageKey);
  // A failed write/clear stays authoritative even if stale storage is readable.
  if (state?.persistence !== 'memory') {
    try {
      state = { entries: parse(localStorage.getItem(storageKey)), persistence: 'browser' };
    } catch {
      state = { entries: state?.entries ?? new Map(), persistence: 'memory' };
    }
    memory.set(storageKey, state);
  }
  return state;
}

export function saveSessionConfiguration(baseUrl: string, agentName: string, sid: string,
  options: OpenApiCreateOptions = {}): Persistence | undefined {
  if (!validId(sid)) return undefined;
  const storageKey = key(baseUrl, agentName);
  const entries = new Map(readBucket(storageKey).entries);
  // Most recently saved wins, without evicting an entry merely because it was read.
  entries.delete(sid);
  entries.set(sid, sanitizeConfiguration(options));
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  const state: Bucket = { entries, persistence: 'memory' };
  memory.set(storageKey, state);
  try {
    localStorage.setItem(storageKey, JSON.stringify({ version: 1,
      entries: [...entries].map(([sessionId, configuration]) => ({ sid: sessionId, options: configuration })) }));
    state.persistence = 'browser';
  } catch { /* Continue with this page's snapshot; do not restore stale browser data. */ }
  return state.persistence;
}

export function readSessionConfiguration(baseUrl: string, agentName: string, sid: string): SessionConfiguration | undefined {
  if (!validId(sid)) return undefined;
  const snapshot = readBucket(key(baseUrl, agentName)).entries.get(sid);
  return snapshot === undefined ? undefined : { ...snapshot };
}

/** Clear one backend/Agent scope. A failed clear masks persistent data in this page. */
export function clearSessionConfigurations(baseUrl: string, agentName: string): Persistence {
  const storageKey = key(baseUrl, agentName);
  const state: Bucket = { entries: new Map(), persistence: 'memory' };
  memory.set(storageKey, state);
  try {
    localStorage.removeItem(storageKey);
    state.persistence = 'browser';
  } catch { /* Keep the empty in-memory override even if storage still has old snapshots. */ }
  return state.persistence;
}

/** Frontend-only lookup metadata; requests and execution still use the remote SID. */
export function saveSessionAgent(baseUrl: string, sid: string, agentName: string): void {
  saveSessionConfiguration(baseUrl, '', sid, { agentName });
}
export function readSessionAgent(baseUrl: string, sid: string): string | undefined {
  return readSessionConfiguration(baseUrl, '', sid)?.agentName;
}
