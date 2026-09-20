import { useCallback, useEffect, useState } from 'react';

import { WebShellWithProviders, type WebShellTheme } from '@qwen-code/web-shell';

import { ErrorBoundary } from '@/components/ErrorBoundary';

/**
 * daemon 兼容层挂在后端 `/d` 前缀（@qwen-code/sdk 的 DaemonClient 是
 * baseUrl + path 字符串拼接，所以带路径前缀的 baseUrl 天然可用）。
 *
 *  · dev：VITE_API_BASE=http://127.0.0.1:3000（仓库根 .env）→ 直连后端，CORS 已放行；
 *  · 生产：VITE_API_BASE 为空串（构建期注入，bundle 不烘入本地地址，同旧 UI 的约定）
 *    → 同源 origin + /d，与单容器部署形态一致。
 */
function resolveApiBase(): string {
  const raw = import.meta.env.VITE_API_BASE?.trim().replace(/\/+$/, '');
  if (raw) return raw;
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

const API_BASE = resolveApiBase();
const DAEMON_BASE = `${API_BASE}/d`;

/** 深链沿用旧 UI 的 `?session=<id>` 形态：刷新、分享、前进后退都能恢复选中会话。 */
function sessionIdFromLocation(): string | undefined {
  return new URLSearchParams(window.location.search).get('session') ?? undefined;
}

/**
 * 稳定客户端 id：daemon 兼容层把它盖上 user 回显事件的 originatorClientId，
 * web-shell 的 suppressOwnUserEcho 靠它与自己的 clientId 精确匹配来抑制
 * "自己刚发的话"的回显——不传的话 LIVE 下用户消息会显示两遍（实测）。
 */
function resolveClientId(): string {
  const KEY = 'das.clientId.v1';
  try {
    const existing = window.localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    window.localStorage.setItem(KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/**
 * 主题持久化：web-shell 自带的持久化通道是 daemon settings（POST /workspaces/:id/settings），
 * 本仓的 daemon 兼容层没有这个端点（404），刷新必落回默认 dark。
 * 宿主侧接管的官方形态：受控 theme + onThemeChange 时写 localStorage。
 * 注意只用 onThemeChange（用户切换动作），不用 onThemeResolved（settings 解析通道）——
 * README 明令后者不可用于持久化，否则下次 settings 编辑会被陈旧副本遮蔽。
 */
function resolveTheme(): WebShellTheme {
  const KEY = 'das.theme.v1';
  try {
    return window.localStorage.getItem(KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * 前端主界面 = qwen-code Web Shell。
 *
 * sessionContext 用 standalone：data agent 的会话是云上资源（无 cwd/工作区概念），
 * standalone 正是 web-shell 为"产品集成、无 daemon 工作区"准备的形态。
 * 服务端由 server-node/src/daemon 把 webshell 协议翻译到 data agent OpenAPI 的 8 个接口。
 */
export default function App() {
  const [sessionId, setSessionId] = useState<string | undefined>(sessionIdFromLocation);
  const [clientId] = useState(resolveClientId);
  const [theme, setTheme] = useState<WebShellTheme>(resolveTheme);

  const handleSessionIdChange = useCallback((next: string | undefined) => {
    setSessionId(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('session', next);
    else url.searchParams.delete('session');
    window.history.replaceState(null, '', url);
  }, []);

  const handleThemeChange = useCallback((next: WebShellTheme) => {
    setTheme(next);
    try {
      window.localStorage.setItem('das.theme.v1', next);
    } catch {
      // localStorage 不可用（隐私模式等）：主题只在本次会话内生效，不持久化也能用
    }
  }, []);

  return (
    <div style={{ height: '100%' }}>
      <ErrorBoundary label="Web Shell" variant="panel" resetKeys={[sessionId]}>
        <WebShellWithProviders
          baseUrl={DAEMON_BASE}
          sessionContext={{ kind: 'standalone' }}
          sessionId={sessionId}
          clientId={clientId}
          onSessionIdChange={handleSessionIdChange}
          theme={theme}
          onThemeChange={handleThemeChange}
          language="zh-CN"
          sidebar
        />
      </ErrorBoundary>
      <MockBadge />
    </div>
  );
}

/**
 * MOCK 模式角标：回放模式下必须一眼可辨（旧顶栏徽章的职责由它接管），
 * 读的还是同一个 /api/health——MOCK 的事实源在后端配置，前端不自判。
 */
function MockBadge() {
  const [mock, setMock] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/health`)
      .then((res) => res.json() as Promise<{ result?: { mock?: boolean } }>)
      .then((body) => {
        if (alive && body.result?.mock === true) setMock(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!mock) return null;
  return (
    <div
      style={{
        position: 'fixed',
        right: 12,
        bottom: 12,
        zIndex: 60,
        padding: '2px 10px',
        borderRadius: 999,
        fontSize: 12,
        lineHeight: '20px',
        background: 'rgba(245, 158, 11, 0.14)',
        color: '#fbbf24',
        border: '1px solid rgba(245, 158, 11, 0.4)',
        pointerEvents: 'none',
      }}
    >
      MOCK · 回放录制件
    </div>
  );
}
