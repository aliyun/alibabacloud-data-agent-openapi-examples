/**
 * 右栏各 tab 的加载态：骨架形状 + 一条读屏能播报的状态。
 *
 * 三件事必须一起做，缺一件就有具体的坏处：
 *  · **骨架**而不是一个转圈图标——占位高度先确定下来，数据一到不会因为高度突变
 *    把面板内容顶走；
 *  · `role="status"` ——这是右栏唯一会让读屏主动播报"正在加载"的地方，
 *    没有它，视障用户点完 tab 之后听到的是一片沉默，只能靠猜；
 *  · 文案里带上**接口名**——右栏五个 tab 打的是五个不同接口，
 *    而其中一个（LoadAgentSession）在会话 RUNNING 期实测有约一半概率阻塞到 178s。
 *    只写"正在加载"的话，用户不知道该不该等下去。
 *
 * 状态文案必须挂在 `aria-hidden` 容器**外面**：写进去读屏就读不到了。
 */
export interface PanelLoadingProps {
  /** 正在调用的上游接口名，例如 ListAgentSessionArtifacts。 */
  api: string;
  /** 额外补一句处境说明，例如"会话运行中时这一步可能要等很久"。 */
  note?: string;
  /** 骨架行数，按这个 tab 数据到达后的大致高度给。 */
  rows?: number;
}

export function PanelLoading({ api, note, rows = 4 }: PanelLoadingProps) {
  return (
    <div className="space-y-2">
      <p className="sr-only" role="status">
        正在调用 {api}
        {note === undefined ? '' : `，${note}`}…
      </p>
      <div aria-hidden className="space-y-2">
        {Array.from({ length: rows }, (_, i) => (
          <div
            key={i}
            className="skeleton h-3.5 rounded"
            style={{ width: `${100 - ((i * 13) % 45)}%` }}
          />
        ))}
      </div>
      <p className="pt-1 font-mono text-[10px] text-muted-foreground">
        {api}
        {note === undefined ? '' : ` · ${note}`}
      </p>
    </div>
  );
}
