import type { OpenApiCreateOptions, SessionDefaults } from './session-client';

const modes = new Set(['default', 'yolo', 'plan', 'auto-edit', 'auto']);
const reasoning = new Set(['none', 'default', 'low', 'medium', 'high', 'xhigh', 'max']);
const key = (baseUrl: string, agentName: string) => `workbench.session-options.v1:${baseUrl}:${agentName}`;

export interface PreferenceState {
  options: OpenApiCreateOptions;
  persistence: 'browser' | 'memory';
}
// Failed writes (including clears) remain authoritative in this page. A later
// read of stale browser data must not undo a user's in-memory selection.
const memory = new Map<string, PreferenceState>();

export function sanitizePreferences(raw: unknown): OpenApiCreateOptions {
  if (!raw || typeof raw !== 'object') return {};
  const input = raw as Record<string, unknown>;
  const model = typeof input.modelServiceId === 'string' ? input.modelServiceId.trim() : '';
  return {
    ...(model && model.length <= 512 && model !== 'data-agent' ? { modelServiceId: model } : {}),
    ...(typeof input.approvalMode === 'string' && modes.has(input.approvalMode) ? { approvalMode: input.approvalMode } : {}),
    ...(typeof input.reasoningEffort === 'string' && reasoning.has(input.reasoningEffort) ? { reasoningEffort: input.reasoningEffort } : {}),
  };
}

export function readPreferenceState(baseUrl: string, agentName: string): PreferenceState {
  const storageKey = key(baseUrl, agentName);
  let state = memory.get(storageKey);
  if (state?.persistence !== 'memory') {
    try {
      const serialized = localStorage.getItem(storageKey);
      let raw: unknown;
      try { raw = serialized ? JSON.parse(serialized) : {}; } catch { raw = {}; }
      state = { options: sanitizePreferences(raw), persistence: 'browser' };
    } catch {
      state = { options: state?.options ?? {}, persistence: 'memory' };
    }
    memory.set(storageKey, state);
  }
  return { options: { ...state.options }, persistence: state.persistence };
}

export function readPreferences(baseUrl: string, agentName: string): OpenApiCreateOptions {
  return readPreferenceState(baseUrl, agentName).options;
}

export function savePreferences(baseUrl: string, agentName: string, options: OpenApiCreateOptions) {
  const storageKey = key(baseUrl, agentName);
  const state: PreferenceState = { options: sanitizePreferences(options), persistence: 'memory' };
  memory.set(storageKey, state);
  try {
    localStorage.setItem(storageKey, JSON.stringify(state.options));
    state.persistence = 'browser';
  } catch { /* The current page continues using memory. */ }
  return state.persistence;
}

export function clearPreferences(baseUrl: string, agentName: string) {
  const storageKey = key(baseUrl, agentName);
  const state: PreferenceState = { options: {}, persistence: 'memory' };
  memory.set(storageKey, state);
  try { localStorage.removeItem(storageKey); state.persistence = 'browser'; }
  catch { /* Keep the empty memory override, even if browser data still exists. */ }
  return state.persistence;
}

export function effectiveDefaults(defaults: SessionDefaults, preferences: OpenApiCreateOptions): SessionDefaults {
  const saved = sanitizePreferences(preferences);
  return { ...defaults, ...(saved.modelServiceId ? { model: saved.modelServiceId } : {}),
    ...(saved.approvalMode ? { approvalMode: saved.approvalMode } : {}),
    ...(saved.reasoningEffort ? { reasoningEffort: saved.reasoningEffort } : {}) };
}

/** Explicit SDK arguments > user overrides > freshly fetched environment. */
export function resolveCreationOptions(defaults: SessionDefaults, preferences: OpenApiCreateOptions,
  initial: OpenApiCreateOptions): OpenApiCreateOptions {
  const saved = effectiveDefaults(defaults, preferences);
  const selectedModel = initial.modelServiceId?.trim();
  const model = selectedModel && selectedModel !== 'data-agent' ? selectedModel : saved.model;
  const effort = initial.reasoningEffort ?? saved.reasoningEffort;
  return {
    ...(model ? { modelServiceId: model } : {}),
    approvalMode: initial.approvalMode ?? saved.approvalMode,
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
  };
}

/** Selected Agent is frontend-owned; per-Agent model/mode defaults remain isolated. */
const selectedAgents = new Map<string, string>();
const selectionKey = (baseUrl: string) => `workbench.selected-agent.v2:${baseUrl}`;
export function validAgentName(value: string): boolean {
  return value.trim().length > 0 && value.trim().length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}
export function readSelectedAgent(baseUrl: string): string {
  try {
    // v1 briefly used the incorrect built-in default data_agent. Preserve
    // explicit custom choices, but do not revive that old default.
    const legacy = localStorage.getItem(`workbench.selected-agent.v1:${baseUrl}`);
    const saved = localStorage.getItem(selectionKey(baseUrl)) ?? (legacy !== 'data_agent' ? legacy : null);
    if (!selectedAgents.has(baseUrl) && saved && validAgentName(saved)) selectedAgents.set(baseUrl, saved.trim());
  } catch { /* Use the current page selection when storage is unavailable. */ }
  return selectedAgents.get(baseUrl) ?? 'dataworks_data_agent';
}
export function saveSelectedAgent(baseUrl: string, value: string): void {
  if (!validAgentName(value)) throw new Error('Agent 名称需为 1–128 个字符，不能包含控制字符');
  const name = value.trim();
  selectedAgents.set(baseUrl, name);
  try { localStorage.setItem(selectionKey(baseUrl), name); } catch { /* Memory fallback. */ }
}
