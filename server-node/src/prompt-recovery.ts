import { apiError, classifyError, type AcpFrame } from '@das/shared';
import { SdkError } from './sdk.js';

/** 游标仅属于本轮；Load 的历史帧及自身终态不能结束原 Prompt。 */
export class PromptResumeState {
  rid: string | undefined;
  offset = 0;
  sessionId: string | undefined;
  ended = false;
  constructor(readonly promptId: string) {}

  take(frame: AcpFrame, replay: boolean, loadId?: string): boolean {
    if (replay && frame.Error && String(frame.Id) === loadId) {
      throw new SdkError(classifyError(frame.Error));
    }
    if (replay && String(frame.Id) === loadId) return false;
    if (!replay) {
      this.rid ??= frame.RequestId;
      this.sessionId ??= frame.Params?.sessionId;
    }
    const offset = frame.Params?._meta?.offset;
    const positioned = Number.isSafeInteger(offset) && offset! > 0;
    // Redis 在途 buffer 可能没有 RequestId；只接受同 session 的有游标帧，
    // 显式属于其他轮的历史帧仍然过滤，Load 的无游标控制帧不冒充原轮。
    const own = this.rid !== undefined && (frame.RequestId === this.rid
      || (!frame.RequestId && !!this.sessionId && frame.Params?.sessionId === this.sessionId && positioned));
    if (replay && this.sessionId && frame.Params?.sessionId && frame.Params.sessionId !== this.sessionId) return false;
    const ownResponse = String(frame.Id) === this.promptId && (!frame.RequestId || own);
    if (replay && !own && !ownResponse) return false;
    const terminal = typeof frame.Result?.stopReason === 'string' && frame.Result.stopReason.length > 0;
    if (frame.Error || (terminal && (!replay || ownResponse || own))) this.ended = true;
    if (own && positioned) {
      if (replay && offset! <= this.offset) return false;
      this.offset = Math.max(this.offset, offset!);
    } else if (replay && frame.Params?.update && !terminal) {
      // 历史可能被合并且丢失游标，不能追加整段文本后假称无损恢复。
      if (!frame.Params._meta?.waitForResponse) {
        throw new SdkError(apiError('stream_break', 'Load 续传帧缺少 offset，无法安全合并；请拉取历史恢复。'));
      }
      return false;
    }
    return true;
  }

  get resumable(): boolean { return !this.ended && !!this.rid && this.offset > 0; }
}

export interface ResumeSource { id: string; frames: AsyncIterable<AcpFrame> }

/** SDK readTimeout 是帧间预算，不能代替恢复阶段的总截止时间。 */
export async function* beforeDeadline(frames: AsyncIterable<AcpFrame>, deadline: number): AsyncGenerator<AcpFrame> {
  const iterator = frames[Symbol.asyncIterator]();
  let expired = false;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { expired = true; return; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), remaining);
      });
      let next: IteratorResult<AcpFrame> | undefined;
      try { next = await Promise.race([iterator.next(), timeout]); }
      finally { clearTimeout(timer); }
      if (!next) { expired = true; return; }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // SDK 没有 per-stream abort：超时不能再等待悬挂的 next；待其返回后释放迭代器。
    const closing = iterator.return?.();
    if (expired) void Promise.resolve(closing).catch(() => undefined);
    else await closing;
  }
}

/** 只重试只读 Load；从不重发 Prompt，不替调用方发送 Cancel。 */
export async function* recoverPromptFrames(initial: ResumeSource,
  load: (offset: number, timeoutMs: number) => ResumeSource,
  retryTransport: (error: unknown) => boolean,
  options: { attempts?: number; budgetMs?: number; delayMs?: number;
    onResume?: (offset: number, attempt: number) => void } = {},
): AsyncGenerator<AcpFrame> {
  const state = new PromptResumeState(initial.id);
  let source = initial;
  let attempt = 0;
  let deadline = 0;
  let openingLoad = false;
  while (true) {
    try {
      if (openingLoad) source = load(state.offset, Math.max(1, deadline - Date.now()));
      for await (const frame of deadline ? beforeDeadline(source.frames, deadline) : source.frames) {
        if (deadline && Date.now() >= deadline) return;
        if (state.take(frame, attempt > 0, source.id)) yield frame;
        if (state.ended) return;
      }
    } catch (error) {
      if (!state.resumable || !retryTransport(error)) throw error;
    }
    if (!state.resumable || attempt >= (options.attempts ?? 3)) return;
    deadline ||= Date.now() + (options.budgetMs ?? 600_000);
    const delay = (options.delayMs ?? 250) * 2 ** attempt;
    if (Date.now() + delay >= deadline) return;
    await new Promise(resolve => setTimeout(resolve, delay));
    attempt += 1;
    options.onResume?.(state.offset, attempt);
    openingLoad = true;
  }
}
