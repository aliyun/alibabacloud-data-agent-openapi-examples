import { useEffect, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { MarkdownTable } from '@/components/chat/MarkdownTable';
import { Mermaid } from '@/components/chat/Mermaid';
import { highlight, LOADED_LANGS, resolveLang, skipHighlightNote, skipHighlightReason } from '@/lib/highlight';
import { copyText } from '@/lib/clipboard';
import { isSafeHref, isSafeImageSrc } from '@/lib/safeUrl';
import { plainTextNotice, shouldRenderPlainText } from '@/lib/streamText';
import { useThrottledText } from '@/hooks/useThrottledText';

/**
 * 助手回答的 Markdown 渲染。
 *
 * 设计吸收自 Qwen Code 系 Web UI 的 Markdown 渲染方案（那边的实现深绑它自己的
 * transcript 模型与上下文，不便直接复用）；这里取的是它几条**行为**：
 * 流式期间不做语法高亮、链接白名单过滤、超长代码跳过高亮、高亮结果缓存。
 *
 * 仍然刻意不做的：katex（数据分析场景公式出现率极低，而它带一整套字体）、
 * CodeMirror（输入区是 textarea，见 Composer）、xterm 终端回放、图片灯箱。
 */

export interface MarkdownProps {
  text: string;
  /**
   * 正在收流。用途有两个：推迟语法高亮与推迟 mermaid 渲染。
   * 不影响 Markdown 结构解析——结构必须逐字实时出，否则用户看不到"正在写"。
   */
  streaming?: boolean;
}

export function Markdown({ text, streaming }: MarkdownProps) {
  const live = streaming === true;
  const shown = useThrottledText(text, live);
  const plain = shouldRenderPlainText(shown, live);

  if (plain) {
    /**
     * 降级块。说明必须写在界面上：不然用户看到一段没有排版的正文，
     * 会以为是渲染坏了（而这个工程的立场是"对用户说实话"）。
     */
    return (
      <div className="my-2 overflow-hidden rounded-md border border-border">
        <p className="border-b border-border bg-muted/60 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {plainTextNotice(shown)}
        </p>
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">
          {shown}
        </pre>
      </div>
    );
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 代码块的容器由 CodeBlock 自己画（要带语言标签和复制按钮），
          // 所以这里把默认的 <pre> 摘掉，避免 pre 套 pre。
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const raw = String(children).replace(/\n$/, '');
            const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1];
            // 没有 language- 类名的也可能是块级：``` 后面不写语言的围栏块。
            // 判据只能看有没有换行——行内代码里出现裸换行的情况极罕见，
            // 而漏判会让整个围栏块塌成一行。
            if (lang === undefined && !raw.includes('\n')) return <code>{children}</code>;
            // mermaid 图定义在半截状态下渲染必然报错，流式期间先当普通代码块显示
            if (lang === 'mermaid' && !live) return <Mermaid code={raw} />;
            return <CodeBlock lang={lang ?? 'text'} code={raw} streaming={live} />;
          },
          table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
          /**
           * 链接一律过白名单。
           *
           * 回答正文是 agent 产出的、不受本工程控制的内容，`[点我](javascript:…)`
           * 是完全合法的 Markdown，不过滤就是一个点击即执行的注入面。
           * 判不出安全的地址不渲染成链接，只留文本——用户至少看得见原始内容。
           */
          a: ({ href, children }) =>
            isSafeHref(href) ? (
              // 新窗口打开：agent 给的文档链接点开后不该把当前会话顶掉
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ) : (
              <span title={`已拦截不安全的链接地址：${href ?? '(空)'}`}>{children}</span>
            ),
          img: ({ src, alt }) =>
            isSafeImageSrc(typeof src === 'string' ? src : undefined) ? (
              <img src={src} alt={alt ?? ''} loading="lazy" className="my-2 max-h-96 max-w-full rounded-md border border-border" />
            ) : (
              <span className="my-2 block rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                已拦截不安全的图片地址：{String(src ?? '(空)')}
              </span>
            ),
        }}
      >
        {shown}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ lang, code, streaming }: { lang: string; code: string; streaming: boolean }) {
  const [html, setHtml] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');

  /** 标签上显示实际用到的语法名：`sh` 要显示成 `shellscript`，否则看起来像没映射成功。 */
  const displayLang = resolveLang(lang, LOADED_LANGS);

  useEffect(() => {
    /**
     * 流式期间**只出纯文本，不高亮**。
     *
     * 代码块是逐 token 追加的，每来一片就重跑一次高亮，会让整块代码的颜色每几十毫秒
     * 闪一次（而且语法树在半截代码上每次都不一样，闪得毫无规律）。长轮实测 191s、
     * 平均约 4.7 帧/s（最密的 1 秒里 15 帧），会闪一路。
     * 所以流式中一律纯文本，收到终态再高亮一次。
     */
    if (streaming) {
      setHtml(undefined);
      return;
    }

    let cancelled = false;
    void highlight(code, lang).then((result) => {
      if (!cancelled) setHtml(result);
    });

    return () => {
      cancelled = true;
    };
  }, [lang, code, streaming]);

  async function copy(): Promise<void> {
    const ok = await copyText(code);
    setCopied(ok ? 'ok' : 'fail');
    // 失败态不自动复位：那是一条需要用户看见并处理的信息（手动选中复制）
    if (ok) setTimeout(() => setCopied('idle'), 1500);
  }

  const skipReason = skipHighlightReason(code);

  return (
    <div className="my-2 overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/60 px-2 py-1">
        <span className="font-mono text-[11px] text-muted-foreground">{displayLang}</span>
        {skipReason !== undefined && (
          <span className="text-[10px] text-muted-foreground" title={skipHighlightNote(skipReason, code)}>
            未高亮
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {countLines(code)} 行
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          title={copied === 'fail' ? '剪贴板不可用（常见于非 https 访问），请手动选中复制' : '复制这段代码'}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied === 'ok' ? (
            <Check className="size-3 text-ok" />
          ) : copied === 'fail' ? (
            <X className="size-3 text-destructive" />
          ) : (
            <Copy className="size-3" />
          )}
          {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败' : '复制'}
        </button>
      </div>
      {html === undefined ? (
        <pre className="overflow-x-auto p-3 text-xs leading-5">
          <code className="font-mono">{code}</code>
        </pre>
      ) : (
        // shiki 的输出是它自己转义过的 HTML，不含任何用户可控的原始标签
        <div
          className="shiki-host overflow-x-auto [&_pre]:p-3 [&_pre]:text-xs [&_pre]:leading-5"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}

function countLines(code: string): number {
  return code === '' ? 0 : code.split('\n').length;
}
