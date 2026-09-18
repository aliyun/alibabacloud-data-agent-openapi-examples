import { describe, expect, it } from 'vitest';

import {
  MARKDOWN_PLAINTEXT_CHARS,
  plainTextNotice,
  shouldEmitNow,
  shouldRenderPlainText,
  STREAM_THROTTLE_MS,
} from '@/lib/streamText';

/**
 * 流式正文的两条判据：这一片要不要立刻上屏、整段要不要放弃 Markdown 解析。
 *
 * 阈值全部用**字面量**断言（80 / 32000）：拿被测常量算期望值对取值零判别力，
 * 而这两个数恰好是唯一容易改错的东西——节流改大看得出错字，改小等于没节流；
 * 降级阈值改小会让正常长回答一直掉排版。
 */

describe('常量', () => {
  it('节流 80ms（≈12.5 帧/s，高于实测最密的 15 帧/s 那一秒，所以看不出卡顿）', () => {
    expect(STREAM_THROTTLE_MS).toBe(80);
  });

  it('降级阈值 32,000 字', () => {
    expect(MARKDOWN_PLAINTEXT_CHARS).toBe(32_000);
  });
});

describe('shouldEmitNow', () => {
  it('文字没变就不上屏（流式帧里有大量重复推送）', () => {
    expect(shouldEmitNow('abc', 'abc', 0, 80)).toBe(false);
    expect(shouldEmitNow('abc', 'abc', 9999, 80)).toBe(false);
  });

  it('距上次渲染不到 80ms 就压住这一片', () => {
    expect(shouldEmitNow('abc', 'abcd', 0, 80)).toBe(false);
    expect(shouldEmitNow('abc', 'abcd', 79, 80)).toBe(false);
  });

  it('满 80ms 就上屏（边界取等号：>= 不是 >）', () => {
    expect(shouldEmitNow('abc', 'abcd', 80, 80)).toBe(true);
    expect(shouldEmitNow('abc', 'abcd', 120, 80)).toBe(true);
  });

  /**
   * 非单调必须立刻上屏：`next` 不是 `prev` 的延长，说明内容被整体换掉了
   * （切轮次、重取历史、回放还原）。这时候还按节流压着，界面上就留着上一段的话。
   */
  it('内容被整体换掉时不受节流约束，立刻上屏', () => {
    expect(shouldEmitNow('一段长回答', '另一段', 0, 80)).toBe(true);
    expect(shouldEmitNow('abcdef', 'abcXef', 0, 80)).toBe(true);
  });

  it('被换短也一样立刻上屏（截断不是"没变"）', () => {
    expect(shouldEmitNow('abcdef', 'abc', 0, 80)).toBe(true);
  });

  /**
   * 空串是任何串的前缀，所以"从空开始的第一片"在判据眼里也是单调延长，同样受节流约束。
   * 这可以接受：最多压 80ms，而且尾随定时器保证它一定落地；实测首帧通常在挂载
   * 80ms 之后才到（那一支走的是上面「满 80ms 就上屏」），所以真正被压住的窗口很窄。
   */
  it('从空开始的第一片也按单调延长处理（受节流，但一定落地）', () => {
    expect(shouldEmitNow('', 'T', 0, 80)).toBe(false);
    expect(shouldEmitNow('', 'T', 80, 80)).toBe(true);
  });
});

describe('shouldRenderPlainText', () => {
  it('只在流式期间降级：收完的长回答只解析一次，永久降级会把完整排版一起收走', () => {
    expect(shouldRenderPlainText('x'.repeat(32_000), true)).toBe(true);
    expect(shouldRenderPlainText('x'.repeat(32_000), false)).toBe(false);
    expect(shouldRenderPlainText('x'.repeat(99_000), false)).toBe(false);
  });

  it('流式中不到阈值仍走完整 Markdown', () => {
    expect(shouldRenderPlainText('x'.repeat(31_999), true)).toBe(false);
  });

  it('阈值取等号', () => {
    expect(shouldRenderPlainText('x'.repeat(32_000), true)).toBe(true);
  });
});

describe('plainTextNotice', () => {
  it('带实际字数与阈值，并说清代价与恢复时机', () => {
    const note = plainTextNotice('x'.repeat(40_000));
    expect(note).toContain('40,000');
    expect(note).toContain('32,000');
    expect(note).toContain('纯文本');
    expect(note).toContain('恢复完整排版');
  });

  it('不说"内容丢了"：正文一个字没少，只是没有排版', () => {
    const note = plainTextNotice('x'.repeat(40_000));
    expect(note).not.toContain('丢');
    expect(note).not.toContain('截断');
  });
});
