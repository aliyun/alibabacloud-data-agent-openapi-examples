import { useState } from 'react';
import { Archive, ArchiveRestore, ArrowDown, Download, Loader2, MessageSquareText } from 'lucide-react';
import { classifyError, stripMarkerInstruction, type ApiError } from '@das/shared';

import { ApiRequestError } from '@/api/client';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Composer, type ComposerAction } from '@/components/chat/Composer';
import { ErrorBanner } from '@/components/chat/ErrorBanner';
import { InteractionCard } from '@/components/chat/InteractionCard';
import { ProbeAction } from '@/components/chat/ProbeAction';
import { TurnView } from '@/components/chat/TurnView';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAutoScroll } from '@/hooks/useAutoScroll';
import { useHealth } from '@/hooks/useHealth';
import { useSessionHistory } from '@/hooks/useSessionHistory';
import { useCreateSession, useSessions } from '@/hooks/useSessions';
import { buildExportHtml, downloadHtml, exportFilename, type ExportableTurn } from '@/lib/exportHtml';
import { formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useSelectedSession } from '@/state/session';
import { sessionMetaStore, useSessionMeta } from '@/state/sessionMeta';
import { toastStore } from '@/state/toast';
import { inflightStore, useInflight, type InflightRecord } from '@/state/inflight';
import { turnStore } from '@/state/turnStore';
import { useTurnStream } from '@/state/useTurnStream';

/**
 * 中栏：对话面板 + 输入框。
 *
 * 时间线由两部分拼成：已结束的历史轮次（来自 load 接口，react-query 管）与在途轮次
 * （来自流式接口，turnStore 管）。两者的事实源不同——服务端 SessionStatus 恒为
 * RELEASED、SessionUpdatedAt 恒等于 SessionCreatedAt（实测 29/29），所以
 * "这一轮跑完没有"只能信前端自己收到的流，不能去问服务端。
 */
export function ChatPanel() {
  const sessionId = useSelectedSession();
  const { data: health } = useHealth();
  const { data: sessionsData } = useSessions();
  const history = useSessionHistory(sessionId);
  const turn = useTurnStream();
  const persistedInflight = useInflight();
  const createSession = useCreateSession();
  /** 自动新建会话失败时的错误。放在这里而不是 turnStore：这一轮压根没开始。 */
  const [createError, setCreateError] = useState<ApiError | undefined>(undefined);

  const mock = health?.mock === true;
  const summary = sessionsData?.sessions.find((s) => s.sessionId === sessionId);
  const inflightHere = turn.sessionId === sessionId && turn.phase !== 'idle';
  const ghost = inflightHere && turn.phase === 'ghost';
  /**
   * 本地有在途标记，但这个页面并没有在收流：收流的那一方已经不在了
   * （刷新、关标签页、或另一个标签页在跑）。此时前端无法再接上那条流，
   * 能做的只有拉历史——所以要说清楚，不能让它看起来像"还在接收中"。
   */
  const orphan =
    !inflightHere && turn.phase === 'idle' && persistedInflight?.sessionId === sessionId
      ? persistedInflight
      : undefined;

  /**
   * 滚动跟随。判据（阈值、何时脱离、何时恢复）全在 `lib/scrollPolicy.ts`，
   * 这里只给它喂"内容变了"的信号。
   */
  const scroll = useAutoScroll([
    turn.messageText,
    turn.frameCount,
    turn.tools.length,
    turn.phase,
    history.data,
  ]);

  /**
   * 历史轮次里可能包含**在途这一轮**：本轮结束后拉一次历史，load 就把它也还原出来了，
   * 两边同 rid ⇒ 界面上出现两段一模一样的内容。留 in-flight 那一份（它带着 phase、
   * marker 校验、流式光标，这些是 load 还原不出来的），把历史里的同 rid 轮次滤掉。
   */
  const historyTurns = (history.data?.turns ?? []).filter(
    (t) => !(inflightHere && turn.rid !== undefined && t.rid === turn.rid),
  );

  /**
   * 会话存在、历史也拉回来了，但一轮都没有。
   *
   * 必须是 `isSuccess` 而不是 `!isPending`：拉取失败时 turns 也是空的，
   * 那时候该显示的是错误横幅，不是"这个会话很干净"。
   */
  const noTurns = history.isSuccess && historyTurns.length === 0 && !inflightHere;

  const meta = useSessionMeta();
  const alias = sessionId === undefined ? undefined : meta[sessionId]?.alias;
  const archived = sessionId !== undefined && meta[sessionId]?.archived === true;
  /** 本地别名优先：改过名的会话，标题栏与列表要显示同一个名字。 */
  const heading = alias ?? (summary ? stripMarkerInstruction(summary.title) : (sessionId ?? '未选择会话'));

  /** 任何会话在收流。在途锁是进程级的，所以新建会话在这期间也不该给。 */
  const busy = turn.phase === 'streaming';

  /**
   * 导出当前会话。
   *
   * 只导**已经加载进来的**轮次（历史 + 在途），不为导出再去 load 一次：
   * LIVE 下 RUNNING 期调 load 实测约一半概率阻塞到那一轮跑完（178s），
   * 为了存个档把界面挂住三分钟不值得。所以导出件的范围就是屏幕上看得到的范围，
   * toast 里也照实报轮数。
   */
  function exportSession(): void {
    if (sessionId === undefined) return;
    const turns: ExportableTurn[] = inflightHere ? [...historyTurns, turn] : historyTurns;
    const at = Date.now();
    downloadHtml(
      exportFilename(sessionId, at),
      buildExportHtml({ sessionId, title: heading, turns, exportedAt: at, mock }),
    );
    toastStore.push(
      turns.length === 0 ? '已导出，但这个会话没有可导出的轮次' : `已导出 ${turns.length} 轮到 HTML 文件`,
      turns.length === 0 ? 'warning' : 'info',
    );
  }

  /**
   * 输入框上方的快捷动作。按当前处境给，不给用不上的：
   * 没选中会话或会话已幽灵化时，唯一有意义的动作是新建一个；选中了就给「拉取历史」。
   * 导出与归档在标题栏（它们作用于"正在看的这个会话"，放输入框上方会被理解成作用于这一轮）。
   */
  const composerActions: ComposerAction[] = [];
  if (sessionId === undefined || ghost) {
    if (!busy && !createSession.isPending) {
      composerActions.push({
        id: 'new-session',
        label: '新建会话',
        title: '新建一个会话并选中它；输入框里已经写好的内容不会丢',
        onClick: () =>
          createSession.mutate({
            title: `样板工程会话 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
          }),
      });
    }
  } else {
    composerActions.push({
      id: 'refetch-history',
      label: '拉取历史',
      title: '重新 load 这个会话的历史（服务端在那一轮 RUNNING 期间可能长时间不返回）',
      onClick: () => void history.refetch(),
    });
  }

  /**
   * 发送入口。未选中会话时先建一个会话再发——这样打开页面就能直接打字，
   * 不必先去左栏点「新建」。建会话成功后 useCreateSession 会自动选中它。
   * prompt 就是用户原文：归属校验码由服务端在 routes/prompt.ts 里注入，
   * 前端不掺和，避免"注入的内容和真正发出去的东西隔一层网络"。
   *
   * 建会话失败必须**抛回去**：Composer 靠它决定要不要保留草稿（见 submit）。
   * 错误内容另存一份用于渲染横幅——LIVE 下最常见的失败是 `create_empty_body`，
   * 那种情况界面上如果不说，用户只会看到"点了发送什么都没发生"。
   */
  async function handleSend(text: string): Promise<void> {
    setCreateError(undefined);
    let sid = sessionId;
    if (sid === undefined) {
      try {
        const created = await createSession.mutateAsync({
          title: `样板工程会话 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        });
        sid = created.sessionId;
      } catch (err) {
        setCreateError(toApiError(err, '新建会话失败'));
        throw err;
      }
    }
    // 刻意不在这里 refetch 历史：新一轮刚开始就去 load，真实模式下正好撞上
    // RUNNING 期的阻塞（实测约一半概率挂到那一轮跑完，178s）。
    // 在途轮次由 turnStore 渲染，不依赖历史。
    //
    // 发送时强制恢复跟随（规则 5）：用户可能正翻在上面看旧轮次，而他刚发的这句话
    // 必须出现在视野里——否则界面看起来像"点了发送什么都没发生"。
    scroll.pinToBottom();
    turnStore.start(sid, text.trim());
  }

  return (
    <div id="chat" tabIndex={-1} className="flex h-full min-h-0 min-w-0 flex-col bg-background focus:outline-none">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <h1 className="truncate text-sm font-semibold">{heading}</h1>
        <span role="status" aria-live="polite" className="flex min-w-0 items-center gap-2">
          {inflightHere && turn.phase === 'streaming' && (
            <Badge variant="secondary" className="gap-1 font-normal">
              <Loader2 className="size-3 animate-spin" />
              接收中
            </Badge>
          )}
          {turn.stalled && inflightHere && turn.phase === 'streaming' && (
            <Badge variant="warning" className="font-normal">
              超过 45 秒没有收到任何事件
            </Badge>
          )}
        </span>

        <div className="ml-auto flex items-center gap-1">
          {summary?.mockScenario && (
            <span
              className="hidden max-w-[20rem] truncate text-[11px] text-muted-foreground lg:inline"
              title={summary.mockScenario}
            >
              {summary.mockScenario}
            </span>
          )}
          {sessionId !== undefined && (
            <>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 shrink-0 text-muted-foreground"
                onClick={() => sessionMetaStore.toggleArchived(sessionId)}
                aria-label={archived ? '取消归档' : '归档'}
                title={
                  archived
                    ? '取消归档（放回会话列表）'
                    : '归档：本地标记，会话仍在列表底部的「已归档」分组里，上游不受影响'
                }
              >
                {archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 shrink-0 text-muted-foreground"
                onClick={exportSession}
                aria-label="导出为单文件 HTML"
                title="把已加载的轮次导出成一个不含脚本的 HTML 文件（思考过程与工具结果一律展开）"
              >
                <Download className="size-3.5" />
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scroll.ref} className="h-full overflow-y-auto px-4 py-6">
          {/**
           * 只有空态才切成 flex 列：`min-h-full` 让容器撑满滚动区，WelcomeHead 用 `flex-1` 居中。
           * 有轮次时保持块级 —— flex item 的 `min-width:auto` 会让宽代码块把这一列撑宽，
           * 给消息区引出一条本不该有的横向滚动条。
           */}
          <div
            className={cn(
              'mx-auto max-w-3xl space-y-6',
              sessionId === undefined && 'flex min-h-full flex-col',
            )}
          >
            {createError && <ErrorBanner error={createError} />}

            {sessionId === undefined ? (
              <WelcomeHead />
            ) : (
              <>
                {history.isPending && <HistorySkeleton />}

                {history.isError && <ErrorBanner error={toApiError(history.error, '拉取历史失败')} />}

                {noTurns && <NoTurnsNotice totalFrames={history.data?.totalFrames ?? 0} />}

                {orphan && (
                  <OrphanInflightNotice
                    record={orphan}
                    onTakeover={() => {
                      void history.refetch();
                      inflightStore.clear();
                    }}
                  />
                )}

                {historyTurns.map((t, i) => (
                  <div key={t.rid ?? i} className="space-y-2">
                    {t.error && <ErrorBanner error={classifyError(t.error)} />}
                    {/**
                      * 一轮一个边界：上游某条回答里有一段畸形内容时，坏的只是那一轮，
                      * 同会话的其他轮次必须继续可读。
                      *
                      * resetKeys 刻意只用 rid，不带 frameCount / messageText 这类每帧都变的量：
                      * 确定性崩溃（同一段内容每次都抛）在那种键下会变成"每帧自动重试一次"
                      * 的热循环，界面闪个不停还刷满控制台。留给用户点「重试」。
                      */}
                    <ErrorBoundary label="这一轮" variant="inline" resetKeys={[t.rid]}>
                      <TurnView
                        rid={t.rid}
                        userText={t.userText}
                        thoughtText={t.thoughtText}
                        messageText={t.messageText}
                        tools={t.tools}
                        frameCount={t.frameCount}
                        stopReason={t.stopReason}
                        rawStopReason={t.rawStopReason}
                        tokenUsage={t.tokenUsage}
                        contextUsage={t.contextUsage}
                        unrecognizedUpdates={t.unrecognizedUpdates}
                        firstTimestamp={t.firstTimestamp}
                        lastTimestamp={t.lastTimestamp}
                        queuedNotices={t.queuedNotices}
                      />
                    </ErrorBoundary>
                    {!t.terminated && (
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        这一轮在上游没有终态记录（可能已被取消——cancelled 终态目前不落历史，
                        属上游已知缺口）。内容以上方实际收到的为准，不代表它还在执行。
                      </p>
                    )}
                  </div>
                ))}

                {inflightHere && (
                  <div className="space-y-2">
                    {turn.phase === 'cancelled' && (
                      <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                        已取消——服务端已停止执行这一轮（流以 cancelled 终态收场）。
                        注意：cancelled 终态目前不落历史，稍后拉取历史时这一轮会显示为无终态。
                      </div>
                    )}

                    {turn.phase === 'abandoned' && (
                      <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                        取消请求未能送达，已退回为仅停止本地接收；服务端那一轮可能仍在执行，
                        结果可以在稍后拉取历史时看到。
                      </div>
                    )}

                    {turn.error && (
                      <ErrorBanner
                        error={turn.error}
                        actions={
                          turn.phase === 'break_recovering' && sessionId !== undefined ? (
                            <ProbeAction
                              sessionId={sessionId}
                              rid={turn.rid}
                              baselineTokens={turn.tokenUsage?.totalTokens}
                              deadlineSince={turn.brokeAt ?? turn.startedAt}
                              onTakeover={() => {
                                void history.refetch();
                                turnStore.clear();
                              }}
                            />
                          ) : turn.phase === 'ghost' ? (
                            <span className="text-[11px] opacity-80">唯一可行的动作是在左栏新建一个会话。</span>
                          ) : turn.error.kind === 'prompt_not_dispatched' ? (
                            /**
                             * 刻意不给探测器：零帧说明这一轮根本没开始执行，
                             * "探测是否完成"在这种处境下是错误指引（探测靠的是该 rid 的帧数与
                             * token 跳变，而这一轮连 rid 都没有——上游只给了一个 POP 回执）。
                             */
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              onClick={() => {
                                void history.refetch();
                                turnStore.clear();
                              }}
                            >
                              拉取历史确认这一轮没留下内容
                            </Button>
                          ) : undefined
                        }
                      />
                    )}

                    {/**
                      * 在途这一轮同样要有自己的边界：流式内容是逐片拼起来的，
                      * 中间态畸形（半截代码围栏、半张图）比历史轮次更容易触发渲染分支的 bug。
                      * resetKeys 带上 phase：它一轮里只变几次，既给了"中途崩了、收尾时再试一次"
                      * 的机会，又不会像每帧都变的键那样把确定性崩溃变成热循环。
                      */}
                    <ErrorBoundary label="这一轮" variant="inline" resetKeys={[turn.rid, turn.phase]}>
                      {/**
                        * 人卡交互卡：agent 在等人（ask_user_question / 工具授权）时出现在
                        * 这一轮的正文之后。回覆走 /reply，原流继续；卡随
                        * permission_resolved 帧自动收起。
                        */}
                      {inflightHere && turn.interaction && (
                        <InteractionCard
                          interaction={turn.interaction}
                          onReply={(payload) => turnStore.replyToInteraction(payload)}
                        />
                      )}
                      <TurnView
                        rid={turn.rid}
                        userText={turn.userText}
                        thoughtText={turn.thoughtText}
                        messageText={turn.messageText}
                        tools={turn.tools}
                        frameCount={turn.frameCount}
                        stopReason={turn.stopReason}
                        rawStopReason={turn.rawStopReason}
                        tokenUsage={turn.tokenUsage}
                        contextUsage={turn.contextUsage}
                        marker={turn.marker}
                        verified={turn.verified}
                        mock={mock}
                        unrecognizedUpdates={turn.unrecognizedUpdates}
                        firstTimestamp={turn.firstTimestamp}
                        lastTimestamp={turn.lastTimestamp}
                        queuedNotices={turn.queuedNotices}
                        streaming={turn.phase === 'streaming'}
                        startedAt={turn.startedAt}
                      />
                    </ErrorBoundary>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {scroll.jumpVisible && (
          <button
            type="button"
            onClick={scroll.jumpToBottom}
            title="回到最新内容，并恢复自动跟随"
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card px-3 py-1 text-[11px] text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowDown className="size-3" />
            回到底部
          </button>
        )}
      </div>

      <Composer
        sessionId={sessionId}
        streaming={inflightHere && (turn.phase === 'streaming' || turn.phase === 'cancelling')}
        cancelling={turn.phase === 'cancelling'}
        busyElsewhere={turn.phase === 'streaming' && turn.sessionId !== sessionId}
        ghost={ghost}
        mock={mock}
        onSend={handleSend}
        onStop={() => turnStore.cancelTurn()}
        actions={composerActions}
      />
    </div>
  );
}

/** react-query 的 error 是 unknown：后端归一化过的那份优先，其余退回按文本分类。 */
function toApiError(err: unknown, fallback: string): ApiError {
  if (err instanceof ApiRequestError) return err.error;
  return classifyError({ message: err instanceof Error ? err.message : fallback });
}

/**
 * 未选中会话时的欢迎头。
 *
 * 刻意不写产品名（顶栏已经有了）、也不给示例提示词：录制件里那几条真实提示词
 * 都带着 E2E 校验码与"只读、不要写操作"这类脚手架约束，摆出来当范例会引导用户
 * 照着写。空态只需要说清一件事——直接打字发送就会自动建会话。
 */
export function WelcomeHead() {
  return (
    // flex-1 跟着父容器的 `min-h-full` 走（见 ChatPanel 的消息区容器），所以永不溢出。
    // 早先写的是 min-h-[60vh]：60vh 是视口相对量，而可用高度只有滚动容器那么高
    // （实测 511×562 视口下 60vh=337px、容器只有 265px），必然溢出，
    // 溢出后 useAutoScroll 还会把这个空态滚到底部——居中也白居。
    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <MessageSquareText className="size-6 text-muted-foreground" />
      <p className="mt-3 text-sm text-muted-foreground">
        在下面的输入框写下任务，回车发送 —— 会自动新建一个会话。
      </p>
    </div>
  );
}

/**
 * 会话存在、历史也拉回来了，但一轮都没有。
 *
 * 分成两种情况说，因为它们的原因完全不同：
 *  · `totalFrames === 0` —— 真的什么都没发过；
 *  · `totalFrames > 0` —— 有帧，但没有一条 `user_message_chunk` 回显，
 *    而"至少一条提示词回显"正是 shared reducer 认定的轮次判据（见 reduceHistory）。
 *    这就是 prompt 被上游以 HTTP 200 收下、却从未派发给执行端时，历史里留下的形状
 *    （实测：只有一个 config_option_update 加一个 Result.stopReason=end_turn 的空轮次）。
 *    这种情况如果只显示"还没有轮次"，用户会以为自己没发出去过。
 */
export function NoTurnsNotice({ totalFrames }: { totalFrames: number }) {
  return (
    <div className="py-12 text-center">
      <p className="text-sm text-muted-foreground">
        {totalFrames === 0
          ? '这个会话还没有任何轮次。在下面的输入框写下任务，回车发送。'
          : `历史里有 ${totalFrames} 帧，但没有一帧是提示词回显 —— 它们不构成轮次，所以这里什么都不渲染。`}
      </p>
      {totalFrames > 0 && (
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
          别照着原文重发一遍：先确认这一轮到底有没有在服务端跑起来。
        </p>
      )}
    </div>
  );
}

/**
 * 本地在途标记的孤儿态。
 *
 * 用琥珀色而不是红色：与断流同级——任务可能还在服务端跑，不是失败。
 * 措辞上刻意不说"正在接收"，因为这个页面确实没在收；也不给"重发"，
 * 因为在确认那一轮结束之前重发就是把同一个写操作执行两遍。
 */
function OrphanInflightNotice({ record, onTakeover }: { record: InflightRecord; onTakeover: () => void }) {
  const phaseText =
    record.phase === 'streaming'
      ? '正在接收流'
      : record.phase === 'break_recovering'
        ? '回复通道已中断'
        : '已停止接收';

  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-foreground">
      <p className="text-sm font-semibold text-warning">这个会话上有一轮可能在服务端执行</p>
      <p className="mt-1">
        本地在途标记：{formatTime(record.startedAt)} 开始，标记时的状态是「{phaseText}」
        {record.rid ? `，rid=${record.rid}` : '（还没收到第一帧，没有 rid）'}。
      </p>
      <p className="mt-1">
        但当前页面并没有在收它的流——收流的那一方（刷新前的页面，或另一个标签页）已经不在了。
        这条流也接不回来：BeginLogOffset 实测是死参数，服务端没有增量续传能力。
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onTakeover}>
          拉取历史看结果
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => inflightStore.clear()}>
          清除这条本地标记
        </Button>
      </div>
      <p className="mt-1.5 opacity-80">在确认那一轮结束之前不要重发：重发会把同一个写操作执行两遍。</p>
    </div>
  );
}

/**
 * 拉取历史时的骨架屏。
 *
 * 形状照真实一轮画（右侧一条短圆角块＝用户气泡，左侧三条长条＝回答正文），
 * 而不是一个转圈图标：占位形状让"内容会出现在哪、大约多高"先确定下来，
 * 历史一到就不会因为高度突变把滚动位置顶走。
 *
 * 读屏这块要分两层：骨架是纯装饰，整块 `aria-hidden`；状态文案单独一条
 * `role="status"`，而且必须挂在 `aria-hidden` 容器**外面**——写进去读屏就读不到了。
 */
function HistorySkeleton() {
  return (
    <div className="space-y-3">
      <p className="sr-only" role="status">
        正在拉取会话历史…
      </p>
      <div aria-hidden className="space-y-3">
        <div className="flex justify-end">
          <div className="skeleton h-9 w-2/5 rounded-2xl rounded-br-md" />
        </div>
        <div className="space-y-2">
          <div className="skeleton h-4 w-11/12 rounded" />
          <div className="skeleton h-4 w-4/5 rounded" />
          <div className="skeleton h-4 w-2/3 rounded" />
        </div>
      </div>
    </div>
  );
}
