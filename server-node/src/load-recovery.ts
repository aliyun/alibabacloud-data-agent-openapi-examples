import { apiError, classifyError, type AcpFrame } from '@das/shared';
import { SdkError } from './sdk.js';
import { beforeDeadline, type ResumeSource } from './prompt-recovery.js';

/** 快照跨多轮，offset 不能跨轮拼接；重读时丢弃半份历史，只接受本次 Load 回执。 */
export async function readLoadSnapshot(open: (remainingMs: number) => ResumeSource,
  retryTransport: (error: unknown) => boolean,
  options: { budgetMs?: number; attempts?: number; delayMs?: number } = {}): Promise<AcpFrame[]> {
  const deadline = Date.now() + (options.budgetMs ?? 30_000);
  for (let attempt = 0; attempt < (options.attempts ?? 3) && Date.now() < deadline; attempt++) {
    const frames: AcpFrame[] = [];
    try {
      const source = open(Math.max(1, deadline - Date.now()));
      for await (const frame of beforeDeadline(source.frames, deadline)) {
        const own = String(frame.Id) === source.id;
        if (frame.Error && (own || frame.Id === undefined)) throw new SdkError(classifyError(frame.Error));
        frames.push(frame);
        if (own && typeof frame.Result?.stopReason === 'string' && frame.Result.stopReason) {
          if (frame.Result.stopReason !== 'end_turn') throw new SdkError(apiError('stream_break', 'Load 历史快照未正常完成。'));
          return frames;
        }
      }
    } catch (error) {
      if (!retryTransport(error)) throw error;
      if (Date.now() >= deadline || attempt + 1 >= (options.attempts ?? 3)) throw error;
    }
    if (attempt + 1 >= (options.attempts ?? 3)) break;
    const delay = (options.delayMs ?? 250) * 2 ** attempt;
    if (Date.now() + delay >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new SdkError(apiError('stream_break', 'Load 历史流中断，未取得本次快照终态；未返回部分历史。'));
}
