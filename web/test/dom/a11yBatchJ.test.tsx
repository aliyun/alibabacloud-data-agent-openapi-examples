// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError } from '@das/shared';

import { ErrorBanner } from '@/components/chat/ErrorBanner';
import { PanelLoading } from '@/components/right/PanelLoading';
import { SessionRenameInput } from '@/components/left/SessionRenameInput';

/**
 * 批次J 的三条可达性 / 交互判据。
 *
 * 这三样都不是纯函数，只能在 DOM 里钉：
 *  · `PanelLoading` 的 `role="status"` 必须挂在 `aria-hidden` 容器**外面**——写进去
 *    读屏就读不到，等于这个 live region 白做；
 *  · `ErrorBanner` 的播报层级跟着色调走（red/amber → alert，muted → status），
 *    一处判据五个复用点同时生效，改错了要能被测出来；
 *  · `SessionRenameInput` 的 Enter 保存 / Esc 取消且挡冒泡 / 失焦取消——失焦从
 *    "保存"改成"取消"是这一批最容易被人顺手改回去的行为，必须有测试兜住。
 */

afterEach(cleanup);

describe('PanelLoading 的 live region', () => {
  it('role="status" 在 aria-hidden 容器外面，读屏读得到', () => {
    const { container } = render(<PanelLoading api="LoadAgentSession" rows={3} />);
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    // status 自身不能是 aria-hidden，也不能落在任何 aria-hidden 祖先里。
    expect(status?.getAttribute('aria-hidden')).not.toBe('true');
    let node: Element | null = status;
    while (node !== null) {
      expect(node.getAttribute('aria-hidden')).not.toBe('true');
      node = node.parentElement;
    }
  });

  it('播报文案带接口名，骨架条数按 rows 画', () => {
    const { container } = render(<PanelLoading api="ListAgentSessionArtifacts" rows={5} />);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('ListAgentSessionArtifacts');
    // 骨架是装饰，整块 aria-hidden；rows=5 就画 5 条。
    const decorative = container.querySelector('[aria-hidden="true"]');
    expect(decorative).not.toBeNull();
    expect(decorative?.querySelectorAll('.skeleton').length).toBe(5);
  });
});

describe('ErrorBanner 的播报层级跟色调走', () => {
  it('red / amber 用 alert（打断当前朗读）', () => {
    const first = render(<ErrorBanner error={apiError('session_ghost', 'upstream returned 422')} />);
    expect(first.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(first.container.querySelector('[role="status"]')).toBeNull();
    first.unmount();

    const second = render(<ErrorBanner error={apiError('stream_break', 'session stream ended without turn terminal')} />);
    expect(second.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('muted（并发被拒）降级成 status，不抢注意力', () => {
    const { container } = render(
      <ErrorBanner error={apiError('concurrent_rejected', 'session_concurrent_operation_in_progress')} />,
    );
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('SessionRenameInput 的三条语义', () => {
  function setup() {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(
      <SessionRenameInput initial="原标题" maxLength={256} hintId="s1-rename-hint" onCommit={onCommit} onCancel={onCancel} />,
    );
    const input = screen.getByLabelText('重命名会话 原标题') as HTMLInputElement;
    return { input, onCommit, onCancel };
  }

  it('maxLength 与提示行都写死 256，aria-describedby 指向提示行', () => {
    const { input } = setup();
    expect(input.maxLength).toBe(256);
    expect(input.getAttribute('aria-describedby')).toBe('s1-rename-hint');
    expect(screen.getByText(/最长 256 字/)).toBeTruthy();
  });

  it('Enter 提交当前值', () => {
    const { input, onCommit, onCancel } = setup();
    fireEvent.change(input, { target: { value: '新别名' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('新别名');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Esc 取消，且 stopPropagation——不能连带关掉抽屉', () => {
    const { input, onCommit, onCancel } = setup();
    fireEvent.change(input, { target: { value: '打了一半' } });
    // React 的合成事件挂在 root 容器上，fireEvent 的合成冒泡观察不到 stopPropagation
    // 对**原生**传播的影响，所以这里派发原生事件，在 document 上挂一个探针：
    // 若组件里的 e.stopPropagation() 生效（它会委托到原生事件），探针就不会被触发。
    let bubbledToDocument = false;
    document.addEventListener('keydown', () => {
      bubbledToDocument = true;
    });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(bubbledToDocument).toBe(false);
  });

  it('失焦取消，不保存——打了一半点别处不会静默写下半截别名', () => {
    const { input, onCommit, onCancel } = setup();
    fireEvent.change(input, { target: { value: '分析这个表的' } });
    fireEvent.blur(input);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });
});
