import { useEffect, useRef, useState } from 'react';
import { Check, CircleDashed, FileText, Loader2, TriangleAlert, X } from 'lucide-react';
import type { ToolCallView, ToolStatus } from '@das/shared';

import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/format';

const STATUS_META: Record<ToolStatus, { label: string; className: string; Icon: typeof Check }> = {
  pending: { label: '排队中', className: 'text-muted-foreground', Icon: CircleDashed },
  in_progress: { label: '执行中', className: 'text-info', Icon: Loader2 },
  completed: { label: '已完成', className: 'text-ok', Icon: Check },
  failed: { label: '失败', className: 'text-destructive', Icon: X },
  /**
   * 上游给了一个不在已观测集合里的状态。已观测的四种不构成封闭集合，
   * 所以新值要显示出来，而不是静默当成 pending——否则一次上游变更
   * 会表现为"卡片永远转圈"。
   */
  unknown: { label: '未知状态', className: 'text-warning', Icon: TriangleAlert },
};

/**
 * 轮次已经不在收流了，卡片却还停在 pending / in_progress：那是**上游没把终态帧送回来**
 * （断流、点了 Stop、会话幽灵化、load 回放结束都会这样），不是"它还在跑"。
 * 继续转圈等于替上游担保一个我们并不知道的事实，所以换成不转圈的琥珀色并说清是什么情况。
 */
const UNSETTLED_META = { label: '未回传终态', className: 'text-warning', Icon: TriangleAlert };

/** command 与 description 各有专门的位置，不再在参数表里重复一遍。 */
const DEDICATED_PARAMS = new Set(['command', 'description']);

/** 参数值可能是对象或数组；字符串原样出，避免多一层引号。 */
function valueOf(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 一次工具调用的卡片。
 *
 * 状态流转完全由帧驱动：pending → in_progress → completed/failed，
 * 聚合时一律"有值才覆盖"——实测 rawInput.command 只出现在 in_progress 帧上，
 * completed 帧不带，无脑赋值会在跑完那一刻把命令清空。
 */
export function ToolCard({ tool, streaming = true }: { tool: ToolCallView; streaming?: boolean }) {
  const unsettled = !streaming && (tool.status === 'in_progress' || tool.status === 'pending');
  const meta = unsettled ? UNSETTLED_META : STATUS_META[tool.status];
  const heading = tool.title ?? tool.name ?? tool.toolCallId;

  const failed = tool.status === 'failed';
  /**
   * 失败时自动展开结果：失败的原因几乎总是只写在结果正文里（Exit Code、报错栈），
   * 折叠着就等于把最关键的一屏藏起来。
   *
   * 完成时自动折叠，但**只在用户没手动动过的前提下**——用户主动展开的东西
   * 被代码在几百毫秒后合上，是那种"我明明点开了"的失效感。
   */
  const [resultOpen, setResultOpen] = useState(failed);
  const [paramsOpen, setParamsOpen] = useState(false);
  const resultTouched = useRef(false);
  const prevStatus = useRef<ToolStatus>(tool.status);

  useEffect(() => {
    const before = prevStatus.current;
    prevStatus.current = tool.status;
    if (resultTouched.current) return;
    if (before !== 'failed' && tool.status === 'failed') setResultOpen(true);
    if (tool.status === 'completed') setResultOpen(false);
  }, [tool.status]);

  const settled = tool.status === 'completed' || tool.status === 'failed';
  /**
   * 与 TurnView 的耗时同一条规矩：只有状态落定了（或整轮已不在收流）才显示。
   * 执行中显示的话，帧一停数字就冻住，而"帧停了"正是最需要计时的处境。
   */
  const durationMs =
    tool.firstTimestamp !== undefined && tool.lastTimestamp !== undefined && (settled || !streaming)
      ? tool.lastTimestamp - tool.firstTimestamp
      : undefined;

  const params = Object.entries(tool.rawInput ?? {}).filter(([key]) => !DEDICATED_PARAMS.has(key));

  return (
    <div className="rounded-md border border-border bg-muted/30 text-xs">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <meta.Icon className={cn('size-3.5 shrink-0', meta.className, !unsettled && tool.status === 'in_progress' && 'animate-spin')} />
        <span className={cn('shrink-0 font-medium', meta.className)}>{meta.label}</span>
        <span className="truncate font-mono text-[11px] text-foreground">{heading}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {durationMs !== undefined && (
            <span className="font-mono text-[10px] text-muted-foreground" title="末帧减首帧的服务端 Timestamp 差值">
              {formatDuration(durationMs)}
            </span>
          )}
          {tool.name && tool.title && tool.name !== tool.title && (
            <span className="text-[11px] text-muted-foreground">{tool.name}</span>
          )}
        </span>
      </div>

      {tool.description && (
        <p className="border-t border-border px-2.5 py-1 text-[11px] leading-relaxed text-muted-foreground">
          {tool.description}
        </p>
      )}

      {tool.command && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-all border-t border-border px-2.5 py-1.5 font-mono text-[11px] text-foreground">
          {tool.command}
        </pre>
      )}

      {tool.locations.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-t border-border px-2.5 py-1">
          <FileText className="size-3 shrink-0 text-muted-foreground" />
          {tool.locations.map((location) => (
            <span key={location} className="font-mono text-[10px] text-muted-foreground">
              {location}
            </span>
          ))}
        </div>
      )}

      {params.length > 0 && (
        <div className="border-t border-border">
          <button
            type="button"
            onClick={() => setParamsOpen((v) => !v)}
            aria-expanded={paramsOpen}
            className="w-full px-2.5 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {paramsOpen ? '收起入参' : `查看入参（${params.length}）`}
          </button>
          {paramsOpen && (
            <dl className="space-y-0.5 border-t border-border px-2.5 py-1.5 font-mono text-[11px]">
              {params.map(([key, value]) => (
                <div key={key} className="flex gap-2">
                  <dt className="shrink-0 text-muted-foreground">{key}</dt>
                  <dd className="break-all text-foreground">{valueOf(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

      {tool.resultText && (
        <div className="border-t border-border">
          <button
            type="button"
            onClick={() => {
              resultTouched.current = true;
              setResultOpen((v) => !v);
            }}
            aria-expanded={resultOpen}
            className="w-full px-2.5 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {resultOpen ? '收起结果' : '查看执行结果'}
          </button>
          {resultOpen && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-border px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {tool.resultText}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
