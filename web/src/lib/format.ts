/** 时间戳 → 本地可读。上游给的是毫秒。 */
export function formatTime(ms: number | undefined): string {
  if (ms === undefined) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false });
}

/** 时长 → "1m 32s" / "820ms"。用于展示一轮跑了多久、load 花了多久。 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** 大数字 → "58.3k"。token 计数用，只为在窄栏里放得下。 */
export function formatCount(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/**
 * hero 上的大数字：六位以内给带千分位的**精确值**，再大就退回 "1.2M"。
 *
 * 与 `formatCount` 的分工是"这个数字要不要逐位读"：hero 上的总量是用户唯一
 * 会拿去做预算的数字，58,342 与 58.3k 不是同一个信息量；但右栏只有约 320px 宽，
 * 28px 字号下七位数一定折行，所以百万级往上只能牺牲精度换一行放得下。
 */
export function formatCompact(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n.toLocaleString('zh-CN');
}

/**
 * 时间戳 → 只有时分秒。
 *
 * 轮次元信息那一行挤的是 11px 的小 chip，`formatTime` 的「2026/9/16 19:44:26」
 * 会把帧数、token 数一起挤到下一行。日期放在 title 里，需要时看得到。
 */
export function formatClock(ms: number | undefined): string {
  if (ms === undefined) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 再往前，"45 天前"已经不具备排序价值，不如直接给日期。 */
const RELATIVE_HORIZON = 30 * DAY;

/**
 * 时间戳 → 相对时间（"3 分钟前"）。会话列表要回答的是"哪个最近"，
 * 绝对时间得让用户自己做减法。
 *
 * `now` 由调用方传（见 `useNow`）：不传就用当下，传了就能在测试里钉住
 * 59 分 / 60 分这类边界，不必装假时钟。
 *
 * 负值归"刚刚"：上游与本地时钟不同步时 createdAt 可能落在未来，
 * 显示"-3 分钟前"是把时钟问题当成内容问题抛给用户。
 */
export function formatRelative(ms: number | undefined, now: number = Date.now()): string {
  if (ms === undefined) return '—';
  const time = new Date(ms).getTime();
  if (Number.isNaN(time)) return '—';
  const diff = now - time;
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < RELATIVE_HORIZON) return `${Math.floor(diff / DAY)} 天前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}
