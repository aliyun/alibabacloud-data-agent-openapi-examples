import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { toastStore } from './state/toast';
import './index.css';

/**
 * react-query 只用来管"服务端事实源"：会话列表、历史、token 用量、artifact、health。
 *
 * 在途的流式轮次刻意不放进来——实测 901 帧 / 191 秒 ⇒ 平均约 4.7 帧/s、
 * 最密的 1 秒里 15 帧，immutable 缓存每帧整树替换会把 GC 打爆。那部分走
 * state/turnStore 的 mutable 聚合器 + rAF（另带 250ms 兜底定时器）节流。
 */

/**
 * queryKey 的第一个元素 → 提示里的人话名字。
 *
 * 键名在 hooks/ 下的各个 key builder 里（`['history', sessionId]` 这种形状），
 * 新增查询时这里要跟着补一条；漏了不会出错，提示里会直接显示原始键名。
 */
const QUERY_LABEL: Record<string, string> = {
  health: '后端状态',
  sessions: '会话列表',
  history: '会话历史',
  artifacts: '扩展产物',
  usage: 'token 用量',
};

const queryClient = new QueryClient({
  /**
   * 后台重取失败必须出个声。
   *
   * 查询已经有数据时，重取失败**不会**把 `isError` 翻成 true：界面上继续显示
   * 上一次的数据，ErrorBanner 不画，没有任何地方说"这份已经过期了"。
   * 对本工程尤其要命——会话历史在 RUNNING 期实测有约一半概率阻塞，
   * 30s 超时（HISTORY_READ_TIMEOUT_MS）之后就是这条静默路径。
   *
   * 反过来，首次加载失败时各个面板自己已经画了 ErrorBanner，
   * 那种情况（`data === undefined`）就不该再弹一条，否则同一件事出现两次。
   */
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (query.state.data === undefined) return;
      const head = query.queryKey[0];
      const label = typeof head === 'string' ? (QUERY_LABEL[head] ?? head) : '数据';
      const reason = error instanceof Error ? error.message : String(error);
      toastStore.push(`${label}刷新失败，界面上是上一次的数据：${reason}`, 'warning');
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      /**
       * 关掉聚焦重取。切回标签页时对每个可见会话重取，等于对可能正在 RUNNING 的
       * 会话触发 load —— 实测 load 在 RUNNING 期有约一半概率阻塞到那一轮跑完
       * （178s / 81.6s），界面会莫名卡死。
       */
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    {/* 根边界在各栏边界之外：外壳自己（栅格、ResizeObserver、主题）抛了也得有兜底。 */}
    <ErrorBoundary label="整个界面" variant="root">
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
