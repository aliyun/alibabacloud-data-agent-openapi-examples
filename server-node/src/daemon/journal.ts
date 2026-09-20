import type { DaemonEvent } from './events.js';

export interface JournalEntry {
  id: number;
  event: DaemonEvent;
}

/**
 * 内存上限。一轮长轮实测 1201 帧，20k 条大约等于十几个长轮；daemon 真身用
 * 环形缓冲 + resync，我们先把上限放大到"单进程演示用不完"的量级，
 * 触顶时丢弃最旧事件（见 compact 的注释）。
 */
const MAX_EVENTS = 20_000;

/**
 * 单会话事件日志：daemon 模型（202 异步 prompt + SSE + Last-Event-ID 续传）的服务端事实源。
 *
 * 与现行 `/api/sessions/:id/prompt`（把上游流直连到客户端连接）的本质区别：
 * 事件先进 journal，再由 SSE 分发——浏览器断线重连时从游标续播，而服务端对上游
 * 那一轮的消费（runner）不受任何客户端连接存亡影响。这正是选这套协议的动机：
 * 对抗上游 218~258s 断流墙时，"连接断了"与"轮次丢了"第一次解耦。
 */
export class SessionJournal {
  private entries: JournalEntry[] = [];
  private nextId = 1;
  /**
   * 历史种子（load 回放）与之后 live 轮次的分界。load 响应把种子放 `compactedReplay`、
   * 之后的放 `liveJournal`，语义对齐真 daemon（provider 按序重放两段）。
   */
  private seedCount = 0;
  private waiters = new Set<() => void>();

  /** 有执行中的轮次（在途锁的另一面视图，供会话列表的 hasActivePrompt 用）。 */
  activePrompt = false;
  /** 执行中轮次的 promptId（cancel 路由发 prompt_cancelled 事件要用）。 */
  activePromptId: string | undefined;

  append(event: DaemonEvent): JournalEntry {
    const id = this.nextId;
    this.nextId += 1;
    const entry: JournalEntry = { id, event: { ...event, id } };
    this.entries.push(entry);
    this.compact();
    this.notify();
    return entry;
  }

  /**
   * 用历史帧翻译出的事件做种子。只在 journal 为空时执行——第二次 load 幂等返回
   * 同一份日志（种子 + 期间发生的 live 轮次），不会把历史重复灌一遍。
   */
  seed(events: DaemonEvent[]): void {
    if (this.entries.length > 0) return;
    for (const event of events) this.append(event);
    this.seedCount = this.entries.length;
  }

  /** id 严格大于 lastId 的事件（保持顺序）。lastId<=0 视为从头。 */
  since(lastId: number): JournalEntry[] {
    if (lastId <= 0) return [...this.entries];
    return this.entries.filter((entry) => entry.id > lastId);
  }

  /** 历史种子段（load 响应的 compactedReplay）。 */
  compacted(): JournalEntry[] {
    return this.entries.slice(0, this.seedCount);
  }

  /** 种子之后的 live 段（load 响应的 liveJournal）。 */
  live(): JournalEntry[] {
    return this.entries.slice(this.seedCount);
  }

  all(): JournalEntry[] {
    return [...this.entries];
  }

  lastId(): number {
    const last = this.entries[this.entries.length - 1];
    return last !== undefined ? last.id : 0;
  }

  firstId(): number {
    const first = this.entries[0];
    return first !== undefined ? first.id : 0;
  }

  /**
   * 等待 id 大于 sinceId 的新事件；waitMs 内没有就返回空数组（SSE 心跳节拍由调用方决定）。
   *
   * 先查再挂 waiter，append 侧 notify 唤醒——两侧都不持锁，不存在"事件到了但没被唤醒"。
   */
  waitForMore(sinceId: number, waitMs: number): Promise<JournalEntry[]> {
    const existing = this.since(sinceId);
    if (existing.length > 0) return Promise.resolve(existing);
    return new Promise<JournalEntry[]>((resolve) => {
      let settled = false;
      const finish = (result: JournalEntry[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(result);
      };
      const timer = setTimeout(() => finish([]), waitMs);
      const wake = (): void => finish(this.since(sinceId));
      this.waiters.add(wake);
    });
  }

  /**
   * 触顶丢弃最旧事件。丢弃意味着某些旧游标续传时会出现空洞——调用方（SSE 路由）
   * 检测到 `firstId > lastEventId + 1` 时只 warn 并从现存最旧事件续播：
   * 真身 daemon 在这里是强制 resync，v1 先选"尽力续播"，丢段比整个会话打不开轻。
   */
  private compact(): void {
    if (this.entries.length <= MAX_EVENTS) return;
    const drop = this.entries.length - MAX_EVENTS;
    this.entries.splice(0, drop);
    this.seedCount = Math.max(0, this.seedCount - drop);
  }

  private notify(): void {
    const wakeups = [...this.waiters];
    this.waiters.clear();
    for (const wake of wakeups) wake();
  }
}
