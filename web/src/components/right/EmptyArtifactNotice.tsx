import { useState } from 'react';
import { Check, Copy, FileQuestion, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';

/**
 * artifact 空态说明。
 *
 * 右栏接的是真实接口，不兜底填充假数据：实测 ListAgentSessionArtifacts 恒返回空数组，
 * GetAgentSessionArtifactMeta 这条也拿不到内容。空态要把这件事讲清楚，
 * 否则使用者会以为是自己的调用方式不对，反复重试。
 *
 * 空态还必须**可操作**：只说"拿不到"的话，用户的下一步是去翻文档或者重试点按钮；
 * 给一句现成的提示词（并且把原文摆在界面上，不复制看不见的东西）才是真的下一步。
 */
const INLINE_SNIPPET =
  '请把结果直接内联写进回答正文：表格用 Markdown 表格，代码用围栏代码块，' +
  '不要只给文件路径或 artifact。';

export function EmptyArtifactNotice() {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');

  async function copySnippet(): Promise<void> {
    const ok = await copyText(INLINE_SNIPPET);
    setCopied(ok ? 'ok' : 'fail');
    // 失败态不自动复位：那是一条需要用户看见并处理的信息（手动选中复制）
    if (ok) setTimeout(() => setCopied('idle'), 1500);
  }

  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <FileQuestion className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">没有 artifact</p>
      <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
        <p>上游这两个 artifact 接口实测恒返回空——不是调用出错。</p>
        <p>要产物就在提示词里要求 agent 把结果内联写进回答。</p>
      </div>

      <div className="w-full space-y-2 rounded-md border border-border bg-muted/30 p-2.5 text-left">
        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">{INLINE_SNIPPET}</p>
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-full gap-1 text-[11px]"
          onClick={() => void copySnippet()}
          title={
            copied === 'fail'
              ? '剪贴板不可用（常见于非 https 访问），请手动选中上面的文字复制'
              : '把这句提示词复制到剪贴板，粘进输入框跟着你的问题一起发'
          }
        >
          {copied === 'ok' ? (
            <Check className="size-3 text-ok" />
          ) : copied === 'fail' ? (
            <X className="size-3 text-destructive" />
          ) : (
            <Copy className="size-3" />
          )}
          {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败' : '复制这句提示词'}
        </Button>
      </div>
    </div>
  );
}
