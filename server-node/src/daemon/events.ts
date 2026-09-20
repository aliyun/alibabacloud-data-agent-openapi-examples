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
