import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { eventCursorOf, type AcpFrame, type EventCursor } from '@das/shared';
import { recoverPromptFrames, type ResumeSource } from '../src/prompt-recovery.js';
import { toApiError } from '../src/normalize.js';
import { livePromptFrames } from '../src/live.js';

const cursor = (id: number, type = 'session_update'): EventCursor => ({ sessionId: 'session', eventEpoch: 'epoch',
  eventId: String(id), promptId: 'native-prompt', eventType: type });
const chunk = (id: number, text = 'x'): AcpFrame => ({ Jsonrpc: '2.0', RequestId: 'turn', _meta: { eventCursor: cursor(id) },
  Params: { sessionId: 'session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const end = (id = 6): AcpFrame => ({ Jsonrpc: '2.0', Id: 'prompt', Result: { stopReason: 'end_turn' },
  _meta: { eventCursor: cursor(id, 'turn_complete') } });
async function* frames(rows: AcpFrame[], error?: Error) { yield* rows; if (error) throw error; }
const source = (rows: AcpFrame[], error?: Error): ResumeSource => ({ id: 'prompt', frames: frames(rows, error) });
const retry = (e: unknown) => toApiError(e, 'GetAgentSessionEvents').kind === 'transport';
async function collect(rows: AsyncIterable<AcpFrame>) { const out: AcpFrame[] = []; for await (const r of rows) out.push(r); return out; }
const opts = { sessionId: 'session', delayMs: 0, attempts: 3 };

describe('Prompt resumes only the native Events cursor', () => {
  it('resumes after the applied event and keeps one original terminal', async () => {
    const events = vi.fn(() => source([chunk(5, 'new'), end()]));
    expect(await collect(recoverPromptFrames(source([chunk(4)]), events, retry, opts)))
      .toEqual([chunk(4), chunk(5, 'new'), end()]);
    expect(events.mock.calls).toHaveLength(1);
    expect((events.mock.calls as unknown as EventCursor[][])[0]?.[0]).toEqual(cursor(4));
  });
  it('advances only fully handled cursors across repeated transport disconnects', async () => {
    const events = vi.fn((saved: EventCursor) => source(saved.eventId === '4' ? [chunk(5)] : [end()]));
    await collect(recoverPromptFrames(source([chunk(4)]), events, retry, opts));
    expect(events.mock.calls.map(call => call[0].eventId)).toEqual(['4', '5']);
  });
  it.each(['eventEpoch', 'promptId', 'sessionId', 'eventId'] as const)('rejects changed or duplicated cursor field %s', async key => {
    const invalid = chunk(5);
    (invalid._meta as { eventCursor: EventCursor }).eventCursor[key] = key === 'eventId' ? '4' : 'other';
    await expect(collect(recoverPromptFrames(source([chunk(4)]), () => source([invalid]), retry, opts))).rejects.toThrow();
  });
  it('does not use a legacy offset as native resume proof', async () => {
    const legacy = chunk(4); delete legacy._meta; legacy.Params!._meta = { offset: 900 };
    const events = vi.fn(); await collect(recoverPromptFrames(source([legacy]), events, retry, opts));
    expect(events).not.toHaveBeenCalled();
  });
  it('does not resume a terminal or a business rejection', async () => {
    const events = vi.fn();
    for (const rows of [[chunk(4), end()], [{ Error: { code: -32603, message: 'denied' } }]]) {
      await collect(recoverPromptFrames(source(rows), events, retry, opts));
    }
    expect(events).not.toHaveBeenCalled();
  });
  it('a subscription error after a saved cursor checks Events instead of claiming execution failure', async () => {
    const events = vi.fn(() => source([end()]));
    const result = await collect(recoverPromptFrames(source([chunk(4), { Error: { errorCode: 'DAEMON_STREAM_ENDED', message: 'ended' } }]), events, retry, opts));
    expect(result).toEqual([chunk(4), end()]); expect(events).toHaveBeenCalledOnce();
  });
  it('bounds empty subscriptions and does not retry authentication failures', async () => {
    const events = vi.fn(() => source([]));
    await collect(recoverPromptFrames(source([chunk(4)]), events, retry, opts));
    expect(events).toHaveBeenCalledTimes(3);
    const denied = vi.fn(() => source([], Object.assign(new Error('denied'), { statusCode: 403 })));
    await expect(collect(recoverPromptFrames(source([chunk(4)]), denied, retry, opts))).rejects.toThrow('denied');
    expect(denied).toHaveBeenCalledOnce();
  });
  it('closes the upstream on consumer disposal without starting another request', async () => {
    let closed = false;
    const initial = { id: 'prompt', frames: (async function* () { try { yield chunk(4); } finally { closed = true; } })() };
    const events = vi.fn(); const stream = recoverPromptFrames(initial, events, retry, opts);
    await stream.next(); await stream.return(undefined);
    expect(closed).toBe(true); expect(events).not.toHaveBeenCalled();
  });
  it('preserves metadata through SDK core and waits for the receipt before publishing a native terminal', async () => {
    const envelope = (id: number, type: string, data: object) => ({ v: 1, id, type, promptId: 'native-prompt', data });
    const sse = (event: object, id?: number) => `${id === undefined ? '' : 'id: '+id+'\n'}event: ${(event as {type:string}).type}\ndata: ${JSON.stringify(event)}\n\n`;
    const client = {
      callSSEApi: vi.fn(() => (async function* () { yield { event: { data: JSON.stringify(chunk(4)) }, statusCode: 200, headers: {} }; })()),
      callApi: vi.fn(async () => ({ statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from([
        sse({ v: 1, type: 'stream_open', data: { sessionId: 'session', nativeSessionId: 'native-session', eventEpoch: 'epoch' } }),
        sse(envelope(5, 'session_update', { sessionId: 'native-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new' } } }), 5),
        sse(envelope(6, 'turn_complete', { sessionId: 'native-session', stopReason: 'end_turn' }), 6),
        sse(envelope(7, 'pending_prompt_completed', { sessionId: 'native-session' }), 7),
        sse({ type: 'replay_complete', data: { replayedCount: 3, lastReplayedEventId: 7 } }),
      ]) })),
    };
    const result = await collect(livePromptFrames({ client } as never, 'session', 'test'));
    expect(client.callSSEApi).toHaveBeenCalledOnce(); expect(client.callApi).toHaveBeenCalledOnce();
    const request = (client.callApi.mock.calls as unknown as unknown[][])[0]?.[1] as { query: object; headers: object };
    expect(request.query).toEqual({ SessionCode: 'session', EventEpoch: 'epoch' });
    expect(request.headers).toMatchObject({ 'Last-Event-Id': '4' });
    expect(result).toHaveLength(3); expect(eventCursorOf(result.at(-1)!)).toEqual(cursor(6, 'turn_complete'));
    expect(result[1]?.Params?.sessionId).toBe('session');
  });
});
