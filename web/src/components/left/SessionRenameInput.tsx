import { useEffect, useRef } from 'react';

export interface SessionRenameInputProps {
  /** 进入重命名时输入框里的初始文本（本地别名，没有就用上游标题）。 */
  initial: string;
  /** 本地别名的长度上限，写进 maxLength 与提示行。 */
  maxLength: number;
  /** 提示行的 id，供 aria-describedby 指向。 */
  hintId: string;
  /** Enter：把输入框当前值提交出去。 */
  onCommit: (value: string) => void;
  /** Esc 或失焦：放弃这次改名，不提交任何值。 */
  onCancel: () => void;
}

/**
 * 会话重命名输入框（本地别名，上游没有重命名接口）。
 *
 * 三条语义必须一起成立，抽成独立组件（独立文件）就是为了能在 jsdom 里逐条钉住，
 * 而不必把整个 SessionList 连同它的模块图（layout → window.matchMedia）拉进测试：
 *  · 挂载即 focus + select，双击进来就能直接改，不用先点一下；
 *  · Enter 才提交；
 *  · Esc 与失焦都**取消**。Esc 要 stopPropagation——抽屉也听 Esc，重命名时按 Esc
 *    只该退出改名，不该连抽屉一起关掉。
 *
 * 失焦取消而不是保存，是刻意的：原来失焦即保存会静默写下半截内容（打到一半去点
 * 别的会话，别名就成了"分析这个表的"），清空再点走则把别名整个抹掉，两次都没有提示。
 * Enter 才是明确的"我打完了"。
 */
export function SessionRenameInput({ initial, maxLength, hintId, onCommit, onCancel }: SessionRenameInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    el.focus();
    el.select();
  }, []);

  return (
    <li className="space-y-1">
      <input
        ref={inputRef}
        defaultValue={initial}
        maxLength={maxLength}
        aria-label={`重命名会话 ${initial}`}
        aria-describedby={hintId}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onCommit(e.currentTarget.value);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            // 挡住冒泡：抽屉也听 Esc，重命名时按 Esc 只该取消改名，不该连抽屉一起关掉。
            e.stopPropagation();
            onCancel();
          }
        }}
        onBlur={onCancel}
        className="h-8 w-full rounded-md border border-primary/50 bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <p id={hintId} className="px-0.5 text-[10px] text-muted-foreground">
        Enter 保存 · Esc 或点别处取消（本地别名，最长 {maxLength} 字）
      </p>
    </li>
  );
}
