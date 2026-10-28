// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPreferences, effectiveDefaults, readPreferences, readPreferenceState, resolveCreationOptions, sanitizePreferences, savePreferences } from '../../src/session-preferences';

const defaults = { agentName: 'a', model: 'env-model', approvalMode: 'yolo', reasoningEffort: 'high', models: [] };
afterEach(() => {
  vi.restoreAllMocks();
  clearPreferences('/d', 'a');
  localStorage.clear();
});
describe('automatic session defaults', () => {
  it('uses environment defaults initially, then retains only non-secret browser preferences', () => {
    expect(effectiveDefaults(defaults, readPreferences('/d', 'a'))).toEqual(defaults);
    savePreferences('/d', 'a', { modelServiceId: 'chosen', approvalMode: 'default', reasoningEffort: 'none', secret: 'must-not-save' } as never);
    expect(effectiveDefaults(defaults, readPreferences('/d', 'a'))).toMatchObject({ model: 'chosen', approvalMode: 'default', reasoningEffort: 'none' });
    expect(localStorage.getItem(localStorage.key(0)!)).not.toContain('secret');
    expect(readPreferences('/d', 'other-agent')).toEqual({});
    expect(readPreferences('http://other-server/d', 'a')).toEqual({});
    clearPreferences('/d', 'a');
    expect(effectiveDefaults(defaults, readPreferences('/d', 'a'))).toEqual(defaults);
  });

  it('explicit SDK fields override cached choices, including the initial reasoning effort', () => {
    const saved = { modelServiceId: 'cached', approvalMode: 'yolo', reasoningEffort: 'high' };
    expect(resolveCreationOptions(defaults, saved, { modelServiceId: 'env-model', approvalMode: 'plan', reasoningEffort: 'none' }))
      .toEqual({ modelServiceId: 'env-model', approvalMode: 'plan', reasoningEffort: 'none' });
    expect(resolveCreationOptions(defaults, saved, { reasoningEffort: 'minimal' }).reasoningEffort).toBe('minimal');
  });

  it('cleared overrides follow later environment changes without pinning a snapshot', () => {
    savePreferences('/d', 'a', { modelServiceId: 'chosen', approvalMode: 'default', reasoningEffort: 'none' });
    clearPreferences('/d', 'a');
    const next = { ...defaults, model: 'new-env', approvalMode: 'auto', reasoningEffort: 'low' };
    expect(resolveCreationOptions(next, readPreferences('/d', 'a'), {}))
      .toEqual({ modelServiceId: 'new-env', approvalMode: 'auto', reasoningEffort: 'low' });
    expect(readPreferences('/d', 'a')).toEqual({});
    expect(sanitizePreferences({ modelServiceId: ' data-agent ', approvalMode: '', reasoningEffort: '' })).toEqual({});
  });

  it('retains usable in-memory choices when reads and writes fail', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled'); });
    expect(savePreferences('/d', 'a', { modelServiceId: 'memory-model', approvalMode: 'plan' })).toBe('memory');
    expect(readPreferenceState('/d', 'a')).toEqual({
      options: { modelServiceId: 'memory-model', approvalMode: 'plan' }, persistence: 'memory',
    });
    expect(resolveCreationOptions(defaults, readPreferences('/d', 'a'), {})).toMatchObject({ modelServiceId: 'memory-model', approvalMode: 'plan' });
  });

  it('a failed clear masks stale persistent preferences for the rest of this page', () => {
    savePreferences('/d', 'a', { modelServiceId: 'stale-browser-model' });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('disabled'); });
    expect(clearPreferences('/d', 'a')).toBe('memory');
    expect(readPreferences('/d', 'a')).toEqual({});
    expect(effectiveDefaults(defaults, readPreferences('/d', 'a'))).toEqual(defaults);
    expect(localStorage.getItem(localStorage.key(0)!)).toContain('stale-browser-model');
  });

  it('treats corrupt stored JSON as absent preferences rather than a storage outage', () => {
    localStorage.setItem('workbench.session-options.v1:/d:a', 'not-json');
    expect(readPreferenceState('/d', 'a')).toEqual({ options: {}, persistence: 'browser' });
  });
});
