import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  label: string;
  variant?: 'root' | 'panel';
  resetKeys?: readonly unknown[];
  children: ReactNode;
}

/** Host fallback for web-shell rendering failures; it never resubmits prompts. */
export class ErrorBoundary extends Component<Props, { error: Error | undefined }> {
  override state: { error: Error | undefined } = { error: undefined };
  static getDerivedStateFromError(error: Error) { return { error }; }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info.componentStack);
  }

  override componentDidUpdate(previous: Props) {
    const before = previous.resetKeys ?? [];
    const after = this.props.resetKeys ?? [];
    if (this.state.error && (before.length !== after.length || before.some((v, i) => !Object.is(v, after[i])))) {
      this.setState({ error: undefined });
    }
  }

  override render() {
    if (!this.state.error) return this.props.children;
    const root = this.props.variant === 'root';
    return (
      <div role="alert" className="host-error">
        <p>「{this.props.label}」暂时无法显示</p>
        <p>任务可能仍在后端执行。恢复界面后先检查会话历史，不要重复发送任务。</p>
        <p>{this.state.error.message}</p>
        <details><summary>错误详情</summary><pre>{this.state.error.stack}</pre></details>
        <button type="button" onClick={() => root ? window.location.reload() : this.setState({ error: undefined })}>
          {root ? '刷新页面' : '重试渲染'}
        </button>
      </div>
    );
  }
}
