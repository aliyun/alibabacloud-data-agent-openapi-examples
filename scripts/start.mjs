#!/usr/bin/env node
// Launch one backend and the shared frontend; terminate the pair together.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { config } from 'dotenv';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('用法: npm start -- [node|python|java]\n默认 node。MOCK=1 免凭证体验；DAS_ENV=<name> 选择 .env.<name>。\n首次安装与语言要求见 README.md。Ctrl+C 同时停止后端和前端。');
  process.exit(0);
}
const language = args[0] ?? 'node';
if (args.length > 1 || !['node', 'python', 'java'].includes(language)) {
  console.error('请选择 node、python 或 java，例如 npm start -- python');
  process.exit(2);
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
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
  setTimeout(() => {
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
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
console.log(`启动 ${language} 后端；首次 Java 构建可能需要几分钟。`);
launch('bash', [path.join(root, 'scripts/dev-server.sh'), language]);
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
