import { createElement as h, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import {
  buildChartModel,
  buildTableModel,
  isNumericColumn,
  isPlottableColumn,
  nodeText,
  sortRows,
  toNumber,
  type TableCell,
} from '@/lib/tableModel';

/**
 * 表格纯函数层的单测。
 *
 * 这些函数吃的是 react-markdown 交出来的**元素树**，所以用例里用 `createElement`
 * 直接搭一棵与真实渲染同形的树——不跑 jsdom、不渲染组件，node 环境即可。
 *
 * 排序与数值判定是用户能直接看出对错的功能：排错了不会报错，只会静默给出
 * 错误的顺序，所以必须有断言钉住。
 */

function cell(text: string, align?: 'left' | 'center' | 'right'): TableCell {
  return { node: text, align, text };
}

/**
 * 搭一棵 thead + tbody 的子节点树，形状与 remark-gfm 的输出一致。
 *
 * 返回的是 **table 的子节点**而不是 table 元素本身：react-markdown 交给
 * `components.table` 的 `children` 就是子节点，多包一层 table 会让
 * buildTableModel 什么也认不出来。
 */
function table(head: Array<[string, 'left' | 'center' | 'right' | undefined]>, rows: string[][]): ReactNode[] {
  return [
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        ...head.map(([text, align]) => h('th', { style: align ? { textAlign: align } : undefined }, text)),
      ),
    ),
    h(
      'tbody',
      null,
      ...rows.map((row) => h('tr', null, ...row.map((text) => h('td', null, text)))),
    ),
  ];
}

describe('nodeText', () => {
  it('递归取出嵌套元素里的可见文本', () => {
    const node = h('td', null, '共 ', h('strong', null, '12'), ' 条', h('br'), null);
    expect(nodeText(node)).toBe('共 12 条');
  });

  it('空值与布尔值不产出文本', () => {
    expect(nodeText(undefined)).toBe('');
    expect(nodeText(null)).toBe('');
    expect(nodeText(false)).toBe('');
    expect(nodeText(0)).toBe('0');
  });
});

describe('buildTableModel', () => {
  it('认得出 thead/tbody 与 GFM 的对齐', () => {
    const model = buildTableModel(
      table(
        [
          ['表名', 'left'],
          ['行数', 'right'],
          ['占比', undefined],
        ],
        [
          ['a', '10', '50%'],
          ['b', '20', '50%'],
        ],
      ),
    );

    expect(model.sortable).toBe(true);
    expect(model.head.map((c) => c.text)).toEqual(['表名', '行数', '占比']);
    expect(model.head[1]?.align).toBe('right');
    expect(model.head[2]?.align).toBeUndefined();
    expect(model.rows).toHaveLength(2);
    expect(model.rows[1]?.map((c) => c.text)).toEqual(['b', '20', '50%']);
  });

  it('没有 thead 就不排序：第一行是数据还是表头判不出来', () => {
    const bare: ReactNode[] = [
      h('tr', null, h('td', null, 'a'), h('td', null, '1')),
      h('tr', null, h('td', null, 'b'), h('td', null, '2')),
    ];
    const model = buildTableModel(bare);
    expect(model.sortable).toBe(false);
    expect(model.head).toEqual([]);
    expect(model.rows).toHaveLength(2);
  });
});

describe('toNumber', () => {
  it('吃下 agent 常见的数字写法', () => {
    expect(toNumber('1,234')).toBe(1234);
    expect(toNumber('1，234')).toBe(1234);
    expect(toNumber('-12')).toBe(-12);
    expect(toNumber('+12')).toBe(12);
    expect(toNumber('(1,234)')).toBe(-1234);
    expect(toNumber('50%')).toBe(50);
    expect(toNumber('¥1,000')).toBe(1000);
    expect(toNumber('$3.5')).toBe(3.5);
    expect(toNumber('1.2万')).toBe(12000);
    expect(toNumber('3 GB')).toBe(3e9);
    expect(toNumber('2k')).toBe(2000);
    expect(toNumber('1亿')).toBe(1e8);
    expect(toNumber('0.5')).toBe(0.5);
  });

  it('判不出来就返回 undefined，由调用方整列按文本排', () => {
    expect(toNumber('')).toBeUndefined();
    expect(toNumber('—')).toBeUndefined();
    expect(toNumber('null')).toBeUndefined();
    expect(toNumber('abc')).toBeUndefined();
    // 不认识的后缀不猜倍率：猜一个就是在排序里编造大小关系
    expect(toNumber('3 桶')).toBeUndefined();
    expect(toNumber('12px')).toBeUndefined();
    expect(toNumber('1.2.3')).toBeUndefined();
  });
});

describe('isNumericColumn', () => {
  const rows: TableCell[][] = [
    [cell('a'), cell('10'), cell('')],
    [cell('b'), cell('20'), cell('')],
    [cell('c'), cell('很多'), cell('')],
  ];

  it('混着文本的列不是数值列', () => {
    expect(isNumericColumn(rows, 0)).toBe(false);
    expect(isNumericColumn(rows, 1)).toBe(false);
  });

  it('全空的列不是数值列：没有可排的内容', () => {
    expect(isNumericColumn(rows, 2)).toBe(false);
  });

  it('有空单元格但其余都是数字时算数值列', () => {
    const withHole: TableCell[][] = [[cell('1'), cell('10')], [cell(''), cell('20')]];
    expect(isNumericColumn(withHole, 0)).toBe(true);
  });
});

describe('isPlottableColumn', () => {
  it('合计行与 NULL 占位符不把整列判死（这是与排序判据的关键差别）', () => {
    const rows: TableCell[][] = [
      [cell('1月'), cell('100')],
      [cell('2月'), cell('200')],
      [cell('合计'), cell('—')],
    ];
    // 严格判定会说这一列不是数值列 ⇒ 整张图画不出来
    expect(isNumericColumn(rows, 1)).toBe(false);
    expect(isPlottableColumn(rows, 1)).toBe(true);
  });

  it('主体是文本的列仍然不画：画出来是误导', () => {
    const rows: TableCell[][] = [[cell('1')], [cell('很多')], [cell('更多')]];
    expect(isPlottableColumn(rows, 0)).toBe(false);
  });

  it('恰好一半是数字时画（阈值取在"至少一半"）', () => {
    const rows: TableCell[][] = [[cell('1')], [cell('待定')]];
    expect(isPlottableColumn(rows, 0)).toBe(true);
  });

  it('全空的列不画', () => {
    expect(isPlottableColumn([[cell('')], [cell('')]], 0)).toBe(false);
  });
});

describe('sortRows', () => {
  const rows: TableCell[][] = [
    [cell('b'), cell('20')],
    [cell('a'), cell('')],
    [cell('c'), cell('3')],
  ];

  it('数值列按大小排，不按字符串排', () => {
    // 字符串排会得到 20 < 3，这正是必须区分两种列的原因
    expect(sortRows(rows, 1, 'asc', true).map((r) => r[0]?.text)).toEqual(['c', 'b', 'a']);
    expect(sortRows(rows, 1, 'desc', true).map((r) => r[0]?.text)).toEqual(['b', 'c', 'a']);
  });

  it('空值一律沉底，desc 时也不跑到最上面', () => {
    expect(sortRows(rows, 1, 'desc', true).at(-1)?.[0]?.text).toBe('a');
  });

  it('文本列用本地化数字感知比较', () => {
    const textRows: TableCell[][] = [[cell('第10行')], [cell('第9行')], [cell('第1行')]];
    expect(sortRows(textRows, 0, 'asc', false).map((r) => r[0]?.text)).toEqual(['第1行', '第9行', '第10行']);
  });

  it('返回新数组，不改调用方那一份', () => {
    const sorted = sortRows(rows, 0, 'asc', false);
    expect(sorted).not.toBe(rows);
    expect(rows.map((r) => r[0]?.text)).toEqual(['b', 'a', 'c']);
  });
});

describe('buildChartModel', () => {
  it('标签列取第一个非数值列，数值列全部进系列', () => {
    const model = buildTableModel(
      table(
        [
          ['月份', undefined],
          ['销售额', undefined],
          ['成本', undefined],
        ],
        [
          ['1月', '100', '60'],
          ['2月', '200', '80'],
        ],
      ),
    );
    const chart = buildChartModel(model);
    expect(chart?.labels).toEqual(['1月', '2月']);
    expect(chart?.series.map((s) => s.name)).toEqual(['销售额', '成本']);
    expect(chart?.series[0]?.values).toEqual([100, 200]);
  });

  it('全是数值列时用第 0 列当标签', () => {
    const model = buildTableModel(
      table(
        [
          ['月份', undefined],
          ['销售额', undefined],
        ],
        [
          ['1', '100'],
          ['2', '200'],
        ],
      ),
    );
    const chart = buildChartModel(model);
    expect(chart?.labels).toEqual(['1', '2']);
    expect(chart?.series.map((s) => s.name)).toEqual(['销售额']);
  });

  it('非数字的格子是 NaN 而不是 0：当 0 会把缺失值画成真实的零', () => {
    const model = buildTableModel(
      table(
        [
          ['月份', undefined],
          ['销售额', undefined],
        ],
        [
          ['1月', '100'],
          ['2月', '待定'],
        ],
      ),
    );
    const chart = buildChartModel(model);
    expect(chart?.series[0]?.values[1]).toBeNaN();
  });

  it('画不出图就返回 undefined，好让组件不渲染那个点了也是空白的按钮', () => {
    const oneCol = buildTableModel(table([['名字', undefined]], [['a'], ['b']]));
    expect(buildChartModel(oneCol)).toBeUndefined();

    const noNumeric = buildTableModel(
      table(
        [
          ['名字', undefined],
          ['说明', undefined],
        ],
        [['a', 'x']],
      ),
    );
    expect(buildChartModel(noNumeric)).toBeUndefined();

    const empty = buildTableModel(table([['名字', undefined], ['行数', undefined]], []));
    expect(buildChartModel(empty)).toBeUndefined();
  });

  it('最多取 4 条系列：再多颜色就分不开了', () => {
    const model = buildTableModel(
      table(
        [
          ['月份', undefined],
          ...['a', 'b', 'c', 'd', 'e', 'f'].map((n) => [n, undefined] as [string, undefined]),
        ],
        [['1月', '1', '2', '3', '4', '5', '6']],
      ),
    );
    expect(buildChartModel(model)?.series).toHaveLength(4);
  });
});
