import type { TurnAggregate } from '@das/shared';

import { turnTail, turnToBlocks } from '@/lib/turnText';

/**
 * 把一个会话导出成单文件 HTML。
 *
 * 三条刻意的取舍：
 *
 * 1. **正文用 `<pre>` + 全量转义，不渲染 Markdown。** 导出件的用途是留档与对账，
 *    要的是"和聚合器里的全文逐字一致"。在导出件里再渲染一次 Markdown，等于把
 *    界面那套渲染器（含代码高亮、表格、mermaid）复制一份到一个没有测试覆盖的
 *    产物里，而且必然要往字符串里塞未转义的 HTML——那是给自己造一个 XSS 载体。
 * 2. **复用 `turnToBlocks`。** 与「复制整轮」同一份序列化，所以导出件不会比复制少东西。
 *    界面上默认折叠的思考过程与工具结果，在导出件里一律展开：折叠是屏幕上的取舍，
 *    留档时把内容藏起来就成了静默丢失。
 * 3. **不含任何脚本。** 导出件会被双击打开、可能被转发，`<script>` 一个都不放。
 */

/**
 * 一轮的可导出字段。
 *
 * 直接 Pick 上游聚合结果：历史轮次是 `TurnAggregate`、在途轮次是 turnStore 的 `TurnView`，
 * 这两个类型在下列字段上同名同型，所以两边都能原样传进来，不必再写一层适配
 * （适配层最容易出的错就是漏字段——导出件少一段而界面上是全的，没人会发现）。
 */
export type ExportableTurn = Pick<
  TurnAggregate,
  | 'rid'
  | 'userText'
  | 'thoughtText'
  | 'messageText'
  | 'tools'
  | 'stopReason'
  | 'frameCount'
  | 'firstTimestamp'
  | 'lastTimestamp'
  | 'tokenUsage'
>;

export interface ExportInput {
  sessionId: string;
  /** 界面上显示的那个名字（本地别名优先，其次 SessionTitle）。 */
  title: string;
  turns: readonly ExportableTurn[];
  exportedAt: number;
  /** 回放数据导出时必须标出来：否则一份 MOCK 导出件会被当成线上结论转发。 */
  mock: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 文件名里只留安全字符：SessionId 是上游给的，不该假设它能直接进文件名。 */
export function exportFilename(sessionId: string, at: number): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'session';
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `das-session-${safe}-${stamp}.html`;
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0 auto; max-width: 60rem; padding: 2rem 1.25rem 4rem;
  font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
header { border-bottom: 1px solid #8884; padding-bottom: .75rem; margin-bottom: 1.5rem; }
h1 { font-size: 1.15rem; margin: 0 0 .35rem; }
.meta { font-size: 12px; opacity: .75; margin: 0; }
.meta code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.notice { font-size: 12px; opacity: .75; margin: .5rem 0 0; }
section { margin: 0 0 1.75rem; padding-bottom: 1.25rem; border-bottom: 1px dashed #8883; }
h2 { font-size: .95rem; margin: 0 0 .25rem; }
h3 { font-size: 12px; text-transform: none; opacity: .7; margin: 1rem 0 .25rem; font-weight: 600; }
pre { margin: 0; padding: .6rem .75rem; border: 1px solid #8883; border-radius: 6px;
  white-space: pre-wrap; word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.6; }
.tail { font-size: 11.5px; opacity: .7; margin: .5rem 0 0; font-family: ui-monospace, Menlo, monospace; }
.empty { font-size: 13px; opacity: .8; }
`.trim();

export function buildExportHtml(input: ExportInput): string {
  const { sessionId, title, turns, exportedAt, mock } = input;
  const when = new Date(exportedAt).toLocaleString('zh-CN', { hour12: false });

  const head = `<header>
<h1>${escapeHtml(title || '（无标题）')}</h1>
<p class="meta">会话 <code>${escapeHtml(sessionId)}</code> · ${turns.length} 轮 · 导出于 ${escapeHtml(when)} · ${mock ? '<strong>MOCK 回放数据</strong>' : 'LIVE 真实接口'}</p>
<p class="notice">正文与界面聚合器里的全文逐字一致（界面上默认折叠的思考过程与工具结果在这里一律展开）。本文件不含脚本。</p>
</header>`;

  const body =
    turns.length === 0
      ? // 空会话要明说：只吐一个空 body 的话，打开的人分不清是"这个会话没内容"还是"导出坏了"。
        '<p class="empty">这个会话没有可导出的轮次：历史里没有一条提示词回显，聚合器认不出轮次。</p>'
      : turns
          .map((turn, index) => {
            const blocks = turnToBlocks(turn)
              .map((b) => `<h3>${escapeHtml(b.heading)}</h3>\n<pre>${escapeHtml(b.text)}</pre>`)
              .join('\n');
            const facts: string[] = [];
            if (turn.frameCount !== undefined) facts.push(`${turn.frameCount} 帧`);
            if (turn.tokenUsage?.totalTokens !== undefined) facts.push(`${turn.tokenUsage.totalTokens} tokens`);
            if (turn.firstTimestamp !== undefined) {
              const end = turn.lastTimestamp !== undefined ? ` → ${new Date(turn.lastTimestamp).toLocaleTimeString('zh-CN', { hour12: false })}` : '';
              facts.push(`${new Date(turn.firstTimestamp).toLocaleTimeString('zh-CN', { hour12: false })}${end}`);
            }
            const tail = turnTail(turn);
            return `<section>
<h2>第 ${index + 1} 轮${facts.length > 0 ? ` <span class="meta">· ${escapeHtml(facts.join(' · '))}</span>` : ''}</h2>
${blocks || '<p class="empty">这一轮没有任何内容块。</p>'}
${tail ? `<p class="tail">${escapeHtml(tail)}</p>` : ''}
</section>`;
          })
          .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title || sessionId)}</title>
<style>${STYLE}</style>
</head>
<body>
${head}
${body}
</body>
</html>
`;
}

/**
 * 触发浏览器下载。
 *
 * anchor 必须先挂到 DOM 上再 click：Firefox 对游离节点的 click 不做下载。
 * objectURL 延后一拍再 revoke——立刻 revoke 在部分浏览器上会把还没开始的下载打断。
 */
export function downloadHtml(filename: string, html: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
