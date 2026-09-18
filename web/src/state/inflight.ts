import { useSyncExternalStore } from 'react';

/**
 * 在途标记的本地持久化。
 *
 * 存在的理由：运行态问不出服务端（SessionStatus 恒为 RELEASED），事实源是前端自己
 * 收到的流；而流只活在写它的那个内存里。刷新页面或换个标签页，"这一轮还在跑"这个
 * 事实就凭空消失了——用户接着就会重发，而重发等于把同一个写操作执行两遍。
 *
 * 所以这里只落**标量**：sessionId / rid / phase / startedAt。
 *
 * **刻意不存 offset / 帧序号**：BeginLogOffset 是死参数，服务端没有增量续传，
 * 而且空闲约 5 分钟后计数器会重置；存一个旧的大 offset 再拿去续传，只会把新帧
 * 全部过滤掉，看起来像"什么都没发生"。存了也用不上，用上了就是错的。
 *
 * 这条记录**不是权威**，只是提醒：写下它的标签页才是真正收流的那一方。别的标签页
 * 或刷新之后读到它，能说的最多是"这一轮可能在途"，不能说"正在接收"。
 */
export type InflightPhase = 'streaming' | 'break_recovering' | 'abandoned';

export interface InflightRecord {
  sessionId: string;
  rid: string | undefined;
  phase: InflightPhase;
  startedAt: number;
}

const STORAGE_KEY = 'das.inflight.v1';

/**
 * 超过这个时长就当残留清掉。
 *
 * 取 10 分钟：后端对流有 330s 硬上限，实测最长一轮 191s；正常路径下记录早该被
 * done / clear 覆盖掉了，还留着的只可能是浏览器崩了或标签页被强杀。
 */
const STALE_MS = 600_000;

let current: InflightRecord | undefined = read();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function read(): InflightRecord | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // 隐私模式 / 配额满：读不到就算了，在途标记不是功能正确性的前提
    return undefined;
  }
  if (!raw) return undefined;

  const record = parse(raw);
  if (!record) {
    discard();
    return undefined;
  }
  if (Date.now() - record.startedAt > STALE_MS) {
    discard();
    return undefined;
  }
  return record;
}

function parse(raw: string): InflightRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId === '') return undefined;
  if (!isInflightPhase(candidate.phase)) return undefined;
  if (typeof candidate.startedAt !== 'number' || !Number.isFinite(candidate.startedAt)) return undefined;
  return {
    sessionId: candidate.sessionId,
    rid: typeof candidate.rid === 'string' && candidate.rid !== '' ? candidate.rid : undefined,
    phase: candidate.phase,
    startedAt: candidate.startedAt,
  };
}

function isInflightPhase(value: unknown): value is InflightPhase {
  return value === 'streaming' || value === 'break_recovering' || value === 'abandoned';
}

/** turnStore 的七态里只有这三种意味着"服务端可能还在跑"。 */
export function persists(phase: string): phase is InflightPhase {
  return isInflightPhase(phase);
}

function discard(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上，删不掉也不影响
  }
}

export const inflightStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): InflightRecord | undefined {
    return current;
  },

  write(record: InflightRecord): void {
    current = record;
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
      } catch {
        // 写不进去只影响刷新后的提示，不影响本轮
      }
    }
    emit();
  },

  clear(): void {
    if (current === undefined) {
      discard();
      return;
    }
    current = undefined;
    discard();
    emit();
  },
};

/** 别的标签页改了记录时同步过来。storage 事件不会在写入方自己这里触发。 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    current = event.newValue ? parse(event.newValue) : undefined;
    emit();
  });
}

export function useInflight(): InflightRecord | undefined {
  return useSyncExternalStore(inflightStore.subscribe, inflightStore.getSnapshot, inflightStore.getSnapshot);
}
