import { useCallback, useEffect, useState, useContext, useRef, type ComponentProps, type ReactNode } from 'react';

import {
  DaemonWorkspaceProvider, DaemonSessionProvider, useActions, useConnection, useWorkspace, WebShell, type WebShellTheme, type ComposerToolbarAction,
} from '@qwen-code/web-shell';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { OpenApiPromptRendering } from './components/OpenApiPromptRendering';
import { installOpenApiSessionCreation, type OpenApiCreateOptions, type SessionDefaults } from './session-client';
import { clearPreferences, effectiveDefaults, readPreferences, readPreferenceState, resolveCreationOptions, savePreferences, readSelectedAgent, saveSelectedAgent } from './session-preferences';
import { sessionIdFromLocation, writeSessionRoute } from './session-route';
import { saveSessionConfiguration, saveSessionAgent, readSessionAgent } from './session-configuration';
import { SessionSettingsContext, SessionSettingsButton, SessionSettingsDialog, SessionCreateError } from './session-settings';
import { apiHttpError } from './api-error';
import { resolveClientId } from './client-id';
import dataAgentLogo from './assets/data-agent-logo.png';

const BRAND = {
  name: 'Data Agent',
  logo: <img src={dataAgentLogo} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />,
};

const SIDEBAR = {
  branding: {
    render: () => (
      <div className="host-brand" aria-label="Data Agent powered by DataWorks">
        <div className="host-brand-row">
          <img className="host-brand-logo" src={dataAgentLogo} alt="" />
          <div className="host-brand-text">
            <div className="host-brand-name">Data Agent</div>
            <div className="host-brand-credit">Powered by DataWorks</div>
          </div>
        </div>
      </div>
    ),
  },
};



/**
 * daemon 兼容层挂在后端 `/d` 前缀（@qwen-code/sdk 的 DaemonClient 是
 * baseUrl + path 字符串拼接，所以带路径前缀的 baseUrl 天然可用）。
 *
 *  · dev：VITE_API_BASE=http://127.0.0.1:3000（仓库根 .env）→ 直连后端，CORS 已放行；
 *  · --lan：VITE_API_BASE 为空，走网页同源 /api 与 /d 代理；
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
 * 服务端由 server-node/src/daemon 把 web-shell 协议适配为 DataAgent OpenAPI 调用。
 */
export default function App() {
  const [sessionId, setSessionId] = useState<string | undefined>(sessionIdFromLocation);
  const [clientId] = useState(resolveClientId);
  const [theme, setTheme] = useState<WebShellTheme>(resolveTheme);

  const handleSessionIdChange = useCallback((next: string | undefined) => {
    setSessionId(next);
    writeSessionRoute(next);
  }, []);

  useEffect(() => {
    writeSessionRoute(sessionIdFromLocation(), true);
    const onPopState = () => setSessionId(sessionIdFromLocation());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
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
        <DaemonWorkspaceProvider baseUrl={DAEMON_BASE}>
          <OpenApiSessionCreation theme={theme}>
            <DaemonSessionProvider
              sessionContext={{ kind: 'standalone' }}
              sessionId={sessionId}
              clientId={clientId}
              suppressOwnUserEcho={false}
            >
              <OpenApiPromptRendering>
                <OpenApiToolbarDefaults>
                  <SessionWebShell
                    onSessionIdChange={handleSessionIdChange}
                    theme={theme}
                    onThemeChange={handleThemeChange}
                    language="zh-CN"
                    brand={BRAND}
                    sidebar={{ ...SIDEBAR, footer: { items: ['theme', 'version', 'sessionsOverview', 'workspacesOverview', 'splitView', 'daemonStatus', 'localFiles', 'collapse'],
                      render: () => <SessionSettingsButton /> } }}
                    renderComposerHeader={SessionCreateError}
                    cycleModeOnTab={false}
                  />
                </OpenApiToolbarDefaults>
              </OpenApiPromptRendering>
            </DaemonSessionProvider>
          </OpenApiSessionCreation>
        </DaemonWorkspaceProvider>
      </ErrorBoundary>
      <MockBadge />
    </div>
  );
}

// Existing sessions cannot change model or mode through POP yet.
const SESSION_TOOLBAR_ACTIONS: readonly ComposerToolbarAction[] = [
  'commands', 'contextUsage', 'gitBranch', 'widthMode', 'voice', 'workspace',
];

function SessionWebShell(props: ComponentProps<typeof WebShell>) {
  const settings = useContext(SessionSettingsContext);
  const { sessionId } = useConnection();
  const [sidebarEnabled, setSidebarEnabled] = useState(true);
  const sidebarAgent = useRef(settings?.configured?.agentName);
  useEffect(() => {
    const agent = settings?.configured?.agentName;
    if (settings?.open || !agent || sidebarAgent.current === agent) return;
    const previous = sidebarAgent.current;
    sidebarAgent.current = agent;
    // The public sidebar prop remounts only its directory, clearing old Agent
    // pages/cursors. Session provider and composer (including draft) stay mounted.
    if (previous) setSidebarEnabled(false);
  }, [settings?.configured?.agentName, settings?.open]);
  useEffect(() => {
    if (sidebarEnabled) return;
    const timer = setTimeout(() => setSidebarEnabled(true), 0);
    return () => clearTimeout(timer);
  }, [sidebarEnabled]);
  const actions: readonly ComposerToolbarAction[] = sessionId ? SESSION_TOOLBAR_ACTIONS
    : ['model', ...(settings?.configured?.approvalMode === 'plan' ? [] : ['approvalMode'] as const), ...SESSION_TOOLBAR_ACTIONS];
  return <WebShell {...props} sidebar={{ ...(typeof props.sidebar === 'object' ? props.sidebar : {}), enabled: props.sidebar !== false && sidebarEnabled }} composerToolbarActions={actions} onSlashCommand={command => {
    if (['settings', 'model', 'approval-mode', 'plan'].includes(command.command)) {
      settings?.setOpen(true);
      return true;
    }
  }} />;
}

/** Keep native standalone create overrides; Plan remains an atomic POP option. */
export function OpenApiToolbarDefaults({ children }: { children: ReactNode }) {
  const actions = useActions();
  const { sessionId } = useConnection();
  const settings = useContext(SessionSettingsContext);
  const signature = JSON.stringify(settings?.configured);
  const applied = useRef(signature);
  const creating = useRef(0);
  const [pendingCreates, setPendingCreates] = useState(0);
  useEffect(() => {
    if (settings?.open || applied.current === signature || creating.current > 0) return;
    const previous = applied.current;
    applied.current = signature;
    // Public clearSession refreshes the standalone options without remounting
    // WebShell (and losing the draft). Never reload an attached session.
    if (previous && previous !== 'undefined' && !sessionId) {
      void actions.clearSession().catch(error => console.warn('无法刷新新会话选项', error));
    }
  }, [actions, settings?.open, signature, sessionId, pendingCreates]);
  useEffect(() => {
    const original = actions.createSession;
    const create: typeof original = async options => {
      const context = { ...options };
      // Native Plan is post-create setApprovalMode; our settings send Plan in
      // CreateAgentSession itself. The neutral advertised mode is not a choice.
      if (settings?.configured?.approvalMode === 'plan') delete context.approvalMode;
      creating.current += 1;
      setPendingCreates(creating.current);
      try {
        return await original.call(actions, context);
      } finally { creating.current -= 1; setPendingCreates(creating.current); }
    };
    actions.createSession = create;
    return () => { if (actions.createSession === create) actions.createSession = original; };
  }, [actions, settings]);
  return children;
}

/** Install before mounting the session provider, including StrictMode remounts. */
export function OpenApiSessionCreation({ children, theme = 'dark' }: { children: ReactNode; theme?: WebShellTheme }) {
  const { client, baseUrl } = useWorkspace();
  const [readyClient, setReadyClient] = useState<typeof client>();
  const [defaults, setDefaults] = useState<SessionDefaults>();
  const [configError, setConfigError] = useState<string>();
  const [createError, setCreateError] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let mounted = true;
    const readDefaults = async () => {
      const response = await fetch(`${baseUrl}/openapi/session-options`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw apiHttpError(response.status, await response.json().catch(() => undefined), '无法读取会话配置，请确认后端版本');
      const remote = await response.json() as SessionDefaults;
      const options = { ...remote, agentName: readSelectedAgent(baseUrl) };
      if (!options || typeof options.agentName !== 'string' || !Array.isArray(options.models)) throw new Error('无效的会话默认配置');
      if (mounted) { setDefaults(options); setConfigError(undefined); }
      return options;
    };
    void readDefaults().catch((error: Error) => { if (mounted) setConfigError(error.message); });
    const restore = installOpenApiSessionCreation(client, baseUrl, async initial => {
      const agentName = readSelectedAgent(baseUrl);
      const preferences = readPreferences(baseUrl, agentName);
      const options = await readDefaults();
      return { ...resolveCreationOptions(options, preferences, initial), agentName };
    }, {
      onDiscovered: (sid, agent) => saveSessionAgent(baseUrl, sid, agent),
      agentName: sid => sid ? readSessionAgent(baseUrl, sid) ?? readSelectedAgent(baseUrl) : readSelectedAgent(baseUrl),
      defaults: async () => {
        const defaults = await readDefaults();
        const saved = effectiveDefaults(defaults, readPreferences(baseUrl, defaults.agentName));
        // Native Plan uses a post-create mutation. Advertise a neutral mode
        // only for Plan; the action adapter retains the atomic POP setting.
        return saved.approvalMode === 'plan' ? { ...saved, approvalMode: 'default' } : saved;
      },
      onCreateError: error => { if (mounted) setCreateError(error.message); },
      onCreated: (options, session) => {
        if (mounted) setCreateError(undefined);
        if (options.agentName) {
          saveSessionConfiguration(baseUrl, options.agentName, session.sessionId, options);
          saveSessionAgent(baseUrl, session.sessionId, options.agentName);
        }
        if (mounted) setRevision(value => value + 1);
      },
      // A successful create is not a user preference change. In particular it
      // must not turn inherited environment values into persistent overrides.
    });
    setReadyClient(client);
    return () => { mounted = false; restore(); };
  }, [client, baseUrl]);
  const preferences = defaults ? readPreferenceState(baseUrl, defaults.agentName) : undefined;
  const configured = defaults ? effectiveDefaults(defaults, preferences!.options) : undefined;
  const update = (options: OpenApiCreateOptions) => {
    if (!defaults) return;
    savePreferences(baseUrl, defaults.agentName, { ...readPreferences(baseUrl, defaults.agentName), ...options });
    setDefaults({ ...defaults });
  };
  return <SessionSettingsContext.Provider value={{ baseUrl, defaults, configured, preferences, configError, createError, clearCreateError: () => setCreateError(undefined),
    open: settingsOpen, setOpen: setSettingsOpen, update, revision, theme,
    selectAgent: name => {
      saveSelectedAgent(baseUrl, name);
      if (defaults) setDefaults({ ...defaults, agentName: name.trim() });
    },
    reset: () => { if (defaults) { clearPreferences(baseUrl, defaults.agentName); saveSelectedAgent(baseUrl, 'dataworks_data_agent'); setDefaults({ ...defaults, agentName: 'dataworks_data_agent' }); } } }}>
    <div className="openapi-shell" onKeyDownCapture={event => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault(); event.stopPropagation(); setSettingsOpen(true);
      }
    }}>{readyClient === client ? children : null}</div>
    <SessionSettingsDialog />
  </SessionSettingsContext.Provider>;
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
