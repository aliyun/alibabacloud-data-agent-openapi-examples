/**
 * 全局快捷键的**判据表 + 匹配函数**（纯函数，node 环境直接单测）。
 *
 * 表只有一份，帮助浮层照着它渲染——分两处写的话，浮层迟早会和真实绑定不一致，
 * 而那种不一致是"按了没反应，帮助里却写着能按"，比没有快捷键更糟。
 *
 * 选键的硬约束是**不能占用浏览器自己的键**：Ctrl+J（下载）、Ctrl+K（地址栏搜索）、
 * Ctrl+Shift+I/K（开发者工具）、Ctrl+Shift+B（Chrome 书签栏）全部排除。
 */

export type ShortcutAction = 'toggleLeft' | 'toggleRight' | 'focusFilter' | 'toggleHelp';

export interface ShortcutDef {
  id: ShortcutAction;
  /** 帮助浮层里显示的组合键。`mod` 在渲染时按平台换成 ⌘ / Ctrl。 */
  keys: string;
  label: string;
  /**
   * 焦点在输入框里时还生效吗。
   *
   * 侧栏开关要生效（IDE 惯例：写代码时也要能收侧栏）；
   * `/` 与 `?` 绝对不能——那是在往框里打字。
   */
  allowInEditable: boolean;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'toggleLeft', keys: 'mod + B', label: '收起 / 展开会话栏', allowInEditable: true },
  { id: 'toggleRight', keys: 'mod + \\', label: '收起 / 展开扩展区', allowInEditable: true },
  { id: 'focusFilter', keys: '/', label: '聚焦会话过滤框', allowInEditable: false },
  { id: 'toggleHelp', keys: '?', label: '打开这份快捷键列表', allowInEditable: false },
];

/** 匹配需要的最小事件面：给真实 KeyboardEvent 用，也给测试用的字面量用。 */
export interface ShortcutKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * 这次按键命中哪个动作，没命中返回 undefined。
 *
 * `mod` 在 Mac 上是 ⌘、其余平台是 Ctrl，但**两者都接受**：外接键盘的 Mac 用户
 * 按 Ctrl+B 是肌肉记忆，只认 ⌘ 会让快捷键看起来"时灵时不灵"。
 * Mac 上 Ctrl+B 在系统层没有占用（终端里是 readline 的"左移一个字符"，
 * 但浏览器里收不到），所以这个宽松不会撞到别的东西。
 */
export function matchShortcut(event: ShortcutKeyEvent, inEditable: boolean): ShortcutAction | undefined {
  const mod = event.ctrlKey || event.metaKey;
  // Alt/Option 会改变按键含义（macOS 上 Option+\ 打出的是别的字符），一律不匹配。
  if (event.altKey) return undefined;

  if (mod && !event.shiftKey) {
    const key = event.key.toLowerCase();
    if (key === 'b') return pick('toggleLeft', inEditable);
    if (key === '\\') return pick('toggleRight', inEditable);
    return undefined;
  }

  if (mod) return undefined;

  if (event.key === '/') return pick('focusFilter', inEditable);
  if (event.key === '?') return pick('toggleHelp', inEditable);
  return undefined;
}

function pick(id: ShortcutAction, inEditable: boolean): ShortcutAction | undefined {
  const def = SHORTCUTS.find((s) => s.id === id);
  if (def === undefined) return undefined;
  if (inEditable && !def.allowInEditable) return undefined;
  return id;
}

/** 焦点是不是在能打字的地方。选区在别处时 `/` 必须真的输入一个斜杠。 */
export function isInEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** 帮助浮层里的 `mod` 换成平台符号。 */
export function renderKeys(keys: string, isMac: boolean): string {
  return keys.replace('mod', isMac ? '⌘' : 'Ctrl');
}
