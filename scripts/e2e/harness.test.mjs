// All tests use loopback fake servers and synthetic data. No credentials or cloud calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { runHarness, consumeOwned, consumeEvents, validateBase, lines } from './run.mjs';
import { startOwned, unusedPort } from './managed.mjs';

const opts = { region: 'test-region', language: 'node', mode: 'yolo' };
function event(id, text, type = 'session_update') {
  return { v: 1, id: String(id), type, data: { sessionId: 'sid', ...(type === 'turn_complete' ? { stopReason: 'end_turn' }
    : { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } }) } };
}
function sse(value, outer = value.id) { return `${outer === undefined ? '' : `id: ${outer}\n`}data: ${JSON.stringify(value)}\n\n`; }
async function fixture(scenario = 'ok') {
  const state = { memory: '', answer: '', events: [], subscribers: new Set(), calls: [], ownedDone: 0, deleted: false, title: '', archived: false };
  const servers = [];
  const start = async label => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      state.calls.push({ label, method: req.method, url: req.url, body, after: req.headers['last-event-id'] });
      const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
      if (url.pathname === '/api/health') return json({ ok: true, result: { mock: false, region: 'test-region' } });
      if (url.pathname === '/d/openapi/session-options') return json({ agentName: 'test-agent' });
      if (url.pathname === '/d/standalone/sessions' && req.method === 'POST') return json({ sessionId: 'sid' });
      if (url.pathname === '/api/sessions') return json({ result: { sessions: state.deleted || state.archived ? [] : [{ sessionId: 'sid', title: state.title }] } });
      if (url.pathname === '/d/standalone/sessions' && req.method === 'GET') return json({ sessions: state.archived ? [{ sessionId: 'sid' }] : [] });
      if (url.pathname.endsWith('/load')) return json({ compactedReplay: [event(1, state.answer)], liveJournal: [] });
      if (url.pathname.endsWith('/cancel')) { res.writeHead(204); return res.end(); }
      if (url.pathname.endsWith('/metadata')) { state.title = body.displayName; return json({}); }
      if (url.pathname.endsWith('/archive')) { state.archived = true; return json({ archived: ['sid'] }); }
      if (url.pathname.endsWith('/unarchive')) { state.archived = false; return json({ unarchived: ['sid'] }); }
      if (url.pathname.endsWith('/delete')) { state.deleted = true; return json({ removed: ['sid'] }); }
      if (url.pathname === '/d/session/sid/events') {
        if (scenario === 'events-http-error') { res.writeHead(503); return res.end('unavailable'); }
        if (scenario === 'events-wrong-type') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
        // Real upstream sends stream_open without a sessionId before any business event.
        res.write(sse({ v: 1, type: 'stream_open', data: {} }));
        const sub = { res, after: req.headers['last-event-id'] };
        state.subscribers.add(sub); res.on('close', () => state.subscribers.delete(sub));
        return;
      }
      if (url.pathname === '/api/sessions/sid/prompt') {
        assert.equal(typeof body.text, 'string');
        const followup = body.text.includes('FOLLOWUP_');
        let answer;
        if (!followup) { state.memory = body.text.match(/WB_[a-f0-9]+/)[0]; answer = state.memory; }
        else {
          assert.ok(!body.text.includes(state.memory), 'follow-up Prompt must not repeat the memory marker');
          answer = `${body.text.match(/FOLLOWUP_[a-f0-9]+/)[0]}:${state.memory}`;
        }
        state.answer += answer;
        const id = state.events.length + 1;
        const values = [event(id, answer), event(id + 1, '', 'turn_complete')];
        state.events.push(...values);
        for (const { res: remote, after } of state.subscribers) {
          if (scenario === 'remote-eof') remote.end();
          else if (scenario === 'old-id' && followup) remote.end(sse(event(after, answer)) + sse(event(Number(after) + 1, '', 'turn_complete')));
          else if (scenario === 'old-answer' && followup) remote.end(sse(event(id, state.memory)) + sse(values[1]));
          else if (scenario === 'missing-cursor' && followup) {
            const { id: ignored, ...noId } = values[0]; void ignored;
            remote.end(sse(noId) + sse(values[1]));
          } else remote.end(values.map(value => sse(value)).join(''));
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ type: 'meta', rid: `rid-${id}`, sessionId: 'sid', mock: false })}\n`);
        if (scenario === 'owned-error') return res.end(`${JSON.stringify({ type: 'error', rid: `rid-${id}`, error: { kind: 'stream_break' } })}\n`);
        if (scenario === 'owned-eof') return res.end();
        if (scenario === 'owned-timeout') return;
        // Remote is already terminal: success must still wait for this owned done.
        setTimeout(() => {
          state.ownedDone++;
          res.end(`${JSON.stringify({ type: 'done', rid: `rid-${id}`, stopReason: 'end_turn' })}\n`);
        }, 25);
        return;
      }
      res.writeHead(404); res.end('{}');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };
  const base = await start('A'); const secondary = await start('B');
  const cleanup = async () => {
    for (const server of servers) { server.closeAllConnections(); server.close(); }
  };
  return { state, base, secondary, cleanup };
}
async function execute(scenario, hook, extra = {}) {
  const f = await fixture(scenario);
  let result;
  try {
    result = await runHarness({ ...opts, 'base-url': f.base, 'secondary-base-url': f.secondary, ...extra }, { timeoutMs: 700, beforeFollowup: hook });
    return { ...result, state: f.state };
  } finally { await f.cleanup(); if (result) fs.rmSync(result.output, { recursive: true, force: true }); }
}

test('dual-server journey requires both streams, alternates Prompt/Events, renames cross-server and deletes once', async () => {
  const { report, state } = await execute('ok');
  assert.equal(report.status, 'PASS');
  assert.equal(report.checks.length, 9);
  assert.equal(state.ownedDone, 2);
  const prompts = state.calls.filter(call => call.url === '/api/sessions/sid/prompt');
  assert.deepEqual(prompts.map(call => call.label), ['A', 'B']);
  const events = state.calls.filter(call => call.url === '/d/session/sid/events');
  assert.deepEqual(events.map(call => call.label), ['B', 'A']);
  assert.equal(events[1].after, '2');
  assert.equal(state.calls.find(call => call.url.endsWith('/metadata')).label, 'B');
  assert.equal(state.calls.filter(call => call.method === 'POST' && call.url === '/d/standalone/sessions').length, 1);
  assert.equal(state.calls.filter(call => call.url.endsWith('/delete')).length, 1);
  assert.ok(!state.calls.some(call => call.url.includes('receipt') || call.url === '/d/session/sid/prompt'));
  // Downloaded source archives have no Git metadata; do not invent a revision.
  assert.ok(Object.hasOwn(report.harnessSource, 'sha'));
  assert.ok(report.harnessSource.sha === null || /^[a-f0-9]{40,64}$/.test(report.harnessSource.sha));
  assert.ok(report.harnessSource.dirty === null || typeof report.harnessSource.dirty === 'boolean');
  assert.equal(report.requestedSettings.mode, 'yolo');
  assert.equal(report.rounds.length, 2);
});
for (const scenario of ['owned-error', 'owned-eof', 'owned-timeout', 'remote-eof', 'old-id', 'old-answer', 'missing-cursor']) {
  test(`${scenario}: failure retains SID, never retries Prompt or deletes`, async () => {
    const { report, state } = await execute(scenario);
    assert.equal(report.status, 'FAIL');
    assert.equal(report.sessionId, 'sid');
    assert.equal(state.deleted, false);
    const count = state.calls.filter(call => call.url === '/api/sessions/sid/prompt').length;
    assert.equal(count, ['old-id', 'old-answer', 'missing-cursor'].includes(scenario) ? 2 : 1);
    assert.ok(!state.calls.some(call => call.url.includes('receipt')));
  });
}
test('restart hook runs between rounds, loads on A and leaves second Prompt server B cold', async () => {
  let restarted = false;
  const { report, state } = await execute('ok', async ({ sessionId }) => { assert.equal(sessionId, 'sid'); restarted = true; return { restarted: true }; });
  assert.equal(report.status, 'PASS'); assert.equal(restarted, true);
  const loads = state.calls.filter(call => call.url.endsWith('/load'));
  assert.deepEqual(loads.map(call => call.label), ['B', 'A']);
  assert.equal(report.restart.restarted, true);
});


for (const choice of ['primary', 'secondary']) {
  test(`explicit Prompt routing ${choice} never uses create/receipt on the other server`, async () => {
    const { report, state } = await execute('ok', undefined, { 'prompt-server': choice });
    assert.equal(report.status, 'PASS');
    assert.deepEqual(state.calls.filter(call => call.url === '/api/sessions/sid/prompt').map(call => call.label),
      choice === 'primary' ? ['A', 'A'] : ['B', 'B']);
    assert.deepEqual(state.calls.filter(call => call.url === '/d/session/sid/events').map(call => call.label),
      choice === 'primary' ? ['B', 'B'] : ['A', 'A']);
  });
}
test('restart failure preserves SID and never sends another Prompt or deletes', async () => {
  const { report, state } = await execute('ok', async () => { throw new Error('owned restart failure'); });
  assert.equal(report.status, 'FAIL'); assert.equal(report.sessionId, 'sid');
  assert.equal(state.calls.filter(call => call.url === '/api/sessions/sid/prompt').length, 1);
  assert.equal(state.deleted, false);
});

test('URL credentials/query/hash are rejected; valid loopback is accepted', () => {
  for (const url of ['https://user:secret@example.com', 'https://example.com?token=secret', 'https://example.com#secret', 'file:///tmp/x']) {
    assert.throws(() => validateBase(url), /Invalid base URL/);
  }
  assert.equal(validateBase('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
});
function response(text, type) { return new Response(text, { headers: { 'content-type': type } }); }
test('owned stream rejects wrong rid, mock, cancelled and missing done', async () => {
  const meta = { type: 'meta', rid: 'owned', sessionId: 'sid', mock: false };
  for (const events of [
    [meta, { type: 'done', rid: 'external', stopReason: 'end_turn' }],
    [{ ...meta, mock: true }, { type: 'done', rid: 'owned', stopReason: 'end_turn' }],
    [meta, { type: 'done', rid: 'owned', stopReason: 'cancelled' }], [meta],
  ]) await assert.rejects(consumeOwned(response(events.map(value => JSON.stringify(value)).join('\n'), 'application/x-ndjson'), 'sid'));
});
test('SSE rejects cursor disagreement, wrong session and old terminal without answer', async () => {
  for (const text of [sse(event(4, 'answer'), '5'), sse({ ...event(4, 'answer'), data: { sessionId: 'other' } }), sse(event(4, '', 'turn_complete'))]) {
    await assert.rejects(consumeEvents(response(text, 'text/event-stream'), 'sid', 'answer', '3'));
  }
});
test('streaming UTF-8 and CRLF split boundaries are preserved', async () => {
  const bytes = new TextEncoder().encode('data: 中文\r\n\r\n');
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const actual = []; for await (const line of lines(body)) actual.push(line);
  assert.deepEqual(actual, ['data: 中文', '']);
});

test('owned process restart changes PID; occupied user port is never adopted/stopped', async () => {
  const sentinel = http.createServer((req, res) => res.end('untouched'));
  sentinel.listen(0, '127.0.0.1'); await once(sentinel, 'listening');
  const sentinelPort = sentinel.address().port;
  const fake = "require('node:http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({result:{mock:false}}))}).listen(Number(process.env.PORT),'127.0.0.1')";
  const launch = port => startOwned({ command: process.execPath, args: ['-e', fake], port, startupMs: 3000 });
  let first; let second;
  try {
    await assert.rejects(launch(sentinelPort), /occupied/);
    const port = await unusedPort();
    first = await launch(port); await first.stop();
    second = await launch(port);
    assert.notEqual(first.pid, second.pid);
    assert.equal(await (await fetch(`http://127.0.0.1:${sentinelPort}`)).text(), 'untouched');
  } finally { await first?.stop(); await second?.stop(); sentinel.closeAllConnections(); sentinel.close(); }
});

test('report paths inside checkout are rejected before network; source report contains no environment snapshot', async () => {
  await assert.rejects(runHarness({ ...opts, 'base-url': 'http://127.0.0.1:1', 'output-dir': path.resolve('never-create-e2e-report') }), /outside the checkout/);
  // Filesystem output is private and tests clean it; no env/credential snapshot is part of the report schema.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
  const output = path.join(tmp, 'report');
  try {
    fs.symlinkSync(process.cwd(), path.join(tmp, 'checkout'), 'dir');
    await assert.rejects(runHarness({ ...opts, 'base-url': 'http://127.0.0.1:1', 'output-dir': path.join(tmp, 'checkout', 'never-create-report') }), /outside the checkout/);
    const { report } = await runHarness({ ...opts, 'base-url': 'http://127.0.0.1:1', 'output-dir': output }, { timeoutMs: 100 });
    assert.equal(report.status, 'FAIL');
    assert.ok(!Object.hasOwn(report, 'env'));
    assert.equal(fs.statSync(path.join(output, 'result.json')).mode & 0o777, 0o600);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});


test('sidless connection/status controls are ignored for answer/terminal/cursor proof', async () => {
  const controls = [
    { v: 1, type: 'stream_open', data: {} },
    { v: 1, type: 'replay_complete', id: '999', data: { lastEventId: 999 } },
    { v: 1, type: 'slow_client_warning', data: { queueSize: 1, maxQueued: 10, lastEventId: 998 } },
    { v: 1, type: 'session_snapshot', data: { currentModelId: 'do-not-log-this-value' } },
  ];
  const text = controls.map(value => sse(value)).join('') + sse(event(4, 'answer')) + sse(event(5, '', 'turn_complete'));
  const result = await consumeEvents(response(text, 'text/event-stream'), 'sid', 'answer', '3');
  assert.equal(result.answer, 'answer'); assert.equal(result.lastEventId, '5');
  assert.equal(result.eventCount, 2); assert.equal(result.controlCount, 4);
  assert.ok(!JSON.stringify(result.controlShapes).includes('do-not-log-this-value'));
  assert.ok(result.controlShapes.some(shape => shape.includes('stream_open')));
  await assert.rejects(consumeEvents(response(controls.map(value => sse(value)).join(''), 'text/event-stream'), 'sid', 'answer', '3'), /without terminal/);
});
test('all declared subjects are checked, even on connection/status controls', async () => {
  for (const value of [
    { type: 'stream_open', data: { sessionId: 'other', token: 'do-not-log-this-value' } },
    { type: 'replay_complete', sessionId: 'other', data: {} },
  ]) {
    await assert.rejects(consumeEvents(response(sse(value), 'text/event-stream'), 'sid', 'answer', '3'), error => {
      assert.match(error.message, /session mismatch.*eventShape=/);
      assert.ok(!error.message.includes('do-not-log-this-value'));
      assert.ok(!error.message.includes('other'));
      return true;
    });
  }
});
test('business content and terminal still require matching SID, with value-free event diagnostics', async () => {
  for (const value of [
    { type: 'session_update', id: '4', data: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'do-not-log-this-value' } } } },
    { type: 'turn_complete', id: '5', data: { stopReason: 'end_turn' } },
    { ...event(4, 'answer'), data: { sessionId: 'other' } },
  ]) {
    await assert.rejects(consumeEvents(response(sse(value), 'text/event-stream'), 'sid', 'answer', '3'), error => {
      assert.match(error.message, /eventShape=/);
      assert.match(error.message, /dataKeys/);
      assert.ok(!error.message.includes('do-not-log-this-value'));
      return true;
    });
  }
});
test('sidless subscription errors/resync are failure signals, not success or harmless status', async () => {
  for (const type of ['stream_error', 'session_died', 'session_closed', 'state_resync_required', 'client_evicted']) {
    const bad = { type, data: { error: 'do-not-log-this-value' } };
    await assert.rejects(consumeEvents(response(sse(bad) + sse(event(4, 'answer')) + sse(event(5, '', 'turn_complete')), 'text/event-stream'), 'sid', 'answer', '3'), error => {
      assert.match(error.message, /failed or requires resync.*eventShape=/);
      assert.ok(error.message.includes(type));
      assert.ok(!error.message.includes('do-not-log-this-value'));
      return true;
    });
  }
});

test('malformed envelopes are not mistaken for harmless sidless controls', async () => {
  for (const value of [null, [], { data: {} }, { type: 'stream_open', data: [] }]) {
    await assert.rejects(consumeEvents(response(`data: ${JSON.stringify(value)}\n\n` + sse(event(4, 'answer')) + sse(event(5, '', 'turn_complete')), 'text/event-stream'), 'sid', 'answer', '3'));
  }
});

for (const scenario of ['events-http-error', 'events-wrong-type']) test(`${scenario}: subscription rejected before any Prompt write`, async () => {
  const { report, state } = await execute(scenario);
  assert.equal(report.status, 'FAIL');
  assert.equal(state.calls.filter(call => call.url.endsWith('/prompt')).length, 0);
  assert.equal(state.calls.filter(call => call.url.endsWith('/delete')).length, 0);
  assert.match(report.error, /before Prompt/);
});

test('truncated owned JSON cannot disclose payload text in the failure report', async () => {
  await assert.rejects(consumeOwned(response('{"secret":"DO_NOT_LOG_SECRET"\n', 'application/x-ndjson'), 'sid'), error => {
    assert.equal(error.message, 'invalid owned NDJSON (payload omitted)');
    assert.ok(!error.message.includes('DO_NOT_LOG_SECRET'));
    return true;
  });
});
