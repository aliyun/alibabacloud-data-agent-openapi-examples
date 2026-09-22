import { describe, expect, it } from 'vitest';

import { SessionJournal } from '../src/daemon/journal.js';
import { turnCompleteEvent, sessionUpdateEvent } from '../src/daemon/events.js';

function updateEvent(n: number) {
  return sessionUpdateEvent('s', { sessionUpdate: 'agent_message_chunk', text: `chunk-${n}` });
}

describe('daemon journal', () => {
  it('refreshes a partial history prefix while preserving cursors and live events', () => {
    const journal = new SessionJournal();
    journal.seed([updateEvent(1)]);
    journal.seed([updateEvent(1), updateEvent(2)]);
    expect(journal.since(1).map(e => e.id)).toEqual([2]);
    journal.seed([updateEvent(1)]);
    journal.seed([updateEvent(1), updateEvent(2)]);
    expect(journal.lastId()).toBe(2);
    journal.activePrompt = true;
    journal.seed([updateEvent(1), updateEvent(2), updateEvent(3)]);
    expect(journal.lastId()).toBe(2);
    journal.activePrompt = false;
    journal.seed([updateEvent(9), updateEvent(2), updateEvent(3)]);
    expect(journal.lastId()).toBe(2);
    journal.append(updateEvent(3));
    journal.seed([updateEvent(1), updateEvent(2), updateEvent(3), updateEvent(4)]);
    expect(journal.lastId()).toBe(3);
  });
  it('append 分配单调 id；since 按 id 过滤', () => {
    const journal = new SessionJournal();
    const a = journal.append(updateEvent(1));
    const b = journal.append(updateEvent(2));
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(journal.lastId()).toBe(2);
    expect(journal.since(1).map((e) => e.id)).toEqual([2]);
    expect(journal.since(0).map((e) => e.id)).toEqual([1, 2]);
    expect(journal.since(2)).toEqual([]);
  });

  it('seed 只在空 journal 生效（重复 load 幂等）；compacted/live 按种子边界切分', () => {
    const journal = new SessionJournal();
    journal.seed([updateEvent(1), updateEvent(2), updateEvent(3)]);
    journal.append(updateEvent(4)); // live 轮次
    journal.seed([updateEvent(9)]); // 第二次 load：不能覆盖

    expect(journal.all().map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(journal.compacted().map((e) => e.id)).toEqual([1, 2, 3]);
    expect(journal.live().map((e) => e.id)).toEqual([4]);
  });

  it('waitForMore：有新事件立即返回；超时返回空数组（SSE 心跳节拍）', async () => {
    const journal = new SessionJournal();
    journal.append(updateEvent(1));

    const pending = journal.waitForMore(1, 5_000);
    journal.append(updateEvent(2)); // append 必须唤醒等待者
    const woken = await pending;
    expect(woken.map((e) => e.id)).toEqual([2]);

    const timedOut = await journal.waitForMore(2, 20);
    expect(timedOut).toEqual([]);
  });

  it('事件入 journal 时带上 id（SSE id 行与 data.id 一致）', () => {
    const journal = new SessionJournal();
    const entry = journal.append(turnCompleteEvent('s', 'end_turn', 'p1'));
    expect(entry.event.id).toBe(1);
    expect(entry.event.type).toBe('turn_complete');
    expect(entry.event.data).toEqual({ sessionId: 's', stopReason: 'end_turn', promptId: 'p1' });
  });
});
