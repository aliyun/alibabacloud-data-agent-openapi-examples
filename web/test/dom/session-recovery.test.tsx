// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionEventRecovery, SessionRecoveryContext, type SessionRecoveryRequest } from '../../src/session-recovery';
const harness = vi.hoisted(() => ({ connection: { sessionId: 'a' as string | undefined }, actions: { reloadSession: vi.fn() } }));
vi.mock('@qwen-code/web-shell', () => ({ useConnection: () => harness.connection, useActions: () => harness.actions }));
afterEach(cleanup);
beforeEach(() => { harness.connection = { sessionId: 'a' }; harness.actions.reloadSession.mockReset().mockResolvedValue(undefined); });
function view(request: SessionRecoveryRequest, complete = vi.fn(), retry = vi.fn()) {
  return { complete, retry, node: <SessionRecoveryContext.Provider value={{ request, complete, retry }}><SessionEventRecovery /></SessionRecoveryContext.Provider> };
}
it('reloads the current view once through its public action and completes the exact request', async () => {
  const request = { sessionId: 'a', automatic: true, id: 1 }; const v = view(request);
  render(v.node);
  await waitFor(() => expect(v.complete).toHaveBeenCalledWith(request));
  expect(harness.actions.reloadSession).toHaveBeenCalledTimes(1);
  expect(harness.actions.reloadSession.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
});
it('does not load a previous session after navigation', async () => {
  const v = view({ sessionId: 'previous', automatic: true, id: 1 }); render(v.node);
  await waitFor(() => expect(v.complete).toHaveBeenCalled());
  expect(harness.actions.reloadSession).not.toHaveBeenCalled();
});
it('aborts an old recovery when navigating to another session', async () => {
  harness.actions.reloadSession.mockImplementation(() => new Promise(() => {}));
  const v = view({ sessionId: 'a', automatic: true, id: 1 }); const ui = render(v.node);
  await screen.findByRole('status');
  const signal = harness.actions.reloadSession.mock.calls[0]![0] as AbortSignal;
  harness.connection = { sessionId: 'b' }; ui.rerender(v.node);
  // A parent rerender with a new context value reflects the real provider transition.
  ui.rerender(view({ sessionId: 'a', automatic: true, id: 1 }, v.complete, v.retry).node);
  await waitFor(() => expect(signal.aborted).toBe(true));
  expect(harness.actions.reloadSession).toHaveBeenCalledTimes(1);
});
it('stops automatic rebuilds and offers a manual recovery without a retry loop', async () => {
  const v = view({ sessionId: 'a', automatic: false, id: 2 }); render(v.node);
  fireEvent.click(await screen.findByRole('button', { name: '恢复会话' }));
  expect(v.retry).toHaveBeenCalledWith('a'); expect(harness.actions.reloadSession).not.toHaveBeenCalled();
});
it('surfaces a failed Load separately from transcript and never silently repeats it', async () => {
  harness.actions.reloadSession.mockRejectedValue(new Error('fixture access denied'));
  const v = view({ sessionId: 'a', automatic: true, id: 1 }); render(v.node);
  await act(async () => {});
  expect((await screen.findByRole('alert')).textContent).toContain('fixture access denied');
  expect(harness.actions.reloadSession).toHaveBeenCalledTimes(1);
});
