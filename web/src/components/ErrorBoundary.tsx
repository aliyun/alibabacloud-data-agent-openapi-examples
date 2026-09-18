import { Component, type ErrorInfo, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface ErrorBoundaryProps {
  /** 出现在兜底文案里的位置名，例如「会话列表」「对话区」「这一轮」。 */
  label: string;
  /**
   * 三档兜底，按"崩了之后还剩多少可用界面"分：
   *  · `root` —— 整棵树没了，只能刷新；
   *  · `panel` —— 一栏没了，其余两栏照常，可以就地重试；
   *  · `inline` —— 一栏里的**一条内容**没了（某一轮的 Markdown / 图 / 表格），
   *    同一栏的其他轮次必须继续可读。没有这一档，上游一段畸形内容就能把整个
   *    对话区换成一块报错，用户连"是哪一轮出的问题"都看不到。
   */
  variant?: 'root' | 'panel' | 'inline';
  /**
   * 这些值里任何一个变了（逐项 Object.is）就自动清空错误、重新渲染子树。
   *
   * 给对话区挂上选中的会话 id：崩在 A 会话的内容上之后，用户从（还活着的）左栏
   * 点 B 会话，就该给对话区一次重新渲染的机会，而不是让他对着兜底文案按刷新。
   * 逐条内容那一档挂 rid：流式期间同一条会被反复更新，更新本身就该给一次自愈机会。
   */
  resetKeys?: readonly unknown[];
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | undefined;
}

/**
 * 渲染期异常的兜底。
 *
 * 为什么必须有：这个界面的渲染输入是**上游给的任意内容**——Markdown、工具结果、
 * 帧里的未知字段。reducer 那一层已经做到"未知帧型不崩、只记录"，但渲染层还有
 * 一大堆没被测试覆盖的分支；一旦某个分支抛了，React 18 的默认行为是把**整棵树**
 * 卸载成白屏，连"哪一栏崩了"都看不到，而在途的那一轮还在后台收着流。
 *
 * 在途的流不受影响：turnStore 是模块级单例，不挂在 React 树上。所以点「重试渲染」
 * 之后，如果那一轮还在收，聚合好的内容会接着出现在界面上。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 必须留一条控制台记录：inline 那一档只显示 message，组件栈只有这里有。
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info.componentStack);
  }

  override componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error === undefined) return;
    if (sameKeys(prev.resetKeys, this.props.resetKeys)) return;
    this.setState({ error: undefined });
  }

  override render(): ReactNode {
    const error = this.state.error;
    if (error === undefined) return this.props.children;

    if (this.props.variant === 'inline') return this.renderInline(error);
    return this.renderBlock(error);
  }

  /** 一条内容崩了：占一行，说清是哪一条、报了什么，并给一次重试。不摊调用栈。 */
  private renderInline(error: Error): ReactNode {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1.5 text-[11px] leading-relaxed"
      >
        <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
        <span className="min-w-0 break-words">
          「{this.props.label}」没能渲染出来：{error.message}
        </span>
        <button
          type="button"
          onClick={() => this.setState({ error: undefined })}
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-muted-foreground underline-offset-2 transition-colors hover:bg-accent hover:text-foreground"
        >
          重试
        </button>
      </div>
    );
  }

  /** 一栏或整棵树崩了：给足上下文，原始报错与调用栈收进折叠区（默认收起）。 */
  private renderBlock(error: Error): ReactNode {
    const root = this.props.variant === 'root';
    return (
      <div
        role="alert"
        className={
          root
            ? 'flex h-full flex-col items-center justify-center gap-3 bg-background p-6 text-center'
            : 'm-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs'
        }
      >
        <TriangleAlert className={root ? 'size-6 text-destructive' : 'size-4 text-destructive'} />
        <p className={root ? 'text-sm font-semibold' : 'font-semibold'}>
          {root ? '界面渲染崩了' : `「${this.props.label}」渲染崩了`}
        </p>
        <p className={root ? 'max-w-md text-xs leading-relaxed text-muted-foreground' : 'mt-1 leading-relaxed text-muted-foreground'}>
          {root
            ? '在途的那一轮仍在后台接收（收流不挂在界面上），刷新页面会丢掉它——先看下面的报错内容，再决定要不要刷新。'
            : '其余部分仍然可用。在途的那一轮也仍在后台接收，重试渲染之后能接着看到它。'}
        </p>
        <p className={root ? 'max-w-md break-words font-mono text-[11px] text-foreground' : 'mt-1 break-words font-mono text-[11px] text-foreground'}>
          {error.message}
        </p>
        {/**
          * 调用栈收进折叠区而不是直接摊开。
          *
          * 它是排查凭据、必须拿得到（这个工程的价值主张就是把上游的真实报错交给用户），
          * 但一崩就铺半屏英文堆栈，看起来像半成品，而且会把上面那句"其余部分仍然可用"
          * 挤出视野。默认收起、摘要写清里面是什么，两边都不亏。
          */}
        <details className={root ? 'w-full max-w-md text-left' : 'mt-1 w-full'}>
          <summary className="cursor-pointer text-[11px] text-muted-foreground transition-colors hover:text-foreground">
            调用栈（排查用）
          </summary>
          <pre className="mt-1 max-h-40 w-full overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px] text-foreground">
            {error.stack ?? '（这个环境没有给出调用栈）'}
          </pre>
        </details>
        {!root && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => this.setState({ error: undefined })}>
            重试渲染
          </Button>
        )}
        {root && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => window.location.reload()}>
            刷新页面
          </Button>
        )}
      </div>
    );
  }
}

/** 逐项 Object.is 比对。长度不同也算变了——少一个 key 意味着调用方换了形状。 */
function sameKeys(prev: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean {
  if (prev === undefined || next === undefined) return prev === next;
  if (prev.length !== next.length) return false;
  return prev.every((value, i) => Object.is(value, next[i]));
}
