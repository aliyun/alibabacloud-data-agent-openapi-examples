#!/usr/bin/env node
// Launch one backend and the shared frontend; terminate the pair together.
import { spawn } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { config } from 'dotenv';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('用法: npm start -- [node|python|java] [--mock]\n默认 node。\n免凭证体验（回放合成样例）：MOCK=1 npm start -- <lang>（mac/Linux/Git Bash）或\n  · Windows PowerShell：$env:MOCK="1"; npm start -- <lang>\n  · Windows cmd.exe：set MOCK=1&& npm start -- <lang>\n  · 任意外壳：`npm start -- <lang> --mock` 或 `-m`（不用写环境变量，三平台同形）\nDAS_ENV=<name> 选择 .env.<name>。\nCtrl+C 同时停止后端和前端。');
  process.exit(0);
}
const mockFlag = args.includes('--mock') || args.includes('-m');
const language = args.find((v) => ['node', 'python', 'java'].includes(v)) ?? 'node';
const unknownArgs = args.filter((v) => !['node', 'python', 'java', '--mock', '-m'].includes(v));
if (unknownArgs.length > 0) {
  console.error('无法识别的参数：' + unknownArgs.join(' ') + '（例如 npm start -- python 或 npm start -- python --mock）');
  process.exit(2);
}
if (mockFlag) {
  // --mock/-m：不用写环境变量的免凭证快捷方式（Windows PowerShell/cmd 与 POSIX 外壳都可以）
  process.env.MOCK = '1';
}
const envName = process.env.DAS_ENV?.trim();
if (envName && !/^[\w.-]+$/.test(envName)) throw new Error('DAS_ENV 只能包含字母、数字、下划线、点和短横线');
const envFile = path.join(root, envName ? `.env.${envName}` : '.env');
if (envName && !existsSync(envFile)) throw new Error(`找不到 ${envFile}`);
if (existsSync(envFile)) config({ path: envFile, override: false });
const port = Number(process.env.PORT || 3000);
const webPort = Number(process.env.WEB_PORT || 5173);
for (const value of [port, webPort]) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('PORT / WEB_PORT 必须为 1–65535 的整数');
}
if (port === webPort) throw new Error('PORT 与 WEB_PORT 不能相同');
const env = {
  ...process.env,
  PORT: String(port),
  VITE_API_BASE: `http://127.0.0.1:${port}`,
  CORS_ORIGIN: [...new Set([...(process.env.CORS_ORIGIN || '').split(',').filter(Boolean), `http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`])].join(','),
};
// Fail before launching either service when the chosen ports are already occupied.
for (const p of [port, webPort]) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`端口 ${p} 已占用，请停止原服务或设置 PORT / WEB_PORT`)));
    probe.listen(p, '127.0.0.1', () => probe.close(resolve));
  });
}

const children = [];
let stopping = false;

/** Windows 上没有 -PID×进程组语义（process.kill(-pid) 会 NPE），用 child.kill() 代替。 */
function killChild(child, signal) {
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch { /* already stopped */ }
}

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) killChild(child, 'SIGTERM');
  setTimeout(() => {
    for (const child of children) killChild(child, 'SIGKILL');
    process.exit(code);
  }, 1500);
}
process.on('SIGINT', () => stop(130));
process.on('SIGTERM', () => stop(143));
function launch(command, argv) {
  const child = spawn(command, argv, { cwd: root, env, stdio: 'inherit', detached: true });
  children.push(child);
  child.once('error', (error) => { console.error(error.message); stop(1); });
  child.once('exit', (code) => stop(code ?? 1));
  return child;
}

/**
 * 后端的 spawn 规格：POSIX 借 bash 走 dev-server.sh（脚本含 JDK 探测/分层失败提示）；
 * win32 起原生命令，不走 bash——这是这个 launcher 的唯一 OS 分叉点。
 */
function backendSpec(lang) {
  if (process.platform !== 'win32') {
    return { command: 'bash', argv: [path.join(root, 'scripts/dev-server.sh'), lang], needsBuild: false };
  }
  const isWin = process.platform === 'win32';
  if (lang === 'node') {
    // node server 自端 tsx 执行器（`--import tsx`，跨平台 ESM import flag）
    return { command: process.execPath, argv: ['--import', 'tsx', path.join('server-node', 'src', 'index.ts')], needsBuild: false };
  }
  if (lang === 'python') {
    // 优先仓库内 .venv（Python 的 Windows venv 目录名是 Scripts 而非 bin）
    const venvPy = [
      path.join(root, 'server-python', '.venv', 'Scripts', 'python.exe'),
      path.join(root, 'server-python', '.venv', 'bin', 'python'),
    ].find(existsSync);
    return { command: venvPy ?? 'python', argv: ['-m', 'das_python.main'], needsBuild: false };
  }
  // java：源码新于 jar 时先 mvn package（Windows 上 mvn 是 mvn.cmd，经 cmd /c 调度）
  const jar = path.join(root, 'server-java', 'target', 'das-server-java-0.1.0.jar');
  const needsBuild = !existsSync(jar) || newerExists(path.join(root, 'server-java', 'src'), jar);
  return {
    command: 'java',
    argv: ['-jar', path.join('server-java', 'target', 'das-server-java-0.1.0.jar')],
    needsBuild,
  };
}

/** 遍历 src 下 *.java：有比 target jar 新的源文件（pom/src 变了就要重新打。 */
function newerExists(dir, target) {
  const targetTime = existsSync(target) ? statSync(target).mtimeMs : 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
      for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (statSync(full).mtimeMs > targetTime) return true;
    }
  }
  return false;
}

/** 在 Windows 上对 mvn 这类 .cmd 包装的调用（node spawn 不会自行解析 .cmd）。 */
function shellRun(command, args) {
  return new Promise((resolve, reject) => {
    const comspec = process.env.COMSPEC || 'cmd.exe';
    const child = spawn(comspec, ['/d', '/s', '/c', [command, ...args].join(' ')], {
      cwd: path.join(root, 'server-java'),
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (exitCode) => (exitCode === 0 ? resolve() : reject(new Error(`${command} 失败，请看上面的 maven 输出`))));
  });
}

console.log(`启动 ${language} 后端；首次 Java 构建可能需要几分钟。`);
const spec = backendSpec(language);
if (language === 'java' && process.platform === 'win32' && spec.needsBuild) {
  console.log('Windows：源码比 jar 新，先跑 mvn -DskipTests package');
  try {
    await shellRun('mvn', ['-q', '-DskipTests', 'package']);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
launch(spec.command, spec.argv);
const deadline = Date.now() + 300_000;
let ready = false;
while (!stopping && Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = await response.json();
    if (response.ok && body.ok === true) { ready = true; break; }
  } catch { /* starting */ }
  await new Promise((resolve) => setTimeout(resolve, 300));
}
if (!stopping) {
  if (!ready) { console.error('后端在 5 分钟内未就绪，请查看上面的启动日志。'); stop(1); }
  else {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/d/capabilities`, { signal: AbortSignal.timeout(1500) });
      const capabilities = await response.json();
      if (!response.ok || !capabilities.features?.includes('standalone_sessions_v1')) throw new Error('unsupported');
    } catch {
      console.warn(`提示：${language} 后端已启动，但尚未提供 web-shell 会话接口。网页可以打开，会话交互仍待该语言适配完成。`);
    }
    launch(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--config', 'web/vite.config.ts', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort', 'web']);
    console.log(`打开 http://127.0.0.1:${webPort} · 后端 ${language} · Ctrl+C 同时停止两项服务`);
  }
}
