import { useEffect, useRef, useState } from 'react';

import { STREAM_THROTTLE_MS, shouldEmitNow } from '@/lib/streamText';

/**
 * 流式正文的节流：把每帧都变的 `text` 压成最多 12.5 帧/s 的显示值。
 *
 * 判据（重复推送不上屏、内容被整体换掉时立刻上屏、其余按间隔合并）在
 * `lib/streamText.ts` 里，是纯函数、逐条钉住；这里只负责把它接到时钟上。
 *
 * 只在 `streaming` 为真时节流。收完之后必须**无条件**把完整文字交出去：
 * 尾随的那一片如果压在定时器里、而组件又在这一刻卸载，界面上就会永远少最后一句。
 */
export function useThrottledText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text);
  /** 上一次真正上屏的文字与时刻。放 ref：它们每帧都要读，但本身不驱动渲染。 */
  const shownRef = useRef(text);
  const lastEmit = useRef(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function emit(value: string): void {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    lastEmit.current = Date.now();
    shownRef.current = value;
    setShown(value);
  }

  useEffect(() => {
    if (!streaming) {
      emit(text);
      return;
    }
    const elapsed = Date.now() - lastEmit.current;
    if (shouldEmitNow(shownRef.current, text, elapsed, STREAM_THROTTLE_MS)) {
      emit(text);
      return;
    }
    // 尾随更新：保证被合并掉的那些帧里，最后一片一定落地。
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      lastEmit.current = Date.now();
      shownRef.current = text;
      setShown(text);
    }, Math.max(0, STREAM_THROTTLE_MS - elapsed));
  }, [text, streaming]);

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  return shown;
}
