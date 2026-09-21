/**
 * daemon 兼容层的事件信封与构造器。
 *
 * 形状对齐 qwen-code 的 daemon REST API 契约（`docs/developers/daemon-rest-api.openapi.json`
 * 的 EventEnvelope）：`{v:1, type, data, id?, originatorClientId?, _meta?}`。
 * 消费方是 @qwen-code/web-shell（经 @qwen-code/sdk 的 RestSseTransport 解析），
 * 它按 `type` 分发 normalize、容忍未知字段，所以这里只保证已知事件类型的
 * data 必填字段，其余原样带过。
 */
export interface DaemonEvent {
  v: 1;
  type: string;
  data: Record<string, unknown>;
  /** journal 分配的单调序号；SSE 帧的 `id:` 行与 `Last-Event-ID` 续传都靠它。 */
  id?: number;
  originatorClientId?: string;
  _meta?: Record<string, unknown>;
}

/**
 * session_update：`data.update` 里是 ACP update 载荷（整包透传，不重塑）。
 *
 * data 形状对齐真 daemon：`{sessionId, update:{...}}`——web-shell 的
 * `getSessionUpdatePayload` 优先读 `data.update`，读不到才退回 data 本体；
 * 若把 update 挂在别的键上，`data.sessionUpdate` 会被当成判别器读出对象而非
 * 字符串，整个事件退化成"未知块"渲染原始 JSON（e2e 实测过这个坑）。
 */
export function sessionUpdateEvent(
  sessionId: string,
  update: Record<string, unknown>,
  originatorClientId?: string,
): DaemonEvent {
  return {
    v: 1,
    type: 'session_update',
    data: { sessionId, update },
    ...(originatorClientId ? { originatorClientId } : {}),
  };
}

export function turnCompleteEvent(sessionId: string, stopReason: string, promptId: string): DaemonEvent {
  return { v: 1, type: 'turn_complete', data: { sessionId, stopReason, promptId } };
}

export function turnErrorEvent(
  sessionId: string,
  message: string,
  opts: { promptId?: string; code?: string; errorKind?: string } = {},
): DaemonEvent {
  const data: Record<string, unknown> = { sessionId, message };
  if (opts.promptId !== undefined) data.promptId = opts.promptId;
  if (opts.code !== undefined) data.code = opts.code;
  if (opts.errorKind !== undefined) data.errorKind = opts.errorKind;
  return { v: 1, type: 'turn_error', data };
}

export function promptCancelledEvent(sessionId: string, promptId: string): DaemonEvent {
  return { v: 1, type: 'prompt_cancelled', data: { sessionId, promptId } };
}

/** SSE `?snapshot=1` 时连接即附的快照（合成事件，不入 journal、不带 id）。 */
export function sessionSnapshotEvent(sessionId: string): DaemonEvent {
  return {
    v: 1,
    type: 'session_snapshot',
    data: { sessionId, currentModelId: 'data-agent', currentApprovalMode: null },
  };
}

// ------------------------------------------------------------------
// permission：上游 `_qwen/notify` 帧 → daemon `permission_request` / `permission_resolved`
//
// 事件类型名与 data 键名以 @qwen-code/sdk 的事件契约为准（dist/daemon/events.d.ts：
// DAEMON_KNOWN_EVENT_TYPE_VALUES 与 DaemonPermissionRequestData/ResolvedData）。
// toolCall 原样透传（含 _meta.toolName / rawInput / content），web-shell 按
// `_meta.toolName` 判别工具、按 `rawInput` 取 ask_user_question 的问卷。
// options 映射为 web-shell normalizer 期望的 `{optionId, label, raw:{kind}}` 形状。
// ------------------------------------------------------------------

export function permissionRequestEvent(
  sessionId: string,
  pending: {
    requestId: string;
    toolCall?: Record<string, unknown>;
    title?: string | null;
    options: Array<{ optionId: string; name?: string; kind?: string }>;
  },
): DaemonEvent {
  const data: Record<string, unknown> = {
    requestId: pending.requestId,
    sessionId,
    toolCall: pending.toolCall ?? null,
    options: pending.options.map((option) => ({
      optionId: option.optionId,
      label: option.name ?? option.optionId,
      raw: { kind: pickOptionKind(option) },
    })),
  };
  if (pending.title != null) data.title = pending.title;
  return { v: 1, type: 'permission_request', data };
}

/**
 * 合成 raw.kind（web-shell 提交按钮只认 allow_once/allow_always/reject_once/reject_always）。
 *
 * 上游 DataAgent 的选项不带 kind 字段，只能从 optionId 的文本语义合成：
 *  reject：cancel/reject/deny 出现 → reject_once（reject 一刀斩，不加 "always" 担心记住拒绝）
 *  allow_always：optionId 含 always → allow_always
 *  其它一律 allow_once（没它 "提交" 按钮恒 disabled——web-shell 提交选项不可用的真正根因）
 */
function pickOptionKind(option: { optionId: string; kind?: string }): string {
  if (option.kind) return option.kind;
  const id = option.optionId.toLowerCase();
  if (/cancel|reject|deny|拒绝/.test(id)) return 'reject_once';
  if (id.includes('always')) return 'allow_always';
  return 'allow_once';
}

export function permissionResolvedEvent(
  sessionId: string,
  requestId: string,
  outcome: Record<string, unknown>,
): DaemonEvent {
  return {
    v: 1,
    type: 'permission_resolved',
    data: { requestId, sessionId, outcome },
  };
}
