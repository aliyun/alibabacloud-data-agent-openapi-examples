import { frameFromSdkBody, pendingInteractionOf, permissionResolvedOf } from '@das/shared';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';

export interface NativePromptCursor {
  sessionId: string;
  promptId: string;
  eventEpoch: string;
  eventId: number;
  eventType: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function alias(value: Record<string, unknown>, upper: string, lower: string): unknown {
  if (value[upper] !== undefined && value[lower] !== undefined
    && JSON.stringify(value[upper]) !== JSON.stringify(value[lower])) throw new Error('Prompt 事件字段冲突');
  return value[upper] ?? value[lower];
}
function token(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

/** Native continuation identity, never an NDJSON offset or a browser request ID. */
function cursorOf(frame: Record<string, unknown>, sessionId: string): NativePromptCursor | undefined {
  const candidates: unknown[] = [];
  for (const key of ['Meta', 'meta', '_meta']) {
    if (frame[key] === undefined) continue;
    if (!object(frame[key])) throw new Error('Prompt 事件元信息无效');
    const candidate = alias(frame[key], 'EventCursor', 'eventCursor');
    if (candidate !== undefined) candidates.push(candidate);
  }
  let cursor: NativePromptCursor | undefined;
  for (const candidate of candidates) {
    if (!object(candidate)) throw new Error('Prompt 原生事件游标无效');
    const sid = alias(candidate, 'SessionId', 'sessionId');
    const promptId = alias(candidate, 'PromptId', 'promptId');
    const eventEpoch = alias(candidate, 'EventEpoch', 'eventEpoch');
    const rawId = alias(candidate, 'EventId', 'eventId');
    const eventType = alias(candidate, 'EventType', 'eventType');
    if (sid !== sessionId || !token(promptId) || typeof eventEpoch !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(eventEpoch)
      || typeof rawId !== 'string' || !/^\d+$/.test(rawId) || !Number.isSafeInteger(Number(rawId))
      || typeof eventType !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(eventType)) {
      throw new Error('Prompt 原生事件游标无效或属于其他会话');
    }
    const next = { sessionId, promptId, eventEpoch, eventId: Number(rawId), eventType };
    if (cursor && JSON.stringify(cursor) !== JSON.stringify(next)) throw new Error('Prompt 原生事件游标冲突');
    cursor = next;
  }
  return cursor;
}

/** Render the already consumed Prompt frame before continuing Events after its native ID. */
export function decodePromptEvent(body: unknown, sessionId: string, ownedPromptId: string):
  { event?: DaemonEvent; cursor?: NativePromptCursor } {
  const frame = frameFromSdkBody(body);
  if (!frame) return {};
  const cursor = cursorOf(frame, sessionId);
  const params = object(frame.Params) ? frame.Params : undefined;
  const data = params && object(params.data) ? params.data : undefined;
  for (const value of [params?.sessionId, data?.sessionId]) {
    if (value !== undefined && value !== sessionId) throw new Error('拒绝其他会话的 Prompt 帧');
  }
  // The owned HTTP done/error is the only turn terminal authority.
  if (frame.Result !== undefined || frame.Error !== undefined) return { cursor };
  let event: DaemonEvent | undefined;
  if (frame.Method === 'session/update' && params && object(params.update)) {
    event = { v: 1, type: 'session_update', data: params };
  } else if (frame.Method === '_qwen/notify' && params) {
    const pending = pendingInteractionOf(frame);
    const resolved = permissionResolvedOf(frame);
    if (pending) {
      const toolCall = data && object(data.toolCall) ? data.toolCall : null;
      const options = pending.options.map(option => ({ optionId: option.optionId,
        label: option.name ?? option.optionId,
        kind: option.kind ?? (/cancel|reject|deny|拒绝/.test(option.optionId.toLowerCase()) ? 'reject_once'
          : option.optionId.toLowerCase().includes('always') ? 'allow_always' : 'allow_once') }));
      const meta = toolCall && object(toolCall._meta) ? toolCall._meta : undefined;
      const question = meta?.qwenInteractionKind === 'user_question' || meta?.toolName === 'ask_user_question';
      const answersOnly = question && !options.some(option => option.kind === 'allow_once');
      if (answersOnly) options.push({ optionId: '__openapi_answers__', label: '提交回答', kind: 'allow_once' });
      event = { v: 1, type: 'permission_request', data: { ...data, sessionId, requestId: pending.requestId,
        toolCall, options, ...(answersOnly ? { openApiAnswersOnly: true } : {}) } };
    } else if (resolved) {
      event = { v: 1, type: 'permission_resolved', data: { ...data, sessionId, requestId: resolved.requestId,
        outcome: data && object(data.outcome) ? data.outcome : { outcome: 'selected' } } };
    }
  }
  if (!event) return { cursor };
  if (cursor && cursor.eventType !== event.type) throw new Error('Prompt 游标事件类型与帧不一致');
  event.promptId = ownedPromptId;
  if (cursor) event.id = cursor.eventId;
  event._meta = { source: 'workbench_prompt_frame', ...(cursor
    ? { nativePromptId: cursor.promptId, eventEpoch: cursor.eventEpoch } : {}) };
  return { event, cursor };
}
