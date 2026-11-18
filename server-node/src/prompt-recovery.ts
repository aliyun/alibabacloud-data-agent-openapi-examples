import { apiError, eventCursorOf, type AcpFrame, type EventCursor } from '@das/shared';
import { SdkError } from './sdk.js';

class SubscriptionInterrupted extends Error {}

/** A request commits only complete events that its consumer has handled; no history offsets or POP request IDs. */
export class PromptResumeState {
  cursor?: EventCursor;
  ended = false;
  constructor(readonly rpcId: string, readonly sessionId?: string) {}
  private readCursor(frame: AcpFrame) {
    try { return eventCursorOf(frame, this.sessionId); }
    catch { throw new SdkError(apiError('stream_break', '原生事件游标与会话不匹配')); }
  }
  take(frame: AcpFrame): boolean {
    const cursor = this.readCursor(frame);
    if (cursor && this.cursor && (cursor.eventEpoch !== this.cursor.eventEpoch || cursor.promptId !== this.cursor.promptId
      || Number(cursor.eventId) <= Number(this.cursor.eventId))) throw new SdkError(apiError('stream_break', '原生游标发生跳代、重复或跨轮'));
    if (this.cursor && !cursor) {
      if (frame.Error && frame.Error.errorCode !== 'DAEMON_STREAM_CONTRACT_INVALID') throw new SubscriptionInterrupted('原订阅结束，核对原生 Events');
      throw new SdkError(apiError('stream_break', '续传帧缺少有效原生游标'));
    }
    if (cursor && (frame.Error || typeof frame.Result?.stopReason === 'string')) {
      if (cursor.eventType !== (frame.Error ? 'turn_error' : 'turn_complete') || String(frame.Id) !== this.rpcId) {
        throw new SdkError(apiError('stream_break', '终态与原生事件证明不匹配'));
      }
      this.ended = true;
    }
    return true;
  }
  commit(frame: AcpFrame) { this.cursor = this.readCursor(frame) ?? this.cursor; }
  get resumable(): boolean { return !this.ended && this.cursor !== undefined; }
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

/** Only read-only Events may reconnect; never resubmit Prompt, Load merged history, or send Cancel. */
export async function* recoverPromptFrames(initial: ResumeSource,
  events: (cursor: EventCursor, timeoutMs: number) => ResumeSource,
  retryTransport: (error: unknown) => boolean,
  options: { sessionId?: string; attempts?: number; budgetMs?: number; delayMs?: number;
    onResume?: (cursor: EventCursor, attempt: number) => void } = {},
): AsyncGenerator<AcpFrame> {
  const state = new PromptResumeState(initial.id, options.sessionId);
  let source = initial;
  let attempt = 0;
  let deadline = 0;
  while (true) {
    try {
      if (attempt) source = events(state.cursor!, Math.max(1, deadline - Date.now()));
      for await (const frame of deadline ? beforeDeadline(source.frames, deadline) : source.frames) {
        if (deadline && Date.now() >= deadline) return;
        if (state.take(frame)) yield frame;
        state.commit(frame);
        if (state.ended) return;
      }
    } catch (error) {
      if (!state.resumable || !(error instanceof SubscriptionInterrupted) && !retryTransport(error)) throw error;
    }
    if (!state.resumable || attempt >= (options.attempts ?? 3)) return;
    deadline ||= Date.now() + (options.budgetMs ?? 600_000);
    const delay = (options.delayMs ?? 250) * 2 ** attempt;
    if (Date.now() + delay >= deadline) return;
    await new Promise(resolve => setTimeout(resolve, delay));
    attempt++;
    options.onResume?.(state.cursor!, attempt);
  }
}
