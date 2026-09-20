import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

import { DEFAULT_AGENT_NAME, DEFAULT_SESSION_SOURCE, MOCK_DEFAULT_SPEED, MOCK_MAX_GAP_MS } from '@das/shared';

/**
 * .env 放在仓库根，前后端共用一份（web 的 vite 配了 envDir 指向根）。
 * 这里用 import.meta.url 定位，不依赖 cwd——`npm run dev` 从根起，
 * `npm run check` 可能从任意目录起，两种情况都要能找到同一个文件。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

export interface AppConfig {
  mock: boolean;
  /** mock 回放是否用真实时间间隔（默认压平，见 MOCK_MAX_GAP_MS）。 */
  mockRealtime: boolean;
  /** 压平之后的播放倍速；mockRealtime 为真时不生效。 */
  mockSpeed: number;
  port: number;
  corsOrigin: string[];
  regionId: string;
  /**
   * 显式上游域名。留空 ⇒ 由 SDK 按 regionId 走内置映射（`dataworks.{region}.aliyuncs.com`）。
   * 非空 ⇒ 直接当 host 用，覆盖映射——这是接预发/日常等内置映射不认识的网关的唯一办法。
   */
  endpoint: string | undefined;
  agentName: string;
  sessionSource: string;
  resourceGroupId: string | undefined;
  accessKeyId: string | undefined;
  accessKeySecret: string | undefined;
  /**
   * 监听地址。默认 127.0.0.1（本地开发：进程持有 AK/SK，暴露到局域网等于把
   * 凭证使用权一起暴露）。容器/内网部署时设 SERVER_HOST=0.0.0.0——同时会把
   * Host 白名单校验关掉（见 index.ts：信任边界从"本机回环"换成"部署网络"）。
   */
  serverHost: string;
  /** 前端构建产物目录；存在则由本进程同源托管（单容器交付 UI+API）。 */
  webDist: string | undefined;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function bool(raw: string | undefined): boolean {
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

function nonEmpty(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v ? v : undefined;
}

function int(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw?.trim() ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat(raw?.trim() ?? '');
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(): AppConfig {
  loadEnvFile();

  const mock = bool(process.env.MOCK);
  const accessKeyId = nonEmpty(process.env.ALIBABA_CLOUD_ACCESS_KEY_ID);
  const accessKeySecret = nonEmpty(process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET);

  const cfg: AppConfig = {
    mock,
    mockRealtime: bool(process.env.MOCK_REALTIME),
    mockSpeed: num(process.env.MOCK_SPEED, MOCK_DEFAULT_SPEED),
    port: int(process.env.PORT, 3000),
    corsOrigin: (nonEmpty(process.env.CORS_ORIGIN) ?? 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    regionId: nonEmpty(process.env.DATAAGENT_REGION_ID) ?? 'cn-hangzhou',
    endpoint: nonEmpty(process.env.END_POINT),
    agentName: nonEmpty(process.env.DATAAGENT_AGENT_NAME) ?? DEFAULT_AGENT_NAME,
    sessionSource: nonEmpty(process.env.SESSION_SOURCE) ?? DEFAULT_SESSION_SOURCE,
    resourceGroupId: nonEmpty(process.env.RESOURCE_GROUP_ID),
    accessKeyId,
    accessKeySecret,
    serverHost: nonEmpty(process.env.SERVER_HOST) ?? '127.0.0.1',
    webDist: nonEmpty(process.env.WEB_DIST) ?? path.join(REPO_ROOT, 'web', 'dist'),
  };

  if (!cfg.mock && (!cfg.accessKeyId || !cfg.accessKeySecret)) {
    printMissingCredentials();
    process.exit(1);
  }

  return cfg;
}

/**
 * 选择要加载的 env 文件。
 *
 * 默认读 `.env`；设了 `DAS_ENV=<name>` 就改读 `.env.<name>`（例如 `DAS_ENV=beijing-pre`
 * 读 `.env.beijing-pre`），用来在多个上游环境（生产 / 预发 / 日常）之间切换而不动代码、
 * 也不动 package.json——加一个新环境只需多放一个 `.env.<name>` 文件。
 *
 * 每个 env 文件都是**自包含**的（region / endpoint / 资源组 / 凭证各写一份），
 * 所以选中谁就只用谁，不做"基础 .env + 覆盖层"的叠加：叠加会让"我此刻到底在用哪份配置"
 * 变得说不清，而这正是切环境时最该确定的事。已经注入进程的环境变量
 * （`MOCK=1 DAS_ENV=beijing-pre npm run dev`）仍然优先于文件，单条命令临时改一个值照样生效。
 *
 * 指定了 DAS_ENV 却找不到对应文件就**直接退出，不静默回落到 `.env`**：
 * 回落等于让你以为在跑预发、其实打到了生产，是这套机制最该避免的失败形态。
 */
function loadEnvFile(): void {
  const name = nonEmpty(process.env.DAS_ENV);
  const fileName = name ? `.env.${name}` : '.env';
  // 两个位置都找：仓库根（正常用法）与 cwd（有人单独在 server-node/ 目录里跑）。
  const candidates = [path.join(REPO_ROOT, fileName), path.resolve(process.cwd(), fileName)];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) {
    loadDotenv({ path: found, override: false });
    return;
  }

  if (name) {
    const lines = [
      '',
      `指定了 DAS_ENV=${name}，但找不到 ${fileName}。找过这些位置：`,
      ...candidates.map((candidate) => `  - ${candidate}`),
      '',
      '不会回落到 .env：那会让你以为在跑这个环境、其实打到别处。',
      `先 cp .env.example ${fileName} 填好，或去掉 DAS_ENV 用默认 .env。`,
      '',
    ];
    process.stderr.write(`${lines.join('\n')}\n`);
    process.exit(1);
  }

  // 没有 DAS_ENV、也没有 .env：不在这里报错，交给下面的凭证检查给出"缺凭证"的指引。
}

function printMissingCredentials(): void {
  const lines = [
    '',
    '缺少凭证，服务没有启动。',
    '',
    '本工程只从环境变量读 AK/SK：不读 ~/.aliyun/config.json，也不调用 aliyun CLI。',
    '',
    '两条路选一条：',
    '',
    '  A. 只想先看界面和流程（推荐先走这条）',
    '       cp .env.example .env      # 或者不改文件，直接：MOCK=1 npm run dev',
    '     MOCK 模式下完全不调真实接口，回放本仓库录制的真实帧流，无需任何凭证。',
    '',
    '  B. 要调真实接口',
    '     1) cp .env.example .env',
    '     2) 填 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET',
    '        建议单独建 RAM 用户，不要用主账号 AK/SK。',
    '     3) 填 DATAAGENT_REGION_ID（DataWorks 实例所在 region）',
    '     4) 账号下 DataWorks 运行实例为零的话，还要填 RESOURCE_GROUP_ID',
    '     5) 要接预发/日常等内置映射不认识的上游，再填 END_POINT（域名，留空按 region 推导）',
    '',
    `  .env 应该放在仓库根：${path.join(REPO_ROOT, '.env')}`,
    '  要在多个环境间切换：每个环境放一份自包含的 .env.<name>，用 `DAS_ENV=<name> npm run dev` 选。',
    '',
    '  填好之后跑 `npm run check` 做三步自检，再 `npm run dev`。',
    '',
  ];
  process.stderr.write(`${lines.join('\n')}\n`);
}

/**
 * 打印启动信息。
 *
 * 只打印凭证"有没有"，绝不打印凭证本身，也不打印任何前缀/掩码形式——
 * 日志会被贴进 issue、CI 产物和聊天记录里。
 */
export function describeConfig(cfg: AppConfig): string {
  const lines = [
    `mode          : ${cfg.mock ? 'MOCK（回放录制帧流，不调真实接口）' : 'LIVE（调用真实 OpenAPI）'}`,
  ];
  if (cfg.mock) {
    lines.push(
      `replay        : ${cfg.mockRealtime ? '真实时间间隔（MOCK_REALTIME=1）' : `压平至 ${MOCK_MAX_GAP_MS}ms + ${cfg.mockSpeed}x 倍速`}`,
    );
  }
  lines.push(
    `region        : ${cfg.regionId}`,
    `endpoint      : ${cfg.endpoint ?? '(未设置，按 region 走 SDK 内置映射)'}`,
    `agent         : ${cfg.agentName}`,
    `sessionSource : ${cfg.sessionSource}`,
    `resourceGroup : ${cfg.resourceGroupId ?? '(未配置)'}`,
    `credentials   : ${cfg.accessKeyId && cfg.accessKeySecret ? 'present' : 'missing'}`,
    `host          : ${cfg.serverHost}${cfg.serverHost === '127.0.0.1' ? '' : '（容器/内网模式：Host 白名单已关闭）'}`,
    `webDist       : ${cfg.webDist ?? '(未配置，UI 不由本进程托管)'}`,
  );
  return lines.join('\n');
}
