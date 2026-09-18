import { useSyncExternalStore } from 'react';

/**
 * 布局状态。
 *
 * 宽屏与窄屏用的是**两套互不相干的开关**，这是刻意的：
 *  · `leftCollapsed` / `rightCollapsed` —— 宽屏栅格列的折叠态，是用户偏好，持久化；
 *  · `leftDrawer` / `rightDrawer` —— 窄屏抽屉的开合，是瞬态，**不持久化**。
 * 合成一套会出两种错：宽屏展开着侧栏，缩到窄屏时抽屉直接盖住正文（用户没点过
 * 任何东西）；反过来在窄屏开着抽屉、拉宽到宽屏，抽屉态又会被当成"侧栏展开"存下去。
 *
 * `narrow` 也不持久化——它是视口的属性，不是用户偏好。
 */
export interface LayoutState {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftWidth: number;
  rightWidth: number;
  narrow: boolean;
  leftDrawer: boolean;
  rightDrawer: boolean;
}

const STORAGE_KEY = 'das.layout';

/** 窄屏断点：与 index.css 里 `lg` 的取值必须一致，否则两套判据会打架。 */
const NARROW_QUERY = '(max-width: 63.99rem)';

export const LEFT_MIN = 200;
export const LEFT_MAX = 480;
export const RIGHT_MIN = 240;
export const RIGHT_MAX = 640;
/** 默认栏宽。分隔条双击 / 按 Home 回到这个值，也是首次启动的初值。 */
export const LEFT_DEFAULT = 280;
export const RIGHT_DEFAULT = 360;
const RAIL_COL = 40;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

const media = typeof window !== 'undefined' ? window.matchMedia(NARROW_QUERY) : undefined;

function read(): LayoutState {
  const base: LayoutState = {
    leftCollapsed: false,
    rightCollapsed: false,
    leftWidth: LEFT_DEFAULT,
    rightWidth: RIGHT_DEFAULT,
    narrow: media?.matches ?? false,
    leftDrawer: false,
    rightDrawer: false,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<LayoutState>;
    return {
      ...base,
      leftCollapsed: parsed.leftCollapsed === true,
      rightCollapsed: parsed.rightCollapsed === true,
      leftWidth: clamp(parsed.leftWidth ?? base.leftWidth, LEFT_MIN, LEFT_MAX),
      rightWidth: clamp(parsed.rightWidth ?? base.rightWidth, RIGHT_MIN, RIGHT_MAX),
    };
  } catch {
    // localStorage 不可用（隐私模式）或内容损坏，退回默认，不值得为此报错
    return base;
  }
}

let state: LayoutState = read();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * 只存四个标量。`narrow` 是视口属性、抽屉是瞬态，存下来下次启动都是错的。
 * 抽成独立函数是因为 `commitWidths` 要在"值没变但仍需落盘"时也能写一次——
 * 拖拽路径刻意跳过写盘，松手时必须补上，否则刷新就丢了刚拖的宽度。
 */
function persist(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        leftCollapsed: state.leftCollapsed,
        rightCollapsed: state.rightCollapsed,
        leftWidth: state.leftWidth,
        rightWidth: state.rightWidth,
      }),
    );
  } catch {
    // 存不下就不存，布局偏好丢一次没有实质影响
  }
}

function set(patch: Partial<LayoutState>, shouldPersist: boolean): void {
  const next = { ...state, ...patch };
  if (
    next.leftCollapsed === state.leftCollapsed &&
    next.rightCollapsed === state.rightCollapsed &&
    next.leftWidth === state.leftWidth &&
    next.rightWidth === state.rightWidth &&
    next.narrow === state.narrow &&
    next.leftDrawer === state.leftDrawer &&
    next.rightDrawer === state.rightDrawer
  ) {
    return;
  }
  state = next;
  if (shouldPersist) persist();
  notify();
}

/**
 * 跨过断点时把两侧抽屉关掉。
 *
 * 不关的话：宽屏下把窗口拖窄，如果此刻抽屉是开的，它会突然盖住正文；
 * 更常见的是窄屏开着抽屉、拖宽到宽屏，抽屉态残留下来，下次再拖窄又是开着的。
 */
media?.addEventListener('change', (event) => {
  set({ narrow: event.matches, leftDrawer: false, rightDrawer: false }, false);
});

export const layoutStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): LayoutState {
    return state;
  },

  /** 宽屏：折叠/展开栅格里的侧栏（持久化的用户偏好）。 */
  toggleLeft(): void {
    set({ leftCollapsed: !state.leftCollapsed }, true);
  },
  toggleRight(): void {
    set({ rightCollapsed: !state.rightCollapsed }, true);
  },

  /**
   * 窄屏：开合抽屉（瞬态）。
   *
   * 打开一侧时**关掉另一侧**：两块面板各占 `min(86vw, 22rem)`，同时开会把正文整个盖住，
   * 还会叠两层遮罩。另一侧写 false 在"关掉"这条路上是幂等的，所以两个分支能合成一句话。
   */
  toggleDrawer(side: 'left' | 'right'): void {
    if (side === 'left') set({ leftDrawer: !state.leftDrawer, rightDrawer: false }, false);
    else set({ leftDrawer: false, rightDrawer: !state.rightDrawer }, false);
  },
  closeDrawer(side: 'left' | 'right'): void {
    set(side === 'left' ? { leftDrawer: false } : { rightDrawer: false }, false);
  },

  /**
   * 拖拽中调用，所以**不写 localStorage**：一秒能拖出几十次同步写盘。
   * 松手时由 `commitWidths` 落一次。
   */
  dragWidths(leftWidth: number, rightWidth: number): void {
    set(
      {
        leftWidth: clamp(Math.round(leftWidth), LEFT_MIN, LEFT_MAX),
        rightWidth: clamp(Math.round(rightWidth), RIGHT_MIN, RIGHT_MAX),
      },
      false,
    );
  },
  commitWidths(): void {
    persist();
  },

  /**
   * 窗口变小时把两条栏压回可用宽度内。
   *
   * 中栏必须留下 `minCenter`，否则正文会被挤没——这条下限原本只写在 CSS 的
   * `minmax(20rem,1fr)` 里，但拖拽改了栏宽之后 CSS 的下限已经拦不住
   * （280+360 存进去，窗口 700px 时中栏只剩 60px 且不出滚动条）。
   *
   * 由 ResizeObserver 驱动，所以**不写 localStorage**：拖窗口时会连续触发几十次。
   * 存下来的宽度是否超宽不影响下次显示——挂载时 ResizeObserver 会再钳一遍。
   */
  fitTo(available: number): void {
    if (state.narrow || !Number.isFinite(available) || available <= 0) return;
    const minCenter = 320;
    const both = state.leftWidth + state.rightWidth;
    const room = available - minCenter - RAIL_COL;
    if (both <= room) return;
    const scale = room / both;
    set(
      {
        leftWidth: clamp(Math.round(state.leftWidth * scale), LEFT_MIN, LEFT_MAX),
        rightWidth: clamp(Math.round(state.rightWidth * scale), RIGHT_MIN, RIGHT_MAX),
      },
      false,
    );
  },
};

export function useLayout(): LayoutState {
  return useSyncExternalStore(layoutStore.subscribe, layoutStore.getSnapshot, layoutStore.getSnapshot);
}
