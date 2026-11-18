import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));

test('contract runner refuses an occupied healthy port without touching its occupant', async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => { requests++; response.end('{"ok":true}'); });
  const port = await listen(server);
  try {
    const run = spawnSync('bash', ['scripts/contract-test.sh', 'node'], { cwd: root, encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CONTRACT_TEST_PORT: String(port) }, timeout: 10_000 });
    assert.notEqual(run.status, 0); assert.equal(requests, 0); assert.equal(server.listening, true);
  } finally { await close(server); }
});

test('contract runner stops its actual Node backend and releases the owned port', async () => {
  const reservation = net.createServer(); const port = await listen(reservation); await close(reservation);
  const run = spawnSync('bash', ['scripts/contract-test.sh', 'node'], { cwd: root, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CONTRACT_TEST_PORT: String(port) }, timeout: 45_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await close(probe);
});
