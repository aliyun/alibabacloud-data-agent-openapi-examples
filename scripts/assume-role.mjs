#!/usr/bin/env node
// Opt-in, one-shot STS example. No renewal, business Agent creation, or default-start hook.
// node scripts/assume-role.mjs -- npm start -- java
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import OpenApi from '@alicloud/openapi-core';
import { RetryOptions, RuntimeOptions } from '@darabonba/typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const { $OpenApiUtil } = OpenApi;
const Client = typeof OpenApi === 'function' ? OpenApi : OpenApi.default;
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
const messages = {
  usage: 'Usage: node scripts/assume-role.mjs -- <command> [args...]',
  platform: 'This process-group launcher requires macOS or Linux.',
  environment: 'Cannot load the selected .env file; check DAS_ENV and file access.',
  role: 'DATAAGENT_ROLE_ARN must be non-empty in the server environment.',
  caller: 'Set both ALIBABA_CLOUD_ACCESS_KEY_ID and ALIBABA_CLOUD_ACCESS_KEY_SECRET.',
  sts: 'AssumeRole failed; check STS access, role trust, and server configuration. No retry or fallback.',
  credentials: 'STS returned incomplete credentials or an invalid/expired Expiration; command not started.',
  identity: 'STS SourceIdentity does not match the configured value; command not started.',
  child: 'Unable to start or supervise the requested command.',
};

// A closed set of messages: never interpolate SDK exceptions, config, argv, or credentials.
class ExampleError extends Error {
  constructor(kind) { super(messages[kind]); }
}
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

/** Load only the selected file into a COPY. Shell values win, including empty values. */
export function loadEnvironment({ env = process.env, cwd = root, loadDotenv = dotenv.configDotenv } = {}) {
  const selected = env.DAS_ENV?.trim();
  if (selected && !/^[\w.-]+$/.test(selected)) throw new ExampleError('environment');
  const loaded = { ...env };
  try {
    // configDotenv avoids dotenv vault discovery and its diagnostic output.
    const result = loadDotenv({
      path: path.join(cwd, selected ? `.env.${selected}` : '.env'),
      processEnv: loaded,
      override: false,
      quiet: true,
      debug: false,
    });
    if (result.error && (selected || result.error.code !== 'ENOENT')) throw result.error;
  } catch {
    throw new ExampleError('environment');
  }
  // A file must not silently redirect a downstream backend to a different env file.
  loaded.DAS_ENV = env.DAS_ENV ?? '';
  return loaded;
}

/** Injectable factory; explicit credentials prevent a default credential-chain fallback. */
export function createStsClient(config) {
  return new Client(config);
}

/** Issue exactly once. Returned env contains one validated AK/SK/Token snapshot. */
export async function assumeRole(env, { createClient = createStsClient, now = Date.now } = {}) {
  if (!nonEmpty(env.DATAAGENT_ROLE_ARN)) throw new ExampleError('role');
  if (!nonEmpty(env.ALIBABA_CLOUD_ACCESS_KEY_ID) || !nonEmpty(env.ALIBABA_CLOUD_ACCESS_KEY_SECRET)) {
    throw new ExampleError('caller');
  }
  // SourceIdentity is trusted server configuration, never inferred from a UID or ARN.
  const sourceIdentity = nonEmpty(env.DATAAGENT_SOURCE_IDENTITY) ? env.DATAAGENT_SOURCE_IDENTITY : undefined;
  let response;
  try {
    const client = createClient(new $OpenApiUtil.Config({
      accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID,
      accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
      securityToken: nonEmpty(env.ALIBABA_CLOUD_SECURITY_TOKEN) ? env.ALIBABA_CLOUD_SECURITY_TOKEN : undefined,
      endpoint: 'sts.aliyuncs.com',
      protocol: 'https',
      connectTimeout: 10_000,
      readTimeout: 10_000,
      // openapi-core takes retryOptions from Config, not RuntimeOptions.
      retryOptions: new RetryOptions({ retryable: false }),
      globalParameters: new $OpenApiUtil.GlobalParameters({ headers: { connection: 'close' } }),
    }));
    response = await client.callApi(
      new $OpenApiUtil.Params({
        action: 'AssumeRole', version: '2015-04-01', protocol: 'HTTPS',
        pathname: '/', method: 'POST', authType: 'AK', style: 'RPC',
        reqBodyType: 'formData', bodyType: 'json',
      }),
      new $OpenApiUtil.OpenApiRequest({ query: {
        RoleArn: env.DATAAGENT_ROLE_ARN,
        RoleSessionName: 'dataagent-example',
        DurationSeconds: 3600,
        ...(sourceIdentity === undefined ? {} : { SourceIdentity: sourceIdentity }),
      } }),
      new RuntimeOptions({ autoretry: false, maxAttempts: 1, connectTimeout: 10_000, readTimeout: 10_000 }),
    );
  } catch {
    // No cause/raw SDK message: these can include request headers and credential data.
    throw new ExampleError('sts');
  }
  const body = response?.body;
  const credentials = body?.Credentials;
  const expiration = credentials?.Expiration;
  const expiresAt = typeof expiration === 'string' ? Date.parse(expiration) : NaN;
  // Require a real UTC timestamp (Date.parse alone normalizes e.g. February 30).
  if (!credentials || !['AccessKeyId', 'AccessKeySecret', 'SecurityToken'].every((key) => nonEmpty(credentials[key]))
      || !Number.isFinite(expiresAt) || expiresAt <= now()
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(expiration)
      || new Date(expiresAt).toISOString().slice(0, 19) !== expiration.slice(0, 19)) {
    throw new ExampleError('credentials');
  }
  // SourceIdentity is a top-level STS response field, not part of Credentials:
  // https://www.alibabacloud.com/help/en/ram/user-guide/session-tagging-and-fine-grained-access-control-for-assumed-roles-using-sourceidentity
  if (sourceIdentity !== undefined && body.SourceIdentity !== sourceIdentity) throw new ExampleError('identity');
  return {
    expiration: new Date(expiresAt).toISOString(),
    env: {
      ...env,
      ALIBABA_CLOUD_ACCESS_KEY_ID: credentials.AccessKeyId,
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: credentials.AccessKeySecret,
      ALIBABA_CLOUD_SECURITY_TOKEN: credentials.SecurityToken,
    },
  };
}

/**
 * Supervise one POSIX process group, including npm/shell descendants. On leader
 * exit, stop remaining group members too. Allow nested launchers (like start.mjs)
 * time to clean up their own detached services, then force-kill this group.
 * Importing this module never installs listeners or starts a process.
 */
export function runCommand(command, args, env, {
  cwd = root, spawnProcess = spawn, processObject = process,
  graceMs = 3000, pollMs = 50,
} = {}) {
  if (processObject.platform === 'win32') return Promise.reject(new ExampleError('platform'));
  return new Promise((resolve, reject) => {
    let child;
    let outcome;
    let exited = false;
    let failed = false;
    let timer;
    let poll;
    let forced = false;
    let settled = false;
    const handlers = new Map();
    const killGroup = (signal) => {
      if (!child?.pid) return false;
      try { processObject.kill(-child.pid, signal); return true; }
      catch (error) {
        if (error?.code !== 'ESRCH') failed = true;
        return false;
      }
    };
    const onProcessExit = () => { killGroup('SIGKILL'); };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      for (const [signal, handler] of handlers) processObject.removeListener(signal, handler);
      processObject.removeListener('exit', onProcessExit);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      if (failed) reject(new ExampleError('child'));
      else resolve(outcome);
    };
    const check = () => {
      if (settled) return;
      if (exited && (forced || !killGroup(0))) finish();
    };
    const stop = (result, signal) => {
      if (outcome) return;
      outcome = result;
      killGroup(signal);
      // Keep these timers referenced until cleanup finishes, even if the leader exits.
      timer = setTimeout(() => { forced = true; killGroup('SIGKILL'); check(); }, graceMs);
      poll = setInterval(check, pollMs);
      check();
    };
    const onError = () => {
      failed = true;
      // A failed spawn has no pid and will not emit 'exit'.
      if (!child.pid) exited = true;
      stop({ code: 1, signal: null }, 'SIGTERM');
      check();
    };
    const onExit = (code, signal) => {
      exited = true;
      stop({ code, signal }, 'SIGTERM');
      check();
    };
    try {
      child = spawnProcess(command, args, { cwd, env: { ...env }, stdio: 'inherit', shell: false, detached: true });
    } catch {
      reject(new ExampleError('child'));
      return;
    }
    child.once('error', onError);
    child.once('exit', onExit);
    for (const signal of signals) {
      const handler = () => {
        if (outcome) { forced = true; killGroup('SIGKILL'); check(); }
        else {
          // start.mjs handles TERM/INT to stop its separately detached services.
          // HUP/QUIT would kill that launcher before its cleanup can run. Request
          // TERM cleanup, but retain the original signal for our own exit status.
          const childSignal = signal === 'SIGHUP' || signal === 'SIGQUIT' ? 'SIGTERM' : signal;
          stop({ code: null, signal }, childSignal);
        }
      };
      handlers.set(signal, handler);
      processObject.on(signal, handler);
    }
    processObject.once('exit', onProcessExit);
  });
}

export async function main(argv = process.argv.slice(2), {
  env = process.env, cwd = root, createClient = createStsClient, now = Date.now,
  spawnProcess = spawn, processObject = process,
  stdout = process.stdout, stderr = process.stderr,
  graceMs = 3000, pollMs = 50,
} = {}) {
  try {
    if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
      stdout.write(`${messages.usage}\nExample: node scripts/assume-role.mjs -- npm start -- java\n`
        + 'macOS/Linux. Select .env with DAS_ENV; set DATAAGENT_ROLE_ARN and optional DATAAGENT_SOURCE_IDENTITY on the server.\n'
        + 'One issuance, no automatic renewal, retry, or administrator fallback. Does not create a business Agent.\n');
      return { code: 0, signal: null };
    }
    if (argv[0] !== '--' || !nonEmpty(argv[1])) throw new ExampleError('usage');
    if (processObject.platform === 'win32') throw new ExampleError('platform');
    const loaded = loadEnvironment({ env, cwd });
    const assumed = await assumeRole(loaded, { createClient, now });
    stdout.write(`AssumeRole credentials expire at ${assumed.expiration}. One issuance; no automatic renewal.\n`);
    // Child output belongs to the requested command; the wrapper never logs credentials.
    return await runCommand(argv[1], argv.slice(2), assumed.env, { cwd, spawnProcess, processObject, graceMs, pollMs });
  } catch (error) {
    stderr.write(`${error instanceof ExampleError ? error.message : messages.child}\n`);
    return { code: 1, signal: null };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await main();
  if (result.signal) {
    // Restore the actual signal status, after listeners and children have been cleaned up.
    process.exitCode = 128 + (constants.signals[result.signal] ?? 1);
    process.kill(process.pid, result.signal);
  } else {
    process.exitCode = result.code ?? 1;
  }
}
