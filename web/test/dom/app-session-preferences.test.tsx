// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient, DaemonSessionClient, createDaemonTranscriptStore, type DaemonTranscriptStore } from '@qwen-code/sdk/daemon';
import type { SessionDefaults } from '../../src/session-client';

const harness = vi.hoisted(() => ({
  workspace: {} as { client: DaemonClient; baseUrl: string },
  actions: { clearSession: vi.fn(async () => {}), createSession: vi.fn(), sendPrompt: vi.fn(), submitPrompt: vi.fn() },
  shell: vi.fn(),
  store: null as DaemonTranscriptStore | null,
  connection: {} as { sessionId?: string },
}));
vi.mock('@qwen-code/web-shell', () => ({
  useWorkspace: () => harness.workspace,
  useActions: () => harness.actions,
  useConnection: () => harness.connection,
  useTranscriptStore: () => harness.store,
  DaemonWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
  DaemonSessionProvider: ({ children }: { children: ReactNode }) => children,
  WebShell: (props: { sidebar?: { footer?: { render?: () => ReactNode } }; renderComposerToolbarStart?: () => ReactNode }) => {
    harness.shell(props); return <><div>Shell</div>{props.sidebar?.footer?.render?.()}{props.renderComposerToolbarStart?.()}</>;
  },
}));
import App, { OpenApiSessionCreation, OpenApiToolbarDefaults } from '../../src/App';
import { clearPreferences, readPreferences, savePreferences, saveSelectedAgent, readSelectedAgent } from '../../src/session-preferences';
import { SessionSettingsButton, SessionConfiguration, CurrentSessionConfiguration, SessionCreateError } from '../../src/session-settings';
import { readSessionConfiguration, clearSessionConfigurations, saveSessionConfiguration } from '../../src/session-configuration';

const base = 'http://preferences.test/d';
let environment: SessionDefaults;
let creates: Record<string, unknown>[];
const session = { sessionId: 'server-id', clientId: 'c', workspaceCwd: '/data-agent', attached: false,
  sourceType: 'standalone', context: { kind: 'standalone' }, projectlessOutputDirectory: '/out/server-id', workingDirectory: { state: 'ready' } };

beforeEach(() => {
  harness.store = createDaemonTranscriptStore();
  harness.connection = {};
  environment = { agentName: 'a', model: 'env-model', approvalMode: 'plan', reasoningEffort: 'high', models: ['env-model'] };
  creates = [];
  saveSelectedAgent(base, 'a');
  harness.workspace = { client: new DaemonClient({ baseUrl: base, fetch: (input, init) => globalThis.fetch(input, init) }), baseUrl: base };
  harness.actions.createSession = vi.fn(options => DaemonSessionClient.createStandalone(harness.workspace.client, options).then(client => client.session));
  harness.shell.mockClear();
  harness.actions.clearSession.mockClear();
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/capabilities')) return Response.json({ v: 1, mode: 'standalone',
      features: ['standalone_sessions_v1', 'standalone_session_options_v1'], modelServices: ['data-agent'], workspaces: [], policy: {} });
    if (url.endsWith('/openapi/session-options')) return Response.json(environment);
    if (url.endsWith('/standalone/session-options')) return Response.json({ v: 1, initialized: true, approvalMode: environment.approvalMode,
      providers: [{ kind: 'model_provider', status: 'ok', authType: 'none', current: true,
        models: [{ modelId: 'env-model', baseModelId: 'env-model', name: 'Environment', isCurrent: true, isRuntime: false }] }], errors: [] });
    if (url.endsWith('/standalone/sessions')) { creates.push(JSON.parse(init!.body as string)); return Response.json(session); }
    if (url.endsWith('/api/health')) return Response.json({ result: { mock: false } });
    throw new Error(`Unexpected test request ${url}`);
  }));
});
afterEach(() => {
  cleanup();
  harness.workspace.client.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearPreferences(base, 'a');
  clearSessionConfigurations(base, 'a');
  localStorage.clear();
  saveSelectedAgent(base, 'dataworks_data_agent');
});

async function mount() {
  render(<StrictMode><OpenApiSessionCreation><OpenApiToolbarDefaults><SessionSettingsButton /><SessionCreateError /><SessionConfiguration sessionId="server-id" /><div>Ready</div></OpenApiToolbarDefaults></OpenApiSessionCreation></StrictMode>);
  await screen.findByText('Ready');
  fireEvent.click(screen.getByRole('button', { name: '会话设置' }));
  await screen.findByLabelText('新会话模型');
}

describe('App new-session settings', () => {
  it('preserves native model and mode selections with settings reasoning at creation', async () => {
    await mount();
    await act(() => harness.workspace.client.getStandaloneSessionOptions());
    fireEvent.change(screen.getByLabelText('新会话模型'), { target: { value: 'settings-model' } });
    fireEvent.change(screen.getByLabelText('新会话审批模式'), { target: { value: 'auto' } });
    fireEvent.change(screen.getByLabelText('新会话思考深度'), { target: { value: 'none' } });
    await act(() => harness.actions.createSession({ sessionContext: { kind: 'standalone' }, modelServiceId: 'native-model', approvalMode: 'yolo' }));
    expect(creates).toEqual([{ agentName: 'a', modelServiceId: 'native-model', approvalMode: 'yolo', reasoningEffort: 'none' }]);
    expect(readPreferences(base, 'a')).toEqual({ modelServiceId: 'settings-model', approvalMode: 'auto', reasoningEffort: 'none' });
  });

  it('preserves all explicit SDK arguments even when equal to advertised defaults', async () => {
    await mount();
    await act(() => harness.workspace.client.getStandaloneSessionOptions());
    fireEvent.change(screen.getByLabelText('新会话模型'), { target: { value: 'cached-model' } });
    fireEvent.change(screen.getByLabelText('新会话审批模式'), { target: { value: 'yolo' } });
    await act(() => harness.workspace.client.createStandaloneSession({ modelServiceId: 'env-model', approvalMode: 'default', reasoningEffort: 'none' } as never));
    expect(creates).toEqual([{ agentName: 'a', modelServiceId: 'env-model', approvalMode: 'default', reasoningEffort: 'none' }]);
    expect(readPreferences(base, 'a')).toEqual({ modelServiceId: 'cached-model', approvalMode: 'yolo' });
  });

  it('keeps native Plan disabled while applying Plan through creation only', async () => {
    await mount();
    let advertisedMode: string | undefined;
    await act(async () => { advertisedMode = (await harness.workspace.client.getStandaloneSessionOptions()).approvalMode; });
    expect(advertisedMode).toBe('default');
    await act(() => harness.actions.createSession({ modelServiceId: 'env-model', approvalMode: advertisedMode }));
    expect(creates).toEqual([{ agentName: 'a', modelServiceId: 'env-model', approvalMode: 'plan', reasoningEffort: 'high' }]);
    expect(readPreferences(base, 'a')).toEqual({});
  });

  it('restore and successful creates continue inheriting changing ENV without repopulating the cache', async () => {
    savePreferences(base, 'a', { modelServiceId: 'cached', approvalMode: 'yolo', reasoningEffort: 'none' });
    await mount();
    fireEvent.click(screen.getByRole('button', { name: '恢复环境默认值' }));
    expect((screen.getByLabelText('新会话模型') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('新会话审批模式') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('新会话思考深度') as HTMLSelectElement).value).toBe('');
    environment = { ...environment, model: 'new-env', approvalMode: 'auto', reasoningEffort: 'low' };
    await act(() => harness.actions.createSession());
    expect(creates[0]).toEqual({ agentName: 'dataworks_data_agent', modelServiceId: 'new-env', approvalMode: 'auto', reasoningEffort: 'low' });
    expect(readPreferences(base, 'a')).toEqual({});
    environment = { ...environment, model: 'next-env', approvalMode: 'default', reasoningEffort: 'medium' };
    await act(() => harness.actions.createSession());
    expect(creates[1]).toEqual({ agentName: 'dataworks_data_agent', modelServiceId: 'next-env', approvalMode: 'default', reasoningEffort: 'medium' });
    expect(readPreferences(base, 'a')).toEqual({});
  });

  it('clearing individual fields removes only those user overrides', async () => {
    savePreferences(base, 'a', { modelServiceId: 'cached', approvalMode: 'yolo', reasoningEffort: 'none' });
    await mount();
    fireEvent.change(screen.getByLabelText('新会话模型'), { target: { value: '' } });
    expect((screen.getByLabelText('新会话模型') as HTMLInputElement).value).toBe('');
    expect(readPreferences(base, 'a')).toEqual({ approvalMode: 'yolo', reasoningEffort: 'none' });
    fireEvent.change(screen.getByLabelText('新会话审批模式'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('新会话思考深度'), { target: { value: '' } });
    await act(() => harness.actions.createSession());
    expect(creates[0]).toEqual({ agentName: 'a', modelServiceId: 'env-model', approvalMode: 'plan', reasoningEffort: 'high' });
    expect(readPreferences(base, 'a')).toEqual({});
  });

  it('keeps selections usable in memory and accurately reports unavailable storage', async () => {
    await mount();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled'); });
    fireEvent.change(screen.getByLabelText('新会话模型'), { target: { value: 'memory-choice' } });
    expect((screen.getByLabelText('新会话模型') as HTMLInputElement).value).toBe('memory-choice');
    expect(screen.getByText(/浏览器存储不可用，设置仅在当前页面保留/)).toBeTruthy();
    await act(() => harness.actions.createSession());
    expect(creates[0]).toMatchObject({ modelServiceId: 'memory-choice' });
  });

  it('uses native welcome model and approval controls without a custom toolbar row', async () => {
    const view = render(<App />);
    await waitFor(() => expect(harness.shell).toHaveBeenCalled());
    const props = harness.shell.mock.calls.at(-1)![0] as { composerToolbarActions: string[]; cycleModeOnTab: boolean };
    expect(props.composerToolbarActions).toContain('model');
    // Plan is handled only in settings, never with a native post-create mutation.
    expect(props.composerToolbarActions).not.toContain('approvalMode');
    expect(props.composerToolbarActions).not.toContain('plan');
    expect(props.cycleModeOnTab).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(view.container.querySelector('details')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '会话设置' }));
    await screen.findByRole('dialog', { name: '会话设置' });
    expect(screen.getByLabelText('新会话模型')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('records final options only after successful creation and keeps old session display when defaults change', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText('新会话模型'), { target: { value: 'created-model' } });
    fireEvent.change(screen.getByLabelText('新会话审批模式'), { target: { value: 'yolo' } });
    fireEvent.change(screen.getByLabelText('新会话思考深度'), { target: { value: 'none' } });
    await act(() => harness.actions.createSession());
    expect(readSessionConfiguration(base, 'a', 'server-id')).toEqual({ agentName: 'a', modelServiceId: 'created-model', approvalMode: 'yolo', reasoningEffort: 'none' });
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(screen.getByLabelText('当前会话配置').textContent).toContain('created-model');
    expect(screen.getByLabelText('当前会话配置').textContent).toContain('关闭');
    fireEvent.click(screen.getByRole('button', { name: '会话设置' }));
    fireEvent.change(screen.getByLabelText('新会话模型'), { target: { value: 'future-model' } });
    fireEvent.change(screen.getByLabelText('新会话思考深度'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(screen.getByLabelText('当前会话配置').textContent).toContain('created-model');
    expect(screen.getByLabelText('当前会话配置').textContent).not.toContain('future-model');
  });

  it('never represents environment or default preferences as the unknown historic session configuration', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    const status = screen.getByLabelText('当前会话配置');
    expect(status.textContent).toContain('会话配置未记录');
    expect(status.textContent).not.toContain('env-model');
  });

  it('failed creation does not save a session configuration', async () => {
    await mount();
    const previous = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input, init) => String(input).endsWith('/standalone/sessions')
      ? Promise.resolve(Response.json({ error: 'denied' }, { status: 403 })) : previous(input, init)));
    await act(async () => { await expect(harness.actions.createSession()).rejects.toThrow(); });
    expect(readSessionConfiguration(base, 'a', 'server-id')).toBeUndefined();
    expect(screen.getByRole('alert').textContent).toContain('denied');
  });

  it('uses the pane connection SID for split-view configuration, never another pane or defaults', async () => {
    saveSessionConfiguration(base, 'a', 'pane-a', { modelServiceId: 'model-a', approvalMode: 'yolo' });
    saveSessionConfiguration(base, 'a', 'pane-b', { modelServiceId: 'model-b', approvalMode: 'plan' });
    harness.connection = { sessionId: 'pane-a' };
    const tree = () => <OpenApiSessionCreation><CurrentSessionConfiguration /></OpenApiSessionCreation>;
    const view = render(tree());
    await waitFor(() => expect(screen.getByLabelText('当前会话配置').textContent).toContain('model-a'));
    harness.connection = { sessionId: 'pane-b' }; view.rerender(tree());
    expect(screen.getByLabelText('当前会话配置').textContent).toContain('model-b');
    expect(screen.getByLabelText('当前会话配置').textContent).not.toContain('model-a');
    harness.connection = { sessionId: 'unknown' }; view.rerender(tree());
    expect(screen.getByLabelText('当前会话配置').textContent).toContain('未记录');
    expect(screen.getByLabelText('当前会话配置').textContent).not.toContain('env-model');
  });

  it('opens host settings through public slash interception without dispatching a prompt', async () => {
    render(<App />);
    await waitFor(() => expect(harness.shell).toHaveBeenCalled());
    const props = harness.shell.mock.calls.at(-1)![0] as unknown as {
      onSlashCommand: (command: { command: string; input: string; args: string }) => boolean | void;
    };
    await act(() => expect(props.onSlashCommand({ command: 'settings', input: '/settings', args: '' })).toBe(true));
    expect(await screen.findByRole('dialog', { name: '会话设置' })).toBeTruthy();
    expect(creates).toHaveLength(0);
  });

  it('Ctrl/Command comma opens settings and Escape closes without changing defaults', async () => {
    const view = render(<App />);
    await waitFor(() => expect(harness.shell).toHaveBeenCalled());
    fireEvent.keyDown(view.container.querySelector('.openapi-shell')!, { key: ',', ctrlKey: true });
    const dialog = await screen.findByRole('dialog', { name: '会话设置' });
    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(readPreferences(base, 'a')).toEqual({});
    expect(creates).toHaveLength(0);
  });

  it('keeps upstream Data Agent branding together with the host session settings entry', async () => {
    render(<App />);
    await waitFor(() => expect(harness.shell).toHaveBeenCalled());
    const props = harness.shell.mock.calls.at(-1)![0] as unknown as {
      brand: { name: string; logo: ReactNode }; sidebar: { branding: { render: () => ReactNode }; footer: { render: () => ReactNode } };
    };
    expect(props.brand.name).toBe('Data Agent');
    expect(props.brand.logo).toBeTruthy();
    const logo = render(<>{props.sidebar.branding.render()}</>);
    expect(logo.getByLabelText('Data Agent powered by DataWorks')).toBeTruthy();
    expect(logo.getByText('Powered by DataWorks')).toBeTruthy();
    expect(screen.getByRole('button', { name: '会话设置' })).toBeTruthy();
  });

  it('advertises saved defaults and shows native approval for execution modes', async () => {
    savePreferences(base, 'a', { modelServiceId: 'cached-model', approvalMode: 'yolo', reasoningEffort: 'none' });
    render(<App />);
    await waitFor(() => expect(harness.shell).toHaveBeenCalled());
    const props = harness.shell.mock.calls.at(-1)![0];
    expect(props.composerToolbarActions).toEqual(expect.arrayContaining(['model', 'approvalMode']));
    expect(props.renderComposerToolbarStart).toBeUndefined();
    const options = await harness.workspace.client.getStandaloneSessionOptions();
    expect(options.approvalMode).toBe('yolo');
    expect(options.providers[0]?.models.find(model => model.isCurrent)?.modelId).toBe('cached-model');
    await act(() => harness.actions.createSession({ modelServiceId: 'cached-model', approvalMode: 'yolo' }));
    expect(creates[0]).toEqual({ agentName: 'a', modelServiceId: 'cached-model', approvalMode: 'yolo', reasoningEffort: 'none' });
  });

  it('hides native mutators on attached sessions and leaves their connection alone', async () => {
    harness.connection = { sessionId: 'existing' };
    render(<App />);
    await waitFor(() => expect(harness.shell).toHaveBeenCalled());
    const props = harness.shell.mock.calls.at(-1)![0];
    expect(props.composerToolbarActions).not.toContain('model');
    expect(props.composerToolbarActions).not.toContain('approvalMode');
    fireEvent.click(screen.getByRole('button', { name: '会话设置' }));
    fireEvent.change(screen.getByLabelText('新会话模型'), { target: { value: 'future' } });
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(harness.actions.clearSession).not.toHaveBeenCalled();
    expect(creates).toHaveLength(0);
  });

  it('refreshes native welcome options after closing changed settings without remounting the shell', async () => {
    render(<App />);
    await waitFor(() => expect(harness.shell).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '会话设置' }));
    fireEvent.change(screen.getByLabelText('新会话审批模式'), { target: { value: 'yolo' } });
    expect(harness.actions.clearSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    await waitFor(() => expect(harness.actions.clearSession).toHaveBeenCalledTimes(1));
    const options = await harness.workspace.client.getStandaloneSessionOptions();
    expect(options.approvalMode).toBe('yolo');
  });

  it('refreshes deferred settings after an in-flight create fails', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    let fail!: (value: Response) => void;
    const previous = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input, init) => String(input).endsWith('/standalone/sessions')
      ? new Promise<Response>(resolve => { fail = resolve; }) : previous(input, init)));
    let creation!: Promise<unknown>;
    await act(async () => { creation = harness.actions.createSession(); });
    await waitFor(() => expect(fail).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: '会话设置' }));
    fireEvent.change(screen.getByLabelText('新会话模型'), { target: { value: 'newer' } });
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(harness.actions.clearSession).not.toHaveBeenCalled();
    await act(async () => {
      fail(Response.json({ error: 'failed' }, { status: 502 }));
      await expect(creation).rejects.toThrow();
    });
    await waitFor(() => expect(harness.actions.clearSession).toHaveBeenCalledTimes(1));
    expect(readPreferences(base, 'a').modelServiceId).toBe('newer');
  });

  it('does not overwrite newer settings when an older native create succeeds', async () => {
    environment = { ...environment, approvalMode: 'yolo' };
    await mount();
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    let finish!: (value: Response) => void;
    const previous = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input, init) => String(input).endsWith('/standalone/sessions')
      ? new Promise<Response>(resolve => { finish = resolve; }) : previous(input, init)));
    let creation!: Promise<unknown>;
    await act(async () => { creation = harness.actions.createSession({ modelServiceId: 'native-choice', approvalMode: 'auto' }); });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: '会话设置' }));
    fireEvent.change(screen.getByLabelText('新会话模型'), { target: { value: 'newer-choice' } });
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    await act(async () => { finish(Response.json(session)); await creation; });
    expect(readPreferences(base, 'a')).toEqual({ modelServiceId: 'newer-choice' });
    expect(readSessionConfiguration(base, 'a', 'server-id')?.modelServiceId).toBe('native-choice');
  });

  it('keeps native draft overrides separate from the saved defaults', async () => {
    environment = { ...environment, approvalMode: 'auto' };
    await mount();
    fireEvent.change(screen.getByLabelText('新会话审批模式'), { target: { value: 'yolo' } });
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    await act(() => harness.actions.createSession({ modelServiceId: 'draft-model', approvalMode: 'default' }));
    expect(creates[0]).toMatchObject({ modelServiceId: 'draft-model', approvalMode: 'default' });
    expect(readPreferences(base, 'a')).toEqual({ approvalMode: 'yolo' });
    expect(readSessionConfiguration(base, 'a', 'server-id')).toMatchObject({ modelServiceId: 'draft-model', approvalMode: 'default' });
  });

  it('switches Agent for new creation and isolates its saved model preferences', async () => {
    savePreferences(base, 'custom-agent', { modelServiceId: 'custom-model', reasoningEffort: 'none' });
    await mount();
    fireEvent.change(screen.getByLabelText('Agent 名称'), { target: { value: 'custom-agent' } });
    fireEvent.blur(screen.getByLabelText('Agent 名称'));
    expect((screen.getByLabelText('新会话模型') as HTMLInputElement).value).toBe('custom-model');
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    await act(() => harness.actions.createSession());
    expect(creates[0]).toMatchObject({ agentName: 'custom-agent', modelServiceId: 'custom-model', reasoningEffort: 'none' });
    expect(readSessionConfiguration(base, 'custom-agent', 'server-id')?.agentName).toBe('custom-agent');
  });

  it('rejects an empty Agent and defaults back to dataworks_data_agent on reset', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText('Agent 名称'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(screen.getByRole('alert').textContent).toContain('Agent 名称');
    expect(screen.getByRole('dialog', { name: '会话设置' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '恢复环境默认值' }));
    expect((screen.getByLabelText('Agent 名称') as HTMLInputElement).value).toBe('dataworks_data_agent');
  });

  it('pins Agent before asynchronous creation preflight while later settings affect only later creates', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    let release!: (response: Response) => void;
    const previous = globalThis.fetch;
    let once = true;
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      if (String(url).endsWith('/openapi/session-options') && once) {
        once = false; return new Promise<Response>(resolve => { release = resolve; });
      }
      return previous(url, init);
    }));
    let creation!: Promise<unknown>;
    await act(async () => { creation = harness.actions.createSession(); });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: '会话设置' }));
    fireEvent.change(screen.getByLabelText('Agent 名称'), { target: { value: 'agent-next' } });
    fireEvent.blur(screen.getByLabelText('Agent 名称'));
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    await act(async () => { release(Response.json(environment)); await creation; });
    expect(creates[0]?.agentName).toBe('a');
    await act(() => harness.actions.createSession());
    expect(creates[1]?.agentName).toBe('agent-next');
  });

  it('does not revive the mistakenly cached data_agent built-in default', () => {
    const scope = 'http://old-default.test/d';
    localStorage.setItem(`workbench.selected-agent.v1:${scope}`, 'data_agent');
    expect(readSelectedAgent(scope)).toBe('dataworks_data_agent');
  });

  it('preserves a custom Agent selected before the default-name correction', () => {
    const scope = 'http://old-custom.test/d';
    localStorage.setItem(`workbench.selected-agent.v1:${scope}`, 'published-custom');
    expect(readSelectedAgent(scope)).toBe('published-custom');
  });

});
