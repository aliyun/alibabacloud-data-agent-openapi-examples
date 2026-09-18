import { beforeEach, describe, expect, it } from 'vitest';

import {
  LEFT_DEFAULT,
  LEFT_MAX,
  LEFT_MIN,
  RIGHT_DEFAULT,
  RIGHT_MIN,
  layoutStore,
} from '@/state/layout';

/**
 * 布局 store 的宽屏分支。
 *
 * 这些用例跑在 node 环境下（根 vitest 配置 `environment:'node'`），此时
 * `typeof window === 'undefined'` ⇒ `narrow` 恒为 false，正好是拖拽与钳制生效的
 * 那条路径。浏览器里验不了：内置浏览器视口固定 511px，一进去就是窄屏抽屉形态，
 * `fitTo` 直接早退、分隔条根本不渲染。
 *
 * 钉住的核心不变量是**中栏不能被挤没**：栏宽是可拖的固定值，CSS 的
 * `minmax(20rem,1fr)` 只保证"不小于 20rem 就出滚动条"，而 280+360 存进 700px
 * 的窗口时中栏只剩 60px 且不出滚动条——正文等于凭空消失。
 */

/** 把 store 拨回已知起点，避免用例之间互相污染（它是模块级单例）。 */
function reset(): void {
  layoutStore.dragWidths(LEFT_DEFAULT, RIGHT_DEFAULT);
  while (layoutStore.getSnapshot().leftCollapsed) layoutStore.toggleLeft();
  while (layoutStore.getSnapshot().rightCollapsed) layoutStore.toggleRight();
  layoutStore.closeDrawer('left');
  layoutStore.closeDrawer('right');
}

describe('dragWidths 钳制', () => {
  beforeEach(reset);

  it('拖出上下限之外会被夹回边界，而不是让栏宽变成负数或吃掉整屏', () => {
    layoutStore.dragWidths(-500, 99_999);
    const s = layoutStore.getSnapshot();
    expect(s.leftWidth).toBe(LEFT_MIN);
    expect(s.rightWidth).toBe(640);
  });

  it('正常范围内的拖动原样生效，并取整（CSS 不接受小数像素的栏宽）', () => {
    layoutStore.dragWidths(301.6, 400.2);
    const s = layoutStore.getSnapshot();
    expect(s.leftWidth).toBe(302);
    expect(s.rightWidth).toBe(400);
  });

  it('NaN / Infinity 不会渗进状态：拖拽事件在极端情况下会给出色诡异的 clientX', () => {
    layoutStore.dragWidths(Number.NaN, Number.POSITIVE_INFINITY);
    const s = layoutStore.getSnapshot();
    expect(Number.isFinite(s.leftWidth)).toBe(true);
    expect(Number.isFinite(s.rightWidth)).toBe(true);
    expect(s.leftWidth).toBeGreaterThanOrEqual(LEFT_MIN);
  });

  it('改一条不影响另一条', () => {
    layoutStore.dragWidths(LEFT_MAX, RIGHT_DEFAULT);
    expect(layoutStore.getSnapshot().rightWidth).toBe(RIGHT_DEFAULT);
  });
});

describe('fitTo：窗口变小时保住中栏', () => {
  beforeEach(reset);

  it('放得下就一动不动', () => {
    layoutStore.dragWidths(280, 360);
    layoutStore.fitTo(1400);
    const s = layoutStore.getSnapshot();
    expect(s.leftWidth).toBe(280);
    expect(s.rightWidth).toBe(360);
  });

  it('放不下时按比例压缩两条栏，且都不低于各自下限', () => {
    layoutStore.dragWidths(480, 640);
    layoutStore.fitTo(900);
    const s = layoutStore.getSnapshot();
    expect(s.leftWidth + s.rightWidth).toBeLessThanOrEqual(900 - 320 - 40);
    expect(s.leftWidth).toBeGreaterThanOrEqual(LEFT_MIN);
    expect(s.rightWidth).toBeGreaterThanOrEqual(RIGHT_MIN);
  });

  it('压缩是按比例的，不是把某一条栏一刀砍到底', () => {
    layoutStore.dragWidths(400, 400);
    layoutStore.fitTo(1060);
    const s = layoutStore.getSnapshot();
    // 两条等宽 ⇒ 压完仍应等宽（允许 1px 的取整误差）
    expect(Math.abs(s.leftWidth - s.rightWidth)).toBeLessThanOrEqual(1);
  });

  it('非法的可用宽度直接忽略：ResizeObserver 在元素还没布局时会给出 0', () => {
    layoutStore.dragWidths(480, 640);
    layoutStore.fitTo(0);
    layoutStore.fitTo(Number.NaN);
    const s = layoutStore.getSnapshot();
    expect(s.leftWidth).toBe(480);
    expect(s.rightWidth).toBe(640);
  });

  it('窄屏下不钳制：那种形态没有栅格列宽可言', () => {
    // node 环境里 narrow 恒为 false，所以这里只能验证"narrow 为假时确实会钳制"。
    // 窄屏早退那一支由浏览器实测覆盖（511px 下 fitTo 不参与，横向溢出为 0）。
    expect(layoutStore.getSnapshot().narrow).toBe(false);
    layoutStore.dragWidths(480, 640);
    layoutStore.fitTo(900);
    expect(layoutStore.getSnapshot().leftWidth).toBeLessThan(480);
  });
});

describe('折叠与抽屉是两套开关', () => {
  beforeEach(reset);

  it('折叠宽屏侧栏不会顺手打开窄屏抽屉', () => {
    layoutStore.toggleLeft();
    const s = layoutStore.getSnapshot();
    expect(s.leftCollapsed).toBe(true);
    expect(s.leftDrawer).toBe(false);
  });

  it('开抽屉不会顺手折叠宽屏侧栏', () => {
    layoutStore.toggleDrawer('right');
    const s = layoutStore.getSnapshot();
    expect(s.rightDrawer).toBe(true);
    expect(s.rightCollapsed).toBe(false);
  });

  it('打开一侧抽屉会关掉另一侧：两块面板同时开会把正文整个盖住', () => {
    layoutStore.toggleDrawer('right');
    expect(layoutStore.getSnapshot().rightDrawer).toBe(true);
    layoutStore.toggleDrawer('left');
    const s = layoutStore.getSnapshot();
    expect(s.leftDrawer).toBe(true);
    expect(s.rightDrawer).toBe(false);
  });

  it('关掉一侧不会顺手打开另一侧', () => {
    layoutStore.toggleDrawer('left');
    layoutStore.toggleDrawer('left');
    const s = layoutStore.getSnapshot();
    expect(s.leftDrawer).toBe(false);
    expect(s.rightDrawer).toBe(false);
  });

  it('closeDrawer 是幂等的：连点两次遮罩不该把状态翻回去', () => {
    layoutStore.closeDrawer('left');
    layoutStore.closeDrawer('left');
    expect(layoutStore.getSnapshot().leftDrawer).toBe(false);
  });
});
