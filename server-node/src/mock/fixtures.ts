import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  parseRecordedLine,
  type AcpFrame,
  type SessionSummary,
  type SessionsResult,
} from '@das/shared';

import type { AppConfig } from '../config.js';

/**
 * MOCK 模式的数据源：`server-node/test/fixtures/` 下的真实录制件。
 *
 * 单测读的是同一批文件（见 `server-node/test/helpers/fixtures.ts`），所以
 * "mock 下能跑通"与"单测绿"指向的是同一份数据，不会出现两套真相。
 */
const FIXTURE_DIR = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));

export function readFixtureFrames(name: string): AcpFrame[] {
  const raw = readFileSync(new URL(name, `file://${FIXTURE_DIR}`), 'utf8');
  const frames: AcpFrame[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const frame = parseRecordedLine(line);
    if (!frame) throw new Error(`fixture ${name} 有一行解析不出帧`);
    frames.push(frame);
  }
  return frames;
}

/** 非流式录制件：形如 `{JsonRpcResponse:{Result:{…}}, RequestId:'…'}`。 */
export function readFixtureResult<T>(name: string): T {
  const parsed = JSON.parse(readFileSync(new URL(name, `file://${FIXTURE_DIR}`), 'utf8')) as {
    JsonRpcResponse?: { Result?: T; Error?: unknown };
  };
  const result = parsed.JsonRpcResponse?.Result;
  if (result === undefined) throw new Error(`fixture ${name} 里没有 JsonRpcResponse.Result`);
  return result;
}

/**
 * 同一份录制件，但连 `Result` 之外的顶层字段一起给。
 *
 * `npm run check -- --mock` 要输出与 LIVE 完全同形的表格（含 requestId 列），
 * 所以不能只拿 Result。录制件里的 RequestId 是真实抓包留下的，不是编的。
 */
export function readFixtureEnvelope<T>(name: string): { result: T | undefined; requestId: string | undefined; error: unknown } {
  const parsed = JSON.parse(readFileSync(new URL(name, `file://${FIXTURE_DIR}`), 'utf8')) as {
    JsonRpcResponse?: { Result?: T; Error?: unknown };
    RequestId?: string;
  };
  return {
    result: parsed.JsonRpcResponse?.Result,
    requestId: parsed.RequestId,
    error: parsed.JsonRpcResponse?.Error,
  };
}

export interface MockScenario {
  /** 会话 id。mock 会话 id 是本地编的；帧内容里的 sessionId 仍是录制时的真实值。 */
  sessionId: string;
  title: string;
  /** undefined 表示这一轮**一个 ACP 帧都没有**（上游只回 POP 回执那种）。 */
  promptFixture: string | undefined;
  /**
   * 上游 POP 层回执里的 RequestId。真实形态是 SSE 里唯一的一个事件
   * `{"RequestId":"<32位十六进制>"}`，它不是 ACP 帧（见 `shared/frames.ts` 的
   * `POP_ONLY_KEYS`）。给出来是为了让 mock 与 live 走同一条收尾分类：
   * 零帧 + 有回执 ⇒ `prompt_not_dispatched`，且回执号会出现在错误 message 里。
   */
  popAck?: string;
  /** 拉历史时回放哪一份；undefined 表示这个会话没有历史（幽灵化那种）。 */
  historyFixture: string | undefined;
  frameCount: number;
  /**
   * 这个场景演示的是哪条实测约束——**一句话**，因为它会被渲染到界面上
   * （会话行的 title 与中栏标题旁）。完整结论不写在这里，权威副本各一份：
   * 录制件级别看 `server-node/test/fixtures/README.md`，形态与处置级别看根 README 的
   * 「MOCK 模式」「FAQ」「实测约束清单」三节。
   */
  teaches: string;
  createdAt: number;
  /** 覆盖默认的 SessionSource，用于演示"别的来源会被过滤掉"。 */
  sourceOverride?: string;
}

const SHORT_SESSION = 'mock-short';
const TOOLS_SESSION = 'mock-tools';
const LONG_SESSION = 'mock-long';
const BREAK_SESSION = 'mock-break';
const GHOST_SESSION = 'mock-ghost';
const CONCURRENT_SESSION = 'mock-concurrent';
const ACK_SESSION = 'mock-ack-only';
const RENDER_SESSION = 'mock-render';

/**
 * 八条演示会话：七条各对一份录制件（ack-only 那条没有录制件，它演示的正是"零帧"），
 * 一条是合成渲染样例（mock-render，非录制件，见 server-node/test/fixtures/README.md）。
 *
 * 刻意不做"一个会话 + 场景下拉"：真实用法就是"选会话 → 发 prompt"，
 * 把场景绑在会话上，mock 与 live 的操作路径完全一致，前端不需要为 mock 开分支。
 */
export const MOCK_SCENARIOS: MockScenario[] = [
  {
    sessionId: SHORT_SESSION,
    title: '[MOCK] 短轮 · 22 帧 · end_turn',
    promptFixture: 'prompt-short.jsonl',
    historyFixture: 'load-clean.jsonl',
    frameCount: 22,
    teaches: '最短闭环：一问一答、无工具调用、5.6s 拿到 end_turn',
    createdAt: 1_789_026_610_000,
  },
  {
    // marker 注入已退役：标题不再带校验码说明（左栏展示与真实标题一致）。
    title: '[MOCK] 工具轮 · 392 帧 · 6 次调用',
    sessionId: TOOLS_SESSION,
    promptFixture: 'prompt-tools.jsonl',
    historyFixture: 'load-clean.jsonl',
    frameCount: 392,
    teaches: '工具状态机：6 次调用（5 completed + 1 failed）',
    createdAt: 1_789_029_139_000,
  },
  {
    sessionId: LONG_SESSION,
    title: '[MOCK] 长轮 · 901 帧 · 191s · 10 次调用',
    promptFixture: 'prompt-long.jsonl',
    historyFixture: 'load-polluted.jsonl',
    frameCount: 901,
    teaches: '长轮 191s / 901 帧；历史用 RUNNING 期录的那份（有 rid-less 污染）',
    createdAt: 1_789_027_001_000,
  },
  {
    sessionId: BREAK_SESSION,
    title: '[MOCK] 断流 · -32603 · 1201 帧',
    promptFixture: 'error-stream-break.jsonl',
    historyFixture: 'load-polluted.jsonl',
    frameCount: 1201,
    teaches: 'SSE 断流：吐完 1200 帧后收尾 -32603，任务可能仍在服务端跑',
    createdAt: 1_788_787_752_000,
  },
  {
    sessionId: GHOST_SESSION,
    title: '[MOCK] 会话幽灵化 · 422 · 单帧',
    promptFixture: 'error-session-ghost.jsonl',
    historyFixture: undefined,
    frameCount: 1,
    teaches: '会话失效：1s 内单帧 -32603 / 422，不能再发，只能新建',
    createdAt: 1_788_790_920_000,
  },
  {
    sessionId: CONCURRENT_SESSION,
    title: '[MOCK] 并发被拒 · 单帧',
    promptFixture: 'error-concurrent-rejected.jsonl',
    historyFixture: 'load-clean.jsonl',
    frameCount: 1,
    teaches: '同一会话同时只能跑一轮，第二次请求被服务端直接拒绝',
    createdAt: 1_788_276_326_000,
  },
  {
    sessionId: ACK_SESSION,
    title: '[MOCK] prompt 不派发 · 零帧 · 只有 POP 回执',
    // 没有 promptFixture：这一轮**一个 ACP 帧都没有**，上游只回了一个 POP 层回执就关流。
    promptFixture: undefined,
    popAck: '0dd3b146c75bf132a65efa7a3080e7cd',
    historyFixture: undefined,
    frameCount: 0,
    teaches: 'prompt 根本没派发：只有 POP 回执、零帧；与断流不同，任务没在跑',
    createdAt: 1_789_483_174_000,
  },
  {
    // 合成样例，非录制件：真实抓包里恰好没有围栏代码块，shiki 暗色配色与 mermaid
    // 渲染这两条路径从未被真实数据走到。这份是手写的，只为让渲染可被截图验证。
    // 溯源见 server-node/test/fixtures/README.md 的「合成样例」一节。
    sessionId: RENDER_SESSION,
    title: '[MOCK] 渲染覆盖 · 代码块 + mermaid（合成）',
    promptFixture: 'synthetic-render.jsonl',
    historyFixture: 'synthetic-render.jsonl',
    frameCount: 4,
    teaches: '合成样例：覆盖代码块高亮与 mermaid 图渲染（非录制件）',
    createdAt: 1_789_500_000_000,
  },
];

/**
 * 两条"别的来源"的会话，用于证明 SessionSource 过滤真的生效。
 *
 * 它们永远不该出现在前端列表里，只会体现在 `filteredOut` 计数上。
 * ListAgentSessions 的 SessionTitle 过滤器实测被静默忽略，但 SessionSourceList 是生效的——
 * 这正是"只列本样板工程建的会话"能成立的原因。
 */
const OTHER_SOURCE = 'recorded-somewhere-else';

const OTHER_SOURCE_SCENARIOS: MockScenario[] = [
  {
    sessionId: 'mock-other-source-1',
    title: '[MOCK] 别的来源 · 应被过滤掉',
    promptFixture: 'prompt-short.jsonl',
    historyFixture: undefined,
    frameCount: 22,
    teaches: '这条不该出现在列表里。',
    createdAt: 1_788_313_631_000,
    sourceOverride: OTHER_SOURCE,
  },
  {
    sessionId: 'mock-other-source-2',
    title: '[MOCK] 别的来源 · 也应被过滤掉',
    promptFixture: 'prompt-short.jsonl',
    historyFixture: undefined,
    frameCount: 22,
    teaches: '这条也不该出现在列表里。',
    createdAt: 1_788_313_630_000,
    sourceOverride: OTHER_SOURCE,
  },
];

/**
 * MOCK 模式下"新建会话"登记在这里（进程级，重启即清空）。
 *
 * 必须登记：新建返回的 SessionId 之后要能被 findScenario 找到，
 * 否则在 mock 里新建一个会话再发 prompt 就会 404，而 live 模式不会——
 * 这种"只在 mock 下出现的行为差异"是最容易骗过验收的一类。
 */
const createdScenarios: MockScenario[] = [];

export function findScenario(sessionId: string): MockScenario | undefined {
  return MOCK_SCENARIOS.find((s) => s.sessionId === sessionId) ?? createdScenarios.find((s) => s.sessionId === sessionId);
}

/**
 * MOCK 模式的会话列表。
 *
 * 上游字段一律照真实形状给（`SessionStatus` 恒 RELEASED、`SessionUpdatedAt===SessionCreatedAt`），
 * 因为这两个"没用的字段"本身就是要教的内容：运行态问不出来，只能靠前端流。
 */
export function mockSessions(cfg: AppConfig): SessionsResult {
  const all: SessionSummary[] = [...createdScenarios, ...MOCK_SCENARIOS, ...OTHER_SOURCE_SCENARIOS].map((s) => ({
    sessionId: s.sessionId,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.createdAt,
    status: 'RELEASED',
    source: s.sourceOverride ?? cfg.sessionSource,
    tags: s.sourceOverride ? [] : ['mock'],
    mockScenario: s.teaches,
  }));

  const sessions = all.filter((s) => s.source === cfg.sessionSource);
  return { sessions, filteredOut: all.length - sessions.length, total: all.length };
}

/**
 * 新建会话（MOCK）。
 *
 * 成功判据与 live 完全一致：**只有 SessionId 非空**。live 模式下空 body 要归
 * `create_empty_body`（多为账号无运行实例 / 未传 ResourceGroupId），mock 不模拟这条失败路径。
 */
export function mockCreateSession(title: string): { sessionId: string } {
  const sessionId = `${SHORT_SESSION}-${Date.now().toString(36)}`;
  createdScenarios.unshift({
    sessionId,
    // SessionTitle = 首条 prompt 原文（含注入的校验码说明），与 live 行为一致
    title,
    promptFixture: 'prompt-short.jsonl',
    historyFixture: 'load-clean.jsonl',
    frameCount: 22,
    teaches: 'MOCK 下新建的会话，回放短轮录制件（22 帧 / end_turn）。',
    createdAt: Date.now(),
  });
  return { sessionId };
}
