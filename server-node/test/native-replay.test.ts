import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { livePromptFrames } from '../src/live.js';
import { remoteEvents } from '../src/daemon/remote-events.js';

const opener = { type: 'stream_open', data: { sessionId: 'business', nativeSessionId: 'native', eventEpoch: 'epoch' } };
const update = { id: 5, type: 'session_update', promptId: 'p', data: { sessionId: 'native', update: {} } };
const terminal = { id: 6, type: 'turn_complete', promptId: 'p', data: { sessionId: 'native', promptId: 'p', stopReason: 'end_turn' } };
const receipt = { type: 'replay_complete', data: { replayedCount: 2, lastReplayedEventId: 6 } };
const sse = (event: object, id?: number) => `${id === undefined ? '' : `id: ${id}\n`}event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`;
const opened = (chunks: string[]) => ({ statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from(chunks) });

it('accepts the actual POP Data-only opening with an explicit empty SSE ID reset', async () => {
  const client = { callApi: vi.fn(async () => opened(['id: \nevent: stream_open\ndata: '+JSON.stringify({ Data: opener.data })+'\n\n'])) };
  const events = [];
  for await (const event of remoteEvents({ client } as never, 'business')) events.push(event);
  expect(events).toEqual([expect.objectContaining({ type: 'stream_open', data: opener.data })]);
});

it('unwraps native business envelopes inside POP Data after an empty-ID opener', async () => {
  const wrap = (event: typeof update | typeof terminal) => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({ Data: event })}\n\n`;
  const client = { callApi: vi.fn(async () => opened(['id: \nevent: stream_open\ndata: '+JSON.stringify({ Data: opener.data })+'\n\n',
    wrap(update), wrap(terminal)])) };
  const events = [];
  for await (const event of remoteEvents({ client } as never, 'business')) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: 'turn_complete', promptId: 'p', id: 6, data: { sessionId: 'business', stopReason: 'end_turn' } });
  expect(events[1]).toMatchObject({ type: 'session_update', promptId: 'p', id: 5, data: { update: {} } });
});

it('delivers a fresh live terminal without waiting for a replay receipt that the daemon never sends', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = { callApi: vi.fn(async () => ({ statusCode: 200, headers: { 'content-type': 'text/event-stream' },
    body: Readable.from((async function* () {
      yield sse(opener); yield sse(update, 5); yield sse(terminal, 6);
      await gate;
    })()) })) };
  const observed = [];
  try {
    for await (const event of remoteEvents({ client } as never, 'business')) {
      if (event.type === 'turn_complete') release();
      observed.push(event.type);
    }
  } finally { release(); }
  expect(observed).toEqual(['stream_open', 'session_update', 'turn_complete']);
  expect(client.callApi).toHaveBeenCalledOnce();
});

it('fails closed on malformed Prompt JSON after a trusted cursor without opening Events', async () => {
  const initial = { Jsonrpc: '2.0', Method: 'session/update', Params: { sessionId: 'business', update: {} },
    _meta: { eventCursor: { sessionId: 'business', eventEpoch: 'epoch', eventId: '4', promptId: 'p', eventType: 'session_update' } } };
  const client = {
    callSSEApi: vi.fn(() => (async function* () {
      yield { statusCode: 200, headers: {}, event: { data: JSON.stringify(initial) } };
      yield { statusCode: 200, headers: {}, event: { data: '{invalid}' } };
    })()),
    callApi: vi.fn(async () => opened([sse(opener), sse(update, 5), sse(terminal, 6), sse(receipt)])),
  };
  await expect((async () => { for await (const _ of livePromptFrames({ client } as never, 'business', 'once')) { /* consume */ } })())
    .rejects.toMatchObject({ apiError: { kind: 'stream_break' } });
  expect(client.callSSEApi).toHaveBeenCalledOnce();
  expect(client.callApi).not.toHaveBeenCalled();
});

it.each(['bad-receipt', 'missing-receipt', 'valid'] as const)('buffers browser replay terminal until a valid receipt: %s', async variant => {
  let readReceipt = false;
  const client = { callApi: vi.fn(async () => ({ statusCode: 200, headers: { 'content-type': 'text/event-stream' },
    body: Readable.from((async function* () {
      yield sse(opener); yield sse(update, 5); yield sse(terminal, 6);
      if (variant !== 'missing-receipt') { readReceipt = true;
        yield sse(variant === 'valid' ? receipt : { ...receipt, data: { replayedCount: 1, lastReplayedEventId: 6 } }); }
    })()) })) };
  const observed: string[] = [];
  const consume = (async () => {
    for await (const event of remoteEvents({ client } as never, 'business', '4', 'epoch')) {
      if (event.type === 'turn_complete') expect(readReceipt).toBe(true);
      observed.push(event.type);
    }
  })();
  if (variant === 'valid') { await consume; expect(observed).toEqual(['stream_open', 'session_update', 'turn_complete', 'replay_complete']); }
  else { await expect(consume).rejects.toThrow(); expect(observed).not.toContain('turn_complete'); }
});

it.each(['json', 'foreign-session', 'id-mismatch', 'type-mismatch', 'gap', 'prompt-conflict', 'global-failure'] as const)(
  'protocol damage %s cannot trigger a second GET and hide the failure', async variant => {
    let damaged = sse(update, 5);
    if (variant === 'json') damaged = 'event: session_update\ndata: {invalid}\n\n';
    if (variant === 'foreign-session') damaged = sse({ ...update, data: { sessionId: 'foreign', update: {} } }, 5);
    if (variant === 'id-mismatch') damaged = sse(update, 6);
    if (variant === 'type-mismatch') damaged = sse({ ...terminal, id: 5 }, 5).replace('event: turn_complete', 'event: stream_error');
    if (variant === 'gap') damaged = sse({ ...update, id: 6 }, 6);
    if (variant === 'prompt-conflict') damaged = sse({ ...terminal, id: 5, data: { ...terminal.data, promptId: 'other' } }, 5);
    if (variant === 'global-failure') damaged = sse({ id: 5, type: 'state_resync_required', promptId: 'p', data: {} }, 5);
    const initial = { Jsonrpc: '2.0', Method: 'session/update', Params: { sessionId: 'business', update: {} },
      _meta: { eventCursor: { sessionId: 'business', eventEpoch: 'epoch', eventId: '4', promptId: 'p', eventType: 'session_update' } } };
    const client = {
      callSSEApi: vi.fn(() => (async function* () { yield { statusCode: 200, headers: {}, event: { data: JSON.stringify(initial) } }; })()),
      callApi: vi.fn(async () => opened([sse(opener), damaged, sse(receipt)])),
    };
    await expect((async () => { for await (const _ of livePromptFrames({ client } as never, 'business', 'once')) { /* consume */ } })()).rejects.toThrow();
    expect(client.callApi).toHaveBeenCalledOnce(); expect(client.callSSEApi).toHaveBeenCalledOnce();
  });

it('projects only the attested session envelope and preserves tool payload and originator identity', async () => {
  const tool = { ...update, originatorClientId: 'mobile', data: { sessionId: 'native',
    update: { sessionUpdate: 'tool_call_update', rawOutput: { sessionId: 'foreign-tool-content' } } } };
  const client = { callApi: vi.fn(async () => opened([sse(opener), sse(tool, 5),
    sse({ type: 'replay_complete', data: { replayedCount: 1, lastEventId: 5 } }, 5)])) };
  const events = [];
  for await (const event of remoteEvents({ client } as never, 'business', '4', 'epoch')) events.push(event);
  expect(events[1]?.data.sessionId).toBe('business'); expect(events[1]?.originatorClientId).toBe('mobile');
  expect(events[1]?.data.update).toEqual(tool.data.update); expect(events[2]?.id).toBeUndefined();
});
