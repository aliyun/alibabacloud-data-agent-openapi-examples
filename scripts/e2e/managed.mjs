// Two disposable backend processes. Only process groups spawned here may be stopped.
// No frontend is started, no existing port/process is adopted, and no credential is logged.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHarness, parseOptions } from './run.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}
async function assertFree(port) {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', () => reject(new Error('runner-owned port is occupied; refusing to adopt/stop its occupant')));
    listener.listen(port, '127.0.0.1', resolve);
  });
  await new Promise(resolve => listener.close(resolve));
}
export async function startOwned({ command, args, cwd = repo, env = process.env, port, startupMs = 120_000 }) {
  assert.notEqual(process.platform, 'win32', 'managed runner requires POSIX process groups; use run.mjs for existing servers on Windows');
  await assertFree(port);
  const child = spawn(command, args, { cwd, env: { ...env, PORT: String(port), SERVER_HOST: '127.0.0.1' },
    detached: true, stdio: 'ignore' });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const base = `http://127.0.0.1:${port}`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // The only PID/group used here is returned by this spawn, never discovered by port.
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close').catch(() => {});
    const kill = signal => {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    kill('SIGTERM');
    let timer;
    try {
      const exited = await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
      if (!exited) {
        kill('SIGKILL');
        await Promise.race([closed, pause(2000)]);
        assert.ok(child.exitCode !== null || child.signalCode !== null, 'runner-owned process did not stop');
      }
    } finally { clearTimeout(timer); }
  };
  try {
    const deadline = Date.now() + startupMs;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('runner-owned backend exited before readiness; no other process was adopted');
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
        const body = await response.json();
        if (response.ok && body.ok !== false && body.result?.mock === false) {
          if (child.exitCode !== null || child.signalCode !== null) throw new Error('runner-owned backend exited during readiness');
          return { base, port, pid: child.pid, stop, unref: () => child.unref() };
        }
      } catch { /* Only readiness GET is retried, never a business write. */ }
      await pause(100);
    }
    throw new Error('runner-owned LIVE backend readiness timeout');
  } catch (error) { await stop(); throw error; }
}

export async function runManaged(args) {
  assert.ok(['node', 'python', 'java'].includes(args.language), 'managed.mjs requires --language node|python|java');
  assert.ok(!args['base-url'] && !args['secondary-base-url'], 'managed.mjs allocates its own ports; existing servers cannot be adopted');
  const owned = [];
  const ports = [await unusedPort()];
  do { ports[1] = await unusedPort(); } while (ports[1] === ports[0]);
  const lifecycle = { kind: 'runner-owned-two-server-restart', generations: [], cleanup: 'RUNNING' };
  let outcome;
  let stopping;
  const stopAll = async () => {
    const results = await Promise.allSettled(owned.map(server => server.stop()));
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'runner-owned process cleanup failed');
  };
  const interrupt = () => {
    // Abort rather than start/retry any business operation. Report remains interrupted/failed.
    if (stopping) return;
    stopping = stopAll().finally(() => process.exit(130));
  };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const startPair = async () => {
    const generation = [];
    for (const port of ports) {
      const server = await startOwned({ command: 'bash', args: ['scripts/dev-server.sh', args.language],
        env: { ...process.env, MOCK: '0' }, port });
      owned.push(server);
      generation.push({ pid: server.pid, base: server.base });
    }
    lifecycle.generations.push(generation);
    return generation;
  };
  try {
    const pair = await startPair();
    outcome = await runHarness({ ...args, 'base-url': pair[0].base, 'secondary-base-url': pair[1].base }, {
      lifecycle,
      beforeFollowup: async () => {
        await stopAll();
        const next = await startPair();
        return { restarted: true, oldPids: pair.map(server => server.pid), newPids: next.map(server => server.pid) };
      },
    });
    return outcome;
  } finally {
    try { await stopAll(); lifecycle.cleanup = 'PASS'; }
    catch (error) {
      lifecycle.cleanup = 'FAIL';
      if (outcome) { outcome.report.status = 'FAIL'; outcome.report.error = 'runner-owned process cleanup failed'; }
      throw error;
    } finally {
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      if (outcome) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(path.join(outcome.output, 'result.json'), JSON.stringify(outcome.report, null, 2), { mode: 0o600 });
      }
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseOptions(process.argv.slice(2));
  if (args.help) console.log('node scripts/e2e/managed.mjs --language node|python|java [--region REGION] [--model MODEL] [--mode yolo] [--reasoning-effort none] [--output-dir NEW_DIR]\nRun only after explicit cloud-write authorization: starts two disposable LIVE backends on dynamic ports, restarts both after the first completed prompt, loads history and sends the second prompt with the same SID. Same server-side environment as dev-server.sh (DAS_ENV). Never starts a frontend or kills a process found by port. Install/build dependencies beforehand. stdout/stderr of owned backends are discarded; report contains only harness/lifecycle metadata.');
  else { const { report } = await runManaged(args); if (report.status !== 'PASS') process.exitCode = 1; }
}
