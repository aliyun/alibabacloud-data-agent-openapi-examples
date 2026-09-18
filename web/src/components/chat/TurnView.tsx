import { useId, useState } from 'react';
import { BrainCircuit, Check, ChevronRight, Copy, TriangleAlert, Wrench, X } from 'lucide-react';
import type { StopReason, TokenUsage, ToolCallView } from '@das/shared';
import { STOP_REASON_TEXT, stripMarkerInstruction } from '@das/shared';

import { MarkerBadge } from '@/components/chat/MarkerBadge';
import { Markdown } from '@/components/chat/Markdown';
import { ToolCard } from '@/components/chat/ToolCard';
import { Badge } from '@/components/ui/badge';
import { useNow } from '@/hooks/useNow';
import { cn } from '@/lib/utils';
import { copyText } from '@/lib/clipboard';
import { turnToText } from '@/lib/turnText';
import { elapsedLabel, elapsedOf, elapsedTitle } from '@/lib/turnClock';
import { COLLAPSE_TOOL_COUNT, shouldCollapseTools, toolGroupFacts, toolGroupLabel } from '@/lib/turnCollapse';
import { formatClock, formatCount, formatDuration, formatTime } from '@/lib/format';

export interface TurnViewProps {
  rid?: string;
  userText: string;
  thoughtText: string;
  messageText: string;
  tools: ToolCallView[];
  frameCount: number;
  stopReason?: StopReason;
  rawStopReason?: string;
  tokenUsage?: TokenUsage;
  contextUsage?: { size: number; used: number };
  marker?: string;
  verified?: boolean;
  mock?: boolean;
  unrecognizedUpdates?: string[];
  /** 首末帧上的服务端 Timestamp（毫秒），用于开始时刻与耗时。 */
  firstTimestamp?: number;
  lastTimestamp?: number;
  /** 排队通知帧（Method="_qwen/notify"）条数。 */
  queuedNotices?: number;
  /** 正在收流：正文后面挂一个光标，且不说"已完成"。 */
  streaming?: boolean;
  /** 代理进程发起调用的本地时刻。只有收流时才用得到——见下面的计时说明。 */
  startedAt?: number;
}

/**
 * 一轮的渲染。历史轮次（load 还原出来的）与在途轮次（流式聚合出来的）共用这一个组件——
 * 两边喂的都是同一个 shared reducer 的产物，形状一致，所以不需要两套 UI。
 */
export function TurnView(props: TurnViewProps) {
  const [thoughtOpen, setThoughtOpen] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const {
    rid,
    userText,
    thoughtText,
    messageText,
    tools,
    frameCount,
    stopReason,
    rawStopReason,
    tokenUsage,
    contextUsage,
    marker,
    verified,
    mock,
    unrecognizedUpdates,
    firstTimestamp,
    lastTimestamp,
    queuedNotices,
    streaming,
    startedAt,
  } = props;

  // 注入的校验码说明是给用户看的脚手架，不是他写的内容，展示时剥掉
  const prompt = stripMarkerInstruction(userText);

  const isStreaming = streaming === true;

  /**
   * 计时：收流中每秒走一次，结束后定住。
   *
   * 收流期间必须用**本地时钟**：服务端 Timestamp 只在收到帧时才前进，拿它做实时计时，
   * 帧一停数字就冻住——而"帧停了"恰恰是最需要计时的处境（断流、上游挂起），
   * 一个冻住的秒数会被读成"这一轮就用了这么久"。结束后换回服务端 Timestamp，
   * 因为它才是这一轮真实的执行时长（本地那个含网络与排队）。两个数字挂不同标签
   * （「已运行」/「耗时」），否则收尾那一刻数字往回跳会被当成 bug。判据在 `lib/turnClock.ts`。
   */
  const now = useNow(1_000, isStreaming);
  const elapsed = elapsedOf({
    streaming: isStreaming,
    startedAt,
    firstTimestamp,
    lastTimestamp,
    now,
  });

  /** 折叠时的预览：第一行（跳过可能的前导空行）。实测思考过程是逐块拼接的，首块只有 "The"。 */
  const thoughtFirstLine = thoughtText.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';

  /**
   * 与 ToolCard 的「未回传终态」同一个判据，这里只做汇总：一轮里十几个工具调用时，
   * 逐张卡片找哪个还在转圈是不现实的。收流中不算——那时候"停在执行中"是真的在跑。
   */
  const unfinishedTools = streaming
    ? []
    : tools.filter((tool) => tool.status === 'pending' || tool.status === 'in_progress');

  async function copyTurn(): Promise<void> {
    const ok = await copyText(
      turnToText({
        rid,
        userText: prompt,
        thoughtText,
        messageText,
        tools,
        stopReason: stopReason ?? rawStopReason,
      }),
    );
    setCopied(ok ? 'ok' : 'fail');
    if (ok) setTimeout(() => setCopied('idle'), 1500);
  }

  return (
    <div className="space-y-3">
      {prompt && (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2">
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{prompt}</p>
          </div>
        </div>
      )}

      {thoughtText && (
        <div className="rounded-r-md border-l-2 border-border bg-muted/30">
          <button
            type="button"
            onClick={() => setThoughtOpen((v) => !v)}
            aria-expanded={thoughtOpen}
            className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <BrainCircuit className="size-3.5 shrink-0" />
            <span className="shrink-0">{thoughtOpen ? '收起思考过程' : '思考过程'}</span>
            <span className="shrink-0 font-mono opacity-70">{thoughtText.length} 字</span>
            {!thoughtOpen && (
              <span className="min-w-0 flex-1 truncate opacity-70" title={thoughtFirstLine}>
                {thoughtFirstLine}
              </span>
            )}
          </button>
          {thoughtOpen && (
            <p className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words border-t border-border px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
              {thoughtText}
            </p>
          )}
        </div>
      )}

      {tools.length > 0 && (
        <ToolGroup tools={tools} streaming={isStreaming} />
      )}

      {unfinishedTools.length > 0 && (
        <p
          className="flex items-start gap-1.5 text-[11px] leading-relaxed text-warning"
          title="上游没有送来这些工具调用的终态帧（断流、取消、会话失效或回放到底）；状态停在最后一次汇报的取值，不代表还在跑。"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{unfinishedTools.length} 个工具调用没有收到终态帧。</span>
        </p>
      )}

      {(messageText || streaming) && (
        <div>
          <Markdown text={messageText} streaming={streaming} />
          {streaming && <span className="mt-1 block h-4 w-1.5 animate-pulse bg-foreground/60" />}
        </div>
      )}

      {unrecognizedUpdates && unrecognizedUpdates.length > 0 && (
        <div className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            出现了 {unrecognizedUpdates.length} 种本工程不认识的帧类型：
            <span className="font-mono">{unrecognizedUpdates.join(', ')}</span>
            。这些帧没有产出内容——不是解析崩了，而是上游加了新形态，请把它反馈给维护者。
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        {stopReason && (
          <Badge variant={stopReason === 'end_turn' ? 'secondary' : 'warning'} className="font-normal">
            {stopReason}
          </Badge>
        )}
        {!stopReason && rawStopReason && <Badge variant="warning" className="font-normal">{rawStopReason}（不在已知集合内）</Badge>}
        {marker !== undefined && <MarkerBadge marker={marker} verified={verified === true} mock={mock} />}
        {firstTimestamp !== undefined && (
          <span className="font-mono" title={`首帧时间 ${formatTime(firstTimestamp)}`}>
            {formatClock(firstTimestamp)}
          </span>
        )}
        {elapsed !== undefined && (
          <span className="font-mono" title={elapsedTitle(elapsed)}>
            <span className={cn(isStreaming && 'animate-pulse')}>
              {elapsedLabel(elapsed)} {formatDuration(elapsed.ms)}
            </span>
          </span>
        )}
        <span className="font-mono" title={rid === undefined ? '这一轮没有 rid' : `rid=${rid}`}>
          <span className={cn(streaming && 'animate-pulse')}>{frameCount} 帧</span>
        </span>
        {tokenUsage?.totalTokens !== undefined && (
          <span className="font-mono" title={`prompt ${tokenUsage.promptTokens ?? '—'} / completion ${tokenUsage.completionTokens ?? '—'}${tokenUsage.cachedTokens ? ` / cached ${tokenUsage.cachedTokens}` : ''}`}>
            {formatCount(tokenUsage.totalTokens)} tokens
          </span>
        )}
        {contextUsage && (
          <span className="font-mono" title="usage_update 帧给的上下文窗口用量">
            上下文 {formatCount(contextUsage.used)}/{formatCount(contextUsage.size)}
          </span>
        )}
        {queuedNotices !== undefined && queuedNotices > 0 && (
          <span
            className="font-mono"
            title='Method="_qwen/notify" 的排队通知帧：它是"提示词已排上队"的信号，不产出内容'
          >
            排队通知 {queuedNotices}
          </span>
        )}

        <button
          type="button"
          onClick={() => void copyTurn()}
          title={
            copied === 'fail'
              ? '剪贴板不可用（常见于非 https 访问），请手动选中复制'
              : '复制这一轮的全文（含默认折叠的思考过程与工具结果）'
          }
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied === 'ok' ? (
            <Check className="size-3 text-ok" />
          ) : copied === 'fail' ? (
            <X className="size-3 text-destructive" />
          ) : (
            <Copy className="size-3" />
          )}
          {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败' : '复制整轮'}
        </button>
      </div>

      {stopReason && stopReason !== 'end_turn' && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{STOP_REASON_TEXT[stopReason]}</p>
      )}
    </div>
  );
}

/**
 * 工具卡片组。判据在 `lib/turnCollapse.ts`（纯函数、有单测）。
 *
 * 少于等于 `COLLAPSE_TOOL_COUNT` 张时**不画摘要行**：四张以内摊开扫一眼就够，
 * 多套一层折叠只是多一次点击。
 */
function ToolGroup({ tools, streaming }: { tools: ToolCallView[]; streaming: boolean }) {
  const facts = toolGroupFacts(tools);
  const collapsible = facts.count > COLLAPSE_TOOL_COUNT;
  const collapseByDefault = shouldCollapseTools(facts, streaming);
  /**
   * 用户手动开合之后以他的值为准（`undefined` 表示"还没碰过"）。
   * 直接把它存成 boolean 的话，收流结束那一刻判据从"不折叠"翻成"折叠"，
   * 用户刚点开的组会被自动收回去——那是抢他的操作。
   */
  const [override, setOverride] = useState<boolean | undefined>(undefined);
  const open = override ?? !collapseByDefault;
  const panelId = useId();
  // 折叠的唯一目的是降噪；失败与"没有终态"不是噪音，所以摘要行必须把它们喊出来。
  const needsAttention = facts.failed > 0 || (!streaming && facts.unsettled > 0);

  const cards = tools.map((tool) => <ToolCard key={tool.toolCallId} tool={tool} streaming={streaming} />);

  if (!collapsible) return <div className="space-y-1.5">{cards}</div>;

  return (
    <div className="overflow-hidden rounded-md border border-border/70">
      <button
        type="button"
        onClick={() => setOverride(!open)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={open ? '收起这一组工具调用' : '展开这一组工具调用'}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      >
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
        <Wrench className="size-3.5 shrink-0" />
        <span className={cn('min-w-0 flex-1 truncate', needsAttention && 'font-medium text-warning')}>
          {toolGroupLabel(facts)}
        </span>
      </button>
      {open && (
        <div id={panelId} className="space-y-1.5 border-t border-border/70 bg-muted/20 p-1.5">
          {cards}
        </div>
      )}
    </div>
  );
}
