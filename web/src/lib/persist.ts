/**
 * localStorage 的 JSON 读写。
 *
 * 本地偏好（主题、会话别名/置顶、草稿、发过的提示词）全走这里，因为它们面对的是
 * 同一组失败方式：隐私模式与 iframe sandbox 下 localStorage 直接不可用、配额会满、
 * 存进去的东西可能被用户或旧版本写坏。这些都只该导致"偏好丢一次"，
 * 绝不能变成渲染期异常——所以读写都吞掉错误，读失败一律回落调用方给的默认值。
 */

/**
 * 读回来的是 `unknown`：`JSON.parse` 成功不等于形状正确（手改过、或旧版本写过别的结构），
 * 所以每个调用方都要自己过一遍 `guard`，不合格就回落默认值。
 */
export function readJson<T>(key: string, fallback: T, guard: (value: unknown) => value is T): T {
  if (typeof localStorage === 'undefined') return fallback;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return fallback;
  }
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return guard(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** 返回是否真的写进去了。写不进去时调用方通常什么也不用做，但测试要能断言这条路径。 */
export function writeJson(key: string, value: unknown): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
