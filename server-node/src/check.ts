import type { FastifyBaseLogger } from 'fastify';

import { describeConfig, loadConfig } from './config.js';
import { runCheck } from './selfcheck.js';
import { createSdkClient, type SdkClient } from './sdk.js';

/**
 * 终端不渲染 Markdown，而 `detail` 里的 `**…**` 强调是给 `/api/check` 的调用方看的。
 * 原样打出来只会看到字面的星号，所以在打印这一层统一去掉——
 * detail 里因此只需要一种强调写法，不必为两种输出各写一份文案。
 */
function plain(text: string): string {
  return text.replace(/\*\*/g, '');
}

/**
 * `npm run check` 的入口。
 *
 * **不经 HTTP、不依赖 dev server**：直接构造 SDK Client 调上游。
 * 这是有意的——自检要能在"服务起不来"的时候照样告诉你哪一步坏了，
 * 而服务起不来的最常见原因就是自检要查的那几件事。
 *
 * 用法：
 *   npm run check            # 用 .env 里的真凭证跑三步
 *   npm run check -- --mock  # 回放录制件，只验证工程本身装对了（无需凭证）
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const forceMock = args.includes('--mock') || args.includes('-m');
  // 必须在 loadConfig 之前设：它在"非 MOCK 且缺凭证"时会直接 exit(1)，
  // 而 --mock 的全部意义就是让人在没有凭证时也能验证工程。
  if (forceMock) process.env.MOCK = '1';

  const cfg = loadConfig();
  process.stdout.write(`\n${describeConfig(cfg)}\n\n`);

  let client: SdkClient | undefined;
  if (!cfg.mock) {
    try {
      client = createSdkClient(cfg);
    } catch (err) {
      process.stderr.write(`构造 SDK Client 失败：${err instanceof Error ? err.message : String(err)}\n\n`);
      return 1;
    }
  }

  /**
   * live.ts 里的告警都走 `ctx.log?.warn`，不传就被静默丢掉——而 CLI 自检恰恰是
   * 最需要看到它们的地方（例如"会话列表达到分页上限，结果可能不完整"）。
   * 写 stderr 是为了不污染 stdout 上那张 PASS/FAIL 表格。
   */
  const cliLog = {
    warn: (obj: unknown, msg?: string) => {
      process.stderr.write(`[warn] ${msg ?? ''} ${JSON.stringify(obj) ?? ''}\n`);
    },
  } as unknown as FastifyBaseLogger;

  const result = await runCheck(cfg, client, cliLog);

  const label: Record<string, string> = {
    'list-agents': '① ListAgents',
    'create-session': '② CreateAgentSession',
    'token-usage': '③ GetAgentSessionTokenUsage',
  };

  for (const step of result.steps) {
    const head = [
      step.ok ? '✅ PASS' : '❌ FAIL',
      (label[step.name] ?? step.name).padEnd(34),
      `${String(step.elapsedMs).padStart(6)}ms`,
      step.requestId ? `rid=${step.requestId}` : 'rid=—',
    ].join('  ');
    process.stdout.write(`${head}\n`);
    for (const line of plain(step.detail).split('\n')) {
      process.stdout.write(`        ${line}\n`);
    }
    process.stdout.write('\n');
  }

  process.stdout.write(
    `${result.ok ? '✅ 三步全通' : '❌ 有步骤未通过'}（总耗时 ${result.elapsedMs}ms，模式 ${result.mock ? 'MOCK' : 'LIVE'}）\n`,
  );
  if (result.mock) {
    process.stdout.write(
      '\n注意：MOCK 自检只证明"工程本身装对了、录制件能被正确解析"，\n' +
        '它「不能」证明你的 AK/SK、region、实例或资源组配置是对的。真跑请去掉 --mock。\n',
    );
  }
  process.stdout.write('\n');

  return result.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`\n自检异常退出：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n\n`);
    process.exit(1);
  },
);
