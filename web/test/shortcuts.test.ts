import { describe, expect, it } from 'vitest';

import { SHORTCUTS, matchShortcut, renderKeys, type ShortcutKeyEvent } from '@/lib/shortcuts';

function key(partial: Partial<ShortcutKeyEvent>): ShortcutKeyEvent {
  return { key: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...partial };
}

/**
 * 快捷键匹配。
 *
 * 这里钉的不是"按了什么触发什么"这么表面的一件事，而是两条容易悄悄坏掉的约束：
 * 一是**在输入框里打字时 `/` 与 `?` 必须真的输出去**（否则过滤框里打不出斜杠），
 * 二是**不能占用浏览器自己的键**——那条约束写在表里，靠下面的用例守住表的形状。
 */
describe('matchShortcut', () => {
  it('Ctrl+B 与 Cmd+B 都切换左栏，输入框里也生效', () => {
    expect(matchShortcut(key({ key: 'b', ctrlKey: true }), false)).toBe('toggleLeft');
    expect(matchShortcut(key({ key: 'B', ctrlKey: true, shiftKey: false }), false)).toBe('toggleLeft');
    expect(matchShortcut(key({ key: 'b', metaKey: true }), false)).toBe('toggleLeft');
    expect(matchShortcut(key({ key: 'b', ctrlKey: true }), true)).toBe('toggleLeft');
  });

  it('Ctrl+\\ 切换右栏', () => {
    expect(matchShortcut(key({ key: '\\', ctrlKey: true }), false)).toBe('toggleRight');
    expect(matchShortcut(key({ key: '\\', metaKey: true }), true)).toBe('toggleRight');
  });

  it('Ctrl+Shift+B 不匹配——那是浏览器的书签栏', () => {
    expect(matchShortcut(key({ key: 'B', ctrlKey: true, shiftKey: true }), false)).toBeUndefined();
  });

  it('带 Alt 一律不匹配：Option 会改变按键含义', () => {
    expect(matchShortcut(key({ key: 'b', ctrlKey: true, altKey: true }), false)).toBeUndefined();
    expect(matchShortcut(key({ key: '/', altKey: true }), false)).toBeUndefined();
  });

  it('`/` 只在非输入态聚焦过滤框，输入态必须把斜杠还给框', () => {
    expect(matchShortcut(key({ key: '/' }), false)).toBe('focusFilter');
    expect(matchShortcut(key({ key: '/' }), true)).toBeUndefined();
  });

  it('`?` 打开帮助，同样不在输入态生效', () => {
    expect(matchShortcut(key({ key: '?', shiftKey: true }), false)).toBe('toggleHelp');
    expect(matchShortcut(key({ key: '?', shiftKey: true }), true)).toBeUndefined();
  });

  it('普通字母与浏览器保留键不匹配', () => {
    expect(matchShortcut(key({ key: 'b' }), false)).toBeUndefined();
    expect(matchShortcut(key({ key: 'j', ctrlKey: true }), false)).toBeUndefined();
    expect(matchShortcut(key({ key: 'k', ctrlKey: true }), false)).toBeUndefined();
    expect(matchShortcut(key({ key: 'Escape' }), false)).toBeUndefined();
  });
});

describe('SHORTCUTS 表', () => {
  it('每个动作都在表里出现且只出现一次——帮助浮层照着它渲染，漏一条就是少一行说明', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['focusFilter', 'toggleHelp', 'toggleLeft', 'toggleRight']);
  });

  it('每条都有 label 与 keys，且 keys 里用 mod 而不是写死 Ctrl', () => {
    for (const s of SHORTCUTS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.keys.length).toBeGreaterThan(0);
      if (s.keys.includes('+')) expect(s.keys).toContain('mod');
    }
  });

  it('renderKeys 按平台替换 mod', () => {
    expect(renderKeys('mod + B', true)).toBe('⌘ + B');
    expect(renderKeys('mod + B', false)).toBe('Ctrl + B');
    expect(renderKeys('/', true)).toBe('/');
  });
});
