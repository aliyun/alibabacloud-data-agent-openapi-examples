import { isValidElement, type ReactElement, type ReactNode } from 'react';

/**
 * 把 react-markdown 交出来的表格元素树解析成一个纯数据模型。
 *
 * 拆成独立文件有两个理由：
 *  1. 排序 / 数值列判定 / 图表取数这三件事都是纯函数，能在 node 环境下直接单测
 *     （`web/test` 的 environment 是 node，不跑 jsdom）；
 *  2. 组件里同时做"遍历元素树"和"画 SVG"会读不下去。
 *
 * 输入是 ReactNode 而不是 DOM：react-markdown 给的是已经创建好的元素树，
 * 先渲染再去 DOM 里读一遍等于多一次布局，而且拿不到 GFM 的对齐信息。
 */

export type Align = 'left' | 'center' | 'right' | undefined;

export interface TableCell {
  node: ReactNode;
  align: Align;
  /** 纯文本形式，用于排序与数值判定。 */
  text: string;
}

export interface TableModel {
  head: TableCell[];
  rows: TableCell[][];
  /** 有没有 thead。没有的话不排序——第一行是数据还是表头判不出来。 */
  sortable: boolean;
}

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartModel {
  labels: string[];
  series: ChartSeries[];
}

function props(node: ReactNode): Record<string, unknown> | undefined {
  return isValidElement(node) ? (node.props as Record<string, unknown>) : undefined;
}

function typeOf(node: ReactNode): string | undefined {
  if (!isValidElement(node)) return undefined;
  const type = (node as ReactElement).type;
  return typeof type === 'string' ? type : undefined;
}

/** 递归取出元素树里的可见文本。数组是兄弟节点，元素取它的 children。 */
export function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return nodeText(props(node)?.children as ReactNode);
  return '';
}

function alignOf(node: ReactNode): Align {
  const style = props(node)?.style as { textAlign?: string } | undefined;
  const value = style?.textAlign;
  return value === 'left' || value === 'center' || value === 'right' ? value : undefined;
}

function cellsOf(row: ReactNode): TableCell[] {
  const children = props(row)?.children as ReactNode;
  const out: TableCell[] = [];
  for (const child of Array.isArray(children) ? children : [children]) {
    const type = typeOf(child);
    if (type !== 'td' && type !== 'th') continue;
    out.push({ node: props(child)?.children as ReactNode, align: alignOf(child), text: nodeText(child) });
  }
  return out;
}

function rowsOf(section: ReactNode): TableCell[][] {
  const children = props(section)?.children as ReactNode;
  const out: TableCell[][] = [];
  for (const child of Array.isArray(children) ? children : [children]) {
    if (typeOf(child) === 'tr') out.push(cellsOf(child));
  }
  return out;
}

export function buildTableModel(children: ReactNode): TableModel {
  const head: TableCell[][] = [];
  const body: TableCell[][] = [];
  let sawHead = false;

  for (const child of Array.isArray(children) ? children : [children]) {
    const type = typeOf(child);
    if (type === 'thead') {
      sawHead = true;
      head.push(...rowsOf(child));
    } else if (type === 'tbody' || type === 'tfoot') {
      body.push(...rowsOf(child));
    } else if (type === 'tr') {
      // 没有分节的裸表格：所有 tr 都是数据行
      body.push(cellsOf(child));
    }
  }

  // GFM 的表格只有一个表头行；多出来的（比如 rowspan 造成的）并进第一行之后当数据看
  const headerCells = head[0] ?? [];
  const extraHead = head.slice(1);
  return {
    head: headerCells,
    rows: [...extraHead, ...body],
    sortable: sawHead && headerCells.length > 0,
  };
}

/**
 * 数值后缀 → 倍率。
 *
 * 表里没有的后缀一律判为"非数值"（toNumber 返回 undefined）。这是刻意的：
 * 后缀本身携带语义，猜一个倍率等于在排序里编造大小关系。
 */
const UNIT_MULTIPLIER: Record<string, number> = {
  k: 1e3,
  m: 1e6,
  b: 1e9,
  t: 1e12,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  千: 1e3,
  百: 1e2,
  万: 1e4,
  w: 1e4,
  亿: 1e8,
  万亿: 1e12,
};

/**
 * 文本 → 数字。
 *
 * 放宽到能吃下 agent 常见的几种写法：千分位逗号、百分号、货币符号、单位后缀
 * （`1.2万`、`3 GB`）。判不出来就返回 undefined，由调用方决定整列按文本排。
 */
export function toNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '—' || trimmed === '-' || trimmed === 'null') return undefined;

  let negative = false;
  // 会计写法：括号表示负数，`(1,234)`
  let body = trimmed;
  if (/^\(.*\)$/.test(body)) {
    negative = true;
    body = body.slice(1, -1);
  }
  if (/^[+-]/.test(body)) {
    negative = body.startsWith('-');
    body = body.slice(1);
  }

  body = body.replace(/[,，\s¥$€£]/g, '');

  let multiplier = 1;
  if (body.endsWith('%')) body = body.slice(0, -1);
  const unitRaw = /([a-zA-Z万亿千百]+)$/.exec(body)?.[1];
  if (unitRaw !== undefined) {
    const factor = UNIT_MULTIPLIER[unitRaw.toLowerCase()];
    if (factor === undefined) return undefined;
    multiplier = factor;
    body = body.slice(0, -unitRaw.length);
  }

  if (!/^\d*\.?\d+$/.test(body)) return undefined;
  const value = Number.parseFloat(body) * multiplier;
  if (!Number.isFinite(value)) return undefined;
  return negative ? -value : value;
}

/**
 * 这一列是不是数值列。
 *
 * 判据是"**所有非空单元格**都能解析成数字"，而不是"有一个能"：
 * 混着文本的列按数字排会把文本行挤到一端，看起来像排序坏了。
 * 全空的列返回 false（没有可排的内容）。
 */
export function isNumericColumn(rows: TableCell[][], index: number): boolean {
  let seen = 0;
  for (const row of rows) {
    const cell = row[index];
    if (cell === undefined) continue;
    const text = cell.text.trim();
    if (text === '') continue;
    if (toNumber(text) === undefined) return false;
    seen += 1;
  }
  return seen > 0;
}

export type SortDir = 'asc' | 'desc';

/**
 * 作图用的数值列判定，比排序用的 `isNumericColumn` **宽松**。
 *
 * 排序必须严格：混着文本的列按数字排会把文本行挤到一端，看起来像排序坏了。
 * 作图不一样——解析不出来的点直接跳过（NaN），剩下的点仍然是一张有意义的图。
 *
 * 最常见的破坏者是**合计行**与 NULL 的占位符（`—` / `-` / 空串）：
 * SQL 结果表里出现一个，严格判定就会把整张图判死，代价远大于收益。
 *
 * 判据：非空单元格里**至少一半**能解析成数字。全空、或只有少数几格是数字的列
 * 不画——那种列的主体是文本，画出来是误导。
 */
export function isPlottableColumn(rows: TableCell[][], index: number): boolean {
  let seen = 0;
  let numeric = 0;
  for (const row of rows) {
    const cell = row[index];
    if (cell === undefined) continue;
    const text = cell.text.trim();
    if (text === '') continue;
    seen += 1;
    if (toNumber(text) !== undefined) numeric += 1;
  }
  return seen > 0 && numeric * 2 >= seen;
}

export function sortRows(rows: TableCell[][], index: number, dir: SortDir, numeric: boolean): TableCell[][] {
  const factor = dir === 'asc' ? 1 : -1;
  // copy 再排：调用方（React state）拿到的必须是新数组，否则看不出变化
  return [...rows].sort((a, b) => {
    const left = a[index]?.text ?? '';
    const right = b[index]?.text ?? '';
    if (numeric) {
      // 空值一律沉底，不参与正负比较——否则 desc 时它们会跑到最上面
      const ln = toNumber(left);
      const rn = toNumber(right);
      if (ln === undefined && rn === undefined) return 0;
      if (ln === undefined) return 1;
      if (rn === undefined) return -1;
      return (ln - rn) * factor;
    }
    return left.localeCompare(right, 'zh-Hans-CN', { numeric: true }) * factor;
  });
}

/**
 * 从表格取图表数据。
 *
 * 标签列 = 第一个不可作图的列（没有就用第 0 列）；数值列 = 其余所有可作图的列，
 * 最多取 4 条（再多颜色就分不开了，而且中栏宽度放不下）。
 *
 * 数值列判定用的是 `isPlottableColumn`（宽松），不是排序用的 `isNumericColumn`
 * （严格）：合计行与 NULL 占位符在 SQL 结果表里太常见，严格判定会让
 * "有一个格子不是数字"直接等于"这张表画不出图"。
 *
 * 返回 undefined 表示"这张表画不出图"：少于 2 列、没有可作图的列、或者行数为 0。
 * 此时组件不渲染「图表」按钮——给一个点了只会显示空白的按钮比不给更糟。
 */
export function buildChartModel(model: TableModel, maxSeries = 4): ChartModel | undefined {
  const { head, rows } = model;
  if (head.length < 2 || rows.length === 0) return undefined;

  const numericCols: number[] = [];
  let labelCol = -1;
  for (let i = 0; i < head.length; i += 1) {
    if (isPlottableColumn(rows, i)) numericCols.push(i);
    else if (labelCol === -1) labelCol = i;
  }
  if (numericCols.length === 0) return undefined;
  // 全是数值列（比如"月份 | 销售额 | 环比"里月份也被写成数字）就用第 0 列当标签
  if (labelCol === -1) labelCol = 0;

  const labels = rows.map((row, i) => (row[labelCol]?.text.trim() || `第 ${i + 1} 行`));
  const series: ChartSeries[] = numericCols
    .filter((i) => i !== labelCol)
    .slice(0, maxSeries)
    .map((i) => ({
      name: head[i]?.text ?? `列 ${i + 1}`,
      values: rows.map((row) => toNumber(row[i]?.text ?? '') ?? Number.NaN),
    }));

  if (series.length === 0) return undefined;
  return { labels, series };
}
