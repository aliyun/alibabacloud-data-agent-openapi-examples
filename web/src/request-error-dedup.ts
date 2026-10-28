import type { DaemonTranscriptStore, DaemonUiEvent } from '@qwen-code/sdk/daemon';

const seenByStore = new WeakMap<DaemonTranscriptStore, Set<string>>();

/** Replayed browser request results must settle waiters again without duplicating transcript errors. */
export function installRequestErrorDedup(store: DaemonTranscriptStore): () => void {
  let seen = seenByStore.get(store);
  if (!seen) { seen = new Set(); seenByStore.set(store, seen); }
  const dispatch = store.dispatch;
  const reset = store.reset;
  const keep = (event: DaemonUiEvent) => {
    if (event.type !== 'error' || event.source !== 'turn_error' || !event.promptId) return true;
    const key = JSON.stringify([event.promptId, event.code, event.text]);
    if (seen.has(key)) return false;
    seen.add(key);
    while (seen.size > 64) seen.delete(seen.values().next().value!);
    return true;
  };
  const wrapped: DaemonTranscriptStore['dispatch'] = events => {
    if (Array.isArray(events)) {
      const kept = events.filter(keep);
      if (kept.length) dispatch.call(store, kept);
    } else if (keep(events)) dispatch.call(store, events);
  };
  store.dispatch = wrapped;
  const resetWrapped: DaemonTranscriptStore['reset'] = seed => { seen.clear(); reset.call(store, seed); };
  store.reset = resetWrapped;
  return () => {
    if (store.dispatch === wrapped) store.dispatch = dispatch;
    if (store.reset === resetWrapped) store.reset = reset;
  };
}
