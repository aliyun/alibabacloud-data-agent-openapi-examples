// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useThrottledText } from '@/hooks/useThrottledText';

/**
 * 流式节流的时钟接线。
 *
 * 判据本身（重复推送不上屏、非单调立刻上屏、按间隔合并）在 `lib/streamText.ts`
 * 里已经逐条钉住；这里要验的是**接到时钟上之后**的三件肉眼验不出来的事：
 *  · 被合并掉的那些帧里，最后一片一定会落地（尾随定时器）；
 *  · 收流那一刻完整文字**无条件**上屏——压在定时器里的那一片如果因为
 *    streaming 翻 false 就被丢掉，界面上永远少最后一句；
 *  · 合并期间显示的是旧文字而不是半截的中间态。
 *
 * 用假时钟：真等 80ms 的用例既慢又抖，而 `vi.useFakeTimers()` 连 `Date.now()`
 * 一起接管，正好是这个 hook 计时的唯一时间源。
 */

function Probe({ text, streaming }: { text: string; streaming: boolean }): JSX.Element {
  const shown = useThrottledText(text, streaming);
  return <div data-testid="out">{shown}</div>;
}

function out(view: ReturnType<typeof render>): string {
  return (view.getByTestId('out') as HTMLElement).textContent ?? '';
}

describe('useThrottledText', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('非流式：文字换了立刻上屏，不需要等任何定时器', () => {
    const view = render(<Probe text="第一段" streaming={false} />);
    expect(out(view)).toBe('第一段');
    view.rerender(<Probe text="第一段加了一句" streaming={false} />);
    expect(out(view)).toBe('第一段加了一句');
  });

  it('收流那一刻无条件上屏：尾随定时器里压着的最后一片不会被丢', () => {
    const view = render(<Probe text="" streaming />);
    view.rerender(<Probe text="abc" streaming />);
    expect(out(view)).toBe('');
    // 不推进时钟，直接翻 streaming —— 这正是"最后一帧到达"的时刻
    view.rerender(<Probe text="abcdef" streaming={false} />);
    expect(out(view)).toBe('abcdef');
  });

  it('流式中不足 80ms 的追加被合并，到点才上屏', () => {
    const view = render(<Probe text="" streaming />);
    view.rerender(<Probe text="a" streaming />);
    expect(out(view)).toBe('');
    act(() => {
      vi.advanceTimersByTime(79);
    });
    expect(out(view)).toBe('');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(out(view)).toBe('a');
  });

  it('合并期间的多帧只显示最后一片，不逐个走中间态', () => {
    const view = render(<Probe text="" streaming />);
    view.rerender(<Probe text="第一" streaming />);
    view.rerender(<Probe text="第一句" streaming />);
    view.rerender(<Probe text="第一句话" streaming />);
    expect(out(view)).toBe('');
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(out(view)).toBe('第一句话');
  });

  it('超过间隔的追加立刻上屏，不等定时器', () => {
    const view = render(<Probe text="" streaming />);
    view.rerender(<Probe text="a" streaming />);
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(out(view)).toBe('a');
    act(() => {
      vi.advanceTimersByTime(100);
    });
    view.rerender(<Probe text="ab" streaming />);
    expect(out(view)).toBe('ab');
  });

  it('内容被整体换掉（非单调）时立刻上屏，节流管不着', () => {
    const view = render(<Probe text="上一轮的长回答" streaming />);
    view.rerender(<Probe text="这一轮" streaming />);
    expect(out(view)).toBe('这一轮');
  });

  it('文字没变时显示值不动（重复推送不会造成半截态）', () => {
    const view = render(<Probe text="abc" streaming />);
    view.rerender(<Probe text="abc" streaming />);
    expect(out(view)).toBe('abc');
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(out(view)).toBe('abc');
  });
});
