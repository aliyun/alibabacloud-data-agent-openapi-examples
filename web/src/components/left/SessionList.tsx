import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { ArchiveRestore, EyeOff, Loader2, Pencil, Pin, PinOff, Plus } from 'lucide-react';
import { stripMarkerInstruction, transportError } from '@das/shared';

import { ErrorBanner } from '@/components/chat/ErrorBanner';
import { PanelHeader, Rail } from '@/components/layout/Rail';
import { SessionRenameInput } from '@/components/left/SessionRenameInput';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiRequestError } from '@/api/client';
import { SESSION_FILTER_ID } from '@/hooks/useGlobalShortcuts';
import { useNow } from '@/hooks/useNow';
import { useCreateSession, useSessions } from '@/hooks/useSessions';
import { formatRelative, formatTime } from '@/lib/format';
import { groupSessions } from '@/lib/sessionGroups';
import { cn } from '@/lib/utils';
import { sessionStore, useSelectedSession } from '@/state/session';
import { sessionMetaStore, useSessionMeta } from '@/state/sessionMeta';
import { useInflight } from '@/state/inflight';
import { layoutStore, useLayout } from '@/state/layout';
import { useTurnStream } from '@/state/useTurnStream';

export interface SessionListProps {
  /**
   * `dock` = 常驻栅格列（自己画标题行与收起后的竖条）；
   * `drawer` = 窄屏抽屉里（标题行与关闭按钮由 Drawer 画，这里不再重复一遍）。
   */
  variant?: 'dock' | 'drawer';
  /** 选中会话后回调，窄屏用来顺手关掉抽屉。 */
  onPick?: () => void;
}

/** 相对时间的刷新心跳。粒度是分钟，30s 一次就够——快了只是白重渲染。 */
const CLOCK_TICK_MS = 30_000;

/**
 * 本地别名的长度上限。
 *
 * 别名存在 localStorage 里（上游没有重命名接口），不设上限就是让一个输入框
 * 无界地写本地存储。256 字远超任何有意义的会话名，而列表行本身只显示一行、
 * 超出就截断，所以这个上限不会挡掉任何正常用法。
 */
const ALIAS_MAX_CHARS = 256;

/**
 * 左栏：会话列表。
 *
 * 搜索是纯前端的 includes 过滤。这不是偷懒——ListAgentSessions 的 SessionTitle
 * 过滤器实测被服务端静默忽略（传了不报错，也不生效），所以标题搜索只能在前端做。
 * 后端也因此不提供 q 参数，避免造出一个"看起来能用其实没用"的接口。
 *
 * 列表本身已经被后端按 SessionSource 过滤过：别的来源（比如你在 DataWorks 界面上
 * 建的会话）不会出现在这里。这一点刻意**不在界面上解释**——过滤条件是部署期配置，
 * 不是每轮都要读的运行信息，写在 README 的「谁是事实源」一节里。
 *
 * 别名 / 置顶 / 归档 / 隐藏全部是**本地**的（见 state/sessionMeta.ts）：
 * 上游没有重命名、分组、删除会话的接口，所以这些标记一个字节都不发出去，
 * 换浏览器就没了。界面上也不假装它们是会话属性——改名后悬停能看到上游原标题。
 */
export function SessionList({ variant = 'dock', onPick }: SessionListProps) {
  const { leftCollapsed } = useLayout();
  const [query, setQuery] = useState('');
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
  const sessions = useSessions();
  const create = useCreateSession();
  const selected = useSelectedSession();
  const meta = useSessionMeta();
  const turn = useTurnStream();
  const persisted = useInflight();
  const now = useNow(CLOCK_TICK_MS);
  const listRef = useRef<HTMLDivElement>(null);

  const inDrawer = variant === 'drawer';

  /**
   * ↑/↓ 在会话之间移动焦点。
   *
   * 用 DOM 顺序而不是自己维护一份索引：可见的行分散在两个 `<ul>` 里
   * （主列表 + 展开的归档区），而且过滤关键词一变整份顺序就重排，
   * 自己存索引就必须跟着这两件事同步——`querySelectorAll` 拿到的天然就是视觉顺序。
   *
   * 刻意**不绕回**首尾：从最后一条按 ↓ 跳回第一条，会让人以为列表只有这几条。
   */
  function onRowKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const container = listRef.current;
    if (container === null) return;
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-session-row]'));
    const index = rows.indexOf(e.currentTarget);
    if (index === -1) return;
    const target = rows[e.key === 'ArrowDown' ? index + 1 : index - 1];
    if (target === undefined) return;
    e.preventDefault();
    target.focus();
  }

  if (!inDrawer && leftCollapsed) {
    return <Rail side="left" label="会话" onExpand={layoutStore.toggleLeft} />;
  }

  const busy = turn.phase === 'streaming';
  const list = sessions.data?.sessions ?? [];
  const keyword = query.trim().toLowerCase();
  /** 过滤同时看上游标题与本地别名：改了名还按原标题搜，等于改名把会话藏起来了。 */
  const matched = keyword
    ? list.filter((s) => {
        const title = meta[s.sessionId]?.alias ?? stripMarkerInstruction(s.title);
        return title.toLowerCase().includes(keyword);
      })
    : list;
  const groups = groupSessions(matched, (s) => meta[s.sessionId]);
  const archivedCount = groups.archived.length;

  const newButton = (
    <Button
      size="sm"
      variant="ghost"
      className="h-8 shrink-0 gap-1 px-2 text-xs"
      disabled={busy || create.isPending}
      title={busy ? '有一轮正在接收中：同一进程同时只跑一轮' : '新建会话'}
      onClick={() =>
        create.mutate({ title: `样板工程会话 ${new Date().toLocaleString('zh-CN', { hour12: false })}` })
      }
    >
      {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
      新建
    </Button>
  );

  const row = (s: (typeof list)[number], archived: boolean): ReactNode => (
    <SessionRow
      key={s.sessionId}
      sessionId={s.sessionId}
      title={stripMarkerInstruction(s.title)}
      alias={meta[s.sessionId]?.alias}
      pinned={meta[s.sessionId]?.pinned === true}
      archived={archived}
      createdAt={s.createdAt}
      now={now}
      mockScenario={s.mockScenario}
      selected={selected === s.sessionId}
      running={busy && turn.sessionId === s.sessionId}
      maybeRunning={!(busy && turn.sessionId === s.sessionId) && persisted?.sessionId === s.sessionId}
      dead={turn.phase === 'ghost' && turn.sessionId === s.sessionId}
      renaming={renamingId === s.sessionId}
      dimmed={busy && turn.sessionId !== s.sessionId}
      onRowKeyDown={onRowKeyDown}
      onStartRename={() => setRenamingId(s.sessionId)}
      onEndRename={() => setRenamingId(undefined)}
      onPick={() => {
        sessionStore.select(s.sessionId);
        onPick?.();
      }}
    />
  );

  const empty = sessions.data !== undefined && matched.length === 0;

  return (
    <div className={cn('flex h-full min-h-0 min-w-0 flex-col bg-background', !inDrawer && 'border-r border-border')}>
      {!inDrawer && (
        <PanelHeader side="left" title="会话" onCollapse={layoutStore.toggleLeft}>
          {newButton}
        </PanelHeader>
      )}

      <div className="shrink-0 border-b border-border p-2">
        <div className="flex items-center gap-1">
          <input
            id={SESSION_FILTER_ID}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // 有关键词时 Esc 只清空过滤；空关键词时不拦截，让 Esc 照常冒泡给抽屉/浮层。
              if (e.key === 'Escape' && query !== '') {
                e.preventDefault();
                e.stopPropagation();
                setQuery('');
              }
            }}
            placeholder="按标题过滤（含本地别名）"
            aria-label="按标题过滤会话"
            title="按标题过滤会话（前端本地过滤；快捷键 /，Esc 清空）"
            className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          />
          {inDrawer && newButton}
        </div>
        {keyword !== '' && (
          <p role="status" className="mt-1 px-0.5 text-[10px] text-muted-foreground">
            匹配 {matched.length} / {list.length}
          </p>
        )}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        {sessions.isPending && (
          <p className="flex items-center justify-center gap-1.5 px-1 py-6 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            正在拉取会话列表…
          </p>
        )}

        {sessions.isError && (
          <ErrorBanner
            error={
              sessions.error instanceof ApiRequestError
                ? sessions.error.error
                : transportError(String(sessions.error))
            }
            actions={
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void sessions.refetch()}>
                重试
              </Button>
            }
          />
        )}

        {empty && (
          <p className="px-1 py-6 text-center text-xs leading-relaxed text-muted-foreground">
            {list.length === 0
              ? '还没有会话。点上面的「新建」。'
              : groups.hiddenCount > 0 && groups.pinned.length + groups.normal.length + archivedCount === 0
                ? '这个关键词只匹配到被隐藏的会话。'
                : '没有匹配这个关键词的会话。'}
          </p>
        )}

        <ul className="space-y-1">
          {groups.pinned.map((s) => row(s, false))}
          {groups.normal.map((s) => row(s, false))}
        </ul>

        {sessions.data?.truncated === true && (
          <p className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] leading-relaxed">
            列表没取完：已到后端的分页上限，可能还有会话没显示出来。
          </p>
        )}

        {archivedCount > 0 && (
          <div className="mt-3 border-t border-border pt-2">
            <button
              type="button"
              onClick={() => setArchivedOpen((open) => !open)}
              aria-expanded={archivedOpen}
              className="flex w-full items-center gap-1 rounded px-1 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              title="归档是本地标记：会话还在上游，只是从列表里收起来"
            >
              <span className="font-mono">{archivedOpen ? '▾' : '▸'}</span>
              已归档 {archivedCount}
            </button>
            {archivedOpen && <ul className="mt-1 space-y-1">{groups.archived.map((s) => row(s, true))}</ul>}
          </div>
        )}

        {groups.hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => sessionMetaStore.revealHidden()}
            className="mt-2 w-full rounded px-1 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            title="把本地隐藏过的会话放回列表（不会改动上游）"
          >
            已隐藏 {groups.hiddenCount} 个 · 显示回来
          </button>
        )}
      </div>
    </div>
  );
}

interface SessionRowProps {
  sessionId: string;
  /** 上游 SessionTitle 去掉注入说明之后的样子。 */
  title: string;
  alias: string | undefined;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  now: number;
  mockScenario: string | undefined;
  selected: boolean;
  running: boolean;
  /**
   * 本页面没在收流，但本地留着这个会话的在途标记：刷新前那一轮、或另一个标签页里那一轮。
   * 只能提示"可能"——前端已经拿不到那条流了，而服务端问不出运行态。
   */
  maybeRunning: boolean;
  dead: boolean;
  renaming: boolean;
  /**
   * 有一轮正在收流、而这一行不是那一轮。
   *
   * 压暗是"现在点过去也看不到进度"的视觉表达——同一进程同时只跑一轮，
   * 切过去只会看到一个静止的历史列表，而正在跑的那一轮还在后台收流。
   * 理由写在 title 里，不能只靠变灰让用户自己猜。
   */
  dimmed: boolean;
  onRowKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onStartRename: () => void;
  onEndRename: () => void;
  onPick: () => void;
}

/**
 * 一行会话。
 *
 * 操作按钮**不能嵌在主按钮里**（HTML 不允许 button 套 button，React 也会警告），
 * 所以整行是 div：主按钮负责选中，操作簇用 absolute 叠在右上角，靠 `group-hover` /
 * `focus-within` 显形。`focus-within` 那半是键盘可达性的关键——只用 hover 的话，
 * Tab 进来的人永远看不到这些按钮。主按钮留出 pr-16 给操作簇，避免标题被压住。
 */
function SessionRow(props: SessionRowProps) {
  const { sessionId, title, alias, renaming, onEndRename } = props;
  const display = alias ?? title;

  if (renaming) {
    return (
      <SessionRenameInput
        initial={display}
        maxLength={ALIAS_MAX_CHARS}
        hintId={`${sessionId}-rename-hint`}
        onCommit={(value) => {
          sessionMetaStore.setAlias(sessionId, value);
          onEndRename();
        }}
        onCancel={onEndRename}
      />
    );
  }

  return (
    <li className="group relative">
      <div
        className={cn(
          'rounded-md border transition-colors',
          props.selected ? 'border-primary/40 bg-accent' : 'border-transparent hover:border-border hover:bg-accent/50',
          props.dimmed && 'opacity-70',
        )}
      >
        <button
          type="button"
          data-session-row=""
          onClick={props.onPick}
          onDoubleClick={props.onStartRename}
          onKeyDown={props.onRowKeyDown}
          aria-current={props.selected ? 'page' : undefined}
          className="w-full px-2.5 py-2 pr-16 text-left"
          title={[
            alias !== undefined ? `上游原标题：${title}` : (props.mockScenario ?? sessionId),
            props.dimmed ? '有一轮正在接收中（同一进程同时只跑一轮），切过去看不到它的进度' : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          <span className="flex items-center gap-1.5">
            {props.running && <Loader2 className="size-3 shrink-0 animate-spin text-info" />}
            {props.pinned && !props.running && <Pin className="size-3 shrink-0 text-muted-foreground" />}
            <span className="truncate text-xs font-medium">{display || '（无标题）'}</span>
          </span>
          <span className="mt-1 flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground" title={formatTime(props.createdAt)}>
              {formatRelative(props.createdAt, props.now)}
            </span>
            {props.running && (
              <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
                接收中
              </Badge>
            )}
            {props.maybeRunning && (
              <Badge
                variant="warning"
                className="gap-1 px-1.5 py-0 text-[10px] font-normal"
                title="本地在途标记：可能有一轮仍在服务端执行，而本页面已经拿不到那条流。"
              >
                {/* 脉冲点走 animation，所以 index.css 末尾的 prefers-reduced-motion 块会自动冻住它。 */}
                <span className="pulse-dot" aria-hidden />
                可能在途
              </Badge>
            )}
            {props.dead && (
              <Badge variant="destructive" className="px-1.5 py-0 text-[10px] font-normal">
                已失效
              </Badge>
            )}
          </span>
        </button>

        <div className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {props.archived ? (
            <RowAction
              label="取消归档"
              Icon={ArchiveRestore}
              onClick={() => sessionMetaStore.toggleArchived(sessionId)}
            />
          ) : (
            <RowAction
              label={props.pinned ? '取消置顶' : '置顶'}
              Icon={props.pinned ? PinOff : Pin}
              onClick={() => sessionMetaStore.togglePinned(sessionId)}
            />
          )}
          <RowAction label="重命名（本地）" Icon={Pencil} onClick={props.onStartRename} />
          <RowAction label="从列表隐藏（本地）" Icon={EyeOff} onClick={() => sessionMetaStore.setHidden(sessionId, true)} />
        </div>
      </div>
    </li>
  );
}

interface RowActionProps {
  label: string;
  Icon: typeof Pin;
  onClick: () => void;
}

function RowAction({ label, Icon, onClick }: RowActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded bg-background/80 p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Icon className="size-3" />
    </button>
  );
}
