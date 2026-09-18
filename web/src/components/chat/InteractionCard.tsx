import { useState } from 'react';
import { HelpCircle, Loader2, Send, ShieldCheck, TriangleAlert, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { turnStore, TurnView } from '@/state/turnStore';

type Interaction = NonNullable<TurnView['interaction']>;
type ReplyPayload = Parameters<typeof turnStore.replyToInteraction>[0];

export interface InteractionCardProps {
  interaction: Interaction;
  onReply: (payload: ReplyPayload) => void;
}

/** 单题的本地作答状态：选中选项 label 或自定义文本。 */
interface QuestionAnswer {
  label: string | undefined;
  custom: string;
}

/**
 * 人卡交互卡（【LIVE 09-17】，交互语义对齐 Qwen Code Web UI 的提问/授权卡片）。
 *
 * 提交契约（与 Qwen Code Web UI 的提交语义对齐）：
 *  · optionId 非空 → `{ outcome:{outcome:'selected', optionId}, answers? }`；
 *  · optionId 空   → `{ outcome:{outcome:'cancelled'} }`（仅兜底，正常路径不走）。
 * 两类交互的 optionId 都取自帧上的 `data.options[]`：
 *  · ask_user_question：提交用 `kind==='allow_once'` 的选项 + answers（索引键 → 选项
 *    label 或自定义文本）；取消用 `kind==='reject_once'|'reject_always'` 的选项。
 *    answers 缺席时上游会以 proceed_once 解除阻塞，但 agent 收不到答案（实测）。
 *  · 工具授权：选项原样渲染（allow 类主按钮、reject 类危险按钮）。
 * 多问题逐题作答，answers 以问题索引为键；每题都有答案才允许提交（Web Shell 同款）。
 */
export function InteractionCard({ interaction, onReply }: InteractionCardProps) {
  const { request, reply, error } = interaction;
  const busy = reply === 'submitting';
  const settled = reply === 'submitted';

  const questions = request.interactionKind === 'user_question' ? request.questions : [];
  const options = request.options;

  /** Web Shell 同款：提交走 allow_once 选项，取消走 reject 选项。 */
  const submitOption = options.find((o) => o.kind === 'allow_once');
  const rejectOption = options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');

  const [answersByIndex, setAnswersByIndex] = useState<Record<number, QuestionAnswer>>({});

  const answerOf = (idx: number): QuestionAnswer => answersByIndex[idx] ?? { label: undefined, custom: '' };
  const setAnswer = (idx: number, next: QuestionAnswer): void =>
    setAnswersByIndex((prev) => ({ ...prev, [idx]: next }));

  /** Web Shell buildResult：多选以 ", " 连接；单选 label 或自定义文本。demo 不支持 multiSelect，按单选处理。 */
  const buildAnswers = (): Record<string, string> | undefined => {
    if (questions.length === 0) return undefined;
    const result: Record<string, string> = {};
    for (let i = 0; i < questions.length; i += 1) {
      const a = answerOf(i);
      result[String(i)] = a.label ?? (a.custom.trim() || '');
    }
    return result;
  };

  const allAnswered = questions.every((_, i) => (buildAnswers() ?? {})[String(i)] !== undefined && (buildAnswers() ?? {})[String(i)] !== '');

  const submit = (payload: ReplyPayload): void => {
    if (busy || settled) return;
    onReply(payload);
  };

  const submitAsk = (): void => {
    if (!submitOption) {
      // Web Shell 同款：没有 allow_once 选项就拒绝提交——裸 selected 会以
      // proceed_once 解除阻塞但 agent 收不到答案，宁可让用户看到原因。
      return;
    }
    const answers = buildAnswers();
    submit({ optionId: submitOption.optionId, ...(answers ? { answers } : {}), outcome: 'selected' });
  };

  const cancelInteraction = (): void => {
    if (rejectOption) submit({ optionId: rejectOption.optionId, outcome: 'selected' });
    else submit({ outcome: 'cancelled' });
  };

  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2.5',
        settled ? 'border-border/60 bg-muted/30' : 'border-warning/50 bg-warning/5',
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {request.interactionKind === 'user_question' ? (
          <HelpCircle className="size-3.5 shrink-0 text-warning" />
        ) : (
          <ShieldCheck className="size-3.5 shrink-0 text-warning" />
        )}
        <span className="font-medium">
          {settled
            ? '已回覆，等待 agent 继续…'
            : request.interactionKind === 'user_question'
              ? 'Agent 需要你的回答'
              : 'Agent 请求工具授权'}
        </span>
        {request.toolName && (
          <Badge variant="outline" className="font-mono text-[10px] font-normal">
            {request.toolName}
          </Badge>
        )}
        {busy && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
      </div>

      {questions.length > 0 && (
        <div className="mt-2 space-y-3">
          {questions.map((question, qi) => {
            const a = answerOf(qi);
            return (
              <div key={qi} className="space-y-1.5">
                <p className="text-sm leading-relaxed">
                  {questions.length > 1 && <span className="mr-1 font-mono text-[11px] text-muted-foreground">{qi + 1}/{questions.length}</span>}
                  {question.header && <span className="mr-1 font-medium">{question.header}：</span>}
                  {question.question}
                </p>
                {question.options.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {question.options.map((option) => {
                      const selected = a.label === option.label;
                      return (
                        <button
                          key={option.label}
                          type="button"
                          disabled={busy || settled}
                          onClick={() => setAnswer(qi, { label: option.label, custom: '' })}
                          title={option.description}
                          className={cn(
                            'rounded-md border bg-card px-3 py-1.5 text-left text-sm transition-colors',
                            'disabled:cursor-not-allowed disabled:opacity-50',
                            selected
                              ? 'border-foreground/60 bg-accent text-accent-foreground'
                              : 'border-border hover:border-foreground/40 hover:bg-accent/60',
                          )}
                        >
                          {option.label}
                          {option.description && (
                            <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                              {option.description}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <input
                    value={a.custom}
                    onChange={(e) => setAnswer(qi, { label: undefined, custom: e.target.value })}
                    disabled={busy || settled}
                    placeholder="或输入自定义回答…"
                    className="min-w-0 flex-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground/40 disabled:opacity-50"
                  />
                </div>
              </div>
            );
          })}
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              disabled={busy || settled || !submitOption || !allAnswered}
              onClick={submitAsk}
              title={submitOption ? undefined : '上游帧里没有 allow_once 选项，无法提交（Web Shell 同款约束）'}
            >
              <Send className="size-3" />
              提交回答
            </Button>
            {rejectOption && (
              <Button size="sm" variant="ghost" disabled={busy || settled} onClick={cancelInteraction} className="text-muted-foreground">
                <X className="size-3" />
                取消本次交互
              </Button>
            )}
            {!submitOption && !settled && (
              <p className="flex items-center gap-1 text-[11px] text-destructive">
                <TriangleAlert className="size-3.5" />
                上游帧缺少 allow_once 选项，无法提交回答。
              </p>
            )}
          </div>
        </div>
      )}

      {questions.length === 0 && (
        <div className="mt-2 space-y-2">
          {request.toolCallTitle && (
            <p className="break-words font-mono text-[11px] leading-relaxed text-muted-foreground">{request.toolCallTitle}</p>
          )}
          {options.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {options.map((option) => {
                const destructive = option.kind?.startsWith('reject');
                return (
                  <Button
                    key={option.optionId}
                    size="sm"
                    variant={option.kind?.startsWith('allow') ? 'default' : destructive ? 'outline' : 'outline'}
                    disabled={busy || settled}
                    className={cn(destructive && 'text-destructive hover:bg-destructive/10')}
                    onClick={() => submit({ optionId: option.optionId, outcome: 'selected' })}
                    title={option.kind ? `option kind: ${option.kind}` : undefined}
                  >
                    {option.name ?? option.optionId}
                  </Button>
                );
              })}
            </div>
          ) : (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              上游没有给出可选项；可以取消本次交互，或等 agent 自行处理。
            </p>
          )}
          <Button size="sm" variant="ghost" disabled={busy || settled} onClick={cancelInteraction} className="text-muted-foreground">
            <X className="size-3" />
            取消本次交互
          </Button>
        </div>
      )}

      {reply === 'failed' && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{error ?? '回覆失败，可直接重试。'}</span>
        </p>
      )}
      {settled && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          回覆已被上游接受；这一卡会随流上的 permission_resolved 帧自动收起。
        </p>
      )}
    </div>
  );
}
