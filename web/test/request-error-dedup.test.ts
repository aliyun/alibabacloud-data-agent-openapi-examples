import { expect, it } from 'vitest';
import { createDaemonTranscriptStore, normalizeDaemonEvent, type DaemonEvent } from '@qwen-code/sdk/daemon';
import { installRequestErrorDedup } from '../src/request-error-dedup';

const error = (promptId: string, message = 'fixture failure'): DaemonEvent => ({ v: 1, type: 'turn_error',
  data: { sessionId: 'session', promptId, message, code: 'fixture_error' }, _meta: { source: 'workbench_prompt_result' } });

it('normalizes repeated terminal delivery while displaying the actual SDK error only once', () => {
  const store = createDaemonTranscriptStore();
  const release = installRequestErrorDedup(store);
  for (let generation = 0; generation < 3; generation++) store.dispatch(normalizeDaemonEvent(error('old')));
  expect(store.getSnapshot().blocks.filter(block => block.kind === 'error')).toHaveLength(1);
  // A later failed prompt and a different error are independent facts.
  store.dispatch(normalizeDaemonEvent(error('new')));
  store.dispatch(normalizeDaemonEvent(error('old', 'different failure')));
  expect(store.getSnapshot().blocks.filter(block => block.kind === 'error')).toHaveLength(3);
  release();
});

it('allows one error after transcript reset and preserves ordinary errors without prompt ownership', () => {
  const store = createDaemonTranscriptStore();
  const release = installRequestErrorDedup(store);
  store.dispatch(normalizeDaemonEvent(error('old')));
  store.reset();
  store.dispatch(normalizeDaemonEvent(error('old')));
  store.dispatch(normalizeDaemonEvent(error('old')));
  store.dispatch({ type: 'error', text: 'connection issue' });
  store.dispatch({ type: 'error', text: 'connection issue' });
  expect(store.getSnapshot().blocks.filter(block => block.kind === 'error')).toHaveLength(3);
  release();
});
