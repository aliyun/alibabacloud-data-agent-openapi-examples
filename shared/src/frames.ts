import { STOP_REASONS, type StopReason } from './constants.js';

/**
 * 上游 ACP JSON-RPC 帧。
 *
 * 刻意建成宽松形状（所有键可选 + 索引签名）：真实帧里键会缺（900/977 帧没有
 * RequestId）、会多（_qwen/notify 排队帧带 Params.kind）、形状会分叉
 * （content 既可能是对象也可能是数组，且数组元素里还套一层 content）。
 * 把它建成严格的 discriminated union 只会带来假安全感——上游一变就编译通过但运行崩。
 * 所有取值都走下面的 helper，helper 里做真实的运行时判断。
 */
export interface AcpFrame {
  Jsonrpc?: string;
  Method?: string;
  Id?: unknown;
  Params?: FrameParams;
  Result?: Record<string, unknown>;
  Error?: FrameError;
  RequestId?: string;
  Timestamp?: number;
  [key: string]: unknown;
}

export interface FrameParams {
  _meta?: { offset?: number; [key: string]: unknown };
  sessionId?: string;
  update?: FrameUpdate;
  /** 排队通知帧（Method="_qwen/notify"）用这个键，此时没有 update。 */
  kind?: string;
  [key: string]: unknown;
}

export interface FrameUpdate {
  sessionUpdate?: string;
  /**
   * 两种真实形状：
   *  - thought / message / user chunk：`{type:'text', text:'…'}`
   *  - tool_call_update 完成帧：`[{type:'content', content:{type:'text', text:'…'}}]`（双层嵌套）
   *  - tool_call pending 帧：`[]`
   */
  content?: unknown;
  _meta?: {
    source?: string;
    toolName?: string;
    phase?: string;
    provenance?: string;
    usage?: TokenUsage;
    [key: string]: unknown;
  };
  toolCallId?: string;
  title?: string;
  status?: string;
  kind?: string;
  locations?: unknown[];
  rawInput?: { command?: string; description?: string; [key: string]: unknown };
  /** tool_call_update 完成帧上与 content 同级的纯字符串输出，可作兜底。 */
  rawOutput?: unknown;
  /** usage_update 帧的上下文窗口用量。 */
  size?: number;
  used?: number;
  /** load 首帧（sessionUpdate='config_option_update'）带的会话配置项数组。 */
  configOptions?: unknown[];
  [key: string]: unknown;
}

export interface FrameError {
  code?: number;
  errorCode?: string;
  message?: string;
  [key: string]: unknown;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedTokens?: number;
  [key: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * SDK 的 `*WithSSE()` 交出来的 `resp.body` 与线格式**不同名**。
 *
 * 实测（`$dara.cast` + `PromptAgentSessionResponseBody.names()`）：SDK 把 SSE 载荷反解成
 * Darabonba Model 实例，顶层键从 `Jsonrpc/Method/Params/RequestId/Result/Error/Timestamp/Id`
 * 变成 `jsonrpc/method/params/requestId/result/error/timestamp/id`，**且模型里没声明的键会被
 * 静默丢掉**（已核对：录制件里出现过的 8 个顶层键全部在模型声明内，所以当前无损；
 * 上游将来加字段就会丢，这也是这里把未知键原样带过去的原因）。
 *
 * 录制件与 reducer 一律走线格式（PascalCase）。不做这层归一，LIVE 下 `frame.Params`
 * 恒为 undefined ⇒ 一整轮什么都不显示，而且**不报任何错**——最难查的一类静默失效。
 */
const SDK_TO_WIRE: ReadonlyArray<readonly [wire: string, sdk: string]> = [
  ['Jsonrpc', 'jsonrpc'],
  ['Method', 'method'],
  ['Id', 'id'],
  ['Params', 'params'],
  ['Result', 'result'],
  ['Error', 'error'],
  ['RequestId', 'requestId'],
  ['Timestamp', 'timestamp'],
];

const WIRE_KEYS = new Set(SDK_TO_WIRE.map(([wire]) => wire));
const SDK_KEYS = new Set(SDK_TO_WIRE.map(([, sdk]) => sdk));

/**
 * 只有这些键**不足以**构成一个 ACP 帧。
 *
 * 实测依据两条：① 全部录制件里 100% 的帧都带 `Jsonrpc`（逐文件统计 noJsonrpc=0，
 * 合计 3000+ 行）；② 2026-09-15 真实链路上 `PromptAgentSession` 只回一个
 * `{"RequestId":"…"}` 的 POP 层回执就关流。
 *
 * 早先这里只要命中任意一个已知键就当成帧，于是那个回执被透传成"帧"，
 * 还被 `requestIdOf` 当成本轮 rid——rid 因此变成 32 位十六进制的 POP RequestId，
 * 而 ACP 帧上的 rid 是 UUID，拿前者去过滤历史必然一无所获。所以判据收紧成
 * "至少命中一个 ACP 层键"。
 */
const POP_ONLY_KEYS = new Set(['RequestId', 'requestId', 'Timestamp', 'timestamp', 'Id', 'id']);

/**
 * SDK 响应体 → 线格式帧。返回 undefined 表示"这不是一个帧"。
 *
 * 两条必须守住的性质：
 *  1. **缺的键不写**。`hasRequestId` 的判据是 `'RequestId' in frame`（实测 977 行里 900 行
 *     压根没这个键）。若在这里补一个 `RequestId: undefined`，rid 过滤会把 900 行污染帧
 *     全当成有效帧放进来，历史就会显示两遍。
 *  2. **两种大小写都认**。线格式（回放、直接抓包）与 camelCase（SDK Model）都可能是输入，
 *     同一个函数吃掉两种，LIVE 与 MOCK 才能共用下游同一个 reducer。
 */
export function frameFromSdkBody(body: unknown): AcpFrame | undefined {
  const inner = unwrapEnvelope(body);
  if (!isObject(inner)) return undefined;

  const frame: AcpFrame = {};
  let acpKeys = 0;
  for (const [wire, sdk] of SDK_TO_WIRE) {
    if (wire in inner) {
      frame[wire] = inner[wire];
      if (!POP_ONLY_KEYS.has(wire)) acpKeys += 1;
    } else if (sdk in inner) {
      frame[wire] = inner[sdk];
      if (!POP_ONLY_KEYS.has(wire)) acpKeys += 1;
    }
  }
  // 一个 ACP 层键都没有 ⇒ 不是帧。两种典型成因：
  //  · 只有 RequestId 的 POP 回执（上游收下了请求但没派发，见 promptNotDispatched）；
  //  · 载荷外面还套了一层信封，被 cast 按模型反解后字段全丢，剩下一个空 Model。
  // 两种都必须显式失败，不能当成"这一轮没有内容"。
  if (acpKeys === 0) return undefined;

  for (const [key, value] of Object.entries(inner)) {
    if (WIRE_KEYS.has(key) || SDK_KEYS.has(key) || key in frame) continue;
    frame[key] = value;
  }
  return frame;
}

/**
 * 从"只有 POP 回执"的载荷里把 RequestId 捞出来。
 *
 * 它不是 rid（不能用来过滤历史），但在零帧场景下是唯一还能拿去查这次调用的线索，
 * 所以必须留在错误 message 与服务端日志里，而不是随载荷一起丢掉。
 */
export function popAckRequestId(body: unknown): string | undefined {
  const inner = unwrapEnvelope(body);
  if (!isObject(inner)) return undefined;
  const value = 'RequestId' in inner ? inner.RequestId : inner.requestId;
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * 剥掉录制件外层的 `data` 信封。
 *
 * fixture 是抓的原始 SSE，每行形如 `{"data":{…帧…}}`；而 SDK 的
 * `*WithSSE()` yield 出来的 `resp.body` 已经是剥好壳的帧。
 * 这个函数让两条路径收敛成同一个形状——否则回放与真实链路走的不是同一份解析代码，
 * 单测绿了也不能说明线上能用。
 */
export function unwrapEnvelope(value: unknown): unknown {
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'data') return value.data;
  }
  return value;
}

/** 解析一行录制件（带信封）为帧；无法解析或不是对象时返回 undefined。 */
export function parseRecordedLine(line: string): AcpFrame | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return asFrame(unwrapEnvelope(JSON.parse(trimmed)));
  } catch {
    return undefined;
  }
}

export function asFrame(value: unknown): AcpFrame | undefined {
  return isObject(value) ? (value as AcpFrame) : undefined;
}

/**
 * 这一帧有没有 RequestId。
 *
 * 判据必须是**键是否存在**，不是值是否为空串：实测 977 行的 load 回放里有 900 行
 * 压根没有 RequestId 这个键，而 `"RequestId": ""` 命中 0 行。
 * 用 `!frame.RequestId` 或 `frame.RequestId === ''` 都会得到完全错误的过滤结果。
 */
export function hasRequestId(frame: AcpFrame): boolean {
  return 'RequestId' in frame;
}

export function requestIdOf(frame: AcpFrame): string | undefined {
  return hasRequestId(frame) && typeof frame.RequestId === 'string' ? frame.RequestId : undefined;
}

export function paramsOf(frame: AcpFrame): FrameParams | undefined {
  return isObject(frame.Params) ? (frame.Params as FrameParams) : undefined;
}

export function updateOf(frame: AcpFrame): FrameUpdate | undefined {
  const params = paramsOf(frame);
  return params && isObject(params.update) ? (params.update as FrameUpdate) : undefined;
}

/**
 * 这一帧的 sessionUpdate 类型；取不到时返回 undefined。
 *
 * 调用方必须容忍 undefined：排队通知帧（Method="_qwen/notify"）连 update 都没有。
 * 不能 switch 到 default 就抛——上游多一种帧型不该让整个会话打不开。
 */
export function sessionUpdateOf(frame: AcpFrame): string | undefined {
  const update = updateOf(frame);
  return update && typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
}

/** 帧序号。注意它不可持久化：空闲约 5 分钟后服务端计数器会重置（实测从 391 回到 1）。 */
export function offsetOf(frame: AcpFrame): number | undefined {
  const meta = paramsOf(frame)?._meta;
  return meta && typeof meta.offset === 'number' ? meta.offset : undefined;
}

export function timestampOf(frame: AcpFrame): number | undefined {
  return typeof frame.Timestamp === 'number' ? frame.Timestamp : undefined;
}

export function sessionIdOf(frame: AcpFrame): string | undefined {
  const id = paramsOf(frame)?.sessionId;
  return typeof id === 'string' ? id : undefined;
}

export function errorOf(frame: AcpFrame): FrameError | undefined {
  return isObject(frame.Error) ? (frame.Error as FrameError) : undefined;
}

export interface TerminalInfo {
  /** 已知的终态原因；上游给了不认识的字符串时为 undefined。 */
  stopReason: StopReason | undefined;
  /** 上游原样给的字符串，用于在 UI 上如实显示"终态未知（原值 X）"。 */
  rawStopReason: string | undefined;
}

/**
 * 轮次终态。
 *
 * 终态只看顶层 `Result.stopReason`，不看任何状态字段——服务端 SessionStatus 恒为
 * RELEASED、SessionUpdatedAt 恒等于 SessionCreatedAt（实测 29/29），问不出来。
 */
export function terminalOf(frame: AcpFrame): TerminalInfo | undefined {
  if (!isObject(frame.Result)) return undefined;
  const raw = frame.Result.stopReason;
  /**
   * `Result:{}`（有响应壳但没有 stopReason）**不算终态**。
   *
   * 终态的全部语义都在 stopReason 上，空壳只是"上游应答了"。把它当终态会让
   * 静默截断被报成"本轮正常结束"——而调用方接着就会认为回答是完整的。
   * 判不出终态时上层归 stream_break（见 turnStore.run 里的 sawTerminal 分支）。
   */
  if (typeof raw !== 'string' || raw === '') return undefined;
  const known = STOP_REASONS.find((r) => r === raw);
  return { stopReason: known, rawStopReason: raw };
}

/**
 * 取文本内容，同时处理两种真实形状。
 *
 * 直接读 `content.text` 在 tool_call_update 完成帧上会得到空串——那一帧的 content
 * 是数组，文本在 `content[0].content.text`（双层嵌套）。
 */
export function textOf(update: FrameUpdate | undefined): string {
  const content = update?.content;
  if (typeof content === 'string') return content;
  if (isObject(content)) {
    return typeof content.text === 'string' ? content.text : '';
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      if (isObject(item)) {
        const nested = isObject(item.content) ? item.content : item;
        if (typeof nested.text === 'string') parts.push(nested.text);
      }
    }
    return parts.join('');
  }
  return '';
}

/**
 * 工具执行结果文本。
 *
 * 优先取双层嵌套的 `content[0].content.text`（里面带 Command / Output / Exit Code 全文），
 * 取不到再退同级的 `rawOutput`（只有输出本体）。两者都可能没有——pending 帧的 content 是 `[]`。
 */
export function toolResultText(update: FrameUpdate | undefined): string | undefined {
  const fromContent = textOf(update);
  if (fromContent) return fromContent;
  const raw = update?.rawOutput;
  if (typeof raw === 'string' && raw) return raw;
  if (isObject(raw) && typeof raw.text === 'string' && raw.text) return raw.text;
  return undefined;
}

export function tokenUsageOf(update: FrameUpdate | undefined): TokenUsage | undefined {
  const usage = update?._meta?.usage;
  return isObject(usage) ? (usage as TokenUsage) : undefined;
}

/** 工具名在 `update._meta.toolName`，不在顶层；tool_call 帧的 rawInput 是空对象。 */
export function toolNameOf(update: FrameUpdate | undefined): string | undefined {
  const name = update?._meta?.toolName;
  return typeof name === 'string' && name ? name : undefined;
}

/**
 * 工具操作的对象位置（`update.locations`）。
 *
 * **全部录制件里这个键恒为空数组**（逐文件核对过），所以它现在不会产出任何可见内容。
 * 仍然聚合它的理由是：上游声明了这个键，哪天填上了就该直接显示出来，而不是表现为
 * "卡片少了一行"。元素形状同样未被观测到，只能宽松解析——字符串直接收，
 * 对象则按常见命名取第一个非空字符串。
 */
export function locationsOf(update: FrameUpdate | undefined): string[] {
  const raw = update?.locations;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item) out.push(item);
      continue;
    }
    if (!isObject(item)) continue;
    for (const key of ['path', 'pathname', 'uri', 'name'] as const) {
      const value = item[key];
      if (typeof value === 'string' && value) {
        out.push(value);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 人卡交互（permission_request / permission_resolved）
// ---------------------------------------------------------------------------

/**
 * 人卡交互帧的解析产物。
 *
 * 【LIVE 09-17】实测协议（cn-beijing 预发）：两类交互走**同一个**通知通道——
 * `_qwen/notify` 帧、`Params.kind='permission_request'`、`Params.data.requestId`
 * 是回覆（ReplyAgentSession）要用的 permissionRequestId：
 *  · **工具授权**（default 模式下会触发审批的工具调用）：`data.toolCall` 是工具预览，
 *    `data.options[]` 是 ACP 标准选项（optionId 如 `proceed_once`/`proceed_always`/`cancel`，
 *    kind 如 `allow_once`）——回覆走 `outcome.optionId`；
 *  · **ask_user_question**（agent 向用户提问）：`data.toolCall._meta.qwenInteractionKind
 *    ='user_question'`，`qwenQuestions[]`/`rawInput.questions[]` 带问题与选项
 *    （label/description，**没有 optionId**）——回覆走 `answers`（索引键），
 *    只回 outcome 会以 `proceed_once` 解除阻塞但 agent 收不到答案（实测）。
 */
export interface PendingInteraction {
  requestId: string;
  sessionId: string | undefined;
  toolName: string | undefined;
  /** `user_question` = ask_user_question（答案走 answers）；其余按工具授权处理（走 outcome.optionId）。 */
  interactionKind: 'user_question' | 'permission';
  toolCallTitle: string | undefined;
  toolCallId: string | undefined;
  /** ask_user_question 的问题与选项（来自 toolCall.rawInput.questions）。 */
  questions: { question: string; header?: string; options: { label: string; description?: string }[] }[];
  /** 工具授权类的 ACP 选项（来自 data.options）。 */
  options: { optionId: string; name?: string; kind?: string }[];
}

/** 从 `_qwen/notify` 帧里解析人卡请求；不是权限请求帧时返回 undefined。 */
export function pendingInteractionOf(frame: AcpFrame): PendingInteraction | undefined {
  const params = paramsOf(frame);
  if (params?.kind !== 'permission_request') return undefined;
  const data = isObject(params.data) ? params.data : undefined;
  const requestId = data && typeof data.requestId === 'string' ? data.requestId : undefined;
  if (!requestId) return undefined;

  const toolCall = data && isObject(data.toolCall) ? data.toolCall : undefined;
  const meta = toolCall && isObject(toolCall._meta) ? toolCall._meta : undefined;
  const toolName = meta && typeof meta.toolName === 'string' ? meta.toolName : undefined;
  const interactionKind: PendingInteraction['interactionKind'] =
    meta && meta.qwenInteractionKind === 'user_question' ? 'user_question' : 'permission';

  const questions: PendingInteraction['questions'] = [];
  const rawQuestions =
    (toolCall && isObject(toolCall.rawInput) && Array.isArray(toolCall.rawInput.questions)
      ? toolCall.rawInput.questions
      : undefined) ?? (meta && Array.isArray(meta.qwenQuestions) ? meta.qwenQuestions : undefined);
  if (rawQuestions) {
    for (const q of rawQuestions) {
      if (!isObject(q) || typeof q.question !== 'string') continue;
      const opts: { label: string; description?: string }[] = [];
      if (Array.isArray(q.options)) {
        for (const o of q.options) {
          if (isObject(o) && typeof o.label === 'string') {
            opts.push({
              label: o.label,
              description: typeof o.description === 'string' ? o.description : undefined,
            });
          }
        }
      }
      questions.push({
        question: q.question,
        header: typeof q.header === 'string' ? q.header : undefined,
        options: opts,
      });
    }
  }

  const options: PendingInteraction['options'] = [];
  if (data && Array.isArray(data.options)) {
    for (const o of data.options) {
      if (isObject(o) && typeof o.optionId === 'string' && o.optionId) {
        options.push({
          optionId: o.optionId,
          name: typeof o.name === 'string' ? o.name : undefined,
          kind: typeof o.kind === 'string' ? o.kind : undefined,
        });
      }
    }
  }

  return {
    requestId,
    sessionId: data && typeof data.sessionId === 'string' ? data.sessionId : undefined,
    toolName,
    interactionKind,
    toolCallTitle: toolCall && typeof toolCall.title === 'string' ? toolCall.title : undefined,
    toolCallId: toolCall && typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : undefined,
    questions,
    options,
  };
}

/** `permission_resolved` 通知：daemon 确认某个人卡交互已被回覆（回执在原流上）。 */
export function permissionResolvedOf(frame: AcpFrame): { requestId: string } | undefined {
  const params = paramsOf(frame);
  if (params?.kind !== 'permission_resolved') return undefined;
  const data = isObject(params.data) ? params.data : undefined;
  const requestId = data && typeof data.requestId === 'string' ? data.requestId : undefined;
  return requestId ? { requestId } : undefined;
}
