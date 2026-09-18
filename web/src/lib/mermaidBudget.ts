/**
 * mermaid 图的护栏判据（纯函数，node 环境直接单测）。
 *
 * 图定义是 agent 产出的、不受本工程控制的内容。`securityLevel:'strict'` 挡住的是
 * **注入**（标签里的 HTML、click 指令绑回调），挡不住**规模**：一张几百个节点的图
 * 会让 mermaid 的布局算法占住主线程几十秒，界面卡在「正在渲染图…」，
 * 而这段时间里输入框打字、滚动、切 tab 全都不响应——用户看不出是图的问题。
 *
 * 所以这里给两条上限，超了就不送去渲染，并把原文留给用户自己看。
 */

/** 字符上限。正常回答里的流程图是几十行；到万级已经不是"一张图"而是"一份文档"了。 */
export const MAX_MERMAID_CHARS = 50_000;

/**
 * 边数上限。
 *
 * 布局成本主要随边数涨（mermaid 用的是 dagre 一类的分层布局），节点数反而次要。
 */
export const MAX_MERMAID_EDGES = 500;

/**
 * 数箭头记号。这是**启发式**，不是 mermaid 的语法分析：
 * `A --> B --> C` 数到 2（对），`%%` 注释里的箭头也会被数进去（多算）。
 * 多算是可接受的方向——它只是个护栏，宁可提前拦一张本来能渲染的巨图，
 * 也不能漏掉一张真会把主线程占住的。
 *
 * 每个分支一次吃掉**整段**连续的横线/点/等号，所以 `-.->` 数到 1 而不是 2。
 * （分支之间的先后顺序对计数没有影响，实测调换过；这里不做无凭据的声明。）
 */
const EDGE_TOKEN = /-+>>?|-+\.?-+>?|<-+\.?-+|=+>|~{3}/g;

export interface MermaidBudget {
  chars: number;
  edges: number;
  /** 非 undefined 表示不该送去渲染，值就是给用户看的那句说明。 */
  refusal: string | undefined;
}

export function mermaidBudget(code: string): MermaidBudget {
  const chars = code.length;
  const edges = (code.match(EDGE_TOKEN) ?? []).length;

  if (chars > MAX_MERMAID_CHARS) {
    return {
      chars,
      edges,
      refusal: `这张图的定义有 ${chars.toLocaleString('zh-CN')} 字，超过上限 ${MAX_MERMAID_CHARS.toLocaleString('zh-CN')} 字，没有送去渲染。`,
    };
  }
  if (edges > MAX_MERMAID_EDGES) {
    return {
      chars,
      edges,
      refusal: `这张图数到约 ${edges.toLocaleString('zh-CN')} 条边，超过上限 ${MAX_MERMAID_EDGES.toLocaleString('zh-CN')} 条，没有送去渲染：布局会把主线程占住几十秒，期间整个界面都不响应。`,
    };
  }
  return { chars, edges, refusal: undefined };
}
