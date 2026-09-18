import {
  CONCURRENT_REJECTED_TEXT,
  UPSTREAM_STATUS_GHOST,
  type ErrorKind,
} from './constants.js';

/**
 * 归一化后的错误。
 *
 * 上游的业务错误恒以 HTTP 200 返回，真正的错误信息在响应体的
 * `JsonRpcResponse.Error` 里；而同一个 `-32603` 实测对应三种完全不同的处境。
 * 所以前端拿到的永远是这个已经分好类的结构，不再自己看状态码或 code 猜。
 */
export interface ApiError {
  kind: ErrorKind;
  /** JSON-RPC 错误码，例如 -32603；传输层故障时为空。 */
  code: number | undefined;
  /** 上游给的细分错误码（形如 0x48833000000000d1），有就带上，便于对照排查文档。 */
  errorCode: string | undefined;
  /** 归一化后的原因摘要。 */
  message: string;
  /** 原样重试是否有意义。断流一律 false：重发等于把同一个写操作执行两遍。 */
  retryable: boolean;
  /** 这个会话还能不能继续用。幽灵化为 true，其余为 false。 */
  fatalForSession: boolean;
  /** 上游 HTTP 状态码，若可见。 */
  upstreamStatus: number | undefined;
}

export type ErrorTone = 'amber' | 'red' | 'muted';

export interface ErrorCopy {
  title: string;
  detail: string;
  tone: ErrorTone;
}

/**
 * 面向用户的文案，按 kind 一处定义、前后端共用。
 *
 * 这里刻意做到"不夸大也不掩盖"：断流用琥珀色而不是红色，因为任务很可能还在跑；
 * Stop 之后永远不说"已取消"，因为 CancelAgentSession 实测不下达执行端。
 */
export const ERROR_COPY: Record<ErrorKind, ErrorCopy> = {
  stream_break: {
    title: '回复通道已中断，任务可能仍在服务端执行',
    detail:
      '实测 SSE 连接在 218~258 秒之间会被掐断，断流只关掉回复通道，不会停掉正在跑的任务。' +
      '这里不会自动重发——重发会让同一个写操作执行两遍。可以先探测这一轮是否已经完成，或直接拉取历史接管结果。',
    tone: 'amber',
  },
  prompt_not_dispatched: {
    title: '上游收下了这一轮，但没有派发给执行端',
    detail:
      'SSE 只回了一个 POP 层回执（一个 RequestId）就在 1 秒内关流，整轮没有收到任何 ACP 内容帧。' +
      '实测这种形态下 LoadAgentSession 回看，历史里只有一个 end_turn 空轮次：没有你这句话的回显，也没有任何回答。' +
      '这与"断流"恰好相反——断流是任务可能还在跑，这里是根本没开始，所以别去探测是否完成。' +
      '稳妥的顺序是：先拉取历史确认这一轮确实没留下内容，确认之后再重发（重发是写操作，本工程不会自动做）。' +
      '已排除的调用方因素：换 wire 形状、换 User-Agent、换会话、甚至用一个不存在的 SessionId，响应逐字相同。',
    tone: 'amber',
  },
  session_ghost: {
    title: '该会话已失效',
    detail: '这个会话在服务端已经不能再用（上游返回 422，通常 1 秒内就回一帧错误）。唯一可行的动作是新建会话。',
    tone: 'red',
  },
  concurrent_rejected: {
    title: '上一轮还没结束',
    detail: '同一个会话同时只能跑一轮，第二次请求会被服务端直接拒绝。等上一轮出终态之后再发即可。',
    tone: 'muted',
  },
  rpc_error: {
    title: '接口返回错误',
    detail:
      '业务错误也是以 HTTP 200 返回的，真正的错误在响应体的 JsonRpcResponse.Error 里。' +
      '把下面这段 code / errorCode / message 拿去对照排查文档即可定位。',
    tone: 'red',
  },
  transport: {
    title: '连不上后端或上游',
    detail: '先确认后端进程在跑（npm run dev 的 server 那一栏没有报错），再检查 .env 里的 region 与凭证。',
    tone: 'red',
  },
  create_empty_body: {
    title: '建会话返回了空响应体',
    detail:
      'HTTP 200 但响应体是空的，拿不到 SessionId。实测最常见的原因是账号下没有运行中的 DataWorks 实例，' +
      '或者该账号需要 RESOURCE_GROUP_ID 而没配。注意：ResourceGroupId 填了也不校验有效性，所以填错不会报错，只会继续空响应。',
    tone: 'amber',
  },
};

/** 错误文案的默认兜底，用于 kind 之外的意外情况（理论上不会发生）。 */
export const FALLBACK_ERROR_COPY: ErrorCopy = {
  title: '出现未分类的错误',
  detail: '把下面的原始信息贴给维护者，说明工程里漏了一类错误形态。',
  tone: 'red',
};

export function copyFor(kind: ErrorKind): ErrorCopy {
  return ERROR_COPY[kind] ?? FALLBACK_ERROR_COPY;
}

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

export interface ErrorInput {
  code?: number;
  errorCode?: string;
  message?: string;
  /** SDK 响应上的 statusCode，若可见。 */
  upstreamStatus?: number;
}

/** 每种 kind 的重试语义。断流一律不可原样重试：重发等于把同一个写操作执行两遍。 */
const RETRY_POLICY: Record<ErrorKind, { retryable: boolean; fatalForSession: boolean }> = {
  stream_break: { retryable: false, fatalForSession: false },
  // retryable=false 的理由不是"怕重复写入"（实测这一轮压根没落地，历史里只有空轮次），
  // 而是原样重发只会再得到一次同样的 POP 回执：5/5 次实测同形，重发没有信息增量也没有成功率。
  prompt_not_dispatched: { retryable: false, fatalForSession: false },
  session_ghost: { retryable: false, fatalForSession: true },
  concurrent_rejected: { retryable: true, fatalForSession: false },
  rpc_error: { retryable: false, fatalForSession: false },
  transport: { retryable: true, fatalForSession: false },
  create_empty_body: { retryable: false, fatalForSession: false },
};

/** 上游"流结束了但没给终态"时用的 message，与真实抓包逐字一致。 */
export const STREAM_ENDED_TEXT = 'session stream ended without turn terminal';

/** 整轮零 ACP 帧时的 message。这一条是本工程自己的判据，不是上游报文。 */
export const PROMPT_NOT_DISPATCHED_TEXT = 'prompt accepted but never dispatched to an executor';

function build(kind: ErrorKind, input: ErrorInput, message: string): ApiError {
  const policy = RETRY_POLICY[kind];
  return {
    kind,
    code: input.code,
    errorCode: input.errorCode,
    message,
    retryable: policy.retryable,
    fatalForSession: policy.fatalForSession,
    upstreamStatus: input.upstreamStatus,
  };
}

/**
 * 手工造一个归一化错误（重试语义仍由 kind 决定，不由调用方拍脑袋给）。
 *
 * 用于 classifyError 覆盖不到的场合：参数校验失败、后端自己检测到的超时、
 * "这条链路还没接"等等。
 */
export function apiError(kind: ErrorKind, message: string, input: ErrorInput = {}): ApiError {
  return build(kind, { ...input, message }, message);
}

/**
 * 把帧内 / JsonRpcResponse 里的 Error 分成六类。
 *
 * 不能只看 code：实测断流、会话幽灵化、并发被拒三种处境的 code **全是 -32603**，
 * 只有 message 文本能区分。三条形态都来自真实抓包：
 *   - 幽灵化：`prompt forward failed, upstream_status=422`，带 errorCode 0x48833000000000d1
 *   - 并发被拒：`session_concurrent_operation_in_progress, tenant_id=…, session_id=…`，**没有 errorCode 字段**
 *   - 断流：`session stream ended without turn terminal`，带 errorCode 0x48833000000000d1
 */
export function classifyError(input: ErrorInput): ApiError {
  const message = input.message ?? '';

  if (input.upstreamStatus === UPSTREAM_STATUS_GHOST || message.includes(`upstream_status=${UPSTREAM_STATUS_GHOST}`)) {
    return build('session_ghost', input, message || 'upstream returned 422');
  }
  if (message.includes(CONCURRENT_REJECTED_TEXT)) {
    return build('concurrent_rejected', input, message);
  }
  if (message.includes(STREAM_ENDED_TEXT)) {
    return build('stream_break', input, message);
  }
  return build('rpc_error', input, message || 'upstream returned an error without message');
}

/**
 * 流式生成器正常结束、却从头到尾没出现过 Result.stopReason。
 *
 * 这必须算断流而不是成功：静默截断当成 end_turn 会让用户以为回答是完整的。
 */
export function streamBreakWithoutTerminal(frameCount: number): ApiError {
  return build(
    'stream_break',
    { message: STREAM_ENDED_TEXT },
    `${STREAM_ENDED_TEXT} (received ${frameCount} frames, no Result.stopReason)`,
  );
}

/**
 * 整轮**一个 ACP 内容帧都没收到**：上游只回了 POP 层回执（或什么都没回）就关流。
 *
 * 与 streamBreakWithoutTerminal 的区别是有没有内容：断流至少收到过帧，
 * 这一类是零帧。实测形态与判别过程见 constants.ts 里 ERROR_KINDS 上方那段注释。
 * POP RequestId 是这种情况下唯一还能拿去查的线索，所以必须带进 message。
 */
export function promptNotDispatched(popRequestId?: string, elapsedMs?: number): ApiError {
  const clues = [
    typeof elapsedMs === 'number' ? `${elapsedMs}ms` : undefined,
    popRequestId ? `POP RequestId ${popRequestId}` : '上游未给出 RequestId',
  ].join('，');
  return build(
    'prompt_not_dispatched',
    { message: PROMPT_NOT_DISPATCHED_TEXT },
    `${PROMPT_NOT_DISPATCHED_TEXT}（${clues}）。整轮没有收到任何 ACP 帧，也没有 Result.stopReason。`,
  );
}

/** 后端连不上上游、或前端连不上后端。 */
export function transportError(message: string, upstreamStatus?: number): ApiError {
  return build('transport', { message, upstreamStatus }, message);
}

/** 建会话拿到 HTTP 200 但响应体为空。 */
export function createEmptyBodyError(detail?: string): ApiError {
  return build('create_empty_body', { message: detail ?? 'empty response body' }, detail ?? 'empty response body');
}
