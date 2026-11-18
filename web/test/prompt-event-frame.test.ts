import { describe, expect, it } from 'vitest';
import { decodePromptEvent } from '../src/prompt-event-frame';

const sessionId = '00000000-0000-4000-8000-000000000006';
const epoch = '00000000-0000-4000-8000-000000000002';
const cursor = { sessionId, promptId: '00000000-0000-4000-8000-000000000004', eventEpoch: epoch,
  eventId: '174', eventType: 'session_update' };
const params = { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '查询结果' } } };

describe('owned Prompt native event bridge', () => {
  for (const key of ['Meta', 'meta', '_meta']) it(`retains first content and native identity from ${key}`, () => {
    const metadata = key === 'Meta'
      ? { EventCursor: Object.fromEntries(Object.entries(cursor).map(([key, value]) => [key[0]!.toUpperCase() + key.slice(1), value])) }
      : { eventCursor: cursor };
    const decoded = decodePromptEvent({ method: 'session/update', params, [key]: metadata }, sessionId, 'local-owned-id');
    expect(decoded.cursor).toEqual({ ...cursor, eventId: 174 });
    expect(decoded.event).toEqual({ v: 1, type: 'session_update', data: params, id: 174, promptId: 'local-owned-id',
      _meta: { source: 'workbench_prompt_frame', nativePromptId: cursor.promptId, eventEpoch: epoch } });
    expect(decoded.event?.data).toBe(params);
  });
  it('supports wire casing and missing cursor without inventing an ID', () => {
    const { event, cursor } = decodePromptEvent({ Method: 'session/update', Params: params }, sessionId, 'owned');
    expect(cursor).toBeUndefined();
    expect(event?.id).toBeUndefined();
    expect(event?.data).toBe(params);
  });
  for (const change of [{ eventId: '9007199254740992' }, { eventId: '-1' }, { eventId: '1.5' },
    { eventId: 174 }, { eventEpoch: '' }, { eventEpoch: 'epoch\nheader' }, { promptId: '' },
    { eventType: 'session_update\n' }, { sessionId: 'another-session' }]) {
    it(`rejects invalid native identity ${JSON.stringify(change)}`, () => {
      expect(() => decodePromptEvent({ Method: 'session/update', Params: params,
        Meta: { EventCursor: { ...cursor, ...change } } }, sessionId, 'owned')).toThrow();
    });
  }
  it('rejects conflicting metadata and nested aliases', () => {
    expect(() => decodePromptEvent({ Method: 'session/update', Params: params,
      meta: { eventCursor: cursor }, Meta: { EventCursor: { ...cursor, eventId: '175' } } }, sessionId, 'owned')).toThrow();
    expect(() => decodePromptEvent({ Method: 'session/update', Params: params,
      meta: { eventCursor: { ...cursor, EventId: '175' } } }, sessionId, 'owned')).toThrow();
  });
  it('rejects other-session ACP content even with a valid cursor', () => {
    expect(() => decodePromptEvent({ Method: 'session/update', Params: { ...params, sessionId: 'other' },
      Meta: { EventCursor: cursor } }, sessionId, 'owned')).toThrow();
  });
  it('does not turn Result or Error into a second turn terminal', () => {
    expect(decodePromptEvent({ Result: { stopReason: 'end_turn' } }, sessionId, 'owned').event).toBeUndefined();
    expect(decodePromptEvent({ Error: { message: 'failure' } }, sessionId, 'owned').event).toBeUndefined();
  });
  it('converts actual approval option names to web-shell labels and kinds', () => {
    const toolCall = { toolCallId: 'tool-1', title: '执行 SQL', rawInput: { sql: 'SELECT 1' }, _meta: { toolName: 'execute_sql' } };
    const { event } = decodePromptEvent({ Method: '_qwen/notify', Params: { kind: 'permission_request', data: {
      sessionId, requestId: 'approval-1', toolCall, options: [{ optionId: 'proceed_once', name: '确认执行' },
        { optionId: 'cancel', name: '取消' }] } } }, sessionId, 'owned');
    expect(event?.type).toBe('permission_request');
    expect(event?.data).toMatchObject({ sessionId, requestId: 'approval-1', toolCall,
      options: [{ optionId: 'proceed_once', label: '确认执行', kind: 'allow_once' },
        { optionId: 'cancel', label: '取消', kind: 'reject_once' }] });
  });
  it('offers answers-only submission for an ask_user_question without upstream options', () => {
    const toolCall = { _meta: { qwenInteractionKind: 'user_question', toolName: 'ask_user_question' },
      rawInput: { questions: [{ question: '查询哪一年？', options: [{ label: '2026' }] }] } };
    const { event } = decodePromptEvent({ method: '_qwen/notify', params: { kind: 'permission_request', data: {
      sessionId, requestId: 'question-1', toolCall, options: [] } } }, sessionId, 'owned');
    expect(event?.data).toMatchObject({ toolCall, openApiAnswersOnly: true,
      options: [{ optionId: '__openapi_answers__', label: '提交回答', kind: 'allow_once' }] });
  });
  it('keeps permission resolution outcome', () => {
    const outcome = { outcome: 'selected', optionId: 'proceed_once' };
    const { event } = decodePromptEvent({ Method: '_qwen/notify', Params: { kind: 'permission_resolved', data: {
      sessionId, requestId: 'approval-1', outcome } } }, sessionId, 'owned');
    expect(event).toMatchObject({ type: 'permission_resolved', data: { sessionId, requestId: 'approval-1', outcome } });
  });
});
