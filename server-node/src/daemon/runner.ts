import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';

import {
  STREAM_HARD_LIMIT_MS,
  classifyError,
  promptNotDispatched,
  requestIdOf,
  streamBreakWithoutTerminal,
  type AcpFrame,
} from '@das/shared';

import type { AppConfig } from '../config.js';
import { tryAcquire, type InflightEntry } from '../inflight.js';
import { livePromptFrames, type LiveContext } from '../live.js';
import { findScenario, readFixtureFrames } from '../mock/fixtures.js';
import { replayFrames } from '../mock/replay.js';
import { redactApiError, toApiError } from '../normalize.js';
import { sessionUpdateEvent, turnCompleteEvent, turnErrorEvent } from './events.js';
import type { SessionRecord } from './registry.js';
import { errorOfFrame, frameToPermissionEvent, frameToSessionUpdate, terminalOfFrame } from './translate.js';

export interface PromptDeps {
  cfg: AppConfig;
  live: LiveContext | undefined;
  log: FastifyBaseLogger;
}

/**
 * 准入结果。ok 分支返回 202 所需的 {promptId, lastEventId}；
 * 失败分支带 daemon 风格的 HTTP status 与 {error, code}（路由原样下发）。
 */
export type PromptAdmission =
  | { ok: true; promptId: string; lastEventId: number }
  | { ok: false; status: number; error: string; code: string };

interface PromptBlock {
  type?: unknown;
  text?: unknown;
}

/**
 * prompt 准入：所有校验都在**还没碰到上游**之前完成（写操作纪律），
 * 通过后立刻返回 202，轮次在后台跑、事件写 journal、SSE 分发。
 *
 * 这是与现行 `/api/sessions/:id/prompt`（上游流直连客户端）最大的架构差异：
 * 客户端连接的存亡从此不影响上游那一轮的收尾。
 */
export function admitPrompt(
  deps: PromptDeps,
  record: SessionRecord,
  clientFacingId: string,
  promptBlocks: unknown,
  clientId: string | undefined,
): PromptAdmission {
  if (!Array.isArray(promptBlocks) || promptBlocks.length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'prompt 需要至少一个 content block（{type:"text",text}）',
      code: 'empty_prompt',
    };
  }
  const texts: string[] = [];
  for (const block of promptBlocks as PromptBlock[]) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      continue;
    }
    // 上游 PromptAgentSession 只收文本块；图片块如实拒绝而不是静默丢弃（缺口见 OPENAPI-GAPS）
    return {
      ok: false,
      status: 400,
      error: `不支持的 prompt content block（type=${String(block?.type)}）：上游 data agent OpenAPI 仅接受文本`,
      code: 'unsupported_prompt_content',
    };
  }
  const text = texts.join('').trim();
  if (!text) {
    return { ok: false, status: 400, error: 'prompt 文本为空', code: 'empty_prompt' };
  }

  // marker 归属校验已退役（2026-09-20）：不再注入校验码，prompt 原文即 outbound。
  const outbound = text;

  const acquired = tryAcquire(record.realId);
  if (!acquired.ok) {
    return {
      ok: false,
      status: 409,
      error: acquired.error.message,
      code: 'session_concurrent_operation_in_progress',
    };
  }

  const promptId = randomUUID();
  const journal = record.journal;
  journal.activePrompt = true;
  journal.activePromptId = promptId;
  // 202 的 lastEventId 必须在后台任务可能追加任何事件**之前**取——
  // 客户端拿它做 SSE 游标起点，晚了就漏掉这一轮的头几帧。
  const lastEventId = journal.lastId();

  const startedAt = Date.now();
  void runTurn(deps, record, clientFacingId, promptId, outbound, clientId, acquired, startedAt).catch(
    (err: unknown) => {
      // runTurn 内部已兜所有已知路径；这里只防"兜底本身抛了"这种把进程带走的形态。
      deps.log.error({ err, sessionId: record.realId, promptId }, 'daemon prompt 后台任务异常退出');
      journal.activePrompt = false;
      journal.activePromptId = undefined;
    },
  );

  return { ok: true, promptId, lastEventId };
}

/**
 * 后台轮次：帧源（live=SDK SSE / mock=录制件回放）→ 翻译 → journal。
 *
 * 收尾分类与 `pipeline.toWireEvents` 同源：
 *  · 帧内 Error → 首个错误归一成 turn_error（后续帧继续收，断流前已有 1200 帧的形态）；
 *  · Result.stopReason → turn_complete；
 *  · 无终态：有帧 ⇒ stream_break（任务可能仍在跑，绝不重发）；零帧+有回执 ⇒ prompt_not_dispatched。
 * 硬上限 330s 对齐实测断流墙，到点主动按 stream_break 收尾。
 */
async function runTurn(
  deps: PromptDeps,
  record: SessionRecord,
  clientFacingId: string,
  promptId: string,
  outbound: string,
  clientId: string | undefined,
  acquired: { entry: InflightEntry; release: () => void },
  startedAt: number,
): Promise<void> {
  const journal = record.journal;
  deps.log.info({ event: 'prompt_stream_start', backend: 'node', pid: process.pid, sessionId: record.realId, promptId, startedAt }, 'prompt stream start');
  const acks: string[] = [];

  let frames: AsyncIterable<AcpFrame>;
  if (deps.live) {
    frames = livePromptFrames(deps.live, record.realId, outbound, acks);
  } else {
    const scenario = findScenario(record.realId);
    frames = replayFrames(scenario?.promptFixture ? readFixtureFrames(scenario.promptFixture) : [], {
      realtime: deps.cfg.mockRealtime,
      speed: deps.cfg.mockSpeed,
    });
    if (scenario?.popAck) acks.push(scenario.popAck);
  }

  let frameCount = 0;
  let lastFrameAt: number | undefined;
  let outcome = 'eof_without_terminal';
  let exception: { name: string; code?: string }[] = [];
  let errorSent = false;
  let terminal: ReturnType<typeof terminalOfFrame> = undefined;
  let ridBackfilled = false;
  /** 本轮 user 回显的累积文本：上游会把 echo 发两份（bridge-echo，与归档态同款），
   *  去重判据与 historyFramesToEvents 同源，否则 LIVE 下用户消息显示两遍（实测）。 */
  let userText = '';
  const deadline = Date.now() + STREAM_HARD_LIMIT_MS;

  try {
    for await (const frame of frames) {
      if (Date.now() > deadline) { outcome = 'local_hard_limit'; break; }
      frameCount += 1;
      lastFrameAt = Date.now();
      if (!ridBackfilled) {
        const rid = requestIdOf(frame);
        if (rid !== undefined) {
          ridBackfilled = true;
          // 在途锁条目的 rid 回填：撞锁的日志要能报出"正在跑的是哪一轮"
          acquired.entry.rid = rid;
        }
      }
      // permission 通知帧先于 session_update 处理（到达序的真实顺序）；
      // 这是把 `_qwen/notify` 接到 web-shell 弹卡的唯一通道（此前被整帧丢弃→没有弹框）。
      if (!errorSent) {
        const permissionEvent = frameToPermissionEvent(frame, clientFacingId);
        if (permissionEvent !== undefined) {
          journal.append(permissionEvent);
          const requestId = permissionEvent.data.requestId;
          if (typeof requestId === 'string') {
            if (permissionEvent.type === 'permission_request') {
              record.pendingPermissions.set(requestId, permissionEvent.data);
            } else {
              record.pendingPermissions.delete(requestId);
            }
          }
        }
      }
      if (!errorSent) {
        const event = frameToSessionUpdate(frame, clientFacingId, { originatorClientId: clientId });
        let duplicateUserChunk = false;
        if (event) {
          const update = event.data.update as
            | { sessionUpdate?: string; content?: { text?: string } }
            | undefined;
          if (update?.sessionUpdate === 'user_message_chunk') {
            const text = update.content?.text ?? '';
            if (text !== '' && text === userText) duplicateUserChunk = true;
            else userText += text;
          }
          // agent 思考/回答的 chunk 文本原样透传（marker 剥离机制已退役，
          // translate 以同一原则处理；不再有任何流式剥除器）。
        }
        if (event && !duplicateUserChunk) journal.append(event);
      }
      // errorSent 之后只消费不投喂：turn_error 是本轮事件流的终态（daemon 语义），
      // 上游断流前还会再吐少量帧（实测 mock-break 录制件错误帧后仍有收尾帧），
      // 迟到的 session_update 会在 webshell 里变成"终态之后的孤儿内容"。

      const frameError = errorOfFrame(frame);
      if (frameError !== undefined && !errorSent) {
        errorSent = true;
        outcome = 'upstream_error_frame';
        const api = redactApiError(classifyError(frameError));
        journal.append(
          turnErrorEvent(clientFacingId, api.message, { promptId, code: api.kind, errorKind: api.kind }),
        );
      }
      if (terminal === undefined) terminal = terminalOfFrame(frame);
      // Protocol completion must not wait for HTTP EOF (which can stall or reset).
      if (terminal !== undefined) break;
    }

    if (!errorSent) {
      if (terminal !== undefined) {
        journal.append(turnCompleteEvent(clientFacingId, terminal.rawStopReason ?? 'end_turn', promptId));
      } else if (frameCount === 0 && acks.length > 0) {
        errorSent = true;
        outcome = 'ack_without_frames';
        const api = promptNotDispatched(acks[0], Date.now() - startedAt);
        journal.append(
          turnErrorEvent(clientFacingId, api.message, { promptId, code: api.kind, errorKind: api.kind }),
        );
      } else {
        errorSent = true;
        const api = streamBreakWithoutTerminal(frameCount);
        journal.append(
          turnErrorEvent(clientFacingId, api.message, { promptId, code: api.kind, errorKind: api.kind }),
        );
      }
    }
  } catch (err) {
    exception = exceptionFacts(err);
    if (!errorSent && terminal !== undefined) {
      journal.append(turnCompleteEvent(clientFacingId, terminal.rawStopReason ?? 'end_turn', promptId));
    } else if (!errorSent) {
      outcome = 'transport_exception';
      errorSent = true;
      const api = toApiError(err, 'PromptAgentSession');
      journal.append(
        turnErrorEvent(clientFacingId, api.message, { promptId, code: api.kind, errorKind: api.kind }),
      );
    }
  } finally {
    acquired.release();
    journal.activePrompt = false;
    journal.activePromptId = undefined;
    deps.log.info(
      {
        event: 'prompt_stream_end', backend: 'node', pid: process.pid,
        startedAt, endedAt: Date.now(), lastFrameAt,
        idleMs: Date.now() - (lastFrameAt ?? startedAt),
        outcome: terminal !== undefined && !errorSent ? 'terminal' : outcome,
        upstreamRequestId: acquired.entry.rid, popRequestId: acks[0],
        pendingPermissions: record.pendingPermissions.size, exception,
        sessionId: record.realId,
        clientFacingId,
        promptId,
        frames: frameCount,
        stopReason: terminal?.rawStopReason,
        errorSent,
        elapsedMs: Date.now() - startedAt,
      },
      'daemon prompt 轮次收尾',
    );
  }
}

/** Only bounded type/code metadata: never serialize SDK request, headers or message. */
export function exceptionFacts(error: unknown): { name: string; code?: string }[] {
  const facts: { name: string; code?: string }[] = [];
  const seen = new Set<unknown>();
  while (error instanceof Error && facts.length < 4 && !seen.has(error)) {
    seen.add(error);
    const code = (error as Error & { code?: unknown }).code;
    const name = /^(Error|TypeError|AbortError|TimeoutError|RequestTimeoutError|ResponseError|ClientError|ServerError|ThrottlingError)$/.test(error.name) ? error.name : error.constructor.name;
    facts.push({ name,
      ...(typeof code === 'string' && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ERR_STREAM_PREMATURE_CLOSE|ABORT_ERR)$/.test(code) ? { code } : {}),
    });
    error = error.cause;
  }
  return facts;
}
