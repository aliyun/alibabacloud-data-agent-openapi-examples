import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { AlertTriangle, Code2, Maximize, Minus, Plus, Shapes } from 'lucide-react';

import { useTheme } from '@/state/theme';
import { cn } from '@/lib/utils';
import { mermaidBudget } from '@/lib/mermaidBudget';

/**
 * mermaid 图。
 *
 * 整个 `mermaid` 包是动态 import 的：它连同依赖有几百 KB，而绝大多数回答里
 * 一张流程图都没有。放在主 chunk 里等于让每个用户为一种可能不出现的内容付首屏代价。
 *
 * `securityLevel: 'strict'` 不能省：mermaid 默认允许节点标签里写 HTML，
 * 还支持 `click` 指令绑回调——图定义是 agent 产出的、不受本工程控制的内容，
 * strict 会把这两条都关掉（标签走转义、click 失效）。
 *
 * strict 挡的是**注入**，挡不住**规模**：一张几百条边的图会让 mermaid 的布局算法
 * 占住主线程几十秒，期间打字、滚动、切 tab 全都不响应，而用户看不出是图的问题。
 * 所以渲染前先过 `mermaidBudget()`（判据在 `lib/mermaidBudget.ts`，纯函数、有单测），
 * 超上限就不送去渲染，改为给出说明 + 原文。
 */

/**
 * 渲染超时的意义**有限**，这里如实交代：
 * `Promise.race` 只能让我们停止等待、给用户一个说明，**无法中断** mermaid 已经
 * 占住的主线程——那部分工作会继续跑到底。它的价值是不让界面永远停在
 * 「正在渲染图…」，以及把"卡住"这件事归因到图上，而不是让用户以为整个页面死了。
 */
const MERMAID_RENDER_TIMEOUT_MS = 10_000;

let seq = 0;

export function Mermaid({ code }: { code: string }) {
  const theme = useTheme();
  const [svg, setSvg] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [showSource, setShowSource] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  /**
   * mermaid 会把渲染结果挂到一个以这个 id 命名的临时节点上，id 必须是合法的
   * CSS 标识符——所以不能用 React 的 useId()（它产出 `:r1:`，带冒号）。
   */
  const idRef = useRef<string | undefined>(undefined);
  if (idRef.current === undefined) {
    seq += 1;
    idRef.current = `das-mermaid-${seq}`;
  }

  const budget = mermaidBudget(code);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (budget.refusal !== undefined) {
      // 送去渲染之前先拦规模：这是唯一能真正避免主线程被占住的时机。
      setSvg(undefined);
      setError(budget.refusal);
      return;
    }

    let cancelled = false;
    setSvg(undefined);
    setError(undefined);

    // 定时器是这次 effect 独有的：一张回答里可能有好几张图，共用模块级变量会互相清掉。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `渲染超过 ${MERMAID_RENDER_TIMEOUT_MS / 1000} 秒仍未完成，已停止等待。` +
              '注意：mermaid 的布局可能仍在占用主线程，这段时间界面会不响应。原文见下方。',
          ),
        );
      }, MERMAID_RENDER_TIMEOUT_MS);
    });

    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: theme === 'dark' ? 'dark' : 'default',
          fontFamily: 'inherit',
        });

        // 先 parse 再 render：parse 给出的是"第几行语法不对"，
        // render 抛出来的是包了一层的通用错误，对改图没用。
        const work = (async () => {
          await mermaid.parse(code);
          return mermaid.render(idRef.current as string, code);
        })();

        const result = await Promise.race([work, timeout]);
        if (cancelled) return;
        setSvg(result.svg);
      } catch (err) {
        if (cancelled) return;
        // mermaid 出错时可能把临时节点留在 body 里，清掉免得越积越多
        document.getElementById(`d${idRef.current as string}`)?.remove();
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [code, theme, budget.refusal]);

  const drag = useRef<{ x: number; y: number } | undefined>(undefined);
  /** 光标形态要跟着拖拽变，而在 render 里读 ref 不会触发重渲染，所以另存一个 state。 */
  const [dragging, setDragging] = useState(false);

  function onDown(event: ReactPointerEvent<HTMLDivElement>): void {
    drag.current = { x: event.clientX - pan.x, y: event.clientY - pan.y };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = drag.current;
    if (start === undefined) return;
    setPan({ x: event.clientX - start.x, y: event.clientY - start.y });
  }

  function onUp(event: ReactPointerEvent<HTMLDivElement>): void {
    drag.current = undefined;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  if (error !== undefined) {
    return (
      <div className="my-2 rounded-md border border-warning/40 bg-warning/10 text-xs">
        <p className="flex items-center gap-1.5 px-2.5 py-1.5 font-medium text-warning">
          <AlertTriangle className="size-3.5" />
          {/* 规模护栏拦下来的不是语法问题，标题不能一样：一样会让用户去改一个本来没错的图。 */}
          {budget.refusal !== undefined ? '这张图没有送去渲染' : '这段 mermaid 语法没能渲染'}
        </p>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all border-t border-warning/30 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
          {error}
        </pre>
        <details className="border-t border-warning/30 px-2.5 py-1.5">
          <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">查看原文</summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
            {code}
          </pre>
        </details>
      </div>
    );
  }

  return (
    <div className="my-2 overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-1 border-b border-border bg-muted/60 px-2 py-1">
        <Shapes className="size-3 text-muted-foreground" />
        <span className="font-mono text-[11px] text-muted-foreground">mermaid</span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconBtn label="缩小" onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}>
            <Minus className="size-3" />
          </IconBtn>
          <span className="w-9 text-center font-mono text-[11px] text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <IconBtn label="放大" onClick={() => setZoom((z) => Math.min(4, z + 0.2))}>
            <Plus className="size-3" />
          </IconBtn>
          <IconBtn
            label="重置缩放"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            <Maximize className="size-3" />
          </IconBtn>
          <IconBtn label={showSource ? '看图' : '看源码'} onClick={() => setShowSource((v) => !v)}>
            <Code2 className="size-3" />
          </IconBtn>
        </div>
      </div>

      {showSource ? (
        <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-5">{code}</pre>
      ) : svg === undefined ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">正在渲染图…</p>
      ) : (
        <div
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          className={cn(
            'max-h-[28rem] touch-none overflow-hidden bg-card p-2',
            dragging ? 'cursor-grabbing' : 'cursor-grab',
          )}
        >
          <div
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            className="origin-top-left [&_svg]:h-auto [&_svg]:max-w-none"
            // mermaid 的输出在 securityLevel:'strict' 下已对标签做转义，不含原始 HTML
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      )}
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}
