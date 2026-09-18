// @vitest-environment jsdom
import type { SessionsResult } from '@das/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionList } from '@/components/left/SessionList';
import { SESSION_FILTER_ID } from '@/hooks/useGlobalShortcuts';

vi.hoisted(() => {
  /**
   * jsdom 不实现 `matchMedia`，而 `state/layout.ts` 在模块加载时就要读它（第 43 行）。
   * 必须用 `vi.hoisted`：它会被提到所有 import 之前执行，静态 import 才拿得到这个 stub。
   * `matches: false` = 宽屏形态，SessionList 走常驻栅格列那一支。
   */
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

/**
 * 会话列表的接线契约。
 *
 * `SessionRenameInput` 的键盘语义已经在 `a11yBatchJ` 里逐条钉住了，但那是**单个输入框**；
 * 这里钉的是它在列表里的接线：过滤计数、Esc 的归属、↑/↓ 的焦点移动、选中态语义。
 * 这四条都只在"列表 + 全局快捷键 + 抽屉"同时在场时才有意义，拆开测不到。
 *
 * 上游数据一律用假 fetch 喂（`shared/rest.ts` 的 `ApiResult` 信封），不碰网络。
 */

const CREATED_AT = Date.parse('2026-09-01T10:00:00Z');

const SESSIONS: SessionsResult = {
  sessions: [
    {
      sessionId: 's-1',
      title: '查询订单表的血缘',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      status: 'RELEASED',
      source: 'OpenApi',
      tags: [],
    },
    {
      sessionId: 's-2',
      title: '补数据失败排查',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      status: 'RELEASED',
      source: 'OpenApi',
      tags: [],
    },
    {
      sessionId: 's-3',
      title: '资产盘点',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      status: 'RELEASED',
      source: 'OpenApi',
      tags: [],
    },
  ],
  filteredOut: 0,
  total: 3,
};

beforeEach(() => {
  // 只造 client.ts 真正读到的两个字段（status / json()），不依赖 jsdom 有没有 Response。
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, result: SESSIONS }) })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderList(): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <SessionList />
    </QueryClientProvider>,
  );
  return container;
}

function rows(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-session-row]'));
}

function filterInput(): HTMLInputElement {
  const el = document.getElementById(SESSION_FILTER_ID);
  if (el === null) throw new Error('过滤框没渲染出来');
  return el as HTMLInputElement;
}

async function renderWithThreeRows(): Promise<HTMLElement> {
  const container = renderList();
  await waitFor(() => expect(rows(container)).toHaveLength(3));
  return container;
}

describe('SessionList：过滤计数', () => {
  it('有关键词时播报「匹配 N / M」，清空后撤掉', async () => {
    const container = await renderWithThreeRows();
    // 没在过滤时不该有一条常驻的 status：读屏用户会被"匹配 3 / 3"这种废话打断。
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.change(filterInput(), { target: { value: '血缘' } });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('匹配 1 / 3'));
    expect(rows(container)).toHaveLength(1);

    fireEvent.change(filterInput(), { target: { value: '' } });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(rows(container)).toHaveLength(3);
  });
});

describe('SessionList：Esc 的归属', () => {
  /**
   * 探针挂在 document 上、派发的是原生事件。
   *
   * React 18 的监听器挂在 root 容器上，合成事件里的 `stopPropagation()` 会转成
   * `nativeEvent.stopPropagation()`，所以"document 有没有收到"就是它是否生效的事实判据。
   */
  function withDocumentProbe(): { bubbled: () => boolean; dispose: () => void } {
    let bubbled = false;
    const onKey = (): void => {
      bubbled = true;
    };
    document.addEventListener('keydown', onKey);
    return {
      bubbled: () => bubbled,
      dispose: () => document.removeEventListener('keydown', onKey),
    };
  }

  function pressEscapeOnFilter(): void {
    filterInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  }

  it('有关键词时只清空过滤，不把 Esc 交给抽屉/浮层', async () => {
    await renderWithThreeRows();
    fireEvent.change(filterInput(), { target: { value: '血缘' } });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('匹配 1 / 3'));

    const probe = withDocumentProbe();
    try {
      pressEscapeOnFilter();
      expect(probe.bubbled()).toBe(false);
      await waitFor(() => expect(filterInput().value).toBe(''));
      await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    } finally {
      probe.dispose();
    }
  });

  it('关键词为空时不拦截，Esc 照常冒泡（抽屉要靠它关闭）', async () => {
    await renderWithThreeRows();
    expect(filterInput().value).toBe('');

    const probe = withDocumentProbe();
    try {
      pressEscapeOnFilter();
      expect(probe.bubbled()).toBe(true);
    } finally {
      probe.dispose();
    }
  });
});

describe('SessionList：↑/↓ 移动焦点', () => {
  it('按 DOM 顺序上下移动', async () => {
    const container = await renderWithThreeRows();
    const list = rows(container);
    const [first, second] = list as [HTMLButtonElement, HTMLButtonElement, HTMLButtonElement];

    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(second, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
  });

  it('到头/到尾不绕回：绕回会让人以为列表只有这几条', async () => {
    const container = await renderWithThreeRows();
    const list = rows(container);
    const first = list[0] as HTMLButtonElement;
    const last = list[list.length - 1] as HTMLButtonElement;

    last.focus();
    fireEvent.keyDown(last, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(last);

    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
  });
});

describe('SessionList：选中态语义', () => {
  it('选中的那一行带 aria-current="page"，其余没有', async () => {
    const container = await renderWithThreeRows();
    const list = rows(container);
    expect(list.every((row) => row.getAttribute('aria-current') === null)).toBe(true);

    fireEvent.click(list[1] as HTMLButtonElement);
    await waitFor(() =>
      expect((list[1] as HTMLButtonElement).getAttribute('aria-current')).toBe('page'),
    );
    expect((list[0] as HTMLButtonElement).getAttribute('aria-current')).toBeNull();
  });
});
