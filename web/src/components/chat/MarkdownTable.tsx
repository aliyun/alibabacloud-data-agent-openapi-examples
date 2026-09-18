import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { BarChart3, LineChart, Table2 } from 'lucide-react';

import {
  buildChartModel,
  buildTableModel,
  isNumericColumn,
  sortRows,
  type SortDir,
} from '@/lib/tableModel';
import { cn } from '@/lib/utils';
import { formatCount } from '@/lib/format';

/**
 * 增强表格：排序 + 列宽拖拽 + 图表视图。
 *
 * 为什么值得单独做：DataAgent 的核心产出就是查询结果表，而 agent 交回来的是
 * Markdown 表格——纯静态渲染时用户想按某一列看排序，只能把整段文本拷出去贴到 Excel。
 *
 * **图表取自表格本身，不另立协议**：不做 ```chart 这种自定义围栏块，因为上游
 * agent 永远不会主动输出它，那会是一块点了也没数据的死 UI。表格里的数值列是
 * 真实存在的数据，从它取数才有意义。
 */

const CHART_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];

const CHART_W = 640;
const CHART_H = 240;
const PAD = { top: 12, right: 12, bottom: 40, left: 48 };

export function MarkdownTable({ children }: { children: ReactNode }) {
  const model = useMemo(() => buildTableModel(children), [children]);
  const [sort, setSort] = useState<{ col: number; dir: SortDir } | undefined>(undefined);
  const [widths, setWidths] = useState<Array<number | undefined>>([]);
  const [chart, setChart] = useState<'bar' | 'line' | undefined>(undefined);

  const numeric = useMemo(
    () => model.head.map((_, i) => isNumericColumn(model.rows, i)),
    [model],
  );

  const rows = useMemo(
    () => (sort ? sortRows(model.rows, sort.col, sort.dir, numeric[sort.col] === true) : model.rows),
    [model.rows, sort, numeric],
  );

  /**
   * 图表数据无条件算一次，按钮的显隐就等于它是否非空。
   *
   * 刻意不再另写一个"能不能画图"的判据：那会用排序那套**严格**的数值列判定，
   * 而取数用的是宽松判定，两者不一致时就会渲染出一个点了只说
   * "这张表里没有可用于作图的数值"的按钮。
   */
  const chartModel = useMemo(() => buildChartModel({ ...model, rows }), [model, rows]);

  const toggleSort = useCallback(
    (col: number) => {
      setSort((prev) =>
        prev?.col === col
          ? prev.dir === 'asc'
            ? { col, dir: 'desc' }
            : // 第三次点同一列 = 回到原始顺序（agent 给的顺序往往就是 ORDER BY 的结果）
              undefined
          : { col, dir: 'asc' },
      );
    },
    [],
  );

  const drag = useRef<{ col: number; startX: number; startWidth: number } | undefined>(undefined);

  function onHandleDown(event: ReactPointerEvent<HTMLSpanElement>, col: number): void {
    const th = (event.currentTarget as HTMLElement).closest('th');
    if (th === null) return;
    drag.current = { col, startX: event.clientX, startWidth: th.getBoundingClientRect().width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onHandleMove(event: ReactPointerEvent<HTMLSpanElement>): void {
    const state = drag.current;
    if (state === undefined) return;
    const next = Math.max(48, Math.round(state.startWidth + (event.clientX - state.startX)));
    setWidths((prev) => {
      const copy = [...prev];
      copy[state.col] = next;
      return copy;
    });
  }

  function onHandleUp(event: ReactPointerEvent<HTMLSpanElement>): void {
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const fixed = widths.some((w) => w !== undefined);
  const canChart = model.sortable && chartModel !== undefined;

  return (
    <div className="my-3 space-y-1.5">
      {canChart && (
        <div className="flex items-center gap-1" role="group" aria-label="表格视图切换">
          <ViewButton active={chart === undefined} onClick={() => setChart(undefined)} label="表格">
            <Table2 className="size-3" />
          </ViewButton>
          <ViewButton active={chart === 'bar'} onClick={() => setChart('bar')} label="柱状图">
            <BarChart3 className="size-3" />
          </ViewButton>
          <ViewButton active={chart === 'line'} onClick={() => setChart('line')} label="折线图">
            <LineChart className="size-3" />
          </ViewButton>
        </div>
      )}

      {chart !== undefined && chartModel !== undefined ? (
        <Chart kind={chart} labels={chartModel.labels} series={chartModel.series} />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table
            className={cn(
              'w-full border-collapse text-[0.85em]',
              // 只有真的拖过列宽才切 fixed：table-fixed 会让未设宽度的列平分剩余空间，
              // 内容长短差异大时反而更难读
              fixed && 'table-fixed',
            )}
          >
            {model.sortable && (
              <thead>
                <tr>
                  {model.head.map((cell, i) => (
                    <th
                      key={i}
                      scope="col"
                      aria-sort={
                        sort?.col === i
                          ? sort.dir === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                      style={{ width: widths[i], textAlign: cell.align }}
                      className="relative border-b border-border bg-muted px-2 py-1 font-semibold"
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(i)}
                        title={
                          sort?.col === i
                            ? sort.dir === 'asc'
                              ? '再点一次改成降序'
                              : '再点一次恢复原始顺序'
                            : '点一次升序'
                        }
                        className={cn(
                          'max-w-full truncate text-left hover:text-primary',
                          cell.align === 'center' && 'text-center',
                          cell.align === 'right' && 'text-right',
                        )}
                      >
                        {cell.node}
                        {numeric[i] && <span className="ml-1 text-[0.85em] text-muted-foreground">#</span>}
                        {sort?.col === i && (
                          <span className="ml-0.5 text-[0.85em]">{sort.dir === 'asc' ? '↑' : '↓'}</span>
                        )}
                      </button>
                      <span
                        role="separator"
                        aria-orientation="vertical"
                        title="拖拽调整列宽"
                        onPointerDown={(e) => onHandleDown(e, i)}
                        onPointerMove={onHandleMove}
                        onPointerUp={onHandleUp}
                        onPointerCancel={onHandleUp}
                        className="absolute inset-y-0 -right-1 w-2 cursor-col-resize touch-none hover:bg-primary/30"
                      />
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {(model.sortable ? rows : model.rows).map((row, ri) => (
                <tr key={ri} className={ri % 2 === 1 ? 'bg-muted/40' : undefined}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      style={{ textAlign: cell.align }}
                      className="border-b border-border px-2 py-1 align-top"
                    >
                      {cell.node}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors',
        active
          ? 'border-primary/40 bg-accent text-foreground'
          : 'border-border text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
      {label}
    </button>
  );
}

interface ChartProps {
  kind: 'bar' | 'line';
  labels: string[];
  series: Array<{ name: string; values: number[] }>;
}

/**
 * 内联 SVG 图表。
 *
 * 刻意不引图表库：这个场景只需要柱状与折线两种形态，recharts / echarts 的体积
 * 与本工程"首屏只加载会话列表"的取舍相冲突。
 *
 * NaN 表示"这一格不是数字"，画的时候跳过而不是当 0 —— 当 0 会让缺失值看起来
 * 像一个真实的零，在数据场景里那是错误的信息。
 */
function Chart({ kind, labels, series }: ChartProps) {
  const plotW = CHART_W - PAD.left - PAD.right;
  const plotH = CHART_H - PAD.top - PAD.bottom;

  const all = series.flatMap((s) => s.values.filter((v) => Number.isFinite(v)));
  const rawMax = Math.max(...all, 0);
  const rawMin = Math.min(...all, 0);
  const max = niceCeil(rawMax);
  const min = rawMin < 0 ? -niceCeil(-rawMin) : 0;
  const span = max - min || 1;

  const y = (value: number): number => PAD.top + plotH - ((value - min) / span) * plotH;
  const step = plotW / Math.max(labels.length, 1);
  const ticks = [min, (min + max) / 2, max];

  return (
    <figure className="overflow-x-auto rounded-md border border-border bg-card p-2">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${kind === 'bar' ? '柱状图' : '折线图'}：${labels.length} 行 × ${series.map((s) => s.name).join('、')}`}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={CHART_W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(t) + 3}
              textAnchor="end"
              fontSize={9}
              fill="var(--muted-foreground)"
            >
              {formatCount(t)}
            </text>
          </g>
        ))}

        {kind === 'bar'
          ? series.map((s, si) => {
              const groupW = step * 0.72;
              const barW = groupW / series.length;
              return s.values.map((v, i) => {
                if (!Number.isFinite(v)) return null;
                const x = PAD.left + step * i + (step - groupW) / 2 + barW * si;
                const top = y(Math.max(v, 0));
                const bottom = y(Math.min(v, 0));
                return (
                  <rect
                    key={`${si}-${i}`}
                    x={x}
                    y={top}
                    width={Math.max(barW - 1, 1)}
                    height={Math.max(bottom - top, 1)}
                    fill={CHART_COLORS[si % CHART_COLORS.length]}
                  >
                    <title>{`${labels[i] ?? ''} · ${s.name} = ${v}`}</title>
                  </rect>
                );
              });
            })
          : series.map((s, si) => {
              const points = s.values
                .map((v, i) => (Number.isFinite(v) ? `${PAD.left + step * (i + 0.5)},${y(v)}` : null))
                .filter((p): p is string => p !== null);
              return (
                <g key={si}>
                  <polyline
                    points={points.join(' ')}
                    fill="none"
                    stroke={CHART_COLORS[si % CHART_COLORS.length]}
                    strokeWidth={1.5}
                  />
                  {s.values.map((v, i) =>
                    Number.isFinite(v) ? (
                      <circle
                        key={i}
                        cx={PAD.left + step * (i + 0.5)}
                        cy={y(v)}
                        r={2}
                        fill={CHART_COLORS[si % CHART_COLORS.length]}
                      >
                        <title>{`${labels[i] ?? ''} · ${s.name} = ${v}`}</title>
                      </circle>
                    ) : null,
                  )}
                </g>
              );
            })}

        {labels.map((label, i) => (
          <text
            key={i}
            x={PAD.left + step * (i + 0.5)}
            y={CHART_H - PAD.bottom + 12}
            fontSize={9}
            textAnchor={labels.length > 8 ? 'end' : 'middle'}
            fill="var(--muted-foreground)"
            transform={labels.length > 8 ? `rotate(-35 ${PAD.left + step * (i + 0.5)} ${CHART_H - PAD.bottom + 12})` : undefined}
          >
            {truncateLabel(label)}
          </text>
        ))}

        {min < 0 && (
          <line
            x1={PAD.left}
            x2={CHART_W - PAD.right}
            y1={y(0)}
            y2={y(0)}
            stroke="var(--foreground)"
            strokeOpacity={0.35}
            strokeWidth={1}
          />
        )}
      </svg>

      {series.length > 1 && (
        <figcaption className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
          {series.map((s, i) => (
            <span key={s.name} className="flex items-center gap-1">
              <span
                className="inline-block size-2 rounded-sm"
                style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
              />
              {s.name}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

/** 轴上限取整到"好看"的数：直接取 max 会让最高的那根柱子顶到边框上。 */
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

function truncateLabel(label: string): string {
  return label.length > 10 ? `${label.slice(0, 9)}…` : label;
}
