// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { savePreferences } from '../src/session-preferences';

let snapshots: typeof import('../src/session-configuration');
const scope = ['/backend/cn-shanghai/d', 'agent'] as const;
const storageKey = (base: string, agent: string) =>
  `workbench.session-configuration.v1:${JSON.stringify([base, agent])}`;
const selection = { modelServiceId: 'chosen-model', approvalMode: 'plan', reasoningEffort: 'none' };

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  snapshots = await import('../src/session-configuration');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('successful creation configuration snapshots', () => {
  it('never infers unknown historical settings from current preferences', () => {
    savePreferences(...scope, selection);
    expect(snapshots.readSessionConfiguration(...scope, 'historical')).toBeUndefined();
    expect(localStorage.getItem(storageKey(...scope))).toBeNull();
    snapshots.saveSessionConfiguration(...scope, 'created', selection);
    savePreferences(...scope, { modelServiceId: 'new-default', approvalMode: 'yolo' });
    expect(snapshots.readSessionConfiguration(...scope, 'created')).toEqual(selection);
    expect(snapshots.readSessionConfiguration(...scope, 'another-history')).toBeUndefined();
  });

  it('distinguishes an explicit Agent-default snapshot from missing history across reload', async () => {
    snapshots.saveSessionConfiguration(...scope, 'defaults', {
      modelServiceId: undefined, approvalMode: undefined, reasoningEffort: undefined,
    });
    snapshots.saveSessionConfiguration(...scope, 'also-defaults', undefined);
    vi.resetModules();
    const reloaded = await import('../src/session-configuration');
    expect(reloaded.readSessionConfiguration(...scope, 'defaults')).toEqual({});
    expect(reloaded.readSessionConfiguration(...scope, 'also-defaults')).toEqual({});
    expect(reloaded.readSessionConfiguration(...scope, 'unknown')).toBeUndefined();
  });

  it('persists the selected fields over reload, without claiming runtime verification', async () => {
    expect(snapshots.saveSessionConfiguration(...scope, 'sid', selection)).toBe('browser');
    vi.resetModules();
    const reloaded = await import('../src/session-configuration');
    expect(reloaded.readSessionConfiguration(...scope, 'sid')).toEqual(selection);
    expect(reloaded.readSessionConfiguration(...scope, 'sid')).not.toHaveProperty('runtimeVerified');
  });

  it('isolates exact session, backend/region and Agent scopes, including delimiter collisions', () => {
    snapshots.saveSessionConfiguration(...scope, 'Case-SID', selection);
    for (const [base, agent, sid] of [
      [scope[0], scope[1], 'case-sid'], ['/backend/cn-beijing/d', scope[1], 'Case-SID'],
      [scope[0], 'other-agent', 'Case-SID'], ['https://other.example/d', scope[1], 'Case-SID'],
    ] as const) expect(snapshots.readSessionConfiguration(base, agent, sid)).toBeUndefined();
    snapshots.saveSessionConfiguration('a:b', 'c', 'sid', selection);
    expect(snapshots.readSessionConfiguration('a', 'b:c', 'sid')).toBeUndefined();
    snapshots.saveSessionConfiguration(...scope, '__proto__', {});
    expect(snapshots.readSessionConfiguration(...scope, '__proto__')).toEqual({});
  });

  it('stores bounded snapshot fields only, never headers, credentials or extra fields', () => {
    const raw = { modelServiceId: '  data-agent  ', approvalMode: 'auto', reasoningEffort: 'none',
      headers: { Authorization: 'do-not-persist' }, accessKeySecret: 'do-not-persist', source: 'runtime-verified' };
    snapshots.saveSessionConfiguration(...scope, 'sid', raw);
    expect(snapshots.readSessionConfiguration(...scope, 'sid')).toEqual({ approvalMode: 'auto', reasoningEffort: 'none' });
    const serialized = localStorage.getItem(storageKey(...scope))!;
    expect(serialized).not.toMatch(/headers|Authorization|accessKeySecret|do-not-persist|runtime-verified/);
    snapshots.saveSessionConfiguration(...scope, 'invalid-values', {
      modelServiceId: 'x'.repeat(513), approvalMode: 'x'.repeat(129), reasoningEffort: 'bad\nvalue',
    });
    expect(snapshots.readSessionConfiguration(...scope, 'invalid-values')).toEqual({});
    snapshots.saveSessionConfiguration(...scope, 'trimmed', { modelServiceId: ' chosen ', reasoningEffort: 'default' });
    expect(snapshots.readSessionConfiguration(...scope, 'trimmed')).toEqual({ modelServiceId: 'chosen', reasoningEffort: 'default' });
  });

  it('normalizes accepted creation values the same way as the backend', () => {
    snapshots.saveSessionConfiguration(...scope, 'sid', {
      modelServiceId: ' selected-model ', approvalMode: ' yolo ', reasoningEffort: ' none ',
    });
    expect(snapshots.readSessionConfiguration(...scope, 'sid')).toEqual({
      modelServiceId: 'selected-model', approvalMode: 'yolo', reasoningEffort: 'none',
    });
  });

  it('retains a model-specific successful reasoning value across reload without borrowing defaults', async () => {
    snapshots.saveSessionConfiguration(...scope, 'sid', { approvalMode: 'yolo', reasoningEffort: 'minimal' });
    vi.resetModules();
    const reloaded = await import('../src/session-configuration');
    expect(reloaded.readSessionConfiguration(...scope, 'sid')).toEqual({ approvalMode: 'yolo', reasoningEffort: 'minimal' });
    expect(reloaded.readSessionConfiguration(...scope, 'unrelated')).toBeUndefined();
  });

  it('returns a defensive copy and snapshots the input rather than keeping references', () => {
    const input = { ...selection };
    snapshots.saveSessionConfiguration(...scope, 'sid', input);
    input.modelServiceId = 'mutated-input';
    const read = snapshots.readSessionConfiguration(...scope, 'sid')!;
    read.approvalMode = 'mutated-output';
    expect(snapshots.readSessionConfiguration(...scope, 'sid')).toEqual(selection);
  });

  it('keeps at most 100 snapshots per scope in one key, evicting oldest save not oldest read', async () => {
    for (let i = 0; i < 100; i++) snapshots.saveSessionConfiguration(...scope, `s${i}`, { modelServiceId: `m${i}` });
    snapshots.readSessionConfiguration(...scope, 's0'); // Reading does not pin the oldest snapshot.
    snapshots.saveSessionConfiguration(...scope, 's1', selection); // Saving promotes this entry.
    snapshots.saveSessionConfiguration(...scope, 's100', {});
    expect(snapshots.readSessionConfiguration(...scope, 's0')).toBeUndefined();
    expect(snapshots.readSessionConfiguration(...scope, 's1')).toEqual(selection);
    expect(snapshots.readSessionConfiguration(...scope, 's100')).toEqual({});
    expect(localStorage.length).toBe(1);
    expect(JSON.parse(localStorage.getItem(storageKey(...scope))!).entries).toHaveLength(100);
    snapshots.saveSessionConfiguration('/other', 'agent', 's0', {});
    expect(localStorage.length).toBe(2);
    vi.resetModules();
    const reloaded = await import('../src/session-configuration');
    expect(reloaded.readSessionConfiguration(...scope, 's0')).toBeUndefined();
    expect(reloaded.readSessionConfiguration('/other', 'agent', 's0')).toEqual({});
  });

  it.each(['not-json', 'null', '[]', '{}', '{"version":2,"entries":[]}', 'x'.repeat(1_000_001)])(
    'treats corrupt or unsupported persisted data as unknown and can overwrite it', raw => {
      localStorage.setItem(storageKey(...scope), raw);
      expect(snapshots.readSessionConfiguration(...scope, 'sid')).toBeUndefined();
      expect(snapshots.saveSessionConfiguration(...scope, 'sid', {})).toBe('browser');
      expect(snapshots.readSessionConfiguration(...scope, 'sid')).toEqual({});
    },
  );

  it('validates individual persisted records and sanitizes fields again on read', () => {
    localStorage.setItem(storageKey(...scope), JSON.stringify({ version: 1, entries: [
      null, [], { sid: '', options: {} }, { sid: 'absent-options' }, { sid: 'array', options: [] },
      { sid: 'sid', options: { modelServiceId: 'old' } },
      { sid: 'sid', options: { modelServiceId: ' new ', approvalMode: 'INVALID', Authorization: 'ignored' } },
    ] }));
    expect(snapshots.readSessionConfiguration(...scope, 'sid')).toEqual({ modelServiceId: 'new', approvalMode: 'INVALID' });
    expect(snapshots.readSessionConfiguration(...scope, 'absent-options')).toBeUndefined();
    expect(snapshots.readSessionConfiguration(...scope, 'array')).toBeUndefined();
  });

  it('bounds oversized persisted collections before exposing snapshots', () => {
    localStorage.setItem(storageKey(...scope), JSON.stringify({ version: 1,
      entries: Array.from({ length: 101 }, (_, i) => ({ sid: `s${i}`, options: {} })) }));
    expect(snapshots.readSessionConfiguration(...scope, 's0')).toBeUndefined();
    expect(snapshots.readSessionConfiguration(...scope, 's100')).toEqual({});
  });

  it('keeps a failed write authoritative over stale readable browser data', () => {
    snapshots.saveSessionConfiguration(...scope, 'sid', { modelServiceId: 'old-browser' });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('quota'); });
    expect(snapshots.saveSessionConfiguration(...scope, 'sid', selection)).toBe('memory');
    expect(localStorage.getItem(storageKey(...scope))).toContain('old-browser');
    expect(snapshots.readSessionConfiguration(...scope, 'sid')).toEqual(selection);
    snapshots.saveSessionConfiguration(...scope, 'another', {});
    expect(snapshots.readSessionConfiguration(...scope, 'sid')).toEqual(selection);
    set.mockRestore();
    expect(snapshots.saveSessionConfiguration(...scope, 'persist-again', {})).toBe('browser');
    expect(snapshots.readSessionConfiguration(...scope, 'sid')).toEqual(selection);
  });

  it('keeps failed clears authoritative and limits clear to the requested scope', () => {
    snapshots.saveSessionConfiguration(...scope, 'sid', selection);
    snapshots.saveSessionConfiguration('/other', 'agent', 'sid', selection);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw Error('blocked'); });
    expect(snapshots.clearSessionConfigurations(...scope)).toBe('memory');
    expect(localStorage.getItem(storageKey(...scope))).toContain('chosen-model');
    expect(snapshots.readSessionConfiguration(...scope, 'sid')).toBeUndefined();
    expect(snapshots.readSessionConfiguration('/other', 'agent', 'sid')).toEqual(selection);
  });

  it('survives unavailable reads/writes while retaining previous snapshots in this page', () => {
    snapshots.saveSessionConfiguration(...scope, 'prior', selection);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('blocked'); });
    expect(snapshots.readSessionConfiguration(...scope, 'prior')).toEqual(selection);
    expect(snapshots.saveSessionConfiguration(...scope, 'new', {})).toBe('memory');
    expect(snapshots.readSessionConfiguration(...scope, 'new')).toEqual({});
    expect(snapshots.readSessionConfiguration(...scope, 'prior')).toEqual(selection);
  });

  it('works without a localStorage global and bounds its memory fallback too', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(snapshots.readSessionConfiguration(...scope, 'unknown')).toBeUndefined();
    for (let i = 0; i < 101; i++) snapshots.saveSessionConfiguration(...scope, `s${i}`, selection);
    expect(snapshots.readSessionConfiguration(...scope, 's0')).toBeUndefined();
    expect(snapshots.readSessionConfiguration(...scope, 's100')).toEqual(selection);
    expect(snapshots.clearSessionConfigurations(...scope)).toBe('memory');
    expect(snapshots.readSessionConfiguration(...scope, 's100')).toBeUndefined();
  });

  it('observes browser changes when storage is healthy and a successful clear survives reload', async () => {
    snapshots.saveSessionConfiguration(...scope, 'sid', selection);
    localStorage.removeItem(storageKey(...scope));
    expect(snapshots.readSessionConfiguration(...scope, 'sid')).toBeUndefined();
    snapshots.saveSessionConfiguration(...scope, 'sid', selection);
    expect(snapshots.clearSessionConfigurations(...scope)).toBe('browser');
    vi.resetModules();
    const reloaded = await import('../src/session-configuration');
    expect(reloaded.readSessionConfiguration(...scope, 'sid')).toBeUndefined();
  });

  it.each(['', '   ', 'x'.repeat(513), 'bad\nsid'])('ignores invalid sid values safely', sid => {
    expect(snapshots.saveSessionConfiguration(...scope, sid, selection)).toBeUndefined();
    expect(snapshots.readSessionConfiguration(...scope, sid)).toBeUndefined();
    expect(localStorage.length).toBe(0);
  });
});
