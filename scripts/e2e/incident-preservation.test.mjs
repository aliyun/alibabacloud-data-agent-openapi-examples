import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { runSoak } from './soak.mjs';
import { observeTransport } from './transport-diagnostics.mjs';
import { consumeOwned } from './run.mjs';

for (const fails of [true, false]) test(`idle runner preserves first failure without further operations (failure=${fails})`, async () => {
  let stopped = 0; let detached = 0; let calls = 0;
  const waits = [];
  const report = await runSoak({ region: 'synthetic', idleSeconds: [0, 45, 75] }, {
    start: async () => ({ pid: 12345, base: 'http://127.0.0.1:1', stop: async () => { stopped++; }, unref: () => { detached++; } }),
    run: async (_, hooks) => {
      calls++;
      await hooks.beforePrompt({ round: 0 }); await hooks.beforePrompt({ round: 1 });
      return { report: { status: fails ? 'FAIL' : 'PASS', sessionId: `test-${calls}` }, output: 'synthetic-evidence' };
    }, wait: async ms => { waits.push(ms); },
  });
  try {
    assert.equal(calls, fails ? 1 : 3);
    assert.equal(stopped, fails ? 0 : 1);
    assert.equal(detached, fails ? 1 : 0);
    assert.equal(report.cleanup, fails ? 'PRESERVED' : 'PASS');
    assert.equal(report.status, fails ? 'FAIL' : 'PASS');
    assert.deepEqual(waits, fails ? [0] : [0, 45_000, 75_000]);
    const saved = JSON.parse(fs.readFileSync(`${report.output}/summary.json`));
    assert.equal(saved.process.pid, 12345);
    assert.equal(saved.cases[0].sessionId, 'test-1');
  } finally { fs.rmSync(report.output, { recursive: true }); }
});

test('owned stream failure preserves safe frame progress without saving upstream message', async () => {
  const diagnostics = {};
  const response = new Response([
    { type: 'meta', sessionId: 'sid', mock: false, rid: 'rid' },
    { type: 'frame', rid: 'rid', offset: 12, body: { private: 'not-recorded' } },
    { type: 'error', error: { kind: 'transport', message: 'SECRET' } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
  await assert.rejects(consumeOwned(response, 'sid', diagnostics), /no retry/);
  assert.deepEqual(diagnostics, { httpStatus: 200, framesReceived: 1, rid: 'rid', lastOffset: 12, errorKind: 'transport' });
  assert.ok(!JSON.stringify(diagnostics).includes('SECRET'));
});

for (const resets of [false, true]) test(`passive HTTP diagnostics save correlation, never credentials/body/query (reset=${resets})`, async () => {
  const rows = [];
  const release = observeTransport(row => rows.push(row));
  let count = 0;
  const server = http.createServer((req, res) => {
    count++; req.resume();
    if (resets) { req.socket.destroy(); return; }
    res.writeHead(200, { 'x-acs-request-id': 'test-pop-id' }); res.end('private-response');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const request = () => new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${server.address().port}/secret-path?token=private-query`, {
        method: 'POST', headers: { 'x-acs-action': 'PromptAgentSession', authorization: 'private-auth', connection: 'close' },
      }, res => { res.resume(); res.once('end', resolve); });
      req.once('error', reject); req.end('private-request');
    });
    if (resets) await assert.rejects(request(), { code: 'ECONNRESET' }); else await request();
    assert.equal(count, 1);
    assert.ok(rows.some(row => row.event === 'request_start' && row.action === 'PromptAgentSession'));
    assert.ok(rows.some(row => row.event === 'socket'));
    assert.ok(rows.some(row => resets ? row.event === 'request_error' && row.code === 'ECONNRESET'
      : row.event === 'response_headers' && row.requestId === 'test-pop-id'));
    assert.ok(rows.every(row => typeof row.requestNo === 'string' && typeof row.reusedSocket === 'boolean'));
    assert.doesNotMatch(JSON.stringify(rows), /secret-path|private-query|private-auth|private-request|private-response|authorization/i);
  } finally { release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
