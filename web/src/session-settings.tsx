import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useConnection } from '@qwen-code/web-shell';
import type { OpenApiCreateOptions, SessionDefaults } from './session-client';
import { validAgentName, type PreferenceState } from './session-preferences';
import { readSessionConfiguration } from './session-configuration';

export interface SessionSettingsValue {
  baseUrl: string;
  defaults?: SessionDefaults;
  configured?: SessionDefaults;
  preferences?: PreferenceState;
  configError?: string;
  createError?: string;
  clearCreateError: () => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  selectAgent?: (name: string) => void;
  update: (options: OpenApiCreateOptions) => void;
  reset: () => void;
  revision: number;
  theme: 'dark' | 'light' | 'system';
}
export const SessionSettingsContext = createContext<SessionSettingsValue | undefined>(undefined);
const approvalLabels: Record<string, string> = { default: '请求批准', 'auto-edit': '自动编辑', auto: '智能审批', yolo: '完全访问权限', plan: '计划' };
function approvalLabel(mode: string) { return approvalLabels[mode] ? `${approvalLabels[mode]} · ${mode}` : mode; }

function useSettings() {
  const value = useContext(SessionSettingsContext);
  if (!value) throw new Error('Missing session settings provider');
  return value;
}

export function SessionCreateError() {
  const { createError, clearCreateError } = useSettings();
  if (!createError) return null;
  return <div className="session-create-error" role="alert"><span>{createError}</span>
    <button type="button" aria-label="关闭创建错误提示" onClick={clearCreateError}>×</button></div>;
}

export function SessionSettingsButton() {
  const { setOpen } = useSettings();
  return <button type="button" className="session-settings-button" title="会话设置" aria-label="会话设置" onClick={() => setOpen(true)}>
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M10 3h4l1 3 3 1 2 3-2 2 1 3-3 3-3-1-2 2-3-2-1-3-3-1v-4l3-1 1-3z" /><circle cx="12" cy="12" r="3" />
    </svg>
  </button>;
}

/** The public pane context supplies the SID, including split-view panes. */
export function CurrentSessionConfiguration() {
  const { sessionId } = useConnection();
  return <SessionConfiguration sessionId={sessionId} />;
}

/** Always show this session's creation snapshot, never today's defaults as historic facts. */
export function SessionConfiguration({ sessionId }: { sessionId?: string }) {
  const { baseUrl, defaults, configured, setOpen } = useSettings();
  const snapshot = sessionId && defaults ? readSessionConfiguration(baseUrl, defaults.agentName, sessionId) : undefined;
  const selected = sessionId ? snapshot : configured ? { modelServiceId: configured.model,
    approvalMode: configured.approvalMode, reasoningEffort: configured.reasoningEffort } : undefined;
  return <div className="session-configuration" aria-label={sessionId ? '当前会话配置' : '新会话默认配置'}>
    {selected ? <span className="session-configuration-values" title={sessionId
      ? '本浏览器记录的创建时配置，不代表实时运行状态；已有会话不能修改配置。'
      : '用于下一次创建会话，可在会话设置中修改。'}>
      <span className="session-config-model">{selected.modelServiceId ?? '默认模型'}</span>
      <span>{selected.approvalMode ?? 'Agent 默认模式'}</span>
      <span>思考：{selected.reasoningEffort === 'none' ? '关闭' : selected.reasoningEffort ?? 'Agent 默认'}</span>
      <span className="session-config-source">{sessionId ? '创建时' : '默认'}</span>
    </span> : <span className="session-config-source" title={sessionId ? '未记录此会话的创建配置，上游历史也未返回权威配置。' : '等待读取后端默认值。'}>
      {sessionId ? '会话配置未记录' : '正在读取配置'}
    </span>}
    <button type="button" className="session-config-open" onClick={() => setOpen(true)} aria-label="设置新会话默认配置" title="新会话默认配置">设置</button>
  </div>;
}

export function SessionSettingsDialog() {
  const settings = useSettings();
  const { open, setOpen, defaults, preferences, configured, configError, update, reset, theme } = settings;
  const [agentDraft, setAgentDraft] = useState(defaults?.agentName ?? 'dataworks_data_agent');
  const [agentError, setAgentError] = useState<string>();
  useEffect(() => { setAgentDraft(defaults?.agentName ?? 'dataworks_data_agent'); setAgentError(undefined); }, [defaults?.agentName, open]);
  const applyAgent = () => {
    if (!validAgentName(agentDraft)) { setAgentError('请输入 1–128 个字符的 Agent 名称，不能包含控制字符'); return false; }
    if (agentDraft.trim() !== defaults?.agentName) settings.selectAgent?.(agentDraft.trim());
    setAgentError(undefined); return true;
  };
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open) {
      if (!element.open) {
        if (typeof element.showModal === 'function') element.showModal();
        else element.setAttribute('open', '');
      }
    } else if (element.open) {
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
    }
  }, [open]);
  return <dialog ref={dialog} className="session-settings-dialog" data-theme={theme} aria-labelledby="session-settings-title"
    onCancel={event => { event.preventDefault(); setOpen(false); }} onClose={() => setOpen(false)}>
    <header><div><h2 id="session-settings-title">会话设置</h2><p>设置后续新会话的默认行为</p></div>
      <button type="button" aria-label="关闭会话设置" onClick={() => setOpen(false)}>×</button></header>
    <div className="session-settings-body">
      <nav aria-label="设置分类"><span aria-current="page">会话默认值</span></nav>
      <section aria-label="会话默认值">
        <h3>新会话默认配置</h3><p>创建时未显式指定的选项使用以下默认值；已有会话保持原配置。</p>
        {defaults && configured && preferences ? <>
          <label>Agent<input aria-label="Agent 名称" value={agentDraft} maxLength={128} placeholder="dataworks_data_agent"
            aria-invalid={!!agentError} onChange={event => { setAgentDraft(event.target.value); setAgentError(undefined); }} onBlur={applyAgent} />
            <small>默认 dataworks_data_agent；自定义 Agent 需已创建并发布。仅用于后续新会话。</small>{agentError && <small role="alert">{agentError}</small>}</label>
          <label>模型<input autoComplete="off" list="session-model-options" aria-label="新会话模型" value={preferences.options.modelServiceId ?? ''}
            maxLength={512} placeholder={defaults.model ? `沿用环境：${defaults.model}` : '默认模型'} onChange={event => update({ modelServiceId: event.target.value })} />
            <datalist id="session-model-options">{defaults.models.map(model => <option key={model} value={model} />)}</datalist>
            <small>留空沿用后端或 Agent 默认模型。</small></label>
          <div className="session-settings-options">
            <label>审批模式<select aria-label="新会话审批模式" value={preferences.options.approvalMode ?? ''} onChange={event => update({ approvalMode: event.target.value })}>
              <option value="">沿用环境默认（{approvalLabel(defaults.approvalMode)}）</option><option value="default">请求批准（default）</option>
              <option value="auto-edit">自动编辑（auto-edit）</option><option value="auto">智能审批（auto）</option>
              <option value="yolo">完全访问权限（yolo）</option><option value="plan">计划（plan）</option>
            </select></label>
            <label>思考深度<select aria-label="新会话思考深度" value={preferences.options.reasoningEffort ?? ''} onChange={event => update({ reasoningEffort: event.target.value })}>
              <option value="">沿用环境默认</option><option value="none">关闭</option><option value="default">模型默认</option><option value="low">低</option>
              <option value="medium">中</option><option value="high">高</option><option value="xhigh">更高</option><option value="max">最高</option>
            </select></label>
          </div>
          <p className="session-settings-note">{preferences.persistence === 'memory' ? '浏览器存储不可用，设置仅在当前页面保留。' : '已自动保存到本浏览器，按后端地址和 Agent 隔离。'}模型与思考深度须由目标模型支持。</p>
        </> : <p role="status">{configError ?? '正在读取配置…'}</p>}
      </section>
    </div>
    <footer><button type="button" disabled={!defaults} onClick={reset}>恢复环境默认值</button><button className="session-settings-done" type="button" onClick={() => { if (applyAgent()) setOpen(false); }}>完成</button></footer>
  </dialog>;
}
