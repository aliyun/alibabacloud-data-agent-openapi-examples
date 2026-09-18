// @vitest-environment jsdom
import { useCallback, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Drawer } from '@/components/layout/Drawer';

/**
 * 窄屏抽屉的焦点与可及性契约。
 *
 * 这些行为在浏览器里验过一遍，但内置浏览器的视口固定 511px、页面处于隐藏态
 * （`document.hasFocus() === false`），键盘事件送不进去、`:focus` 也不匹配，
 * 只能靠合成事件近似。jsdom 里焦点是**可编程的事实**，所以把这几条钉在测试里：
 * 打开时焦点进面板、Esc 关闭、关闭后焦点还给打开它的那个元素、
 * 关掉的抽屉对辅助技术不可见（`inert`），以及"打开另一侧时不能把焦点拽回来"。
 */

afterEach(() => {
  cleanup();
  // 「焦点被别处拿走」那条用例自己往 body 上 append 了一个按钮，cleanup 只管 RTL 的容器。
  document.body.replaceChildren();
});

/** Esc 走合成事件：抽屉在 document 上挂 keydown，派发目标就是 document 本身。 */
function pressEscape(): void {
  fireEvent.keyDown(document, { key: 'Escape' });
}

function panel(): HTMLElement {
  return screen.getByRole('dialog');
}

describe('Drawer：开合与 inert', () => {
  it('打开时焦点进面板，键盘用户不用从头 Tab', () => {
    render(
      <Drawer side="left" title="会话" open onClose={() => {}}>
        <button type="button">列表里的第一项</button>
      </Drawer>,
    );
    expect(document.activeElement).toBe(panel());
  });

  it('关闭时挂 inert：display:none 只是看不见，屏幕阅读器与浏览器查找仍会进去', () => {
    const view = render(
      <Drawer side="left" title="会话" open onClose={() => {}}>
        <button type="button">列表里的第一项</button>
      </Drawer>,
    );
    expect(panel().hasAttribute('inert')).toBe(false);

    view.rerender(
      <Drawer side="left" title="会话" open={false} onClose={() => {}}>
        <button type="button">列表里的第一项</button>
      </Drawer>,
    );
    expect(panel().hasAttribute('inert')).toBe(true);
  });

  it('关闭时用 hidden 类而不是卸载：抽屉里的搜索词不该因为关一下就被丢掉', () => {
    const view = render(
      <Drawer side="left" title="会话" open onClose={() => {}}>
        <input defaultValue="我打的字" />
      </Drawer>,
    );
    view.rerender(
      <Drawer side="left" title="会话" open={false} onClose={() => {}}>
        <input defaultValue="我打的字" />
      </Drawer>,
    );
    const input = document.querySelector('input');
    expect(input).toBeTruthy();
    expect(input?.value).toBe('我打的字');
  });

  it('Esc 关闭，并调用 onClose', () => {
    const onClose = vi.fn();
    render(
      <Drawer side="right" title="扩展区" open onClose={onClose}>
        <button type="button">tab 内容</button>
      </Drawer>,
    );
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点遮罩关闭', () => {
    const onClose = vi.fn();
    render(
      <Drawer side="right" title="扩展区" open onClose={onClose}>
        <button type="button">tab 内容</button>
      </Drawer>,
    );
    // 遮罩是 dialog 的前一个兄弟节点（aria-hidden + fixed inset-0）。
    const scrim = panel().previousElementSibling;
    expect(scrim?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(scrim as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('关闭按钮带可读的名字与 Esc 提示', () => {
    render(
      <Drawer side="left" title="会话" open onClose={() => {}}>
        <span>内容</span>
      </Drawer>,
    );
    const close = screen.getByLabelText('关闭会话');
    expect(close.getAttribute('title')).toBe('关闭会话（Esc）');
  });
});

describe('Drawer：焦点归还', () => {
  /**
   * 顶栏按钮 + 受控抽屉。open 与"opener 还在不在"都由 Host 自己的 state 持有，
   * 这样 Esc 之后子树会真的重渲染。
   *
   * opener 的卸载**必须走 state**：在测试里直接 `opener.remove()` 是把 React 正在管的
   * 节点从它脚底下抽走，下一次提交会抛 NotFoundError——而且真实场景里 opener 消失
   * 也只可能是因为重渲染，不会因为有人绕过 React 动了 DOM。
   */
  interface Harness {
    opener: HTMLButtonElement;
    dropOpener: () => void;
  }

  function openDrawer(): Harness {
    const api: { setShowOpener?: (show: boolean) => void } = {};

    function Host(): JSX.Element {
      const [open, setOpen] = useState(false);
      const [showOpener, setShowOpener] = useState(true);
      api.setShowOpener = setShowOpener;
      /**
       * onClose 用 useCallback 固定身份：这几条用例要验的是"关闭那一刻"的归还逻辑，
       * 不能混进"父组件重渲染 ⇒ effect 重跑"那条独立路径（它在下面有自己的用例）。
       */
      const close = useCallback(() => setOpen(false), []);
      return (
        <>
          {showOpener ? (
            <button type="button" onClick={() => setOpen(true)}>
              打开会话
            </button>
          ) : null}
          <Drawer side="left" title="会话" open={open} onClose={close}>
            <button type="button">抽屉里的按钮</button>
          </Drawer>
        </>
      );
    }

    render(<Host />);
    const opener = screen.getByText('打开会话') as HTMLButtonElement;
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    return {
      opener,
      dropOpener: () => {
        act(() => {
          api.setShowOpener?.(false);
        });
      },
    };
  }

  it('焦点在面板里时，关闭后还给打开它的那个按钮', () => {
    const { opener } = openDrawer();
    pressEscape();
    expect(document.activeElement).toBe(opener);
  });

  it('面板 display:none 时浏览器会把焦点甩到 body，这种情况也要归还', () => {
    const { opener } = openDrawer();
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);

    pressEscape();
    expect(document.activeElement).toBe(opener);
  });

  it('焦点已经被别处（例如另一侧刚打开的抽屉）拿走时，不能把它拽回来', () => {
    openDrawer();

    // layoutStore.toggleDrawer 是互斥的：打开另一侧会关掉本侧，两侧 effect 按树顺序跑，
    // 新打开那侧先聚焦自己的面板。此时本侧的归还逻辑必须让路，否则焦点停在遮罩外的顶栏。
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    pressEscape();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('opener 已经不在树上时不去聚焦它：游离节点上调 focus() 等于把焦点丢回 body', () => {
    const { opener, dropOpener } = openDrawer();
    (document.activeElement as HTMLElement).blur();
    dropOpener();
    expect(opener.isConnected).toBe(false);

    /**
     * 这里必须 spy 而不是只看 activeElement：按规范（jsdom 也一样）对游离节点调 focus()
     * 是 no-op，activeElement 两种实现下都停在 body——变异验证实测过，删掉
     * `!opener.isConnected` 这条守卫，只看焦点的用例照样绿。
     */
    const focus = vi.spyOn(opener, 'focus');
    pressEscape();
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it('抽屉开着时父组件重渲染不会把焦点从输入框里拽走，也不会改写 opener', () => {
    const api: { bump?: () => void } = {};

    function Host(): JSX.Element {
      const [open, setOpen] = useState(false);
      const [, setTick] = useState(0);
      api.bump = () => setTick((t) => t + 1);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            顶栏按钮
          </button>
          {/* 真实调用方就是这个形状：onClose 内联，每次渲染身份都变 ⇒ effect 每次重跑。 */}
          <Drawer side="left" title="会话" open={open} onClose={() => setOpen(false)}>
            <input aria-label="搜索会话" />
          </Drawer>
        </>
      );
    }

    render(<Host />);
    const opener = screen.getByText('顶栏按钮') as HTMLButtonElement;
    opener.focus();
    fireEvent.click(opener);
    const input = screen.getByLabelText('搜索会话');
    input.focus();

    // 会话列表刷新、栏宽变化……都会让父组件重渲染一次。
    act(() => {
      api.bump?.();
    });
    expect(document.activeElement).toBe(input);

    // opener 也不该被覆盖成"重渲染那一刻的焦点"（那样关掉抽屉会聚焦到搜索框自己身上）。
    pressEscape();
    expect(document.activeElement).toBe(opener);
  });
});
