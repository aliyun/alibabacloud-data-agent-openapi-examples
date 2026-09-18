/**
 * `?session=<id>` 深链。
 *
 * 只做两件事：从 query 里读出会话 id、把当前选中会话写回 query。
 * 用 replaceState 而不是 pushState——切会话不是导航历史，
 * 否则用户点几下之后"后退"会在会话之间来回跳，退不出这个页面。
 */
export const SESSION_PARAM = 'session';

/**
 * 读链接里的会话 id。
 *
 * 不校验它是否真实存在：前端此刻还没拉列表，而"链接指向一个已失效/不存在的会话"
 * 本身就是要让用户看见的结果（中栏会照实报错），提前静默丢弃等于把故障藏起来。
 */
export function readSessionParam(search: string): string | undefined {
  const params = new URLSearchParams(search);
  const raw = params.get(SESSION_PARAM);
  if (raw === null) return undefined;
  const id = raw.trim();
  return id.length > 0 ? id : undefined;
}

/** 把选中会话写进 query；没有选中就把这个参数摘掉，其余参数原样保留。 */
export function writeSessionParam(search: string, sessionId: string | undefined): string {
  const params = new URLSearchParams(search);
  if (sessionId === undefined) params.delete(SESSION_PARAM);
  else params.set(SESSION_PARAM, sessionId);
  const next = params.toString();
  return next.length > 0 ? `?${next}` : '';
}
