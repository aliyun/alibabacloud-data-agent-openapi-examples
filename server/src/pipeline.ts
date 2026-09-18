import {
  classifyError,
  errorOf,
  offsetOf,
  promptNotDispatched,
  requestIdOf,
  streamBreakWithoutTerminal,
  terminalOf,
  type AcpFrame,
  type TerminalInfo,
  type WireEvent,
} from '@das/shared';

import { redactApiError, toApiError } from './normalize.js';

export interface PipelineInput {
  /** 上游帧流：mock 是合成样例回放，live 是 SDK 的 async generator。两者形状一致。 */
  frames: AsyncIterable<AcpFrame>;
  marker: string;
  sessionId: string;
  mock: boolean;
  startedAt: number;
  /** 出错时文案里点名的上游接口，默认 'upstream'。 */
  apiName?: string;
  /**
   * 由帧源填充：上游只回 POP 回执、一个 ACP 帧都没给时，这里是那些回执的 RequestId。
   * 零帧场景下 rid 无从得知，这个值是用户唯一还能拿去查这次调用的线索，
   * 所以必须出现在错误 message 里，而不是只留在服务端日志里。
   */
  popRequestIds?: string[];
}

/**
 * 上游帧流 → wire 事件流。**live 与 mock 共用这一个函数**，
 * 这是"mock 下验收通过"能推广到真实链路的前提。
 *
 * 三条硬规则：
 *  1. 帧原样透传（`body` 就是上游那一帧，不重塑、不改名）；后端唯一的加工是错误归一化。
 *  2. 带 Error 的帧既当普通帧透传（前端 reducer 会记下它），又额外产出一条归一化
 *     的 `error` 事件（UI 文案按 kind 走）。两者不冲突：FrameError 与 ApiError 形状不同。
 *  3. 生成器结束却从未出现 `Result.stopReason` ⇒ **不发 done**，按收到过几帧分两种收尾：
 *     有帧归 `stream_break`（任务可能还在跑），零帧归 `prompt_not_dispatched`（根本没开始）。
 *     静默截断当成成功，用户会以为那段回答是完整的。
 *
 * `meta` 在拿到第一个带 RequestId 的帧时才发：rid 是上游给的，事先不知道。
 * 所以前端必须容忍"只有 error 没有 meta"的流（上游一帧没吐就失败）。
 */
export async function* toWireEvents(input: PipelineInput): AsyncGenerator<WireEvent, void, unknown> {
  let rid: string | undefined;
  let metaSent = false;
  let frameCount = 0;
  let terminal: TerminalInfo | undefined;
  let errorSent = false;

  try {
    for await (const frame of input.frames) {
      frameCount += 1;

      if (!metaSent) {
        rid ??= requestIdOf(frame);
        if (rid !== undefined) {
          metaSent = true;
          yield {
            type: 'meta',
            rid,
            marker: input.marker,
            sessionId: input.sessionId,
            mock: input.mock,
            startedAt: input.startedAt,
          };
        }
      }

      yield { type: 'frame', rid: rid ?? '', offset: offsetOf(frame), body: frame };

      const frameError = errorOf(frame);
      if (frameError && !errorSent) {
        errorSent = true;
        // 这一条也要过脱敏：上游鉴权类报文会把调用方的 AccessKeyId 原文回显出来，
        // 而 wire 事件是要渲染进前端的。异常路径在 toApiError 里已内置，帧内路径在这里。
        yield { type: 'error', rid: rid ?? '', error: redactApiError(classifyError(frameError)) };
      }

      // 终态只看顶层 Result.stopReason；服务端的状态字段问不出运行态（恒 RELEASED）。
      terminal ??= terminalOf(frame);
    }
  } catch (err) {
    /**
     * 帧源在迭代中途抛异常（LIVE 下：鉴权失败、422 幽灵化、socket 被掐）。
     *
     * 必须在这里捕获：走到这一步响应已经被 `hijack()` 接管、状态行与响应头都发出去了，
     * 异常再往上抛没有任何人能把它翻译成前端看得懂的东西——用户只会看到一条莫名断掉的流，
     * 而"莫名断掉"与"断流"在 UI 上是两种完全不同的处置。
     * 归一成一条 error 事件后直接结束，也不再补发 stream_break（已经有更具体的结论了）。
     */
    if (!errorSent) {
      yield { type: 'error', rid: rid ?? '', error: toApiError(err, input.apiName ?? 'upstream') };
    }
    return;
  }

  if (terminal && !errorSent) {
    yield {
      type: 'done',
      rid: rid ?? '',
      stopReason: terminal.stopReason,
      rawStopReason: terminal.rawStopReason,
      frameCount,
    };
    return;
  }

  if (!errorSent) {
    /**
     * 两种"没有终态"必须分开，因为处置完全相反：
     *  · 收到过帧 ⇒ 断流，任务很可能还在服务端跑，动作是探测/拉历史接管，绝不重发；
     *  · 一帧都没收到 ⇒ 上游收下了请求却没派发给执行端（实测历史里只留一个 end_turn
     *    空轮次），任务**根本没开始**，所以"探测是否完成"是错误指引。
     */
    yield {
      type: 'error',
      rid: rid ?? '',
      error:
        frameCount === 0
          ? promptNotDispatched(input.popRequestIds?.[0], Date.now() - input.startedAt)
          : streamBreakWithoutTerminal(frameCount),
    };
  }
}
