/**
 * 会话列表的分组与排序（纯函数，node 环境直接单测）。
 *
 * 分出来是因为这里有两条不看代码就会踩的判据：
 * 一是**上游返回顺序没有任何文档承诺**，后端也没排（server/src/routes/rest.ts 原样透传），
 * 所以"最近的在上面"必须由前端自己保证；二是"既置顶又归档"的会话该落哪一组，
 * 这个歧义只能靠一条写死的优先级消掉。
 */

export interface Groupable {
  sessionId: string;
  /** 毫秒。上游的 SessionUpdatedAt 恒等于 CreatedAt，不能当活动时间用。 */
  createdAt: number;
}

/** 存在本地（localStorage）的会话标记，与服务端无关：上游没有重命名/归档/置顶接口。 */
export interface LocalSessionFlags {
  pinned?: boolean;
  archived?: boolean;
  hidden?: boolean;
}

export interface SessionGroups<T> {
  pinned: T[];
  normal: T[];
  archived: T[];
  /** 被本地隐藏的条数。只给个数——它们的 id 在本地偏好里，列表本身要的是"有 N 个可以找回来"。 */
  hiddenCount: number;
}

/**
 * 分组优先级：隐藏 > 归档 > 置顶 > 普通。
 *
 * 归档压过置顶：用户先置顶（"放最上面"）后归档（"收起来"），最后表达的是"收起来"。
 * 置顶标记本身不清掉——取消归档时它回到置顶组，符合"我只是把它收起来过"的直觉。
 */
export function groupSessions<T extends Groupable>(
  items: readonly T[],
  flagsOf: (item: T) => LocalSessionFlags | undefined,
): SessionGroups<T> {
  const pinned: T[] = [];
  const normal: T[] = [];
  const archived: T[] = [];
  let hiddenCount = 0;

  for (const item of items) {
    const flags = flagsOf(item) ?? {};
    if (flags.hidden === true) {
      hiddenCount += 1;
      continue;
    }
    if (flags.archived === true) archived.push(item);
    else if (flags.pinned === true) pinned.push(item);
    else normal.push(item);
  }

  return {
    pinned: byNewest(pinned),
    normal: byNewest(normal),
    archived: byNewest(archived),
    hiddenCount,
  };
}

/**
 * createdAt 倒序。并列时保持传入顺序——`Array.prototype.sort` 在 V8 上是稳定排序，
 * 所以"上游把并列的会话怎么排的"这个（未文档化的）行为被原样保留，不会每次刷新都抖一下。
 */
function byNewest<T extends Groupable>(items: T[]): T[] {
  return items.sort((a, b) => b.createdAt - a.createdAt);
}
