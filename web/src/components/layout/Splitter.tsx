import { useCallback, useRef, useState } from 'react';

import { layoutStore } from '@/state/layout';

export interface SplitterProps {
  side: 'left' | 'right';
  /** 当前栏宽（px），拖拽的起点。 */
  width: number;
  min: number;
  max: number;
  /** 双击 / Home 键回到这个宽度。 */
  reset: number;
  /** 相邻栏收起时不画把手：竖条本身已经是可点的展开区，再叠一条会抢命中。 */
  active: boolean;
}

/**
 * 可拖拽的栏宽分隔条。
 *
 * 用 pointer 事件而不是 mouse 事件：一套代码同时覆盖鼠标、触屏与触控笔，
 * 且 `setPointerCapture` 能让指针滑出这条 5px 窄区之后仍然继续收到 move ——
 * 不捕获的话快速拖动时指针会跑出元素，拖拽就"断"在半路。
 *
 * 拖拽期间只更新 store、**不写 localStorage**（见 layoutStore.dragWidths），
 * 松手时 commitWidths 落一次盘。
 */
export function Splitter({ side, width, min, max, reset, active }: SplitterProps) {
  const [dragging, setDragging] = useState(false);
  const origin = useRef({ x: 0, width: 0 });

  const apply = useCallback(
    (clientX: number) => {
      const delta = clientX - origin.current.x;
      // 右栏在指针右侧，指针右移是把它变窄
      const next = side === 'left' ? origin.current.width + delta : origin.current.width - delta;
      if (side === 'left') {
        layoutStore.dragWidths(next, layoutStore.getSnapshot().rightWidth);
      } else {
        layoutStore.dragWidths(layoutStore.getSnapshot().leftWidth, next);
      }
    },
    [side],
  );

  if (!active) return <div aria-hidden className="h-full w-full" />;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`调整${side === 'left' ? '会话栏' : '扩展区'}宽度`}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title="拖动调整栏宽 · 双击恢复默认"
      className="group relative h-full w-full cursor-col-resize touch-none select-none outline-none"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        origin.current = { x: event.clientX, width };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        apply(event.clientX);
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
        layoutStore.commitWidths();
      }}
      onPointerCancel={() => {
        setDragging(false);
        layoutStore.commitWidths();
      }}
      onDoubleClick={() => {
        if (side === 'left') layoutStore.dragWidths(reset, layoutStore.getSnapshot().rightWidth);
        else layoutStore.dragWidths(layoutStore.getSnapshot().leftWidth, reset);
        layoutStore.commitWidths();
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        let next: number | undefined;
        if (event.key === 'ArrowLeft') next = width - step;
        else if (event.key === 'ArrowRight') next = width + step;
        else if (event.key === 'Home') next = reset;
        if (next === undefined) return;
        event.preventDefault();
        if (side === 'left') layoutStore.dragWidths(next, layoutStore.getSnapshot().rightWidth);
        else layoutStore.dragWidths(layoutStore.getSnapshot().leftWidth, next);
        layoutStore.commitWidths();
      }}
    >
      {/*
        命中区左右各外扩 3px（负 margin）：5px 的可视条对鼠标来说太窄，
        但栅格轨道就这么宽，只能靠子元素溢出扩命中区。
      */}
      <span
        aria-hidden
        className={[
          'absolute inset-y-0 -left-[3px] -right-[3px]',
          'flex items-center justify-center',
        ].join(' ')}
      >
        <span
          className={[
            'h-full w-px transition-colors',
            dragging ? 'bg-ring' : 'bg-border group-hover:bg-ring/60 group-focus-visible:bg-ring',
          ].join(' ')}
        />
      </span>
    </div>
  );
}
