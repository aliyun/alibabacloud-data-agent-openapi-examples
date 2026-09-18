import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toastStore } from '@/state/toast';

/**
 * 瞬时提示的存取。
 *
 * 要钉住的是三件容易悄悄坏掉的事：条数上限的挤掉顺序、自动消失的定时器和
 * 手动关闭之间不能打架、以及 `getSnapshot` 的引用稳定性——最后这条是
 * `useSyncExternalStore` 的硬要求，返回新数组会让 React 认为状态一直在变，
 * 渲染直接陷入无限循环（React 会在控制台报 "The result of getSnapshot should
 * be cached"，界面则表现为卡死）。
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // 让所有还没到点的自动消失都跑完，模块级状态才不会渗到下一个用例
  vi.advanceTimersByTime(60_000);
  vi.useRealTimers();
  expect(toastStore.getSnapshot()).toEqual([]);
});

describe('toastStore', () => {
  it('push 一条就能在快照里读到，默认 tone 是 info', () => {
    toastStore.push('会话列表刷新失败');
    expect(toastStore.getSnapshot()).toHaveLength(1);
    expect(toastStore.getSnapshot()[0]).toMatchObject({ text: '会话列表刷新失败', tone: 'info' });
  });

  it('没有变化时 getSnapshot 返回同一个引用', () => {
    toastStore.push('a');
    const before = toastStore.getSnapshot();
    expect(toastStore.getSnapshot()).toBe(before);
  });

  it('push 之后引用必须变（否则 React 看不到更新）', () => {
    const before = toastStore.getSnapshot();
    toastStore.push('a');
    expect(toastStore.getSnapshot()).not.toBe(before);
  });

  it('超过 3 条时挤掉最老的那条、顺序保持插入序，剩下的到期后一并清空', () => {
    toastStore.push('1');
    toastStore.push('2');
    toastStore.push('3');
    toastStore.push('4');
    expect(toastStore.getSnapshot().map((t) => t.text)).toEqual(['2', '3', '4']);
    vi.advanceTimersByTime(6_000);
    expect(toastStore.getSnapshot()).toEqual([]);
  });

  it('到点自动消失', () => {
    toastStore.push('a');
    vi.advanceTimersByTime(5_999);
    expect(toastStore.getSnapshot()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toastStore.getSnapshot()).toHaveLength(0);
  });

  it('手动关闭立刻生效，且不影响其它条目各自的到期时间', () => {
    toastStore.push('a');
    // 取不到 id 就退化成 -1：那样 dismiss 是 no-op，下面的长度断言会红，用例照样有效
    const id = toastStore.getSnapshot()[0]?.id ?? -1;
    toastStore.dismiss(id);
    expect(toastStore.getSnapshot()).toHaveLength(0);
    toastStore.push('b');
    const before = toastStore.getSnapshot();
    vi.advanceTimersByTime(6_000);
    expect(before.map((t) => t.text)).toEqual(['b']);
    expect(toastStore.getSnapshot()).toEqual([]);
  });

  it('dismiss 一个不存在的 id 不会清空别的条目', () => {
    toastStore.push('a');
    toastStore.dismiss(999_999);
    expect(toastStore.getSnapshot().map((t) => t.text)).toEqual(['a']);
  });

  it('tone 原样带出去，渲染侧靠它决定颜色与 aria-live', () => {
    toastStore.push('后端未连接', 'destructive');
    expect(toastStore.getSnapshot()[0]?.tone).toBe('destructive');
  });

  it('每次 push 都通知订阅者一次（挤掉与新增是同一个原子变化）', () => {
    const listener = vi.fn();
    const unsubscribe = toastStore.subscribe(listener);
    toastStore.push('1');
    toastStore.push('2');
    toastStore.push('3');
    toastStore.push('4');
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    toastStore.push('5');
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
