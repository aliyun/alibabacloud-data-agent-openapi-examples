import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Paperclip, Send, Square, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  IDLE_CURSOR,
  enterIntent,
  pasteLabel,
  recallNewer,
  recallOlder,
  shouldCollapsePaste,
  shouldRecall,
  type HistoryCursor,
} from '@/lib/composerPolicy';
import { cn } from '@/lib/utils';
import {
  NEW_SESSION_DRAFT,
  getDraft,
  rememberPrompt,
  sentPrompts,
  setDraft as storeDraft,
} from '@/state/composerMemory';

/** 自动增高的上下限（px）。下限要能看见两行，上限再高就该滚动了。 */
const COMPOSER_MIN_HEIGHT = 64;
const COMPOSER_MAX_HEIGHT = 240;

/** "这句没发出去"提示的停留时长。够读完一句话，又不会一直占着输入框下面那行。 */
const BLOCKED_NOTE_MS = 4_000;

/** 折叠起来的粘贴内容。原文只在发送时才拼回去。 */
interface PastedBlock {
  id: number;
  text: string;
}

let nextPastedId = 1;

export interface ComposerAction {
  id: string;
  label: string;
  title?: string;
  onClick: () => void;
}

export interface ComposerProps {
  sessionId: string | undefined;
  /** 本会话正在收流（含"取消中"——那一步流还开着）。 */
  streaming: boolean;
  /** 取消请求已发出、正在等 cancelled 终态：按钮禁用防连点。 */
  cancelling?: boolean;
  /** 别的会话正在收流——在途锁是进程级的，这时候任何会话都发不出去。 */
  busyElsewhere: boolean;
  /** 会话已幽灵化（上游 422），不能再发。 */
  ghost: boolean;
  mock: boolean;
  /**
   * 未选中会话时也能发：由调用方先建会话再发 prompt。
   *
   * 允许返回 Promise：建会话是真实网络调用，可能失败（LIVE 下 `CreateAgentSession`
   * 回空 body 会归 `create_empty_body`）。失败时**草稿不清空**，用户那句话不该白丢。
   */
  onSend: (text: string) => void | Promise<void>;
  onStop: () => void;
  /**
   * 快捷动作 chips。由调用方按当前处境给（未选中会话时给「新建会话」、空闲时给
   * 「拉取历史」「导出 HTML」），Composer 自己不知道哪些动作此刻有意义。
   */
  actions?: readonly ComposerAction[];
}

/**
 * 输入框 + 发送 / 停止。
 *
 * 形态对齐主流 Web Chat 编辑器：发送按钮在输入框**内部右下角**（inline），
 * 而不是游离在输入框外面。未选中会话时输入框也可用——发送会自动新建一个会话。
 *
 * 停止按钮的语义是"取消本轮"（【LIVE 09-18】：CancelAgentSession 已生效，
 * 流会以 `stopReason=cancelled` 终态收场）；'cancelling' 期间按钮禁用防连点。
 *
 * 收流期间输入框**不禁用**（只有幽灵化才禁用）：这一轮发不出去，但下一句可以先写着，
 * 禁用等于让用户干等几十秒到几分钟。代价是 Enter 在这期间发不出去——所以 submit()
 * 在这种情况下会闪一条内联说明「这句没有发出去」，而不是静默 return：
 * 灰按钮加一行小字不足以让人确信"我刚才那下没生效"，而用户会把沉默读成已排队。
 * 刻意不做客户端排队（本轮结束后自动补发）：那一轮可能在用户已经走开之后才结束，
 * 自动补发等于在他没看着的时候触发一次写操作，而上游本来也拒绝同会话并发
 * （实测 `session_concurrent_operation_in_progress`）。
 * 这条决定同时是 Esc 停止能落在输入框里的前提：禁用状态下它拿不到焦点，
 * 局部 Esc 根本不会触发，就只能去做全局 Esc，而全局 Esc 已经归抽屉与浮层用了。
 */
export function Composer({
  sessionId,
  streaming,
  cancelling = false,
  busyElsewhere,
  ghost,
  mock,
  onSend,
  onStop,
  actions = [],
}: ComposerProps) {
  const draftKey = sessionId ?? NEW_SESSION_DRAFT;
  const [draft, setDraft] = useState(() => getDraft(draftKey));
  const [pasted, setPasted] = useState<PastedBlock[]>([]);
  const [cursor, setCursor] = useState<HistoryCursor>(IDLE_CURSOR);
  /**
   * "这句没发出去"的瞬时提示。
   *
   * 收流期间按 Enter 是发不出去的（本轮没结束、进程级在途锁也在拦），
   * 而 submit() 在这种情况下直接 return ——那就是无声失败：用户以为发出去了，
   * 其实一个字都没走。这里给一条内联说明而不是 toast：toast store 的契约是
   * "只用于界面上没有位置可画的消息"，而这条消息在输入框下面就有位置。
   */
  const [blockedNote, setBlockedNote] = useState<string | undefined>(undefined);
  const blockedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => clearTimeout(blockedTimer.current), []);

  function flashBlockedNote(text: string): void {
    setBlockedNote(text);
    clearTimeout(blockedTimer.current);
    blockedTimer.current = setTimeout(() => setBlockedNote(undefined), BLOCKED_NOTE_MS);
  }

  /**
   * 自动增高。必须先把 height 归零再读 scrollHeight：
   * 否则删掉几行之后 scrollHeight 仍是旧高度，框子只会长不会缩。
   */
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT)}px`;
  }, [draft]);

  /**
   * 切会话：换成那个会话自己的草稿。
   *
   * 必须在 effect 里做而不是渲染期算——渲染期 setState 会让同一个 key 的重渲染
   * 把用户正在打的字冲掉。折叠的粘贴块与历史游标一并清空：它们是"这一次要发的内容"
   * 的一部分，跟着会话走没有意义（粘的那段 SQL 是给上一个会话的）。
   */
  useEffect(() => {
    setDraft(getDraft(draftKey));
    setPasted([]);
    setCursor(IDLE_CURSOR);
  }, [draftKey]);

  const typed = draft.trim();
  const canSend = !streaming && !busyElsewhere && !ghost && (typed.length > 0 || pasted.length > 0);

  const placeholder = ghost
    ? '该会话已失效，只能新建会话'
    : busyElsewhere
      ? '另一轮还没结束（同一进程同时只跑一轮）'
      : streaming
        ? '本轮正在接收中，可以先写下一句'
        : sessionId === undefined
          ? '输入提示词开始对话，发送时会自动新建一个会话'
          : '把任务一次性写清楚';

  /** MOCK 标记不能顶掉操作提示：回放模式下键位是一样的，用户照样要知道能按什么。 */
  const hint =
    cursor.index !== null
      ? '↑ ↓ 翻历史 · Esc 回到你打的那句'
      : 'Enter 发送 · Shift / ⌘ / Ctrl / Alt + Enter 换行';

  /** 打字：退出翻历史的状态（框里已经是用户自己的字了，游标留着会让下箭头行为难懂）。 */
  function onType(text: string): void {
    setDraft(text);
    storeDraft(draftKey, text);
    setCursor(IDLE_CURSOR);
  }

  /**
   * 在光标处插一个换行。
   *
   * 用 textarea 自带的 setRangeText 而不是自己拼字符串：选区替换与光标落点
   * 由浏览器算（选中一段再按 ⌘+Enter 应当替换掉那段），而且这一步仍然进
   * 原生撤销栈，⌘Z 能撤回来——直接改 value 会把撤销历史整条清掉。
   */
  function insertNewline(el: HTMLTextAreaElement): void {
    el.setRangeText('\n', el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, 'end');
    onType(el.value);
  }

  /**
   * 发送。折叠的粘贴块拼在正文之后，用空行隔开——它们是内容的一部分，
   * 但用户打的才是"这句话"，顺序上正文在前。
   */
  function submit(): void {
    if (!canSend) {
      /**
       * 发不出去时不能静默 return：Enter 按下去什么都没发生，用户会读成"已经排上队了"。
       * 框里没内容是唯一的例外——那是空回车，弹一句话只会变成噪音。
       */
      if (typed.length > 0 || pasted.length > 0) {
        flashBlockedNote(
          ghost
            ? '这句没有发出去：该会话已失效，只能新建一个会话。'
            : busyElsewhere
              ? '这句没有发出去：另一轮还没结束，同一进程同时只跑一轮。'
              : '这句没有发出去：本轮还在接收中。文字保留在框里，等这一轮结束再发。',
        );
      }
      return;
    }
    const key = draftKey;
    const body = [draft.trim(), ...pasted.map((p) => p.text.replace(/\s+$/, ''))]
      .filter((part) => part.length > 0)
      .join('\n\n');
    // 只记用户自己打的那句：粘贴进来的可能是几千字的建表语句，
    // 塞进提示词历史里会把 20 条的额度一次吃光，而翻历史要找的从来不是那段粘贴。
    const spoken = typed;
    void Promise.resolve(onSend(body)).then(
      () => {
        setDraft('');
        setPasted([]);
        setCursor(IDLE_CURSOR);
        storeDraft(key, '');
        if (spoken.length > 0) rememberPrompt(spoken);
      },
      () => {
        // 失败时把文本与粘贴块都留在原处。拒绝在这里吃掉：错误内容由调用方的横幅交代，
        // 让它冒上去只会变成一个没人渲染的 unhandled rejection。
      },
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    /**
     * 输入法组合态下按回车是"选中候选词"，不是发送。
     * 少了这一条，用拼音打中文时每次选词都会把半截拼音发出去。
     * keyCode 229 是组合态的历史判据，Safari 上不设置 isComposing，两个都要看。
     */
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

    if (event.key === 'Enter') {
      /**
       * 两条分支都要 preventDefault：只有裸 Enter 与 Shift+Enter 是浏览器自己会插换行的，
       * ⌘/Ctrl/Alt+Enter 在 textarea 里默认什么都不插——不自己插就等于吞掉了这一记按键。
       */
      event.preventDefault();
      if (enterIntent(event) === 'submit') submit();
      else insertNewline(event.currentTarget);
      return;
    }

    if (event.key === 'Escape') {
      // 先退出翻历史：那时 Esc 的含义是"把我打的那半句还回来"，比停止接收更贴近当下。
      if (cursor.index !== null) {
        event.preventDefault();
        setDraft(cursor.stash);
        storeDraft(draftKey, cursor.stash);
        setCursor(IDLE_CURSOR);
        return;
      }
      if (streaming) {
        event.preventDefault();
        onStop();
      }
      return;
    }

    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const el = event.currentTarget;
    if (!shouldRecall(event.key, cursor, draft, el.selectionStart ?? 0, el.selectionEnd ?? 0)) return;
    event.preventDefault();
    const history = sentPrompts();
    const step = event.key === 'ArrowUp' ? recallOlder(cursor, history, draft) : recallNewer(cursor, history, draft);
    setCursor(step.cursor);
    if (step.text !== draft) {
      setDraft(step.text);
      storeDraft(draftKey, step.text);
    }
  }

  /**
   * 大段粘贴折成 chip。
   *
   * 判据在 `lib/composerPolicy.ts`。preventDefault 之后输入框里一个字都不留——
   * 折起来的意义就是把正文让给用户正在写的那句话，同时插进去等于没折。
   */
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const text = event.clipboardData.getData('text/plain');
    if (!shouldCollapsePaste(text)) return;
    event.preventDefault();
    setPasted((blocks) => [...blocks, { id: nextPastedId++, text }]);
  }

  return (
    <div className="shrink-0 border-t border-border p-3">
      <div className="mx-auto max-w-3xl">
        {actions.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={action.onClick}
                title={action.title}
                className="rounded-full border border-border bg-background px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {action.label}
              </button>
            ))}
          </div>
        )}

        <div className="rounded-xl border border-border bg-background p-2.5 transition-colors focus-within:border-primary/50">
          {pasted.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {pasted.map((block) => (
                <span
                  key={block.id}
                  className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                  title={`${block.text.slice(0, 200)}${block.text.length > 200 ? '…' : ''}（发送时原文一并送出）`}
                >
                  <Paperclip className="size-3 shrink-0" />
                  <span className="truncate">{pasteLabel(block.text)}</span>
                  <button
                    type="button"
                    onClick={() => setPasted((blocks) => blocks.filter((b) => b.id !== block.id))}
                    aria-label="移除这段粘贴内容"
                    title="移除（原文就不会发送了）"
                    className="shrink-0 rounded p-0.5 transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => onType(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={ghost}
            placeholder={placeholder}
            aria-label="提示词"
            className="max-h-[240px] min-h-[64px] resize-none overflow-y-auto border-0 bg-transparent px-1 py-0.5 text-sm shadow-none focus-visible:ring-0"
          />

          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="truncate text-[11px] text-muted-foreground">
              {mock ? `MOCK 回放 · ${hint}` : hint}
            </span>

            {streaming ? (
              <Button
                size="icon"
                variant="outline"
                onClick={onStop}
                disabled={cancelling}
                className="size-7 shrink-0 rounded-lg"
                title={
                  cancelling
                    ? '取消请求已发出，正在等 cancelled 终态…'
                    : '取消服务端的这一轮：流会以 cancelled 终态结束（Esc 同效）'
                }
              >
                <Square className="size-3.5" />
                <span className="sr-only">{cancelling ? '取消中' : '取消本轮'}</span>
              </Button>
            ) : (
              <Button
                size="icon"
                onClick={submit}
                disabled={!canSend}
                className={cn('size-7 shrink-0 rounded-lg', canSend && 'shadow-sm')}
                title={canSend ? '发送（Enter；带修饰键的 Enter 是换行）' : placeholder}
              >
                <Send className="size-3.5" />
                <span className="sr-only">发送</span>
              </Button>
            )}
          </div>

          {blockedNote !== undefined && (
            <p role="status" className="mt-1.5 text-[11px] leading-relaxed text-warning">
              {blockedNote}
            </p>
          )}
        </div>

        {streaming && <StreamingNote cancelling={cancelling} />}
      </div>
    </div>
  );
}

/**
 * 收流期间的那行说明。
 *
 * 【LIVE 09-18】停止按钮现在会真取消：文案如实说"发取消请求、以 cancelled
 * 终态收场"，并把空闲 no-op 的口径一并交代。
 */
function StreamingNote({ cancelling }: { cancelling: boolean }): ReactNode {
  return (
    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
      {cancelling
        ? '取消请求已发出，正在等服务端停止这一轮（以 cancelled 终态收场）…'
        : '点停止会向上游发送取消请求：轮次会以 cancelled 终态结束；空闲会话上取消是 no-op。'}
    </p>
  );
}
