import { describe, expect, it } from 'vitest';

import {
  IDLE_CURSOR,
  countLines,
  enterIntent,
  pasteLabel,
  recallNewer,
  recallOlder,
  shouldCollapsePaste,
  shouldRecall,
} from '@/lib/composerPolicy';

/**
 * 输入框的三条判据。
 *
 * 阈值一律用**字面量**断言，不用被测常量本身算期望值：
 * 上一轮滚动阈值测试就是这么写的，把常量从 120 改成 0 之后 16 条用例全绿——
 * 自指断言对取值零判别力，而取值恰好是这里唯一容易改错的东西。
 */

const HISTORY = ['最新一句', '中间那句', '最早那句'];

describe('countLines', () => {
  it('没有换行就是 1 行，不是 0 行', () => {
    expect(countLines('abc')).toBe(1);
    expect(countLines('')).toBe(1);
  });

  it('按换行符数 + 1 计', () => {
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\nb\n')).toBe(3);
  });
});

describe('shouldCollapsePaste', () => {
  it('短内容照常插入输入框，不折叠', () => {
    expect(shouldCollapsePaste('select 1')).toBe(false);
    expect(shouldCollapsePaste('x'.repeat(1199))).toBe(false);
  });

  it('字数达到 1200 就折叠', () => {
    expect(shouldCollapsePaste('x'.repeat(1200))).toBe(true);
  });

  it('行数达到 20 就折叠，哪怕字数很少', () => {
    expect(shouldCollapsePaste(Array(19).fill('a').join('\n'))).toBe(false);
    expect(shouldCollapsePaste(Array(20).fill('a').join('\n'))).toBe(true);
  });
});

describe('pasteLabel', () => {
  it('只报字数与行数，不带内容预览', () => {
    expect(pasteLabel('abc')).toBe('粘贴的 3 字 · 1 行');
    expect(pasteLabel('a\nb\nc')).toBe('粘贴的 5 字 · 3 行');
  });

  it('千分位按中文习惯分组，长粘贴不会撑爆 chip', () => {
    expect(pasteLabel('x'.repeat(12345))).toContain('12,345');
  });
});

describe('recallOlder / recallNewer', () => {
  it('历史为空时什么都不做，游标保持 idle', () => {
    const step = recallOlder(IDLE_CURSOR, [], '打到一半');
    expect(step.cursor).toBe(IDLE_CURSOR);
    expect(step.text).toBe('打到一半');
  });

  it('第一次上翻拿到最新那句，并把当前草稿存进 stash', () => {
    const step = recallOlder(IDLE_CURSOR, HISTORY, '打到一半');
    expect(step.text).toBe('最新一句');
    expect(step.cursor).toEqual({ index: 0, stash: '打到一半' });
  });

  it('继续上翻往更早走，走到最早那句就停住', () => {
    let cursor = IDLE_CURSOR;
    let text = '';
    for (let i = 0; i < 5; i += 1) {
      const step = recallOlder(cursor, HISTORY, text);
      cursor = step.cursor;
      text = step.text;
    }
    expect(text).toBe('最早那句');
    expect(cursor.index).toBe(2);
  });

  it('下翻往更新走，越过最新那句就把 stash 还回来并退出历史', () => {
    const step1 = recallOlder(IDLE_CURSOR, HISTORY, '');
    const step2 = recallOlder(step1.cursor, HISTORY, step1.text);
    const atOldest = recallOlder(step2.cursor, HISTORY, step2.text);
    expect(atOldest.cursor.index).toBe(2);
    expect(atOldest.text).toBe('最早那句');

    const back1 = recallNewer(atOldest.cursor, HISTORY, atOldest.text);
    expect(back1.text).toBe('中间那句');
    const back2 = recallNewer(back1.cursor, HISTORY, back1.text);
    expect(back2.text).toBe('最新一句');
    const out = recallNewer(back2.cursor, HISTORY, back2.text);
    expect(out.cursor).toBe(IDLE_CURSOR);
    expect(out.text).toBe('');
  });

  it('不在历史里时下翻是 no-op，不会把框里的字换成历史', () => {
    const step = recallNewer(IDLE_CURSOR, HISTORY, '打到一半');
    expect(step.text).toBe('打到一半');
    expect(step.cursor).toBe(IDLE_CURSOR);
  });

  it('stash 是用户打的那半句，退出历史时必须逐字还回来', () => {
    const inHistory = recallOlder(IDLE_CURSOR, HISTORY, '半句草稿');
    const out = recallNewer(inHistory.cursor, HISTORY, inHistory.text);
    expect(out.text).toBe('半句草稿');
  });
});

describe('shouldRecall', () => {
  it('有选区时一律让给编辑器（箭头的第一职责是收选区）', () => {
    expect(shouldRecall('ArrowUp', IDLE_CURSOR, '', 0, 3)).toBe(false);
    expect(shouldRecall('ArrowDown', { index: 0, stash: '' }, 'abc', 0, 3)).toBe(false);
  });

  it('框是空的、光标在最前面：上箭头翻历史', () => {
    expect(shouldRecall('ArrowUp', IDLE_CURSOR, '', 0, 0)).toBe(true);
  });

  it('框里有字且不在历史中：上箭头不翻，哪怕光标在行首', () => {
    expect(shouldRecall('ArrowUp', IDLE_CURSOR, '多行\n草稿', 0, 0)).toBe(false);
    expect(shouldRecall('ArrowUp', IDLE_CURSOR, '一行草稿', 0, 0)).toBe(false);
  });

  it('已经在翻历史时，上箭头在行首继续翻', () => {
    expect(shouldRecall('ArrowUp', { index: 0, stash: '' }, '最新一句', 0, 0)).toBe(true);
  });

  it('光标不在行首时上箭头还给编辑器', () => {
    expect(shouldRecall('ArrowUp', { index: 0, stash: '' }, '最新一句', 2, 2)).toBe(false);
  });

  it('下箭头只在历史中且光标在末尾时生效', () => {
    expect(shouldRecall('ArrowDown', IDLE_CURSOR, 'abc', 3, 3)).toBe(false);
    expect(shouldRecall('ArrowDown', { index: 1, stash: '' }, 'abc', 3, 3)).toBe(true);
    expect(shouldRecall('ArrowDown', { index: 1, stash: '' }, 'abc', 1, 1)).toBe(false);
  });
});

describe('enterIntent', () => {
  const BARE = { shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };

  it('裸 Enter 是提交', () => {
    expect(enterIntent(BARE)).toBe('submit');
  });

  /**
   * 这四种必须**自己插换行**：浏览器只在裸 Enter 与 Shift+Enter 上自动插，
   * ⌘/Ctrl/Alt+Enter 默认什么都不插。判据只返回 'newline' 而调用方忘了插，
   * 用户按了回车、框里没多一行、也没发出去——静默丢内容，界面上没有任何痕迹。
   */
  it('Shift / ⌘ / Ctrl / Alt + Enter 都是换行', () => {
    expect(enterIntent({ ...BARE, shiftKey: true })).toBe('newline');
    expect(enterIntent({ ...BARE, metaKey: true })).toBe('newline');
    expect(enterIntent({ ...BARE, ctrlKey: true })).toBe('newline');
    expect(enterIntent({ ...BARE, altKey: true })).toBe('newline');
  });

  it('修饰键同时按下也是换行，不会因为多按一个就变成提交', () => {
    expect(enterIntent({ shiftKey: true, metaKey: true, ctrlKey: false, altKey: false })).toBe('newline');
  });
});
