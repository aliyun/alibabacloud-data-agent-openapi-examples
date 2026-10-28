// LIVE acceptance through demo servers. Importing this module never sends requests.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HELP = 'node scripts/e2e/run.mjs --base-url URL [--secondary-base-url URL] [--prompt-server primary|secondary|alternate] [--language node|python|java] [--region cn-beijing] [--model MODEL] [--mode yolo] [--reasoning-effort none] [--output-dir NEW_DIR]\nRequires LIVE servers with the same endpoint/identity/Agent. Creates one test session, sends exactly two prompts, requires both owned NDJSON done and independent remote Events answer/terminal. Second round verifies cursor reconnection and conversation memory. Deletes only after all earlier checks succeed. No Prompt retries or role assumption. Secondary mode alternates Prompt/Events across servers and renames on B, reads back on A. Reports default to a private temporary directory. For owned-process restart use managed.mjs.';
export function parseOptions(argv) {
  return parseArgs({ args: argv, options: {
    'base-url': { type: 'string' }, 'secondary-base-url': { type: 'string' },
    'prompt-server': { type: 'string', default: 'alternate' },
    model: { type: 'string' }, 'reasoning-effort': { type: 'string' },
    mode: { type: 'string', default: 'yolo' }, region: { type: 'string', default: 'cn-beijing' },
    language: { type: 'string' }, 'output-dir': { type: 'string' }, help: { type: 'boolean' },
  } }).values;
}
export function validateBase(value) {
  assert.ok(value, '--base-url is required');
  const base = value.replace(/\/$/, '');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid base URL');
  return base;
}
function cursor(value) {
  assert.match(String(value), /^\d+$/, 'invalid remote cursor');
  assert.ok(Number.isSafeInteger(Number(value)), 'unsafe remote cursor');
  return String(value);
}
// Streaming lines preserve split UTF-8 and CRLF (including a CR/LF split across chunks).
export async function* lines(body) {
  assert.ok(body, 'missing stream body');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        yield buffer.slice(0, boundary).replace(/\r$/, '');
        buffer = buffer.slice(boundary + 1);
      }
      if (done) break;
    }
    if (buffer) yield buffer.replace(/\r$/, '');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function consumeOwned(response, sessionId, diagnostics = {}) {
  diagnostics.httpStatus = response.status;
  diagnostics.framesReceived = 0;
  assert.equal(response.status, 200, 'owned Prompt HTTP failure');
  assert.match(response.headers.get('content-type') ?? '', /application\/x-ndjson/);
  let rid; let done = false; let count = 0;
  for await (const line of lines(response.body)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error('invalid owned NDJSON (payload omitted)'); }
    assert.ok(!done, 'owned data after done');
    if (event.type === 'error') {
      diagnostics.errorKind = /^[a-z_]{1,64}$/.test(event.error?.kind ?? '') ? event.error.kind : 'unknown';
      throw new Error('owned Prompt error (no retry)');
    }
    if (event.type === 'hb') continue;
    if (event.type === 'meta') {
      assert.equal(rid, undefined, 'duplicate owned meta');
      assert.equal(event.sessionId, sessionId, 'owned session mismatch');
      assert.equal(event.mock, false, 'MOCK owned Prompt cannot pass');
      assert.ok(typeof event.rid === 'string' && event.rid, 'missing owned rid');
      rid = event.rid;
      diagnostics.rid = rid;
    } else if (event.type === 'frame' || event.type === 'done') {
      // A pre-meta frame can legitimately lack rid; done cannot.
      if (rid !== undefined) assert.equal(event.rid, rid, 'owned rid mismatch');
      if (event.type === 'done') {
        assert.ok(rid, 'done without owned meta');
        assert.equal(event.stopReason, 'end_turn', 'owned Prompt did not complete normally');
        done = true;
      } else {
        count++;
        diagnostics.framesReceived = count;
        if (Number.isSafeInteger(event.offset)) diagnostics.lastOffset = event.offset;
      }
    } else throw new Error('unknown owned wire event');
  }
  assert.ok(done, 'owned stream ended without done (no retry)');
  return { rid, frameCount: count, stopReason: 'end_turn' };
}
// Diagnostics contain event/schema names only, never payload values or upstream messages.
function eventShape(event) {
  const name = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : '<invalid>';
  const data = event?.data;
  return JSON.stringify({ type: name(event?.type), dataKeys: data && typeof data === 'object' && !Array.isArray(data)
    ? Object.keys(data).sort().slice(0, 24).map(name) : [],
    dataKind: data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data });
}
const BUSINESS_EVENTS = new Set(['session_update', 'turn_complete', 'turn_error', 'permission_request',
  'permission_resolved', 'permission_already_resolved', 'prompt_cancelled']);
const FAILED_STREAM_EVENTS = new Set(['stream_error', 'session_died', 'session_closed', 'state_resync_required', 'client_evicted']);
export async function consumeEvents(response, sessionId, expected, after) {
  assert.equal(response.status, 200, 'Events HTTP failure');
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  let block = []; let answer = ''; let lastEventId; let count = 0; let terminal = false;
  let controlCount = 0; const controlShapes = []; let lastShape;
  for await (const line of lines(response.body)) {
    if (line !== '') { block.push(line); continue; }
    const data = block.filter(item => item.startsWith('data:')).map(item => item.slice(5).trimStart()).join('\n');
    const sseId = block.filter(item => item.startsWith('id:')).at(-1)?.slice(3).trim();
    block = [];
    if (!data) continue;
    let event;
    try { event = JSON.parse(data); } catch { throw new Error('invalid remote event JSON'); }
    const shape = eventShape(event); lastShape = shape;
    try {
      assert.ok(event && typeof event.type === 'string' && event.type && event.data
        && typeof event.data === 'object' && !Array.isArray(event.data), 'invalid remote event envelope');
      // A declared subject is always checked, including controls. Missing subjects
      // are valid for stream_open/replay_complete/subscriber status, not business data.
      for (const subject of [event.sessionId, event.data?.sessionId]) {
        if (subject !== undefined) assert.ok(subject === sessionId, 'remote event session mismatch');
      }
      if (event._meta?.source === 'workbench_prompt_result') continue;
      if (FAILED_STREAM_EVENTS.has(event.type)) throw new Error('remote subscription failed or requires resync');
      const business = BUSINESS_EVENTS.has(event.type) || event.data?.update !== undefined
        || event.data?.stopReason !== undefined;
      if (!business) {
        controlCount++;
        if (controlShapes.length < 16 && !controlShapes.includes(shape)) controlShapes.push(shape);
        // These frames are neither Prompt proof nor a verified business replay cursor.
        continue;
      }
      assert.ok(event.data?.sessionId === sessionId, 'remote business event requires matching sessionId');
      if (sseId !== undefined && event.id !== undefined) assert.equal(String(event.id), sseId, 'SSE and payload cursors differ');
      const eventId = event.id ?? sseId;
      if (eventId !== undefined) {
        const id = cursor(eventId);
        if (after !== undefined) assert.ok(Number(id) > Number(cursor(after)), 'replayed an event at/before the requested cursor');
        if (lastEventId !== undefined) assert.ok(Number(id) >= Number(lastEventId), 'remote cursor moved backwards');
        lastEventId = id;
      } else if (after !== undefined) assert.fail('cursor reconnect cannot be verified without remote event IDs');
      count++;
      if (event.type === 'turn_error') throw new Error('remote turn_error');
      if (event.type === 'permission_request') throw new Error('unexpected permission request in harmless text fixture');
      const update = event.data?.update;
      if (event.type === 'session_update' && update?.sessionUpdate === 'agent_message_chunk') answer += update.content?.text ?? '';
      if (event.type === 'turn_complete') {
        assert.equal(event.data?.stopReason, 'end_turn', 'remote turn did not complete normally');
        terminal = true; break;
      }
    } catch (error) { throw new Error(`${String(error.message).split('\n')[0]}; eventShape=${shape}`); }
  }
  assert.ok(terminal, `remote stream ended without terminal; eventShape=${lastShape ?? 'none'}`);
  assert.ok(answer.includes(expected), `expected remote assistant answer missing; eventShape=${lastShape ?? 'none'}`);
  return { answer, lastEventId, eventCount: count, controlCount, controlShapes, stopReason: 'end_turn' };
}

export async function runHarness(args, { beforeFollowup, beforePrompt, lifecycle = null, timeoutMs = 150_000 } = {}) {
  const base = validateBase(args['base-url']);
  const secondary = args['secondary-base-url'] ? validateBase(args['secondary-base-url']) : null;
  if (secondary === base) throw new Error('secondary must be a different server URL');
  if (args.language && !['node', 'python', 'java'].includes(args.language)) throw new Error('Invalid --language');
  const promptServer = args['prompt-server'] ?? 'alternate';
  assert.ok(['primary', 'secondary', 'alternate'].includes(promptServer), 'Invalid --prompt-server');
  assert.ok(secondary || promptServer !== 'secondary', '--prompt-server secondary requires a secondary server');
  process.umask(0o077);
  // User-selected reports must also stay outside the checkout; raw reports are never release inputs.
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const output = args['output-dir'] ? path.resolve(args['output-dir']) : fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-openapi-e2e-'));
  const resolvedOutput = fs.existsSync(output) ? fs.realpathSync(output)
    : path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  const relative = path.relative(fs.realpathSync(repo), resolvedOutput);
  assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'raw reports must be outside the checkout');
  if (args['output-dir']) fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  const tree = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  const report = { at: new Date().toISOString(), base, secondaryBase: secondary, region: args.region ?? 'cn-beijing',
    language: args.language ?? null, promptServer, lifecycle,
    harnessSource: { sha: revision.status === 0 ? revision.stdout.trim() : null, dirty: tree.status === 0 ? !!tree.stdout.trim() : null },
    requestedSettings: { mode: args.mode ?? 'yolo', model: args.model ?? null, reasoningEffort: args['reasoning-effort'] ?? null },
    status: 'RUNNING', checks: [], rounds: [] };
  const persist = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  persist();
  const request = async (url, method = 'GET', body, server = base) => {
    const response = await fetch(`${server}${url}`, { method, headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
    const value = await response.json();
    assert.ok(response.ok && value.ok !== false, `${method} ${url}: HTTP/business failure`);
    return value;
  };
  const remoteSessions = async (server = base) => {
    const { result } = await request('/api/sessions', 'GET', undefined, server);
    assert.ok(Array.isArray(result?.sessions), 'missing remote sessions');
    assert.notEqual(result.truncated, true, 'incomplete remote list');
    return result.sessions;
  };
  const check = async (name, run) => {
    const item = { name, status: 'RUNNING', startedAt: new Date().toISOString() }; report.checks.push(item); persist();
    try { await run(); item.status = 'PASS'; }
    catch (error) { item.status = 'FAIL'; item.error = String(error.message).slice(0, 1200); throw error; }
    finally { persist(); console.log(`${item.status}: ${name}`); }
  };
  let sessionId;
  try {
    await check('LIVE environment and same configured Agent on all servers', async () => {
      for (const server of [base, ...(secondary ? [secondary] : [])]) {
        const health = (await request('/api/health', 'GET', undefined, server)).result;
        assert.equal(health.mock, false, 'MOCK cannot pass cloud acceptance');
        assert.equal(health.region, report.region);
        const defaults = await request('/d/openapi/session-options', 'GET', undefined, server);
        assert.ok(defaults.agentName);
        if (report.agentName) assert.equal(defaults.agentName, report.agentName, 'server Agent mismatch');
        report.agentName = defaults.agentName;
      }
    });
    await check('CreateAgentSession on primary with selected settings', async () => {
      const created = await request('/d/standalone/sessions', 'POST', {
        approvalMode: report.requestedSettings.mode, ...(args.model ? { modelServiceId: args.model } : {}),
        ...(args['reasoning-effort'] ? { reasoningEffort: args['reasoning-effort'] } : {}),
      });
      assert.ok(typeof created.sessionId === 'string' && created.sessionId);
      sessionId = created.sessionId; report.sessionId = sessionId;
    });
    const sid = encodeURIComponent(sessionId);
    const marker = `WB_${randomUUID().replaceAll('-', '')}`;
    const promptRound = async (expected, after, text) => {
      const round = report.rounds.length;
      const useSecondary = secondary && (promptServer === 'secondary' || promptServer === 'alternate' && round % 2 === 1);
      const promptBase = useSecondary ? secondary : base;
      const eventsBase = secondary ? (useSecondary ? base : secondary) : base;
      const route = { promptBase, eventsBase, after: after ?? null, promptRequests: 0 };
      report.rounds.push(route); persist();
      if (beforePrompt) await beforePrompt({ round, sessionId });
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
      const guarded = fn => fn().catch(error => { controller.abort(); throw error; });
      try {
        // Subscribe first; receiving SSE headers proves the subscription was admitted.
        const events = await fetch(`${eventsBase}/d/session/${sid}/events`, {
          headers: after !== undefined ? { 'Last-Event-Id': cursor(after) } : {}, signal,
        });
        // Reject a failed subscription before invoking any writing request.
        // An async consumer's rejection alone may arrive after POST was dispatched.
        if (events.status !== 200 || !/text\/event-stream/.test(events.headers.get('content-type') ?? '')) {
          await events.body?.cancel();
          throw new Error('Events subscription rejected before Prompt; no write dispatched');
        }
        const remote = guarded(() => consumeEvents(events, sessionId, expected, after));
        // Exactly one POST; EOF/error must never call this operation again.
        const owned = guarded(async () => {
          route.promptRequests++; persist();
          const response = await fetch(`${promptBase}/api/sessions/${sid}/prompt`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal,
          });
          return consumeOwned(response, sessionId, route.diagnostics = {});
        });
        const results = await Promise.allSettled([owned, remote]);
        route.ownedStatus = results[0].status; route.remoteStatus = results[1].status;
        const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, `owned Prompt/remote Events failed: ${failures.map(error => error.message).join('; ')}`);
        route.owned = results[0].value;
        const received = results[1].value;
        route.remote = { lastEventId: received.lastEventId, eventCount: received.eventCount,
          controlCount: received.controlCount, controlShapes: received.controlShapes, stopReason: received.stopReason };
        report.lastEventId = received.lastEventId;
        return received.answer;
      } finally { controller.abort(); persist(); }
    };
    let completedAnswer;
    await check('Owned NDJSON done AND independent remote Events answer/terminal', async () => {
      completedAnswer = await promptRound(marker, undefined, `请记住本会话的测试字符串：${marker}。本轮只回复该字符串，不执行工具。`);
    });
    const load = async (server = secondary ?? base) => {
      const loaded = await request(`/d/standalone/sessions/${sid}/load`, 'POST', {}, server);
      const answer = [...loaded.compactedReplay, ...loaded.liveJournal]
        .filter(event => event.type === 'session_update' && event.data?.update?.sessionUpdate === 'agent_message_chunk')
        .map(event => event.data.update.content?.text ?? '').join('');
      assert.ok(answer.includes(completedAnswer), 'completed assistant answer missing from Load history');
    };
    await check('LoadAgentSession retains completed answer on other server', () => load());
    await check('CancelAgentSession succeeds for completed idle session', async () => {
      const response = await fetch(`${secondary ?? base}/d/session/${sid}/cancel`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(timeoutMs),
      });
      try { assert.equal(response.status, 204, 'idle cancel must succeed'); }
      finally { await response.body?.cancel(); }
    });
    if (beforeFollowup) {
      await check('Restart only runner-owned servers', async () => { report.restart = await beforeFollowup({ sessionId }); });
      // Leave the follow-up Prompt server cold: load on the opposite process.
      const followupOnSecondary = secondary && promptServer !== 'primary';
      await check('Load after backend restart without local session map', () => load(followupOnSecondary ? base : secondary ?? base));
    }
    await check('Cursor reconnect and second owned Prompt retain conversation memory', async () => {
      cursor(report.lastEventId);
      const nonce = `FOLLOWUP_${randomUUID().replaceAll('-', '')}`;
      await promptRound(`${nonce}:${marker}`, report.lastEventId,
        `请先输出本轮标识 ${nonce}，再输出英文冒号，再输出上一轮让我记住的测试字符串。只回复这一行，不执行工具。`);
    });
    await check('Rename on other server persists in primary remote list', async () => {
      const title = `Workbench E2E ${randomUUID().slice(0, 8)}`;
      await request(`/d/standalone/sessions/${sid}/metadata`, 'PATCH', { displayName: title }, secondary ?? base);
      assert.ok((await remoteSessions()).some(item => item.sessionId === sessionId && item.title === title));
    });
    await check('Archive and restore persist across servers', async () => {
      const archived = await request('/d/standalone/sessions/archive', 'POST', { sessionIds: [sessionId] }, secondary ?? base);
      assert.ok(archived.archived.includes(sessionId));
      assert.ok((await request('/d/standalone/sessions?archiveState=archived')).sessions.some(item => item.sessionId === sessionId));
      assert.ok(!(await remoteSessions()).some(item => item.sessionId === sessionId), 'archived session remains active');
      const restored = await request('/d/standalone/sessions/unarchive', 'POST', { sessionIds: [sessionId] });
      assert.ok(restored.unarchived.includes(sessionId));
      assert.ok((await remoteSessions(secondary ?? base)).some(item => item.sessionId === sessionId), 'restored session missing');
    });
    await check('Delete removes test session in other servers remote list', async () => {
      const deleted = await request('/d/standalone/sessions/delete', 'POST', { sessionIds: [sessionId] });
      assert.ok(deleted.removed.includes(sessionId));
      assert.ok(!(await remoteSessions(secondary ?? base)).some(item => item.sessionId === sessionId), 'deleted session remains');
    });
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.error = String(error.message).slice(0, 1500);
  } finally { persist(); console.log(JSON.stringify({ status: report.status, sessionId, output, error: report.error })); }
  return { report, output };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseOptions(process.argv.slice(2));
  if (args.help) console.log(HELP);
  else { const { report } = await runHarness(args); if (report.status !== 'PASS') process.exitCode = 1; }
}
