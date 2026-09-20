import { OBSERVED_SESSION_UPDATES, OBSERVED_TOOL_STATUSES, type StopReason } from './constants.js';
import {
  offsetOf,
  locationsOf,
  requestIdOf,
  sessionUpdateOf,
  sessionIdOf,
  terminalOf,
  textOf,
  timestampOf,
  tokenUsageOf,
  toolNameOf,
  toolResultText,
  updateOf,
  paramsOf,
  errorOf,
  type AcpFrame,
  type FrameError,
  type TokenUsage,
} from './frames.js';
import { partitionByRid } from './rid.js';

export type ToolStatus = (typeof OBSERVED_TOOL_STATUSES)[number] | 'unknown';

export interface ToolCallView {
  toolCallId: string;
  /** 工具名在 update._meta.toolName，不在顶层。 */
  name: string | undefined;
  title: string | undefined;
  status: ToolStatus;
  /**
   * 命令文本。实测只有 in_progress 帧的 rawInput 里有 command，
   * pending 帧的 rawInput 是空对象、completed 帧又不带——所以只能"见到就存、见不到别覆盖"。
   */
  command: string | undefined;
  description: string | undefined;
  /**
   * 入参整包。刻意不只挑 command / description 两个键：实测 rawInput 的形状不固定，
   * 除 `{command,description}` 外还出现过 `{skill:"dataworks-meta-table"}` 这种，
   * 挑键就等于把没预料到的参数静默丢掉。渲染侧按 key/value 全列。
   */
  rawInput: Record<string, unknown> | undefined;
  /** 操作对象位置。全部录制件里恒为空数组，见 frames.locationsOf。 */
  locations: string[];
  /** 执行结果全文（含 Command / Output / Exit Code），来自 content[0].content.text 或 rawOutput。 */
  resultText: string | undefined;
  firstOffset: number | undefined;
  lastOffset: number | undefined;
  /** 首末帧的 Timestamp（毫秒）。差值就是这次调用的可观测耗时。 */
  firstTimestamp: number | undefined;
  lastTimestamp: number | undefined;
}

export interface TurnAggregate {
  rid: string | undefined;
  sessionId: string | undefined;
  /** 用户提示词。归档态会重复出现两条相同文本，已去重。 */
  userText: string;
  thoughtText: string;
  messageText: string;
  tools: ToolCallView[];
  /** usage_update 帧给的上下文窗口用量。 */
  contextUsage: { size: number; used: number } | undefined;
  /** 消息帧 _meta.usage 给的 token 明细。 */
  tokenUsage: TokenUsage | undefined;
  /** 是否出现过顶层 Result.stopReason。 */
  terminated: boolean;
  stopReason: StopReason | undefined;
  rawStopReason: string | undefined;
  /** 帧内 Error（断流 / 幽灵化 / 并发拒绝都走这里）。 */
  error: FrameError | undefined;
  frameCount: number;
  firstTimestamp: number | undefined;
  lastTimestamp: number | undefined;
  minOffset: number | undefined;
  maxOffset: number | undefined;
  /** 排队通知帧（Method="_qwen/notify"）计数。 */
  queuedNotices: number;
  /**
   * 出现过但不认识的 update 类型。
   *
   * 不静默吞掉：这个集合**没有被证明是封闭的**（load 首帧就压根没有 sessionUpdate 键），
   * 新类型出现时要能在界面上看见，而不是表现为"内容凭空少了一段"。
   */
  unrecognizedUpdates: string[];
}

export function createTurn(rid?: string): TurnAggregate {
  return {
    rid,
    sessionId: undefined,
    userText: '',
    thoughtText: '',
    messageText: '',
    tools: [],
    contextUsage: undefined,
    tokenUsage: undefined,
    terminated: false,
    stopReason: undefined,
    rawStopReason: undefined,
    error: undefined,
    frameCount: 0,
    firstTimestamp: undefined,
    lastTimestamp: undefined,
    minOffset: undefined,
    maxOffset: undefined,
    queuedNotices: 0,
    unrecognizedUpdates: [],
  };
}

const KNOWN_UPDATES = new Set<string>(OBSERVED_SESSION_UPDATES);
const KNOWN_TOOL_STATUSES = new Set<string>(OBSERVED_TOOL_STATUSES);

function findTool(turn: TurnAggregate, toolCallId: string): ToolCallView | undefined {
  // 一轮里的工具调用是十位数量级，线性查找比维护一个 Map 更简单，也不会引入序列化问题
  for (const tool of turn.tools) {
    if (tool.toolCallId === toolCallId) return tool;
  }
  return undefined;
}

function noteUnrecognized(turn: TurnAggregate, label: string): void {
  if (!turn.unrecognizedUpdates.includes(label)) turn.unrecognizedUpdates.push(label);
}

/**
 * 把一帧并入轮次聚合。
 *
 * 这是全工程唯一的帧解释点：后端拉历史用它、前端渲染在途流用它、mock 回放也用它。
 * 只存聚合结果、不存原始帧——实测 901 帧 / 191 秒 ⇒ 平均约 4.7 帧/s，
 * 最密的 1 秒里有 15 帧（`server-node/test/reduce.test.ts` 钉住这两个数），
 * 存原始帧会让内存和 React 更新量都随轮次长度线性膨胀。
 */
export function applyFrame(turn: TurnAggregate, frame: AcpFrame): void {
  turn.frameCount += 1;

  if (turn.rid === undefined) turn.rid = requestIdOf(frame);
  if (turn.sessionId === undefined) turn.sessionId = sessionIdOf(frame);

  const timestamp = timestampOf(frame);
  if (timestamp !== undefined) {
    if (turn.firstTimestamp === undefined || timestamp < turn.firstTimestamp) turn.firstTimestamp = timestamp;
    if (turn.lastTimestamp === undefined || timestamp > turn.lastTimestamp) turn.lastTimestamp = timestamp;
  }

  const offset = offsetOf(frame);
  if (offset !== undefined) {
    if (turn.minOffset === undefined || offset < turn.minOffset) turn.minOffset = offset;
    if (turn.maxOffset === undefined || offset > turn.maxOffset) turn.maxOffset = offset;
  }

  const error = errorOf(frame);
  if (error) {
    // 错误帧不产出内容。注意同一轮的帧仍会继续到达（断流前已有 1200 帧），
    // 所以这里只记录、不终止聚合。
    turn.error = error;
    return;
  }

  const terminal = terminalOf(frame);
  if (terminal) {
    turn.terminated = true;
    turn.stopReason = terminal.stopReason;
    turn.rawStopReason = terminal.rawStopReason;
    return;
  }

  const update = updateOf(frame);
  if (!update) {
    // 排队通知帧（Method="_qwen/notify"，Params.kind="pending_prompt_added"）没有 update，
    // 它是"你的提示词排上了"的信号，不是内容。
    const noticeKind = paramsOf(frame)?.kind;
    if (typeof noticeKind === 'string') {
      turn.queuedNotices += 1;
      return;
    }
    noteUnrecognized(turn, '<no update>');
    return;
  }

  const kind = sessionUpdateOf(frame);
  if (kind === undefined) {
    // update 存在但没有 sessionUpdate。容忍并计数，不抛：这是"上游加一种帧型"时
    // 退化成"少了一段内容 + 一个可见计数"，而不是整个会话打不开。
    noteUnrecognized(turn, '<missing sessionUpdate>');
    return;
  }
  if (!KNOWN_UPDATES.has(kind)) noteUnrecognized(turn, kind);

  switch (kind) {
    case 'user_message_chunk': {
      const text = textOf(update);
      /**
       * 归档态里同一句提示词会出现两条完全相同的 user_message_chunk
       * （一条无 offset、一条带 offset 且 _meta.source="bridge-echo"），
       * 实测两份 load 回放都是如此。不去重界面上就会把提示词显示两遍。
       */
      if (text && text !== turn.userText) turn.userText += text;
      break;
    }
    case 'agent_thought_chunk': {
      // 按 token 分片，必须拼接；末尾可能有空串收尾片，追加空串本身无害
      turn.thoughtText += textOf(update);
      break;
    }
    case 'agent_message_chunk': {
      turn.messageText += textOf(update);
      const usage = tokenUsageOf(update);
      if (usage) turn.tokenUsage = usage;
      break;
    }
    case 'tool_call':
    case 'tool_call_update': {
      applyToolFrame(turn, update, offset, timestamp);
      break;
    }
    case 'usage_update': {
      const size = typeof update.size === 'number' ? update.size : undefined;
      const used = typeof update.used === 'number' ? update.used : undefined;
      if (size !== undefined || used !== undefined) {
        turn.contextUsage = {
          size: size ?? turn.contextUsage?.size ?? 0,
          used: used ?? turn.contextUsage?.used ?? 0,
        };
      }
      break;
    }
    default:
      // config_option_update 等：已经记进 unrecognizedUpdates，不当内容处理
      break;
  }
}

function applyToolFrame(
  turn: TurnAggregate,
  update: NonNullable<ReturnType<typeof updateOf>>,
  offset: number | undefined,
  timestamp: number | undefined,
): void {
  const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
  if (!toolCallId) {
    noteUnrecognized(turn, '<tool frame without toolCallId>');
    return;
  }

  const statusRaw = typeof update.status === 'string' ? update.status : undefined;
  const status: ToolStatus =
    statusRaw && KNOWN_TOOL_STATUSES.has(statusRaw) ? (statusRaw as ToolStatus) : 'unknown';

  let tool = findTool(turn, toolCallId);
  if (!tool) {
    tool = {
      toolCallId,
      name: undefined,
      title: undefined,
      status: 'unknown',
      command: undefined,
      description: undefined,
      rawInput: undefined,
      locations: [],
      resultText: undefined,
      firstOffset: offset,
      lastOffset: offset,
      firstTimestamp: timestamp,
      lastTimestamp: timestamp,
    };
    turn.tools.push(tool);
  }

  // 一律"有值才覆盖"：completed 帧不带 title/rawInput.command，
  // 无脑赋值会把 in_progress 阶段拿到的信息擦掉。
  const name = toolNameOf(update);
  if (name) tool.name = name;
  if (typeof update.title === 'string' && update.title) tool.title = update.title;
  if (status !== 'unknown') tool.status = status;
  const command = update.rawInput?.command;
  if (typeof command === 'string' && command) tool.command = command;
  const description = update.rawInput?.description;
  if (typeof description === 'string' && description) tool.description = description;

  /**
   * rawInput 增量合并而不是整包替换：pending 帧的 rawInput 是 `{}`，
   * 替换会把前一帧拿到的参数擦成空。只在真的有新键时才建对象，
   * 否则 `{}` 会让"这个工具没有参数"和"上游没给参数"分不清。
   */
  const rawInput = update.rawInput;
  if (rawInput && typeof rawInput === 'object') {
    const entries = Object.entries(rawInput);
    if (entries.length > 0) {
      tool.rawInput = { ...tool.rawInput, ...rawInput };
    }
  }

  const locations = locationsOf(update);
  if (locations.length > 0) tool.locations = locations;

  const resultText = toolResultText(update);
  if (resultText) tool.resultText = resultText;
  if (offset !== undefined) tool.lastOffset = offset;
  if (timestamp !== undefined) {
    if (tool.firstTimestamp === undefined || timestamp < tool.firstTimestamp) tool.firstTimestamp = timestamp;
    if (tool.lastTimestamp === undefined || timestamp > tool.lastTimestamp) tool.lastTimestamp = timestamp;
  }
}

/** 把一串帧聚合成一个轮次。 */
export function reduceFrames(frames: Iterable<AcpFrame>, rid?: string): TurnAggregate {
  const turn = createTurn(rid);
  for (const frame of frames) applyFrame(turn, frame);
  return turn;
}

export interface HistoryReduction {
  /** 构成轮次的 rid，按首次出现顺序。 */
  turns: TurnAggregate[];
  /** 被丢弃的无 rid 帧数（原始回放污染，同一轮内容的第二份拷贝）。 */
  droppedRidLess: number;
  /** 所有出现过的 rid → 帧数，含不构成轮次的那些。 */
  rids: Record<string, number>;
  /**
   * 有帧但不构成轮次的 rid。
   *
   * 典型是 load 调用自己的那个 rid：名下只有 config_option_update 与一个
   * Result.stopReason=end_turn —— 那是 load 请求的返回，不是会话里真有一轮结束了。
   * 把它当轮次渲染就会凭空多出一个"空回答但已完成"的假轮次。
   */
  nonTurnRids: string[];
  totalFrames: number;
}

/**
 * 把 load（拉历史）的帧流还原成轮次列表。
 *
 * 轮次判据：该 rid 名下至少有一条 user_message_chunk。
 * 只有 load 自己的 rid 与配置帧不满足这条，正好被排除。
 */
export function reduceHistory(frames: Iterable<AcpFrame>): HistoryReduction {
  const { byRid, ridLess, total } = partitionByRid(frames);
  const turns: TurnAggregate[] = [];
  const nonTurnRids: string[] = [];
  const rids: Record<string, number> = {};

  for (const [rid, group] of byRid) {
    rids[rid] = group.length;
    const isTurn = group.some((f) => sessionUpdateOf(f) === 'user_message_chunk');
    if (isTurn) turns.push(reduceFrames(group, rid));
    else nonTurnRids.push(rid);
  }

  return { turns, droppedRidLess: ridLess.length, rids, nonTurnRids, totalFrames: total };
}
