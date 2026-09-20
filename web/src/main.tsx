import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

/**
 * 旧三栏自建 UI（react-query + state/* store 体系 + api/* 客户端）已整体下线，
 * 界面换成 @qwen-code/web-shell（standalone 会话语境）。
 *
 * 职责去向：
 *  · react-query 管的"服务端事实源"（会话列表/历史/用量）→ web-shell 内部的 daemon 客户端；
 *  · turnStore 管的"在途轮次事实源" → 服务端 daemon 兼容层的事件 journal
 *    （server-node/src/daemon/journal.ts）：202 prompt + SSE + Last-Event-ID 续传，
 *    浏览器断线不再丢轮次。
 */
const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    {/* 根边界在最外层：web-shell 自己（providers、transcript、渲染）抛了也得有兜底。 */}
    <ErrorBoundary label="整个界面" variant="root">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
