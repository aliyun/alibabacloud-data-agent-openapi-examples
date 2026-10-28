import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assumeRole, createStsClient, loadEnvironment, main, runCommand } from '../assume-role.mjs';

const script = fileURLToPath(new URL('../assume-role.mjs', import.meta.url));
const now = () => Date.parse('2030-01-01T00:00:00Z');
const caller = Object.freeze({
  ALIBABA_CLOUD_ACCESS_KEY_ID: 'synthetic-caller-ak',
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'synthetic-caller-sk',
  ALIBABA_CLOUD_SECURITY_TOKEN: 'synthetic-caller-token',
  DATAAGENT_ROLE_ARN: 'acs:ram::1234567890123456:role/example',
  DATAAGENT_SOURCE_IDENTITY: 'trusted-subject',
});
const credentials = Object.freeze({
  AccessKeyId: 'synthetic-role-ak', AccessKeySecret: 'synthetic-role-sk',
  SecurityToken: 'synthetic-role-token', Expiration: '2030-01-01T01:00:00Z',
});
const response = () => ({ body: { Credentials: { ...credentials }, SourceIdentity: caller.DATAAGENT_SOURCE_IDENTITY } });
const secretText = [...Object.values(caller), ...Object.values(credentials).slice(0, 3)].join(' ');

function temporaryDirectory(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'assume-role-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function mockSts(reply = response()) {
  const calls = [];
  const configs = [];
  return {
    calls, configs,
    createClient(config) {
      configs.push(config);
      return { async callApi(...args) {
        calls.push(args);
        if (reply instanceof Error) throw reply;
        return reply;
      } };
    },
  };
}

function processHarness({ autoExit = true, exitCode = 0, exitSignal = null, onKill } = {}) {
  const processObject = new EventEmitter();
  processObject.platform = 'linux';
  const child = new EventEmitter();
  child.pid = 987654;
  const calls = [];
  const kills = [];
  let alive = true;
  function exit(code = exitCode, signal = exitSignal) {
    alive = false;
    child.emit('exit', code, signal);
  }
  processObject.kill = (pid, signal) => {
    assert.equal(pid, -child.pid);
    if (!alive) throw Object.assign(new Error('no process'), { code: 'ESRCH' });
    if (signal !== 0) {
      kills.push(signal);
      onKill?.(signal, exit);
    }
  };
  return {
    child, processObject, calls, kills, exit,
    spawnProcess(...args) {
      calls.push(args);
      if (autoExit) queueMicrotask(() => exit());
      return child;
    },
  };
}

function outputCapture() {
  let out = '';
  let err = '';
  return {
    stdout: { write(value) { out += value; } },
    stderr: { write(value) { err += value; } },
    get out() { return out; }, get err() { return err; },
    assertNoSecrets() {
      for (const secret of secretText.split(' ')) assert.ok(!(out + err).includes(secret));
    },
  };
}

test('import and help have no CLI, STS, environment, or process-launch side effects', async () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const before = { ...process.env };
    const listeners = process.eventNames().map(name => [name, process.listenerCount(name)]);
    await import(${JSON.stringify(new URL('../assume-role.mjs', import.meta.url).href)});
    assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(before), 'import changed environment');
    assert.deepEqual(process.eventNames().map(name => [name, process.listenerCount(name)]), listeners);
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
  const output = outputCapture();
  assert.deepEqual(await main(['--help'], {
    env: {}, ...output,
    createClient() { assert.fail('help must not construct STS client'); },
    spawnProcess() { assert.fail('help must not launch a process'); },
  }), { code: 0, signal: null });
  assert.match(output.out, /no automatic renewal/i);
  assert.match(output.out, /Does not create a business Agent/);
});

test('selected dotenv is standalone, override:false, silent, read-only, and preserves parent env', (t) => {
  const cwd = temporaryDirectory(t);
  writeFileSync(path.join(cwd, '.env'), 'DEFAULT_ONLY=must-not-load\n');
  const contents = 'ALIBABA_CLOUD_ACCESS_KEY_ID=file-ak\nALIBABA_CLOUD_ACCESS_KEY_SECRET=file-sk\nDATAAGENT_ROLE_ARN=file-role\nDAS_ENV=must-not-switch\nFILE_ONLY=selected\n';
  writeFileSync(path.join(cwd, '.env.demo'), contents);
  const env = Object.freeze({ DAS_ENV: 'demo', ALIBABA_CLOUD_ACCESS_KEY_ID: 'shell-ak', DATAAGENT_ROLE_ARN: '' });
  const before = { ...process.env };
  const loaded = loadEnvironment({ env, cwd });
  assert.equal(loaded.ALIBABA_CLOUD_ACCESS_KEY_ID, 'shell-ak');
  assert.equal(loaded.ALIBABA_CLOUD_ACCESS_KEY_SECRET, 'file-sk');
  assert.equal(loaded.DATAAGENT_ROLE_ARN, '');
  assert.equal(loaded.FILE_ONLY, 'selected');
  assert.equal(loaded.DEFAULT_ONLY, undefined);
  assert.equal(loaded.DAS_ENV, 'demo');
  assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(before), 'dotenv changed parent environment');
  assert.equal(env.ALIBABA_CLOUD_ACCESS_KEY_SECRET, undefined);
  assert.equal(readFileSync(path.join(cwd, '.env.demo'), 'utf8'), contents);
  loadEnvironment({ env, cwd, loadDotenv(options) {
    assert.equal(options.override, false);
    assert.equal(options.quiet, true);
    assert.equal(options.debug, false);
    assert.notEqual(options.processEnv, env);
    assert.equal(options.path, path.join(cwd, '.env.demo'));
    return {};
  } });
});

test('default .env cannot redirect a child; absent default file allows explicit server env', (t) => {
  const cwd = temporaryDirectory(t);
  assert.equal(loadEnvironment({ env: caller, cwd }).DATAAGENT_ROLE_ARN, caller.DATAAGENT_ROLE_ARN);
  writeFileSync(path.join(cwd, '.env'), 'DAS_ENV=other\nFROM_DEFAULT=yes\n');
  const env = loadEnvironment({ env: {}, cwd });
  assert.equal(env.DAS_ENV, '');
  assert.equal(env.FROM_DEFAULT, 'yes');
});

test('missing selected file, unsafe selector, and loader errors fail without fallback or raw diagnostics', (t) => {
  const cwd = temporaryDirectory(t);
  writeFileSync(path.join(cwd, '.env'), 'DATAAGENT_ROLE_ARN=fallback\n');
  for (const DAS_ENV of ['missing', '../outside', '/outside', 'x\ny']) {
    assert.throws(() => loadEnvironment({ env: { DAS_ENV }, cwd }), /Cannot load/);
  }
  assert.throws(() => loadEnvironment({ env: {}, cwd, loadDotenv() { throw new Error(secretText); } }),
    (error) => !error.message.includes('synthetic') && error.cause === undefined);
});

test('official SDK request passes role/source exactly, uses fixed STS HTTPS and disables client retries', async () => {
  const sts = mockSts();
  const before = { ...process.env };
  const result = await assumeRole(caller, { ...sts, now });
  assert.equal(sts.configs.length, 1);
  const config = sts.configs[0];
  assert.equal(config.endpoint, 'sts.aliyuncs.com');
  assert.equal(config.protocol, 'https');
  assert.equal(config.retryOptions.retryable, false);
  assert.equal(config.accessKeyId, caller.ALIBABA_CLOUD_ACCESS_KEY_ID);
  assert.equal(config.accessKeySecret, caller.ALIBABA_CLOUD_ACCESS_KEY_SECRET);
  assert.equal(config.securityToken, caller.ALIBABA_CLOUD_SECURITY_TOKEN);
  assert.equal(config.credential, undefined);
  assert.equal(sts.calls.length, 1);
  const [params, request, runtime] = sts.calls[0];
  assert.equal(params.action, 'AssumeRole');
  assert.equal(params.version, '2015-04-01');
  assert.equal(params.style, 'RPC');
  assert.equal(params.method, 'POST');
  assert.equal(params.protocol, 'HTTPS');
  assert.equal(params.authType, 'AK');
  assert.equal(params.bodyType, 'json');
  assert.deepEqual(request.query, {
    RoleArn: caller.DATAAGENT_ROLE_ARN, SourceIdentity: caller.DATAAGENT_SOURCE_IDENTITY,
    RoleSessionName: 'dataagent-example', DurationSeconds: 3600,
  });
  assert.equal(runtime.autoretry, false);
  assert.equal(runtime.maxAttempts, 1);
  assert.equal(result.env.ALIBABA_CLOUD_ACCESS_KEY_ID, credentials.AccessKeyId);
  assert.equal(result.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET, credentials.AccessKeySecret);
  assert.equal(result.env.ALIBABA_CLOUD_SECURITY_TOKEN, credentials.SecurityToken);
  assert.equal(result.expiration, '2030-01-01T01:00:00.000Z');
  assert.notEqual(result.env, caller);
  assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(before), 'STS changed parent environment');
  // Construct the installed official SDK without a network request, exercising CJS interop.
  const client = createStsClient(config);
  assert.equal(typeof client.callApi, 'function');
  assert.equal(client._retryOptions.retryable, false);
  assert.equal(await client.getAccessKeyId(), caller.ALIBABA_CLOUD_ACCESS_KEY_ID);
});

test('optional SourceIdentity is not guessed from UID, role ARN, or response', async () => {
  const env = { ...caller, DATAAGENT_SOURCE_IDENTITY: undefined, ALIBABA_CLOUD_SECURITY_TOKEN: undefined, UID: '1234' };
  const sts = mockSts({ body: { Credentials: { ...credentials } } });
  await assumeRole(env, { ...sts, now });
  assert.equal(Object.hasOwn(sts.calls[0][1].query, 'SourceIdentity'), false);
  assert.equal(sts.configs[0].securityToken, undefined);
});

test('invalid input fails before client creation; blank shell values never trigger fallback', async () => {
  for (const field of ['DATAAGENT_ROLE_ARN', 'ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET']) {
    for (const value of [undefined, '', '   ']) {
      await assert.rejects(assumeRole({ ...caller, [field]: value }, {
        createClient() { assert.fail('must reject before constructing client'); }, now,
      }));
    }
  }
});

test('SDK failure is sanitized, has no cause, and is attempted exactly once', async () => {
  const sts = mockSts(Object.assign(new Error(secretText), { data: { credentials }, code: secretText }));
  await assert.rejects(assumeRole(caller, { ...sts, now }), (error) => {
    assert.match(error.message, /AssumeRole failed/);
    assert.equal(error.cause, undefined);
    assert.ok(!error.stack.includes('synthetic'));
    return true;
  });
  assert.equal(sts.calls.length, 1);
  await assert.rejects(assumeRole(caller, { now, createClient() { throw new Error(secretText); } }), /AssumeRole failed/);
});

test('incomplete credentials and invalid, normalized, missing, or expired dates fail closed', async (t) => {
  const mutations = [
    ...['AccessKeyId', 'AccessKeySecret', 'SecurityToken'].flatMap((key) =>
      [undefined, '', '  ', 42].map((value) => ({ name: `${key}: ${String(value)}`, edit: (r) => { r.body.Credentials[key] = value; } }))),
    ...[undefined, '', 'invalid', '2030-01-01', '2030-02-30T00:00:00Z',
      '2030-01-01T00:00:00Z', '2029-12-31T23:59:59Z', `${credentials.Expiration}\n${secretText}`]
      .map((value, index) => ({ name: `Expiration case ${index}`, edit: (r) => { r.body.Credentials.Expiration = value; } })),
    { name: 'missing body', edit: (r) => { delete r.body; } },
    { name: 'missing credentials', edit: (r) => { delete r.body.Credentials; } },
  ];
  for (const { name, edit } of mutations) await t.test(name, async () => {
    const reply = response(); edit(reply);
    const sts = mockSts(reply);
    await assert.rejects(assumeRole(caller, { ...sts, now }), /incomplete credentials or an invalid\/expired Expiration/);
    assert.equal(sts.calls.length, 1);
  });
});

test('configured SourceIdentity must match top-level response exactly', async () => {
  for (const identity of [undefined, '', 'different-subject', 'TRUSTED-SUBJECT']) {
    const reply = response();
    reply.body.SourceIdentity = identity;
    reply.body.Credentials.SourceIdentity = caller.DATAAGENT_SOURCE_IDENTITY;
    await assert.rejects(assumeRole(caller, { ...mockSts(reply), now }), /SourceIdentity does not match/);
  }
});

test('CLI passes literal argv and complete role env, retains DAS_ENV, and reports only expiration', async (t) => {
  const cwd = temporaryDirectory(t);
  writeFileSync(path.join(cwd, '.env.demo'), 'END_POINT=selected-backend\n');
  const env = Object.freeze({ ...caller, DAS_ENV: 'demo' });
  const sts = mockSts();
  const child = processHarness({ exitCode: 7 });
  const output = outputCapture();
  const before = { ...process.env };
  const result = await main(['--', 'npm', 'start', '--', 'java', '--literal=$VALUE'], {
    env, cwd, now, ...sts, ...child, ...output,
  });
  assert.deepEqual(result, { code: 7, signal: null });
  assert.equal(sts.calls.length, 1);
  assert.equal(child.calls.length, 1);
  const [command, args, options] = child.calls[0];
  assert.equal(command, 'npm');
  assert.deepEqual(args, ['start', '--', 'java', '--literal=$VALUE']);
  assert.equal(options.shell, false);
  assert.equal(options.detached, true);
  assert.equal(options.cwd, cwd);
  assert.equal(options.env.DAS_ENV, 'demo');
  assert.equal(options.env.END_POINT, 'selected-backend');
  assert.equal(options.env.ALIBABA_CLOUD_ACCESS_KEY_ID, credentials.AccessKeyId);
  assert.equal(options.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET, credentials.AccessKeySecret);
  assert.equal(options.env.ALIBABA_CLOUD_SECURITY_TOKEN, credentials.SecurityToken);
  options.env.ALIBABA_CLOUD_ACCESS_KEY_ID = 'mutation-in-child-test';
  assert.equal(env.ALIBABA_CLOUD_ACCESS_KEY_ID, caller.ALIBABA_CLOUD_ACCESS_KEY_ID);
  assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(before), 'launcher changed parent environment');
  assert.match(output.out, /2030-01-01T01:00:00.000Z/);
  assert.equal(output.err, '');
  output.assertNoSecrets();
  assert.equal(child.processObject.eventNames().length, 0);
});

test('all signing/validation failures stop before spawn, sanitize output, and never fall back', async (t) => {
  const cwd = temporaryDirectory(t);
  const badIdentity = response(); badIdentity.body.SourceIdentity = secretText;
  const badCredentials = response(); delete badCredentials.body.Credentials.SecurityToken;
  for (const reply of [new Error(secretText), badIdentity, badCredentials, null]) {
    const output = outputCapture();
    const sts = mockSts(reply);
    const result = await main(['--', 'unused'], {
      env: caller, cwd, now, ...sts, ...output,
      spawnProcess() { assert.fail('failure must never launch a child'); },
    });
    assert.deepEqual(result, { code: 1, signal: null });
    assert.equal(sts.calls.length, 1);
    assert.equal(output.out, '');
    assert.notEqual(output.err, '');
    output.assertNoSecrets();
  }
});

test('invalid CLI arguments and unsupported platform fail before STS', async (t) => {
  const cwd = temporaryDirectory(t);
  for (const argv of [[], ['npm', 'start'], ['--'], ['--', '  '], ['--role', secretText]]) {
    const output = outputCapture();
    const result = await main(argv, {
      env: caller, cwd, ...output,
      createClient() { assert.fail('no STS for invalid invocation'); },
    });
    assert.equal(result.code, 1);
    output.assertNoSecrets();
  }
  const result = await main(['--', 'npm'], {
    processObject: { platform: 'win32' }, ...outputCapture(),
    createClient() { assert.fail('no STS on unsupported platform'); },
  });
  assert.equal(result.code, 1);
});

test('spawn exceptions and async errors are sanitized, with listeners removed', async (t) => {
  const cwd = temporaryDirectory(t);
  for (const asyncError of [false, true]) {
    const child = processHarness({ autoExit: false });
    const output = outputCapture();
    const result = await main(['--', 'unused'], {
      env: caller, cwd, now, ...mockSts(), ...child, ...output,
      spawnProcess() {
        if (!asyncError) throw new Error(secretText);
        child.child.pid = undefined;
        queueMicrotask(() => child.child.emit('error', new Error(secretText)));
        return child.child;
      },
    });
    assert.equal(result.code, 1);
    assert.match(output.err, /Unable to start/);
    output.assertNoSecrets();
    assert.equal(child.processObject.eventNames().length, 0);
  }
});

test('signals request group cleanup and preserve the original signal outcome', async () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    const child = processHarness({ autoExit: false, onKill: (_signal, exit) => queueMicrotask(() => exit(0, null)) });
    const result = runCommand('unused', [], {}, child);
    child.processObject.emit(signal);
    assert.deepEqual(await result, { code: null, signal });
    assert.deepEqual(child.kills, [signal === 'SIGHUP' || signal === 'SIGQUIT' ? 'SIGTERM' : signal]);
    assert.equal(child.processObject.eventNames().length, 0);
  }
  const child = processHarness({ exitCode: null, exitSignal: 'SIGTERM' });
  assert.deepEqual(await runCommand('unused', [], {}, child), { code: null, signal: 'SIGTERM' });
});

test('uncooperative child is force-killed after grace period; signal status wins over SIGKILL', async () => {
  const child = processHarness({ autoExit: false, onKill: (signal, exit) => {
    if (signal === 'SIGKILL') queueMicrotask(() => exit(null, 'SIGKILL'));
  } });
  const result = runCommand('unused', [], {}, { ...child, graceMs: 10, pollMs: 2 });
  child.processObject.emit('SIGTERM');
  assert.deepEqual(await result, { code: null, signal: 'SIGTERM' });
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.processObject.eventNames().length, 0);
});

test('leader exit cleans up remaining group members before returning its exit status', async () => {
  const child = processHarness({ autoExit: false, onKill: (_signal, exit) => queueMicrotask(() => exit(0, null)) });
  const result = runCommand('unused', [], {}, { ...child, pollMs: 2 });
  // Simulate an exited npm leader with a surviving same-group shell/service.
  child.child.emit('exit', 9, null);
  assert.deepEqual(await result, { code: 9, signal: null });
  assert.deepEqual(child.kills, ['SIGTERM']);
});

async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for synthetic process');
    await delay(20);
  }
}

function running(pid) {
  // Zombies are already dead, but may briefly await reaping on Linux CI hosts.
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() !== '' && !result.stdout.trim().startsWith('Z');
}

test('real POSIX process group: signal stops an owned parent and grandchild, with no backend or STS',
  { skip: process.platform === 'win32', timeout: 10000 }, async (t) => {
    const cwd = temporaryDirectory(t);
    const pidFile = path.join(cwd, 'pids.json');
    const nested = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);
    `;
    const processObject = new EventEmitter();
    processObject.platform = process.platform;
    processObject.kill = process.kill.bind(process);
    let owned;
    const result = runCommand(process.execPath, ['-e', nested], { ...process.env }, {
      cwd, processObject, graceMs: 500, pollMs: 20,
      spawnProcess(...args) { owned = spawn(...args); return owned; },
    });
    t.after(() => { try { process.kill(-owned.pid, 'SIGKILL'); } catch { /* already gone */ } });
    await waitFor(() => existsSync(pidFile));
    const pids = JSON.parse(readFileSync(pidFile, 'utf8'));
    processObject.emit('SIGTERM');
    assert.deepEqual(await result, { code: null, signal: 'SIGTERM' });
    await waitFor(() => pids.every(pid => !running(pid)));
    assert.equal(processObject.eventNames().length, 0);
  });

for (const signal of ['SIGHUP', 'SIGQUIT']) {
  test(`real nested detached launcher: ${signal} cleans services and preserves wrapper exit signal`,
    { skip: process.platform === 'win32', timeout: 15000 }, async (t) => {
      // Remove the directory only after reading its PID registry and cleaning up.
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'assume-role-test-'));
      const pidFile = path.join(cwd, 'nested-pids.json');
      const backendReady = path.join(cwd, 'backend-ready');
      const frontendReady = path.join(cwd, 'frontend-ready');
      // Exercise start.mjs's actual supervision code, without its env loading,
      // preflight, ports, build, backend, or Vite. All children here are synthetic.
      const start = readFileSync(new URL('../start.mjs', import.meta.url), 'utf8');
      const supervision = start.slice(start.indexOf('const children = [];'),
        start.indexOf('\n/**\n * 后端的 spawn'));
      assert.ok(supervision.includes("process.on('SIGTERM'"));
      assert.ok(supervision.includes('detached: true'));
      const service = (readyFile, ignoreTerm) => `
        const { writeFileSync } = require('node:fs');
        ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
        writeFileSync(${JSON.stringify(readyFile)}, 'ready');
        setInterval(() => {}, 1000);
      `;
      const nested = `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const root = process.cwd();
        const env = {};
        ${supervision}
        // A slow/uncooperative backend requires start.mjs's delayed SIGKILL;
        // merely terminating the nested launcher would leave this service alive.
        const backend = launch(process.execPath, ['-e', ${JSON.stringify(service(backendReady, true))}]);
        const frontend = launch(process.execPath, ['-e', ${JSON.stringify(service(frontendReady, false))}]);
        writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, backend.pid, frontend.pid]));
      `;
      const wrapper = `
        import { runCommand } from ${JSON.stringify(new URL('../assume-role.mjs', import.meta.url).href)};
        const result = await runCommand(process.execPath, ['-e', ${JSON.stringify(nested)}], {},
          { cwd: ${JSON.stringify(cwd)} });
        // Same signal restoration contract as the executable CLI.
        if (result.signal) process.kill(process.pid, result.signal);
        else process.exitCode = result.code ?? 1;
      `;
      // Disable core dumps for SIGQUIT; signal only this test-owned wrapper PID.
      const owned = spawn('/bin/sh', ['-c', 'ulimit -c 0; exec "$@"', 'signal-test',
        process.execPath, '--input-type=module', '-e', wrapper],
      { cwd, env: {}, stdio: 'ignore', detached: true });
      const exited = new Promise((resolve, reject) => {
        owned.once('error', reject);
        owned.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
      });
      // Clean all test-created groups even when an assertion fails on the old bug.
      t.after(() => {
        const pids = existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, 'utf8')) : [];
        for (const pid of [...pids, owned.pid]) {
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
          }
        }
        rmSync(cwd, { recursive: true, force: true });
      });
      await waitFor(() => existsSync(pidFile) && existsSync(backendReady) && existsSync(frontendReady));
      const pids = JSON.parse(readFileSync(pidFile, 'utf8'));
      assert.ok(pids.every(running), 'nested launcher and both detached services must be running');
      process.kill(owned.pid, signal);
      assert.deepEqual(await exited, { code: null, signal });
      assert.ok(pids.every(pid => !running(pid)), 'wrapper must await cleanup of both detached services');
    });
}

test('executable CLI rejects malformed invocation without printing argv secrets', () => {
  const result = spawnSync(process.execPath, [script, secretText], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Usage:/);
  assert.ok(!result.stderr.includes('synthetic'));
});
