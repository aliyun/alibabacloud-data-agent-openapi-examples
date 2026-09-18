/**
 * 工具卡片组什么时候折叠（纯函数，node 环境直接单测）。
 *
 * 一轮长任务实测有十几次工具调用，每张卡片带命令与结果，摊开就是几屏——
 * 用户要看的最终答案被推到屏幕外。折叠是为了降噪，但**降噪不能顺手把坏消息也降掉**：
 * 失败的工具调用、以及"上游没送终态帧"的那些，恰恰是最需要一眼看见的东西。
 * 所以判据里带上了状态统计：有失败或没落定的，就不折叠。
 *
 * 收流期间也不折叠：那时候卡片逐个出现本身就是进度，藏起来等于没有进度条。
 * 代价是长轮里正文会被卡片往下推，这一条交给滚动跟随（`lib/scrollPolicy.ts`）兜。
 */

/** 超过这个条数才折叠。四次以内摊开更省事——点开一次的成本高于扫一眼。 */
export const COLLAPSE_TOOL_COUNT = 4;

/** 只取判据需要的两个字段，这样测试可以直接喂字面量、不必造完整的 ToolCallView。 */
export interface ToolGroupItem {
  name: string | undefined;
  status: string;
}

export interface ToolGroupFacts {
  count: number;
  /** 最后一次调用的工具名。折叠状态下"它在干什么"只剩这一个线索。 */
  lastName: string | undefined;
  failed: number;
  /** 停在 pending / in_progress：可能是真的在跑（收流中），也可能是上游没送终态帧。 */
  unsettled: number;
}

export function toolGroupFacts(tools: readonly ToolGroupItem[]): ToolGroupFacts {
  let failed = 0;
  let unsettled = 0;
  for (const tool of tools) {
    if (tool.status === 'failed') failed += 1;
    if (tool.status === 'pending' || tool.status === 'in_progress') unsettled += 1;
  }
  // 从后往前找第一个有名字的：上游的 name 在 update._meta.toolName 里，实测会缺。
  let lastName: string | undefined;
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const name = tools[i]?.name;
    if (name !== undefined && name !== '') {
      lastName = name;
      break;
    }
  }
  return { count: tools.length, lastName, failed, unsettled };
}

/**
 * 这一组卡片该不该**默认**折叠。用户随时可以点开，这里决定的只是初始态。
 *
 * `unsettled` 在收流中不算坏消息（那是真的在跑），所以只在非收流态才拦折叠——
 * 收流态本来就已经因为 streaming 而不折叠了，这里再判一次是为了让判据自身闭合：
 * 万一将来有人把 streaming 那条去掉，"上游没送终态帧"也不会被折进去。
 */
export function shouldCollapseTools(facts: ToolGroupFacts, streaming: boolean): boolean {
  if (streaming) return false;
  if (facts.count <= COLLAPSE_TOOL_COUNT) return false;
  if (facts.failed > 0) return false;
  if (facts.unsettled > 0) return false;
  return true;
}

/**
 * 折叠摘要行上的字。
 *
 * 刻意**不**在这里报失败数与未终态数：这两种情况本身就会让 `shouldCollapseTools`
 * 返回 false（卡片一定摊开着），再说一遍就等于同一条消息在界面上出现两次，
 * 而重复的消息会被读成两件不同的事。"这组要注意"由调用方给摘要行染色来表达。
 */
export function toolGroupLabel(facts: ToolGroupFacts): string {
  return facts.lastName === undefined
    ? `${facts.count} 次工具调用`
    : `${facts.count} 次工具调用 · 最近 ${facts.lastName}`;
}
