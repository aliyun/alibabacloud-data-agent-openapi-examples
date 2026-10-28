import type { AppConfig } from './config.js';

export interface SessionCreationOptions {
  agentName?: string;
  modelServiceId?: string;
  approvalMode?: string;
  reasoningEffort?: string;
}

export const APPROVAL_MODES = ['default', 'yolo', 'plan', 'auto-edit', 'auto'] as const;

/** Validate only a supplied override; deployment defaults remain owned by cfg. */
export function optionalAgentName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || /\p{Cc}/u.test(value) || !value.trim() || value.trim().length > 128) {
    throw new Error('agentName 必须是非空字符串，最多128字符且不能包含控制字符');
  }
  return value.trim();
}

export function sessionOptions(cfg: AppConfig, body: unknown = {}): SessionCreationOptions {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('会话配置必须是对象');
  const raw = body as Record<string, unknown>;
  for (const key of ['modelServiceId', 'model', 'approvalMode', 'mode', 'reasoningEffort']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].trim())) {
      throw new Error(`${key} 必须是非空字符串`);
    }
  }
  const agentName = optionalAgentName(raw.agentName);
  const model = raw.modelServiceId ?? raw.model;
  const requestedModel = typeof model === 'string' ? model.trim() : undefined;
  const modelServiceId = requestedModel && requestedModel !== 'data-agent' ? requestedModel : cfg.model;
  const approvalMode = ((raw.approvalMode ?? raw.mode) as string | undefined)?.trim() ?? cfg.mode ?? 'yolo';
  const reasoningEffort = (raw.reasoningEffort as string | undefined)?.trim() ?? cfg.reasoningEffort;
  if (!(APPROVAL_MODES as readonly string[]).includes(approvalMode)) throw new Error('不支持的审批模式');
  return { agentName, modelServiceId, approvalMode, reasoningEffort };
}

export function publicSessionOptions(cfg: AppConfig) {
  const defaults = sessionOptions(cfg);
  return {
    agentName: cfg.agentName,
    model: defaults.modelServiceId,
    approvalMode: defaults.approvalMode,
    reasoningEffort: defaults.reasoningEffort,
    models: [...new Set([cfg.model, ...(cfg.models ?? [])].filter((v): v is string => !!v))],
  };
}
