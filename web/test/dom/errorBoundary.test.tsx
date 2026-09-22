// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@/components/ErrorBoundary';

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function Child({ broken }: { broken: boolean }) {
  if (broken) throw new Error('render failed');
  return <div>会话内容</div>;
}

it('renders a fallback and warns against resending a task', () => {
  render(<ErrorBoundary label="Web Shell" variant="root"><Child broken /></ErrorBoundary>);
  expect(screen.getByRole('alert').textContent).toContain('不要重复发送任务');
  expect(screen.getByRole('button', { name: '刷新页面' })).toBeTruthy();
  expect(console.error).toHaveBeenCalled();
});
it('recovers the web-shell subtree when the session changes', () => {
  const view = render(<ErrorBoundary label="Web Shell" resetKeys={['a']}><Child broken /></ErrorBoundary>);
  view.rerender(<ErrorBoundary label="Web Shell" resetKeys={['b']}><Child broken={false} /></ErrorBoundary>);
  expect(screen.getByText('会话内容')).toBeTruthy();
});
it('allows retrying render without resubmitting the task', () => {
  const view = render(<ErrorBoundary label="Web Shell"><Child broken /></ErrorBoundary>);
  view.rerender(<ErrorBoundary label="Web Shell"><Child broken={false} /></ErrorBoundary>);
  fireEvent.click(screen.getByRole('button', { name: '重试渲染' }));
  expect(screen.getByText('会话内容')).toBeTruthy();
});
