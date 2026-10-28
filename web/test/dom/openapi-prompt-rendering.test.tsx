// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { send, submit, actions } = vi.hoisted(() => {
  const send = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
  const submit = vi.fn().mockResolvedValue({ kind: 'admitted' });
  return { send, submit, actions: { sendPrompt: send, submitPrompt: submit } };
});
const store = { dispatch: vi.fn() };
vi.mock('@qwen-code/web-shell', () => ({ useActions: () => actions, useTranscriptStore: () => store }));
import { OpenApiPromptRendering } from '../../src/components/OpenApiPromptRendering';

afterEach(cleanup);
it('renders the remote echo once without replacing the submitted text or retrying it', () => {
  const view = render(<OpenApiPromptRendering><button onClick={() => void actions.sendPrompt('original question', { optimisticUserMessage: true } as never)}>Send</button>
    <button onClick={() => void actions.submitPrompt('queued question')}>Queue</button></OpenApiPromptRendering>);
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
  expect(send).toHaveBeenCalledExactlyOnceWith('original question', { optimisticUserMessage: false });
  expect(submit).toHaveBeenCalledExactlyOnceWith('queued question', { optimisticUserMessage: false });
  view.unmount();
  expect(actions.sendPrompt).toBe(send);
});
