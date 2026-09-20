import { appendFileSync } from 'node:fs';

import {
  CreateAgentSessionRequest,
  CreateAgentSessionRequestParams,
  CreateAgentSessionRequestParamsMeta,
  CreateAgentSessionRequestParamsMetaAgent,
  CreateAgentSessionRequestParamsMetaConfig,
  CreateAgentSessionRequestParamsMetaConfigSessionTags,
  CreateAgentSessionRequestParamsMetaInitialConfigOptions,
  ReplyAgentSessionRequest,
  ReplyAgentSessionRequestParams,
  ReplyAgentSessionRequestParamsOutcome,
} from '@alicloud/dataworks-public20240518';

import { describeConfig, loadConfig } from './config.js';
import { liveCreateSession, liveListSessions, livePromptFrames, type LiveContext } from './live.js';
import { buildCreateSessionRequest } from './live.js';
import { toApiError } from './normalize.js';
import { createSdkClient, runtimeFor, type SdkClient } from './sdk.js';

/**
 * ReplyAgentSession 探针（2026-09-17，SDK 9.9.0 新增接口的首次实测）。
 *
 * 用法（在 server-node/ 目录下，DAS_ENV 选环境）：
 *   npx tsx src/probe-reply.ts --bogus   伪造 permissionRequestId 调一次，
 *                                        探接口可达性与错误语义（预期拿到"请求不存在"类错误）。
 *   npx tsx src/probe-reply.ts --e2e     default 模式建会话 → 发会触发 run_shell_command 的
 *                                        prompt → 等 _qwen/notify(permission_request) →
 *                                        回覆 → 观察原 SSE 流是否继续执行到终态。
 *
 * 对照 live.ts 里 buildCreateSessionRequest 的注释：demo 之所以把 mode 锁死 yolo，
 * 就是因为当时 OpenAPI 侧没有回答人卡的通道；本探针用 default 模式验证的正是这条新通道。
 */

const JSONRPC_VERSION = '2.0';
let rpcId = 0;
function nextRpcId(): string {
  rpcId += 1;
  return `probe-reply-${rpcId}`;
}

/** E2E 总闸：8 次 × 30s 重试窗口 + 一轮执行时间，覆盖 120s 的实例自动启动阈值。 */
const E2E_DEADLINE_MS = 420_000;

/** 会触发 run_shell_command 的最小 prompt（fixtures 里的工具就是 shell）。 */
const TOOL_PROMPT =
  '请必须调用 run_shell_command 工具执行 date "+%Y-%m-%d %H:%M:%S"，把命令的真实输出原样告诉我。' +
  '不要凭记忆回答时间，不要跳过工具调用。';

/** 诱导 ask_user_question 的 prompt：SDK 注释说 ReplyAgentSession 支持提交它的答案（answers/optionId）。 */
const ASK_PROMPT =
  '请调用 ask_user_question 工具向我提问："你想让我接下来做什么？"，选项：' +
  'A. 查看当前时间；B. 列出当前目录文件。在我回答之前不要自行选择，不要继续执行。';

function printJson(label: string, value: unknown): void {
  process.stdout.write(`\n[${label}]\n${JSON.stringify(value, null, 2)}\n`);
}

function plain(text: string): string {
  return text.replace(/\*\*/g, '');
}

function replyOutcome(resp: unknown): { accepted: boolean | undefined; error: unknown; raw: unknown } {
  const body = (resp as { body?: { jsonRpcResponse?: { result?: { accepted?: boolean }; error?: unknown } } })
    ?.body;
  const rpc = body?.jsonRpcResponse;
  return {
    accepted: rpc?.result?.accepted,
    error: rpc?.error,
    raw: body,
  };
}

async function replyOnce(
  client: SdkClient,
  sessionId: string,
  permissionRequestId: string,
  optionId: string | undefined,
  answers: Record<string, string> | undefined,
): Promise<{ ok: boolean; detail: unknown }> {
  try {
    const resp = await client.replyAgentSessionWithOptions(
      new ReplyAgentSessionRequest({
        id: nextRpcId(),
        jsonrpc: JSONRPC_VERSION,
        params: new ReplyAgentSessionRequestParams({
          sessionId,
          permissionRequestId,
          ...(answers ? { answers } : {}),
          outcome: new ReplyAgentSessionRequestParamsOutcome({
            ...(optionId ? { optionId } : {}),
            outcome: 'selected',
          }),
        }),
      }),
      runtimeFor(),
    );
    const out = replyOutcome(resp);
    printJson('ReplyAgentSession 响应', out.raw);
    return { ok: out.accepted === true, detail: out };
  } catch (err) {
    const apiErr = toApiError(err, 'ReplyAgentSession');
    process.stdout.write(`\nReplyAgentSession 调用异常：${plain(apiErr.message)}\n`);
    return { ok: false, detail: apiErr };
  }
}

/** 伪造 permissionRequestId 的可达性探针。错误语义本身就是测试目标，不分支处理。 */
async function probeBogus(ctx: LiveContext, existingSessionId: string | undefined): Promise<number> {
  process.stdout.write(`\n${describeConfig(ctx.cfg)}\n\n== ① 建会话（或复用 --session 指定的）==\n`);
  let sessionId = existingSessionId;
  if (!sessionId) {
    const created = await liveCreateSession(ctx);
    if (!created.ok) {
      process.stdout.write(`建会话失败：${plain(created.error.message)}\n`);
      return 1;
    }
    sessionId = created.result.sessionId;
  }
  process.stdout.write(`sessionId = ${sessionId}\n\n== ② 伪造 permissionRequestId 调 Reply ==\n`);

  const fakeId = `probe-bogus-${Date.now()}`;
  process.stdout.write(`permissionRequestId = ${fakeId}\n`);
  const reply = await replyOnce(ctx.client, sessionId, fakeId, undefined, undefined);
  process.stdout.write(
    `\n== 结论 ==\n接口${reply.ok ? '接受（意外：伪造 ID 也被接受？需要人工核对）' : '未接受'}；` +
      '上面的响应原文（含 Error.code/errorCode/Message）就是预发上游对这条 API 的真实语义。\n',
  );
  return 0;
}

interface PermissionRequest {
  requestId: string;
  frame: Record<string, unknown>;
}

/** 对既有会话发一条轻量 prompt，看 daemon 绑定与派发链路是否健康（诊断用，不回覆）。 */
async function probePing(ctx: LiveContext, sessionId: string, text: string): Promise<number> {
  process.stdout.write(`\nping session=${sessionId}\nprompt: ${text}\n\n`);
  const acks: string[] = [];
  let frames = 0;
  let sawError: unknown;
  for await (const frame of livePromptFrames(ctx, sessionId, text, acks)) {
    frames += 1;
    const su = (frame.Params as { update?: { sessionUpdate?: string; status?: string } } | undefined)?.update;
    if (frames <= 3 || frame.Method) printJson(`帧 #${frames}`, frame);
    else process.stdout.write(`  #${String(frames).padStart(3)} ${su?.sessionUpdate ?? '(帧)'}\n`);
    if (frame.Error) sawError = frame.Error;
    if (frames > 300) break;
  }
  process.stdout.write(
    `\n== ping 结论 ==\n帧数: ${frames}；${sawError ? `收到错误帧: ${JSON.stringify(sawError)}` : '无错误帧'}\n` +
      (acks.length > 0 ? `POP 回执: ${acks.join(', ')}\n` : ''),
  );
  return 0;
}

function permissionRequestOf(frame: Record<string, unknown>): PermissionRequest | undefined {
  if (frame.Method !== '_qwen/notify') return undefined;
  const params = frame.Params as { kind?: unknown; data?: { requestId?: unknown } } | undefined;
  if (params?.kind !== 'permission_request') return undefined;
  const requestId = params.data?.requestId;
  return typeof requestId === 'string' && requestId ? { requestId, frame } : undefined;
}

/** 从权限帧里递归找第一个 optionId（形状未实测，宽松提取；找不到就 undefined，由回覆错误反推）。 */
function firstOptionIdOf(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = firstOptionIdOf(item);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.optionId === 'string' && obj.optionId) return obj.optionId;
    for (const child of Object.values(obj)) {
      const hit = firstOptionIdOf(child);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * 探针建会话：default（会触发人卡）或 yolo（demo 同款，工具自动放行）。
 * 预发实测 create 有概率"HTTP 200 + 会话已注册但响应体为空"，统一用列表回读兜底。
 */
async function createProbeSession(ctx: LiveContext, mode: 'default' | 'yolo'): Promise<string> {
  const startedAt = Date.now();
  const request =
    mode === 'yolo'
      ? buildCreateSessionRequest(ctx.cfg)
      : new CreateAgentSessionRequest({
          id: nextRpcId(),
          jsonrpc: JSONRPC_VERSION,
          params: new CreateAgentSessionRequestParams({
            meta: new CreateAgentSessionRequestParamsMeta({
              agent: new CreateAgentSessionRequestParamsMetaAgent({ agentName: ctx.cfg.agentName }),
              config: new CreateAgentSessionRequestParamsMetaConfig({
                sessionSource: ctx.cfg.sessionSource,
                sessionTags: [new CreateAgentSessionRequestParamsMetaConfigSessionTags({ sessionTagCode: ctx.cfg.sessionSource })],
              }),
              initialConfigOptions: new CreateAgentSessionRequestParamsMetaInitialConfigOptions({
                resourceGroupId: ctx.cfg.resourceGroupId,
                mode: 'default',
              }),
            }),
          }),
        });
  const resp = await ctx.client.createAgentSessionWithOptions(request, runtimeFor());
  const direct = (resp as { body?: { jsonRpcResponse?: { result?: { sessionId?: string } } } })?.body
    ?.jsonRpcResponse?.result?.sessionId;
  if (direct) return direct;

  const listed = await liveListSessions(ctx);
  if (listed.ok) {
    const fresh = listed.result.sessions
      .filter((s) => s.createdAt >= startedAt - 10_000)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (fresh) {
      process.stdout.write(`（create 响应体为空，回读列表补到新建会话 ${fresh.sessionId}）\n`);
      return fresh.sessionId;
    }
  }
  throw new Error(`CreateAgentSession（default 模式）没有返回 SessionId，列表里也没有新建会话：${JSON.stringify(resp)}`);
}

async function probeE2e(ctx: LiveContext, promptText: string, createMode: 'default' | 'yolo'): Promise<number> {
  process.stdout.write(`\n${describeConfig(ctx.cfg)}\n\n== ① ${createMode} 模式建会话 ==\n`);
  const createdAt = Date.now();
  const sessionId = await createProbeSession(ctx, createMode);
  process.stdout.write(`sessionId = ${sessionId}\n\n== ② 发 prompt 并等权限请求 ==\nprompt: ${promptText}\n\n`);

  const deadline = Date.now() + E2E_DEADLINE_MS;
  let permission: PermissionRequest | undefined;
  let frameCount = 0;
  let framesAfterReply = 0;
  let terminal: unknown;
  let replied = false;
  const acks: string[] = [];

  /** prompt 被预发以 0x48833000000000cd（session 未绑定 daemon）拒收时重试：此刻那一轮从未派发，重发不是重复执行写操作。 */
  const NO_DAEMON_BINDING = '0x48833000000000cd';
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  for (let attempt = 1; attempt <= 8 && !replied && !terminal; attempt += 1) {
    if (attempt === 1) {
      process.stdout.write('（create 后等 15s，然后每 30s 重试 prompt——实例自动启动阈值是 120s，要有耐心）\n');
      await sleep(15_000);
    } else {
      process.stdout.write(`（第 ${attempt}/8 次 prompt，距建会话 ${Math.round((Date.now() - createdAt) / 1000)}s）\n`);
      await sleep(30_000);
    }
    let notReady = false;
    let streamBroke = false;

    const frames = livePromptFrames(ctx, sessionId, promptText, acks);
    try {
      for await (const frame of frames) {
      frameCount += 1;
      if (replied) framesAfterReply += 1;
      /** 全量帧落盘：tail 截断吃掉过一次关键时间线，这次每一帧都留档。 */
      appendFileSync('/tmp/probe-e2e-frames.jsonl', `${JSON.stringify(frame)}\n`);

      const su = (frame.Params as { update?: { sessionUpdate?: string; status?: string } } | undefined)?.update;
      const brief =
        (frame.Method as string | undefined) ??
        (su?.sessionUpdate ? `update:${su.sessionUpdate}${su.status ? `/${su.status}` : ''}` : '(帧)');
      if (frameCount <= 40 || frame.Method || su?.sessionUpdate === 'tool_call_update') {
        process.stdout.write(`  #${String(frameCount).padStart(3)} ${brief}\n`);
      }
      /** 前几帧原样转储：单帧收场时这往往是唯一线索（POP 回执/关流原因都藏在载荷里）。 */
      if (frameCount <= 5) printJson(`帧 #${frameCount}（原样）`, frame);

      const frameError = frame.Error as { errorCode?: string } | undefined;
      if (frameError?.errorCode === NO_DAEMON_BINDING) {
        notReady = true;
        break;
      }

      const hit = permissionRequestOf(frame as Record<string, unknown>);
      if (hit && !replied) {
        permission = hit;
        printJson('权限请求帧（原样）', hit.frame);
        /** ask_user_question 类交互：把第一个选项的 label 作为 answers["0"] 提交（索引键，SDK 示例同款）。 */
        const data = (hit.frame.Params as { data?: { toolCall?: { rawInput?: { questions?: Array<{ options?: Array<{ label?: string }> }> } } } } | undefined)
          ?.data;
        const firstQuestion = data?.toolCall?.rawInput?.questions?.[0];
        const firstLabel = firstQuestion?.options?.[0]?.label;
        const answers = firstLabel ? { '0': firstLabel } : undefined;
        process.stdout.write(
          `\n== ③ 回覆 permissionRequestId=${hit.requestId} ==\n` +
            (answers ? `answers = ${JSON.stringify(answers)}\n` : '(无 answers，纯 outcome)\n'),
        );
        const reply = await replyOnce(ctx.client, sessionId, hit.requestId, firstOptionIdOf(hit.frame), answers);
        replied = true;
        process.stdout.write(
          `\n回覆结果：${reply.ok ? 'accepted=true，等待原 SSE 流继续' : '未接受（见上方响应原文）'}\n\n== ④ 继续收流 ==\n`,
        );
      } else if (!hit) {
        /** 兜底观测：帧里任何位置出现 permission 关键字都原样转储，防止帧形与 SDK 文档不符时漏检。 */
        if (JSON.stringify(frame).includes('permission')) {
          printJson(`帧 #${frameCount}（含 permission 关键字）`, frame);
        }
      }

      if (frame.Result && typeof (frame.Result as { stopReason?: unknown }).stopReason === 'string') {
        terminal = frame.Result;
        process.stdout.write(`  #${String(frameCount).padStart(3)} 终态：${JSON.stringify(terminal)}\n`);
        break;
      }
      if (Date.now() > deadline) {
        process.stdout.write(`  （到达 ${E2E_DEADLINE_MS / 1000}s 总闸，停止收流）\n`);
        break;
      }
      }
    } catch (err) {
      streamBroke = true;
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(
        `  （流异常中断：${msg}。重试会作为新的一轮发 prompt；若上一轮实际已被派发，` +
          '它会在服务端继续跑完，只是结果要靠历史回看——本探针的 prompt 无副作用，重试是安全的）\n',
      );
    }

    if (Date.now() > deadline) break;
    if (streamBroke) continue;
    if (!notReady) break;
  }

  process.stdout.write(
    `\n== E2E 结论 ==\n` +
      `帧总数           : ${frameCount}\n` +
      `权限请求         : ${permission ? `收到（requestId=${permission.requestId}）` : '未收到'}\n` +
      `回覆             : ${replied ? '已提交' : '未提交'}\n` +
      `回覆后新增帧数   : ${framesAfterReply}\n` +
      `终态             : ${terminal ? JSON.stringify(terminal) : '未观测到'}\n` +
      (acks.length > 0 ? `POP 回执 RequestId: ${acks.join(', ')}\n` : ''),
  );
  return 0;
}

/** 列当前身份名下的会话（诊断用：对比两对 AK 各自能看到/能动哪些会话）。 */
async function probeList(ctx: LiveContext): Promise<number> {
  const listed = await liveListSessions(ctx);
  if (!listed.ok) {
    process.stdout.write(`列表失败：${plain(listed.error.message)}\n`);
    return 1;
  }
  process.stdout.write(`共 ${listed.result.total} 条（本进程身份可见）\n`);
  for (const s of listed.result.sessions.slice(0, 15)) {
    process.stdout.write(`  ${new Date(s.createdAt).toISOString()}  ${s.sessionId}  ${(s.title || '(空标题)').slice(0, 30)}\n`);
  }
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const mode = args.includes('--e2e')
    ? 'e2e'
    : args.includes('--bogus')
      ? 'bogus'
      : args.includes('--ping')
        ? 'ping'
        : args.includes('--list')
          ? 'list'
          : undefined;
  if (!mode) {
    process.stdout.write('用法：npx tsx src/probe-reply.ts --bogus [--session <id>] | --e2e | --ping --session <id> [--text <prompt>] | --list\n');
    return 2;
  }
  const sessionIdx = args.indexOf('--session');
  const existingSessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : undefined;
  const textIdx = args.indexOf('--text');
  const pingText = (textIdx >= 0 ? args[textIdx + 1] : undefined) ?? '请只回答：1+1 等于几？不要调用任何工具。';

  const cfg = loadConfig();
  if (cfg.mock) {
    process.stderr.write('MOCK 模式下探针没有意义：ReplyAgentSession 探的是真实上游。\n');
    return 2;
  }
  const client = createSdkClient(cfg);
  const ctx: LiveContext = { client, cfg };

  if (mode === 'bogus') return probeBogus(ctx, existingSessionId);
  if (mode === 'list') return probeList(ctx);
  if (mode === 'ping') {
    if (!existingSessionId) {
      process.stderr.write('--ping 需要 --session <id>\n');
      return 2;
    }
    return probePing(ctx, existingSessionId, pingText);
  }
  return probeE2e(ctx, (textIdx >= 0 ? args[textIdx + 1] : undefined) ?? ASK_PROMPT, args.includes('--yolo') ? 'yolo' : 'default').catch(
    (err: unknown) => {
    process.stderr.write(
      `E2E 探针异常：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n` +
        `归一化：${plain(toApiError(err, 'E2E').message)}\n`,
    );
    return 1;
  });
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`\n探针异常退出：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n\n`);
    process.exit(1);
  },
);
