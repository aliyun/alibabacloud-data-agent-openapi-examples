// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '@/components/ErrorBoundary';

/**
 * 渲染期异常的兜底。
 *
 * 为什么必须有 DOM 测试：这层是"上游给的任意内容把某个渲染分支搞炸"时的最后一道
 * 防线，而它平时**永远不会执行**——所以浏览器实测覆盖不到它，只有主动抛错才能验。
 * React 18 没有边界时的默认行为是整棵树卸载成白屏，在途那一轮还在后台收流，
 * 用户看到的是"什么都没发生"。
 */

/** 渲染期抛错的最小组件：props 里给一个开关，用来验「重试渲染」能不能恢复。 */
function Bomb({ shouldThrow }: { shouldThrow: boolean }): JSX.Element {
  if (shouldThrow) throw new Error('boom-from-upstream-content');
  return <div>子树活着</div>;
}

describe('ErrorBoundary：panel 变体（分栏边界）', () => {
  /**
   * React 对每个未被边界之外的错误都会打一条 console.error，
   * 还会附带组件栈——这正是我们想要的行为，但它会把测试输出淹掉。
   * 这里既静音、又反过来断言"确实留了带 label 的记录"（componentDidCatch 那一行）。
   */
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    cleanup();
  });

  it('子树不抛错时完全不介入：透传 children，不渲染任何 role=alert', () => {
    render(
      <ErrorBoundary label="对话区" variant="panel">
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('子树活着')).toBeTruthy();
  });

  it('子树抛错后显示带位置名的兜底文案与错误 message', () => {
    render(
      <ErrorBoundary label="对话区" variant="panel">
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('「对话区」渲染崩了')).toBeTruthy();
    // message 必须在界面上：用户报障时唯一能带回来的就是这行。
    expect(screen.getByRole('alert').textContent).toContain('boom-from-upstream-content');
  });

  it('componentDidCatch 留下一条带 label 的 console.error（组件栈只有这里有）', () => {
    render(
      <ErrorBoundary label="会话列表" variant="panel">
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    const firstArg = consoleError.mock.calls.map((call) => String(call[0]));
    expect(firstArg.some((arg) => arg.includes('[ErrorBoundary:会话列表]'))).toBe(true);
  });

  it('点「重试渲染」会清空错误并重新渲染子树：不再抛错的那一版能自己长回来', () => {
    const view = render(
      <ErrorBoundary label="对话区" variant="panel">
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();

    view.rerender(
      <ErrorBoundary label="对话区" variant="panel">
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    // 光是 rerender 不该自动恢复：错误状态还在，否则「重试渲染」就没有意义了。
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.click(screen.getByText('重试渲染'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('子树活着')).toBeTruthy();
  });

  it('resetKeys 里任一项变化时自动恢复：崩在 A 会话上之后切到 B 会话，不该逼人按刷新', () => {
    const view = render(
      <ErrorBoundary label="对话区" variant="panel" resetKeys={['session-a']}>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();

    view.rerender(
      <ErrorBoundary label="对话区" variant="panel" resetKeys={['session-b']}>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('子树活着')).toBeTruthy();
  });

  it('resetKeys 内容全同时不自动恢复（哪怕数组是新引用）：否则确定性崩溃会变成每帧自愈的热循环', () => {
    const view = render(
      <ErrorBoundary label="这一轮" variant="panel" resetKeys={['rid-1', 'streaming']}>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();

    // 流式期间调用方每次 render 都会新建数组，但内容没变。
    for (let i = 0; i < 3; i += 1) {
      view.rerender(
        <ErrorBoundary label="这一轮" variant="panel" resetKeys={['rid-1', 'streaming']}>
          <Bomb shouldThrow />
        </ErrorBoundary>,
      );
      expect(screen.getByRole('alert')).toBeTruthy();
    }
  });

  it('resetKeys 长度变化也算变了：调用方换了 key 的形状，就该给一次重新渲染的机会', () => {
    const view = render(
      <ErrorBoundary label="这一轮" variant="panel" resetKeys={['rid-1']}>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();

    view.rerender(
      <ErrorBoundary label="这一轮" variant="panel" resetKeys={['rid-1', 'done']}>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('调用栈收在折叠区里：默认不摊开，但拿得到', () => {
    render(
      <ErrorBoundary label="对话区" variant="panel">
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    const details = screen.getByText('调用栈（排查用）').closest('details');
    expect(details).toBeTruthy();
    // 默认收起：一崩就铺半屏英文堆栈会把"其余部分仍然可用"挤出视野。
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.querySelector('pre')?.textContent ?? '').toContain('boom-from-upstream-content');
  });
});

describe('ErrorBoundary：inline 变体（一栏里的一条内容）', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    cleanup();
  });

  it('只占一条 role=alert，不摊调用栈，按钮是「重试」而不是「重试渲染」', () => {
    render(
      <ErrorBoundary label="这一轮" variant="inline">
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('「这一轮」没能渲染出来');
    expect(alert.textContent).toContain('boom-from-upstream-content');
    expect(alert.querySelector('details')).toBeNull();
    expect(alert.querySelector('pre')).toBeNull();
    expect(screen.getByText('重试')).toBeTruthy();
    expect(screen.queryByText('重试渲染')).toBeNull();
  });

  it('兄弟内容不受影响：一轮崩了，同一栏的其他轮次照常渲染', () => {
    render(
      <div>
        <div>第 1 轮：正常内容</div>
        <ErrorBoundary label="这一轮" variant="inline">
          <Bomb shouldThrow />
        </ErrorBoundary>
        <div>第 3 轮：正常内容</div>
      </div>,
    );
    expect(screen.getByText('第 1 轮：正常内容')).toBeTruthy();
    expect(screen.getByText('第 3 轮：正常内容')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('点「重试」清空错误：不再抛错的那一版能长回来', () => {
    const view = render(
      <ErrorBoundary label="这一轮" variant="inline">
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();

    view.rerender(
      <ErrorBoundary label="这一轮" variant="inline">
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByText('重试'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('子树活着')).toBeTruthy();
  });
});

describe('ErrorBoundary：root 变体', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    cleanup();
  });

  it('文案不带位置名，按钮是「刷新页面」而不是「重试渲染」：根崩了没有别的地方可点', () => {
    render(
      <ErrorBoundary label="根" variant="root">
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByText('界面渲染崩了')).toBeTruthy();
    expect(screen.queryByText('重试渲染')).toBeNull();
    const reload = screen.getByText('刷新页面');
    expect(reload).toBeTruthy();
    // 只断言文案与存在性，不点：jsdom 的 location.reload 是未实现的导航。
  });

  it('提醒"刷新会丢掉在途那一轮"：这句话是 root 与 panel 文案的唯一实质差别', () => {
    render(
      <ErrorBoundary label="根" variant="root">
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert').textContent).toContain('刷新页面会丢掉它');
  });
});
