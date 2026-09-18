import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 两个吃 localStorage 的本地状态：会话元数据（别名/置顶/归档/隐藏）与输入框记忆
 * （按会话的草稿、发过的提示词）。
 *
 * 它们在 node 环境里测：模块加载时就要读一次存储，所以每个用例前 `vi.resetModules()`
 * 再动态 import，配上一个假 localStorage。
 *
 * 重点钉的是**存储不可用或内容被写坏时不能炸**：隐私模式下 localStorage 直接没有，
 * 旧版本或手改过的值形状可能不对。这两种情况下唯一可接受的行为是"偏好丢一次、界面照常"，
 * 而这条路径在浏览器里几乎不可能手动复现。
 */

let memory: Record<string, string>;
let writes: number;

function stubStorage(): void {
  vi.stubGlobal('localStorage', {
    getItem(key: string): string | null {
      const value = memory[key];
      return value === undefined ? null : value;
    },
    setItem(key: string, value: string): void {
      writes += 1;
      memory[key] = String(value);
    },
    removeItem(key: string): void {
      delete memory[key];
    },
    clear(): void {
      memory = {};
    },
    key(index: number): string | null {
      return Object.keys(memory)[index] ?? null;
    },
    get length(): number {
      return Object.keys(memory).length;
    },
  });
}

beforeEach(() => {
  vi.resetModules();
  memory = {};
  writes = 0;
  stubStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function loadMeta() {
  return import('@/state/sessionMeta');
}

async function loadMemory() {
  return import('@/state/composerMemory');
}

describe('sessionMetaStore', () => {
  it('初始是空表，且快照引用稳定（useSyncExternalStore 的硬要求）', async () => {
    const { sessionMetaStore } = await loadMeta();
    expect(sessionMetaStore.getSnapshot()).toEqual({});
    expect(sessionMetaStore.getSnapshot()).toBe(sessionMetaStore.getSnapshot());
  });

  it('改一次就换一次引用，订阅者收到通知', async () => {
    const { sessionMetaStore } = await loadMeta();
    const before = sessionMetaStore.getSnapshot();
    let notified = 0;
    const unsubscribe = sessionMetaStore.subscribe(() => {
      notified += 1;
    });

    sessionMetaStore.setAlias('s1', '  我的会话  ');
    expect(notified).toBe(1);
    expect(sessionMetaStore.getSnapshot()).not.toBe(before);
    // 别名两端空白要去掉：它是显示用的名字，带着空格会在窄栏里挤掉一个字
    expect(sessionMetaStore.getSnapshot().s1?.alias).toBe('我的会话');

    unsubscribe();
    sessionMetaStore.setAlias('s1', '再改一次');
    expect(notified).toBe(1);
    expect(sessionMetaStore.getSnapshot().s1?.alias).toBe('再改一次');
  });

  it('空别名与取消标记会把整条记录删掉，不在存储里留空壳', async () => {
    const { sessionMetaStore } = await loadMeta();
    sessionMetaStore.setAlias('s1', '名字');
    expect(Object.keys(memory)).toHaveLength(1);

    sessionMetaStore.setAlias('s1', '   ');
    expect(sessionMetaStore.getSnapshot()).toEqual({});
    expect(JSON.parse(memory['das.sessionMeta.v1'] ?? '{}')).toEqual({});

    sessionMetaStore.togglePinned('s2');
    expect(sessionMetaStore.getSnapshot().s2?.pinned).toBe(true);
    sessionMetaStore.togglePinned('s2');
    expect(sessionMetaStore.getSnapshot()).toEqual({});
  });

  it('置顶不影响归档标记：两个动作互不覆盖', async () => {
    const { sessionMetaStore } = await loadMeta();
    sessionMetaStore.togglePinned('s1');
    sessionMetaStore.toggleArchived('s1');
    expect(sessionMetaStore.getSnapshot().s1).toEqual({ pinned: true, archived: true });
    sessionMetaStore.toggleArchived('s1');
    expect(sessionMetaStore.getSnapshot().s1).toEqual({ pinned: true });
  });

  it('revealHidden 放回隐藏的会话并报告个数；没有隐藏项时返回 0 且不写盘', async () => {
    const { sessionMetaStore } = await loadMeta();
    expect(sessionMetaStore.revealHidden()).toBe(0);
    expect(writes).toBe(0);

    sessionMetaStore.setHidden('s1', true);
    sessionMetaStore.setAlias('s2', '留着别名');
    sessionMetaStore.setHidden('s2', true);
    const writesBefore = writes;

    expect(sessionMetaStore.revealHidden()).toBe(2);
    expect(writes).toBe(writesBefore + 1);
    const snapshot = sessionMetaStore.getSnapshot();
    // s1 除了 hidden 什么都没有，放回后整条记录该消失；s2 有别名，得留着
    expect(snapshot.s1).toBeUndefined();
    expect(snapshot.s2).toEqual({ alias: '留着别名' });
    expect(sessionMetaStore.revealHidden()).toBe(0);
  });

  it('setHidden(false) 与 revealHidden 是两回事：前者只动一个会话', async () => {
    const { sessionMetaStore } = await loadMeta();
    sessionMetaStore.setHidden('s1', true);
    sessionMetaStore.setHidden('s2', true);
    sessionMetaStore.setHidden('s1', false);
    expect(sessionMetaStore.getSnapshot().s2?.hidden).toBe(true);
    expect(sessionMetaStore.getSnapshot().s1).toBeUndefined();
  });

  it('空 sessionId 被忽略：拿不到 id 时写进去会变成一条永远匹配不上的记录', async () => {
    const { sessionMetaStore } = await loadMeta();
    sessionMetaStore.setAlias('', '没有 id');
    expect(sessionMetaStore.getSnapshot()).toEqual({});
    expect(writes).toBe(0);
  });

  it('存储内容损坏时回落空表，但只丢坏的那条', async () => {
    memory['das.sessionMeta.v1'] = JSON.stringify({
      good: { alias: '还在', pinned: true },
      badNumber: { alias: 123 },
      badArray: [],
      badNull: null,
      ok: {},
    });
    const { sessionMetaStore } = await loadMeta();
    expect(sessionMetaStore.getSnapshot()).toEqual({ good: { alias: '还在', pinned: true }, ok: {} });
  });

  it('整份存储不是对象（或压根不是 JSON）时回落空表，不抛异常', async () => {
    memory['das.sessionMeta.v1'] = '[1,2,3]';
    expect((await loadMeta()).sessionMetaStore.getSnapshot()).toEqual({});

    vi.resetModules();
    memory['das.sessionMeta.v1'] = 'not json at all';
    expect((await loadMeta()).sessionMetaStore.getSnapshot()).toEqual({});
  });

  it('localStorage 不可用时所有操作都是 no-op，界面照常用内存里的状态', async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    const { sessionMetaStore } = await loadMeta();
    expect(sessionMetaStore.getSnapshot()).toEqual({});
    sessionMetaStore.setAlias('s1', '只在内存里');
    expect(sessionMetaStore.getSnapshot().s1?.alias).toBe('只在内存里');
    expect(sessionMetaStore.revealHidden()).toBe(0);
    stubStorage();
  });
});

describe('composerMemory', () => {
  it('草稿按键存取，空串等于删除键', async () => {
    const { NEW_SESSION_DRAFT, getDraft, setDraft } = await loadMemory();
    expect(getDraft('s1')).toBe('');

    setDraft('s1', '打到一半');
    expect(getDraft('s1')).toBe('打到一半');
    expect(getDraft('s2')).toBe('');
    expect(getDraft(NEW_SESSION_DRAFT)).toBe('');

    setDraft('s1', '');
    expect(getDraft('s1')).toBe('');
    expect(JSON.parse(memory['das.drafts.v1'] ?? '{}')).toEqual({});
  });

  it('同一个值重复存不写盘：草稿是每次按键都要存的，白写盘没有意义', async () => {
    const { setDraft } = await loadMemory();
    setDraft('s1', 'abc');
    const afterFirst = writes;
    setDraft('s1', 'abc');
    expect(writes).toBe(afterFirst);
    setDraft('s1', 'abcd');
    expect(writes).toBe(afterFirst + 1);
  });

  it('不存在的键存空串也不写盘', async () => {
    const { setDraft } = await loadMemory();
    setDraft('nope', '');
    expect(writes).toBe(0);
  });

  it('提示词历史最新在前', async () => {
    const { rememberPrompt, sentPrompts } = await loadMemory();
    rememberPrompt('第一句');
    rememberPrompt('第二句');
    expect(sentPrompts()).toEqual(['第二句', '第一句']);
  });

  it('重复发同一句是挪到最前，不是丢弃也不是堆两条', async () => {
    const { rememberPrompt, sentPrompts } = await loadMemory();
    rememberPrompt('a');
    rememberPrompt('b');
    rememberPrompt('a');
    expect(sentPrompts()).toEqual(['a', 'b']);
  });

  it('超过上限截断，留下的是最近的 20 条', async () => {
    const { MAX_SENT_PROMPTS, rememberPrompt, sentPrompts } = await loadMemory();
    expect(MAX_SENT_PROMPTS).toBe(20);
    for (let i = 0; i < 25; i += 1) rememberPrompt(`第 ${i} 句`);
    const sent = sentPrompts();
    expect(sent).toHaveLength(20);
    expect(sent[0]).toBe('第 24 句');
    expect(sent[19]).toBe('第 5 句');
  });

  it('空白提示词不记：发送失败或只按了空格都会走到这里', async () => {
    const { rememberPrompt, sentPrompts } = await loadMemory();
    rememberPrompt('   ');
    rememberPrompt('');
    expect(sentPrompts()).toEqual([]);
    expect(writes).toBe(0);
  });

  it('存储被写坏（不是字符串数组）时回落空数组', async () => {
    memory['das.sentPrompts.v1'] = JSON.stringify({ a: 1 });
    const { sentPrompts } = await loadMemory();
    expect(sentPrompts()).toEqual([]);

    vi.resetModules();
    memory['das.sentPrompts.v1'] = JSON.stringify(['ok', 42]);
    expect((await loadMemory()).sentPrompts()).toEqual([]);
  });

  it('草稿表被写坏时回落空表', async () => {
    memory['das.drafts.v1'] = JSON.stringify(['不是表']);
    const { getDraft, setDraft } = await loadMemory();
    expect(getDraft('s1')).toBe('');
    setDraft('s1', '还能用');
    expect(getDraft('s1')).toBe('还能用');
  });
});
