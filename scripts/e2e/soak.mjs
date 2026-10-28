// Bounded idle/repeat acceptance; first failure preserves the session and owned process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { startOwned, unusedPort } from './managed.mjs';
import { runHarness } from './run.mjs';

export async function runSoak({ region, idleSeconds = [0, 15, 45, 75] },
  { start = startOwned, run = runHarness, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  assert.ok(typeof region === 'string' && region);
  assert.ok(idleSeconds.length > 0 && idleSeconds.length <= 12 && idleSeconds.every(n => Number.isInteger(n) && n >= 0 && n <= 300));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-idle-'));
  fs.chmodSync(output, 0o700);
  const diagnostics = path.join(output, 'transport.jsonl');
  const preload = pathToFileURL(fileURLToPath(new URL('./transport-diagnostics.mjs', import.meta.url))).href;
  const report = { status: 'RUNNING', at: new Date().toISOString(), region, cases: [], output,
    diagnostics, cleanup: 'RUNNING', preservation: 'On first failure: no more Prompt, Cancel, Delete, restart or process stop.' };
  const persist = () => fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  persist();
  let server;
  try {
    server = await start({ command: 'bash', args: ['scripts/dev-server.sh', 'node'], port: await unusedPort(),
      env: { ...process.env, MOCK: '0', WORKBENCH_TRANSPORT_DIAGNOSTICS: diagnostics,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`.trim() } });
    report.process = { pid: server.pid, base: server.base }; persist();
    for (const seconds of idleSeconds) {
      console.log(`Idle regression: ${seconds}s; same owned backend PID ${server.pid}`);
      const item = { idleSeconds: seconds, status: 'RUNNING' }; report.cases.push(item); persist();
      const result = await run({ 'base-url': server.base, language: 'node', region, mode: 'yolo', 'reasoning-effort': 'none' }, {
        beforePrompt: async ({ round }) => { if (round === 1) await wait(seconds * 1000); },
      });
      Object.assign(item, { status: result.report.status, sessionId: result.report.sessionId, evidence: result.output }); persist();
      if (result.report.status !== 'PASS') { report.status = 'FAIL'; break; }
    }
    if (report.status === 'RUNNING') report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL';
    report.failure = { name: error?.name === 'AssertionError' ? 'AssertionError' : 'runner_failure' };
  } finally {
    if (server && report.status !== 'PASS') {
      report.cleanup = 'PRESERVED'; server.unref();
      report.nextStep = 'Inspect saved session and transport metadata before any write. Verify PID identity before stopping this owned process group.';
    } else if (server) {
      try { await server.stop(); report.cleanup = 'PASS'; }
      catch { report.status = 'FAIL'; report.cleanup = 'FAIL'; }
    } else report.cleanup = 'NO_READY_PROCESS';
    persist();
  }
  console.log(JSON.stringify({ status: report.status, output, cleanup: report.cleanup }));
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { region: { type: 'string' }, 'idle-seconds': { type: 'string', default: '0,15,45,75' }, help: { type: 'boolean' } } });
  if (values.help) console.log('node scripts/e2e/soak.mjs --region REGION [--idle-seconds 0,15,45,75]\nUses current server environment and creates two-prompt disposable sessions. Node only; first failure preserves session, owned detached process and private transport metadata. No automatic write retry. Inspect summary.json for retained PID/base. Success deletes its test sessions and stops its own backend.');
  else { const report = await runSoak({ region: values.region, idleSeconds: values['idle-seconds'].split(',').map(Number) }); if (report.status !== 'PASS') process.exitCode = 1; }
}
