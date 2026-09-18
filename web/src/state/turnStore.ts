import {
  applyFrame,
  createTurn,
  markerVerified,
  pendingInteractionOf,
  permissionResolvedOf,
  streamBreakWithoutTerminal,
  transportError,
  type ApiError,
  type ApiResult,
  type PendingInteraction,
  type ReplyResult,
  type StopReason,
  type TokenUsage,
  type ToolCallView,
  type TurnAggregate,
  type WireEvent,
} from '@das/shared';

import { API_BASE } from '@/api/client';
import { openPromptStream } from '@/api/stream';
import { inflightStore, persists } from '@/state/inflight';

/**
 * 在途轮次的状态机。
 *
 * 这些 phase 就是"运行态的事实源"：服务端问不出运行态——SessionStatus 恒为
 * RELEASED、SessionUpdatedAt 恒等于 SessionCreatedAt（实测 29/29），所以
 * "这一轮跑完没有"只能信前端自己收到的流。
 *
 * 【LIVE 09-18】cancel 已生效（上游 200 + 流以 `stopReason=cancelled` 终态收场，
 * 实测 3/3），所以新增了 'cancelling' / 'cancelled' 两个相位：点停止 = 向上游
 * 发取消请求并继续收流，等 cancelled 终态到达后落 'cancelled'。cancel 请求
 * 本身失败时退回 'abandoned'（旧行为：只停了本地接收）。
 */
export type TurnPhase =
  | 'idle'
  | 'streaming'
  | 'done'
  /** 已发取消请求、还在收流等 cancelled 终态。 */
  | 'cancelling'
  /** 上游确认取消：流以 stopReason=cancelled 终态收场。 */
  | 'cancelled'
  /** 取消请求失败（或历史遗留路径）：只停止了本地接收，服务端可能仍在执行。 */
  | 'abandoned'
  /** 断流后的等待态（阶段 6 接探测器）。 */
  | 'break_recovering'
  /** 会话已失效（上游 422），这个会话不能再发。 */
  | 'ghost'
  | 'error';

export interface TurnView {
  sessionId: string | undefined;
  phase: TurnPhase;
  rid: string | undefined;
  marker: string | undefined;
  /** 回答正文里原样出现了本轮校验码 ⇒ 这一段确实是这一轮产出的。 */
  verified: boolean;
  startedAt: number | undefined;
  /**
   * 断流被观测到的时刻。探测时限从这一刻起算，不从 startedAt 起算：
   * 长轮实测 191s 才被掐断，用 startedAt 的话 300s 的探测窗口只剩不到 2 分钟。
   */
  brokeAt: number | undefined;
  lastEventAt: number | undefined;
  /** 超过 3 个心跳周期没收到任何事件（含 hb）。判活不挂在 rAF 上。 */
  stalled: boolean;
  frameCount: number;
  /**
   * 首末帧上的服务端 Timestamp（毫秒）。
   *
   * 与 startedAt 不是一个时钟源：startedAt 是**代理进程**发起调用那一刻的
   * `Date.now()`（server/src/routes/prompt.ts），这两个是上游打在帧上的
   * （MOCK 下就是录制当时的时刻）。算"这一轮跑了多久"只能用后者，
   * 拿前者相减会把代理到上游的排队时间也算进来。
   */
  firstTimestamp: number | undefined;
  lastTimestamp: number | undefined;
  userText: string;
  thoughtText: string;
  messageText: string;
  tools: ToolCallView[];
  contextUsage: { size: number; used: number } | undefined;
  tokenUsage: TokenUsage | undefined;
  stopReason: StopReason | undefined;
  rawStopReason: string | undefined;
  error: ApiError | undefined;
  queuedNotices: number;
  unrecognizedUpdates: string[];
  /**
   * 待回应的人卡交互（【LIVE 09-17】）。
   *
   * 出现时轮次仍在 'streaming'：SSE 连接开着、上游在等人回覆。用户点选项后走
   * `replyToInteraction` → POST /reply，原流继续，交互卡随 `permission_resolved`
   * 帧或提交成功消失。**不要**在此状态下重发 prompt——会撞在途锁，且人卡不靠重发解决。
   */
  interaction:
    | {
        request: PendingInteraction;
        reply: 'pending' | 'submitting' | 'submitted' | 'failed';
        error?: string;
      }
    | undefined;
}

const IDLE_VIEW: TurnView = {
  sessionId: undefined,
  phase: 'idle',
  rid: undefined,
  marker: undefined,
  verified: false,
  startedAt: undefined,
  brokeAt: undefined,
  lastEventAt: undefined,
  stalled: false,
  frameCount: 0,
  firstTimestamp: undefined,
  lastTimestamp: undefined,
  userText: '',
  thoughtText: '',
  messageText: '',
  tools: [],
  contextUsage: undefined,
  tokenUsage: undefined,
  stopReason: undefined,
  rawStopReason: undefined,
  error: undefined,
  queuedNotices: 0,
  unrecognizedUpdates: [],
  interaction: undefined,
};

/** 心跳 15s 一跳，连丢 3 跳就算不上"还活着"。 */
const STALL_MS = 45_000;
const STALL_CHECK_MS = 5_000;

/**
 * rAF 兜底定时器的延时。
 *
 * 250ms 足够短：隐藏标签页里定时器被降频到约 1s 一次，仍能看见内容在长；
 * 又足够长：前台时 rAF（约 16ms）总会先到，兜底定时器基本只是被 clearTimeout 掉，
 * 不会与 rAF 抢同一批帧、造成一轮两次重排。
 */
const FLUSH_FALLBACK_MS = 250;

interface Internal {
  view: TurnView;
  /** mutable 聚合器：只存聚合结果，不存原始帧。 */
  agg: TurnAggregate;
  abort: AbortController | undefined;
  stallTimer: ReturnType<typeof setInterval> | undefined;
  rafScheduled: boolean;
  /** rAF 的兜底定时器句柄：隐藏标签页里 rAF 会被暂停，见 markDirty。 */
  flushFallback: ReturnType<typeof setTimeout> | undefined;
  /**
   * 每次 start / clear 递增。
   *
   * 旧一轮的 `run()` 靠它认出自己已经作废：abort 之后 fetch 的 reader 还可能吐出
   * 已经缓冲好的事件，而 clear() 之后视图已经归零——晚到的帧写进去就是"清空了又自己
   * 长出内容"，或者把上一轮的内容混进新一轮的聚合器。
   */
  generation: number;
  /** 最近一次收到 wire 事件的时刻。判活只看它，不挂在 rAF 上。 */
  lastEventAt: number | undefined;
  /**
   * 用户自己敲进去的那句话。
   *
   * 展示时优先用它，而不是流里回显的 `user_message_chunk`：
   *  · MOCK 模式回放的是录制件，回显的是**录制时**那句提示词，跟用户刚敲的无关；
   *  · LIVE 模式回显的是服务端注入过校验码尾行的出站全文（`withMarker`），
   *    那段尾行不是用户写的。
   * 归属由 MarkerBadge 交代，气泡只负责显示用户敲的原文。
   */
  typedText: string;
}

const state: Internal = {
  view: IDLE_VIEW,
  agg: createTurn(),
  abort: undefined,
  stallTimer: undefined,
  rafScheduled: false,
  flushFallback: undefined,
  generation: 0,
  lastEventAt: undefined,
  typedText: '',
};

const listeners = new Set<() => void>();

function buildView(): TurnView {
  const { agg, view } = state;
  return {
    ...view,
    rid: agg.rid ?? view.rid,
    frameCount: agg.frameCount,
    firstTimestamp: agg.firstTimestamp,
    lastTimestamp: agg.lastTimestamp,
    userText: state.typedText || agg.userText,
    thoughtText: agg.thoughtText,
    messageText: agg.messageText,
    // 工具卡片是逐个渲染的，必须给新数组和新对象，否则 React 看不出变化
    tools: agg.tools.map((tool) => ({ ...tool })),
    contextUsage: agg.contextUsage ? { ...agg.contextUsage } : undefined,
    tokenUsage: agg.tokenUsage,
    stopReason: agg.stopReason ?? view.stopReason,
    rawStopReason: agg.rawStopReason ?? view.rawStopReason,
    queuedNotices: agg.queuedNotices,
    unrecognizedUpdates: [...agg.unrecognizedUpdates],
    verified: markerVerified(agg.messageText, view.marker),
    lastEventAt: state.lastEventAt,
    stalled: state.lastEventAt !== undefined && Date.now() - state.lastEventAt > STALL_MS,
  };
}

function publish(): void {
  state.view = buildView();
  for (const listener of listeners) listener();
}

/**
 * 把"服务端可能还在跑"这件事落到 localStorage，让刷新页面/换标签页之后还看得见。
 *
 * 刻意不挂在 publish 里：publish 每帧都会走一次（平均约每秒 4.7 帧），而 localStorage
 * 是同步写盘。这里只在 phase 真正变化的那几个落点调用。
 */
function persistInflight(): void {
  const { sessionId, rid, phase, startedAt } = state.view;
  if (sessionId === undefined || startedAt === undefined || !persists(phase)) {
    inflightStore.clear();
    return;
  }
  inflightStore.write({ sessionId, rid, phase, startedAt });
}

/**
 * 帧到达只标脏，下一次 flush 时 publish 一次 ⇒ 每帧最多触发一次 React 更新。
 *
 * 长轮实测 901 帧 / 191 秒 ⇒ 平均约每秒 4.7 帧，最密的 1 秒里有 15 帧；
 * 逐帧 setState 会让中栏在那一秒里重排 15 次。
 *
 * flush 有**两条**触发路径，缺一不可：
 *  · rAF —— 前台标签页的正常路径，跟着浏览器绘制节奏走；
 *  · 定时器兜底 —— 实测隐藏/后台标签页里 rAF 会被整个暂停（6s 内一次都不触发），
 *    只靠 rAF 的话长轮期间中栏一片空白，直到本轮结束才一次性长出全部内容。
 *    后台定时器只是被降频（约 1s 一次），不会暂停，所以能兜住。
 * 两条路径共用一个幂等的 flush，靠 rafScheduled 保证同一批帧只 publish 一次。
 *
 * **存活判定不挂在这里**——那部分走 stallTimer（setInterval）。
 */
function markDirty(): void {
  if (state.rafScheduled) return;
  state.rafScheduled = true;
  requestAnimationFrame(flush);
  state.flushFallback = setTimeout(flush, FLUSH_FALLBACK_MS);
}

function flush(): void {
  if (!state.rafScheduled) return;
  state.rafScheduled = false;
  if (state.flushFallback !== undefined) {
    clearTimeout(state.flushFallback);
    state.flushFallback = undefined;
  }
  publish();
}

function clearStallTimer(): void {
  if (state.stallTimer !== undefined) {
    clearInterval(state.stallTimer);
    state.stallTimer = undefined;
  }
}

function startStallTimer(): void {
  clearStallTimer();
  state.stallTimer = setInterval(() => {
    if (state.lastEventAt === undefined) return;
    const stalled = Date.now() - state.lastEventAt > STALL_MS;
    // 只在结论真的翻转时才 publish：这个定时器 5s 一跳，无脑 publish 会让中栏每 5s 重排一次
    if (stalled !== state.view.stalled) publish();
  }, STALL_CHECK_MS);
}

function resetAgg(sessionId: string, typedText: string): void {
  state.agg = createTurn();
  state.typedText = typedText;
  state.lastEventAt = Date.now();
  state.view = { ...IDLE_VIEW, sessionId, phase: 'streaming', startedAt: Date.now() };
  persistInflight();
}

function setPhase(phase: TurnPhase, error?: ApiError): void {
  clearStallTimer();
  state.view = {
    ...buildView(),
    phase,
    error: error ?? state.view.error,
    // 只记首次断流的时刻：探测器可能让人反复回到这个 phase，时限不该被重置
    brokeAt: phase === 'break_recovering' ? (state.view.brokeAt ?? Date.now()) : state.view.brokeAt,
    // 人卡只属于进行中的轮次：终态/断流/失效时一并撤下，别让它挂在已结束的轮次上
    interaction: phase === 'streaming' || phase === 'cancelling' ? state.view.interaction : undefined,
  };
  persistInflight();
  for (const listener of listeners) listener();
}

function handle(event: WireEvent): void {
  state.lastEventAt = Date.now();

  switch (event.type) {
    case 'meta':
      // rid 是拿到第一帧才知道的，所以后端可能在 meta 之前先发 error
      state.view = {
        ...state.view,
        rid: event.rid,
        marker: event.marker,
        sessionId: event.sessionId,
        startedAt: event.startedAt,
      };
      state.agg.rid = event.rid;
      persistInflight();
      publish();
      return;

    case 'frame': {
      applyFrame(state.agg, event.body);

      /**
       * 人卡交互帧（【LIVE 09-17】）。
       *
       * 两件事，都在 applyFrame 之后做（notify 帧也要计入 queuedNotices 聚合）：
       *  · `permission_request` ⇒ 挂起交互卡。立刻 publish（不走 rAF）：
       *    这是用户必须在场回应的状态翻转，晚 250ms 是可感知的迟钝；
       *    只在**没有**挂起交互时接收——一轮回覆多个人卡请求时以第一个为准，
       *    后续的等 resolved 后自然接管。
       *  · `permission_resolved` ⇒ 回覆已被上游采纳，撤下交互卡（UI 层的
       *    'submitted' 只是本地乐观态，这一帧才是事实源）。
       */
      const resolved = permissionResolvedOf(event.body);
      if (resolved && state.view.interaction?.request.requestId === resolved.requestId) {
        state.view = { ...buildView(), interaction: undefined };
        publish();
        return;
      }
      const interaction = pendingInteractionOf(event.body);
      if (interaction && state.view.interaction === undefined) {
        state.view = { ...buildView(), interaction: { request: interaction, reply: 'pending' } };
        publish();
        return;
      }
      markDirty();
      return;
    }

    case 'hb':
      // 心跳不改内容，但要让判活知道连接还在；不触发重渲染
      return;

    case 'error': {
      const phase: TurnPhase =
        event.error.kind === 'stream_break'
          ? 'break_recovering'
          : event.error.kind === 'session_ghost'
            ? 'ghost'
            : 'error';
      setPhase(phase, event.error);
      return;
    }

    case 'done':
      /**
       * 终态的事实源是帧本身（agg.stopReason），事件只是信号——所以这里
       * 从聚合器读，不从事件里采信第二遍。cancel 生效后（【LIVE 09-18】）
       * 流会以 stopReason=cancelled 收场，落 'cancelled' 展示"已取消"。
       */
      setPhase(state.agg.stopReason === 'cancelled' ? 'cancelled' : 'done');
      return;
  }
}

async function run(sessionId: string, text: string, abort: AbortController, generation: number): Promise<void> {
  let sawTerminal = false;

  /**
   * 本轮是否已作废。必须在 `handle(event)` **之前**判：
   * abort 之后 reader 仍可能吐出已经缓冲好的事件，晚到的那一帧写进视图，
   * 用户就会看到"点了停止接收、内容却还在长"。generation 则挡住
   * "clear() 之后旧流的帧把空视图重新填满"与跨轮污染。
   */
  const stale = (): boolean => generation !== state.generation || abort.signal.aborted;

  try {
    for await (const event of openPromptStream(sessionId, text, abort.signal)) {
      if (stale()) return;
      if (event.type === 'done' || event.type === 'error') sawTerminal = true;
      handle(event);
    }
  } catch (err) {
    if (stale()) return;
    setPhase('error', transportError(err instanceof Error ? err.message : String(err)));
    return;
  }

  if (stale()) return;

  /**
   * 生成器正常结束却从未出现 done / error ⇒ 归断流，不算成功。
   * 后端管道本身会补这条，但连接被中间层掐断时前端也要能自己判出来：
   * 静默截断当成 end_turn，用户会以为回答是完整的。
   */
  if (!sawTerminal) setPhase('break_recovering', streamBreakWithoutTerminal(state.agg.frameCount));
}

export const turnStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): TurnView {
    return state.view;
  },

  /** 是否正在收流（不分会话）——用于在途锁：同一进程同时只跑一轮。
   *  'cancelling' 也算在途：cancel 已发出但流还开着，此时再发一轮会撞并发锁。 */
  isBusy(): boolean {
    return state.view.phase === 'streaming' || state.view.phase === 'cancelling';
  },

  busySessionId(): string | undefined {
    return state.view.phase === 'streaming' || state.view.phase === 'cancelling'
      ? state.view.sessionId
      : undefined;
  },

  /**
   * 发一轮提示词并开始收流。
   *
   * @param text 发出去的文本，就是用户敲的原文——校验码尾行由**服务端**注入
   *   （`server/src/routes/prompt.ts`），前端不改写提示词，所以这一份同时用于气泡展示。
   *
   * 已有轮次在途时直接拒绝：同一会话并发会被服务端拒（session_concurrent_operation_in_progress），
   * 跨会话并发则会把两轮的帧混进同一个聚合器。UI 侧应当先把输入框禁掉。
   */
  start(sessionId: string, text: string): boolean {
    if (state.view.phase === 'streaming' || state.view.phase === 'cancelling') return false;

    state.abort?.abort();
    // 先递增再交给 run：上一轮 reader 里缓冲的事件从此全部作废
    state.generation += 1;
    const generation = state.generation;
    resetAgg(sessionId, text);
    const abort = new AbortController();
    state.abort = abort;
    startStallTimer();
    publish();
    void run(sessionId, text, abort, generation);
    return true;
  },

  /**
   * 取消本轮。【LIVE 09-18】语义升级：CancelAgentSession 已会真取消执行中的
   * 轮次（HTTP 200 + 流以 stopReason=cancelled 终态收场，实测 3/3），所以点停止
   * **不再只是 abort 本地连接**——而是向上游发取消请求、继续收流，等 cancelled
   * 终态自然到达后落 'cancelled'。
   *
   * cancel 请求本身失败（网络/非 200）时退回旧行为：abort 本地接收 + 'abandoned'
   * （服务端那一轮可能仍在跑）。
   */
  cancelTurn(): void {
    if (state.view.phase !== 'streaming') return;
    const sessionId = state.view.sessionId;
    if (!sessionId) return;
    setPhase('cancelling');

    const fallbackToAbandoned = (): void => {
      if (state.view.phase !== 'cancelling') return; // cancelled/done 已先到
      state.abort?.abort();
      state.abort = undefined;
      clearStallTimer();
      state.view = { ...buildView(), phase: 'abandoned' };
      persistInflight();
      for (const listener of listeners) listener();
    };

    void fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: 'POST',
    })
      .then((res) => {
        if (!res.ok) fallbackToAbandoned();
        // 200：什么都不做——继续收流，等 stopReason=cancelled 的终态帧
        // 经 handle('done') 落 'cancelled'。
      })
      .catch(fallbackToAbandoned);
  },

  /** 兼容旧调用点的别名（语义已升级为"取消本轮"）。 */
  stopReceiving(): void {
    this.cancelTurn();
  },

  /**
   * 回覆当前挂起的人卡交互（【LIVE 09-17】）。
   *
   * 两种载荷（与 shared/rest.ts ReplyResult 的注释一一对应）：
   *  · ask_user_question → `{ answers: {'0': label} }`
   *  · 工具授权 → `{ optionId: 'proceed_once'|… }`
   *  · 取消当前交互 → `{ outcome: 'cancelled' }`
   *
   * 回覆成功后**什么都不用再做**：原 SSE 流还开着，后续帧经 handle('frame') 继续
   * 聚合，`permission_resolved` 到达时交互卡自动撤下。失败时交互卡留在原地
   * （reply='failed' + error），用户可以直接重试——回覆是幂等安全的：重复回覆
   * 同一个 requestId 上游会报"已被处理"，不会产生第二轮执行。
   */
  replyToInteraction(payload: { answers?: Record<string, string>; optionId?: string; outcome?: 'selected' | 'cancelled' }): void {
    const current = state.view.interaction;
    if (!current || current.reply === 'submitting') return;
    const sessionId = state.view.sessionId;
    if (!sessionId) return;

    const applyTo = (mutate: (i: NonNullable<TurnView['interaction']>) => NonNullable<TurnView['interaction']>): void => {
      // 期间交互卡可能已被 permission_resolved 撤下或换了一轮（generation/rid 守卫）：
      // requestId 不匹配就丢弃这次迟到的结果，绝不写回。
      if (state.view.interaction?.request.requestId !== current.request.requestId) return;
      state.view = { ...state.view, interaction: mutate(state.view.interaction!) };
      publish();
    };

    applyTo((i) => ({ ...i, reply: 'submitting', error: undefined }));

    const outcome = payload.outcome ?? 'selected';
    void fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        permissionRequestId: current.request.requestId,
        ...(payload.answers ? { answers: payload.answers } : {}),
        ...(payload.optionId ? { optionId: payload.optionId } : {}),
        outcome,
      }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => undefined)) as ApiResult<ReplyResult> | undefined;
        if (body?.ok && body.result.accepted === true) {
          applyTo((i) => ({ ...i, reply: 'submitted' }));
          return;
        }
        const message = body?.ok
          ? body.result.detail
          : (body?.error.message ?? `回覆请求失败（HTTP ${res.status}）`);
        applyTo((i) => ({ ...i, reply: 'failed', error: message }));
      })
      .catch((err: unknown) => {
        applyTo((i) => ({
          ...i,
          reply: 'failed',
          error: err instanceof Error ? err.message : String(err),
        }));
      });
  },

  /**
   * 切会话或点"拉取历史接管"时把在途视图归零。
   *
   * 同时 abort 掉在途的那条流：视图已经归零了，让旧流继续写就等于"清空之后自己又长出
   * 内容"。两个调用点都在断流 / 零帧之后，那一轮的流本来也已经结束。
   */
  clear(): void {
    state.generation += 1;
    const abort = state.abort;
    state.abort = undefined;
    clearStallTimer();
    if (state.flushFallback !== undefined) {
      clearTimeout(state.flushFallback);
      state.flushFallback = undefined;
    }
    state.rafScheduled = false;
    state.view = IDLE_VIEW;
    state.agg = createTurn();
    state.typedText = '';
    state.lastEventAt = undefined;
    inflightStore.clear();
    for (const listener of listeners) listener();
    abort?.abort();
  },
};
