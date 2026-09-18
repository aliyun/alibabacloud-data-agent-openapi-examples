import { describe, expect, it } from 'vitest';

import {
  highlight,
  isTooLongToHighlight,
  LOADED_LANGS,
  longestLine,
  resolveLang,
  skipHighlightNote,
  skipHighlightReason,
} from '@/lib/highlight';

/**
 * 代码高亮。
 *
 * 重点钉住 shiki **双主题输出的形状**：index.css 靠
 * `.dark .shiki-host .shiki span { color: var(--shiki-dark) !important }` 翻暗色，
 * 这条规则成立的前提是每个 span 上都带着 `--shiki-dark`。
 * 这个前提在亮色下用肉眼永远验不出来——少一套主题只会让暗色变成"深底配深色字"。
 */
describe('highlight', () => {
  /**
   * 钉住 shiki 双主题的**实测输出形状**：亮色是字面量 `color:#D73A49`，
   * 暗色是自定义属性 `--shiki-dark:#F97583`。
   *
   * index.css 里那条 `.dark .shiki-host .shiki span { color: var(--shiki-dark) !important }`
   * 完全依赖 `--shiki-dark` 存在于每个 span 上。如果哪天有人把
   * `themes:{light,dark}` 改回单主题（`theme:'github-light'`），产物照样能高亮、
   * 亮色下一切正常，只有暗色会静默变成"深底配深色字"——这类回归在亮色下肉眼测不出来。
   */
  it('每个 span 同时带亮色字面量与 --shiki-dark 自定义属性', async () => {
    const html = await highlight('SELECT 1 FROM t', 'sql');
    expect(html).toBeDefined();
    expect(html).toContain('shiki-themes');
    expect(html).toContain('github-light');
    expect(html).toContain('github-dark');
    expect(html).toMatch(/<span style="color:#[0-9a-f]{3,8};--shiki-dark:#[0-9a-f]{3,8}">/i);
  });

  it('pre 上带主题底色，由 CSS 强制透明接管（暗色下不然是一块白板）', async () => {
    const html = await highlight('SELECT 1 FROM t', 'sql');
    expect(html).toMatch(/background-color:#[0-9a-f]{3,8}/i);
    expect(html).toContain('--shiki-dark-bg:');
  });

  it('两套颜色确实不同：相同就说明暗色主题没装载上', async () => {
    const html = (await highlight('SELECT 1 FROM t', 'sql')) ?? '';
    const span = /<span style="color:(#[0-9a-f]{3,8});--shiki-dark:(#[0-9a-f]{3,8})">/i.exec(html);
    expect(span).not.toBeNull();
    expect(span?.[1]?.toLowerCase()).not.toBe(span?.[2]?.toLowerCase());
  });

  it('认不出的语言退回 text，但代码本身仍然渲染出来', async () => {
    const html = await highlight('hello world', 'brainfuck-not-registered');
    expect(html).toContain('hello world');
  });

  it('超长内容直接不高亮：语法分析会阻塞主线程，而那种内容也没有着色价值', async () => {
    const huge = 'a'.repeat(100_001);
    expect(isTooLongToHighlight(huge)).toBe(true);
    expect(await highlight(huge, 'text')).toBeUndefined();
    /**
     * 边界样本必须是**多行**的：批次I 加了单行 20,000 字的护栏之后，
     * 100,000 个字符挤在一行上会先被那条拦下（原因是 overlong-line），
     * 用它当总字数阈值的放行样本量的就不是这条护栏了。
     */
    expect(isTooLongToHighlight('a\n'.repeat(50_000))).toBe(false);
    expect(skipHighlightReason('a\n'.repeat(50_000))).toBeUndefined();
    expect(skipHighlightReason('a'.repeat(100_000))).toBe('overlong-line');
  });

  it('命中缓存时返回同一份 HTML（LRU 命中不改内容）', async () => {
    const first = await highlight('SELECT 2', 'sql');
    const second = await highlight('SELECT 2', 'sql');
    expect(second).toBe(first);
  });
});

describe('resolveLang', () => {
  it('把围栏里的常见简写映射到已登记的语法', () => {
    expect(resolveLang('sh', LOADED_LANGS)).toBe('shellscript');
    expect(resolveLang('BASH', LOADED_LANGS)).toBe('shellscript');
    expect(resolveLang('py', LOADED_LANGS)).toBe('python');
    expect(resolveLang('yml', LOADED_LANGS)).toBe('yaml');
    expect(resolveLang('ts', LOADED_LANGS)).toBe('typescript');
    expect(resolveLang('  sql  ', LOADED_LANGS)).toBe('sql');
  });

  it('认不出来的一律落到 text，而不是原样传给 shiki 抛错', () => {
    expect(resolveLang('not-a-lang', LOADED_LANGS)).toBe('text');
    expect(resolveLang('', LOADED_LANGS)).toBe('text');
  });

  it('LOADED_LANGS 含 text 作落点，但不含未登记的语法', () => {
    expect(LOADED_LANGS).toContain('text');
    expect(LOADED_LANGS).not.toContain('brainfuck');
  });
});

describe('longestLine', () => {
  it('空串是 0', () => {
    expect(longestLine('')).toBe(0);
  });

  it('没有换行就是整段长度', () => {
    expect(longestLine('select 1')).toBe(8);
  });

  it('取最长的那一行，不是最后一行也不是第一行', () => {
    expect(longestLine('a\nbbbbb\ncc')).toBe(5);
    expect(longestLine('aaaa\nb\nccc')).toBe(4);
  });

  it('末尾换行不会多算一个空的 0 长行，也不影响结果', () => {
    expect(longestLine('abc\n')).toBe(3);
    expect(longestLine('abc\nd\n')).toBe(3);
  });

  it('\\r\\n 的 \\r 计进长度（Windows 换行的原样长度，护栏宁可多算）', () => {
    expect(longestLine('abc\r\nd')).toBe(4);
  });
});

/**
 * 跳过语法高亮的两条护栏。
 *
 * 阈值全部用**字面量**断言：拿被测常量算期望值的写法对取值零判别力，
 * 而阈值恰好是这里唯一容易改错的东西（改大了会卡主线程，改小了一般代码全不着色）。
 */
describe('skipHighlightReason', () => {
  it('正常代码不跳过', () => {
    expect(skipHighlightReason('SELECT 1\nFROM t')).toBeUndefined();
    expect(skipHighlightReason('')).toBeUndefined();
  });

  it('总字数 100,000 放行，100,001 拦下', () => {
    expect(skipHighlightReason('a\n'.repeat(50_000))).toBeUndefined();
    expect(skipHighlightReason('a'.repeat(100_001))).toBe('too-long');
  });

  it('单行 20,000 放行，20,001 拦下（总字数远没到上限也要拦）', () => {
    expect(skipHighlightReason('a'.repeat(20_000))).toBeUndefined();
    expect(skipHighlightReason('a'.repeat(20_001))).toBe('overlong-line');
  });

  it('总字数没超但其中一行超长：minified JSON 的典型形态', () => {
    const code = `${'x'.repeat(30_000)}\n${'y\n'.repeat(30_000)}`;
    expect(code.length).toBeLessThan(100_000);
    expect(skipHighlightReason(code)).toBe('overlong-line');
  });

  it('两条同时超了报总字数那条：先说更根本的规模问题', () => {
    expect(skipHighlightReason('a'.repeat(120_000))).toBe('too-long');
  });

  it('护栏真的挡住了 highlight()，返回 undefined 让调用方退回纯文本', async () => {
    expect(await highlight('a'.repeat(20_001), 'json')).toBeUndefined();
    expect(isTooLongToHighlight('a'.repeat(20_001))).toBe(true);
  });
});

describe('skipHighlightNote', () => {
  it('两种原因说不同的话，且都带上实际数字', () => {
    const tooLong = skipHighlightNote('too-long', 'a'.repeat(100_001));
    expect(tooLong).toContain('100,000');
    expect(tooLong).toContain('100,001');
    expect(tooLong).not.toContain('一行');

    const overlong = skipHighlightNote('overlong-line', 'a'.repeat(20_001));
    expect(overlong).toContain('20,000');
    expect(overlong).toContain('20,001');
    expect(overlong).toContain('一行');
  });

  it('说的是最长那一行，不是总字数', () => {
    const note = skipHighlightNote('overlong-line', `${'x'.repeat(25_000)}\nshort\n`);
    expect(note).toContain('25,000');
    expect(note).not.toContain('25,012');
  });
});
