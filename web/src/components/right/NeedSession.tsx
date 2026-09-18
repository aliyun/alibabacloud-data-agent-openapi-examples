/** 右栏各 tab 共用的一句空态：没选会话时什么接口都不该发。 */
export function NeedSession() {
  return <p className="px-3 py-6 text-center text-xs text-muted-foreground">先在左栏选择一个会话。</p>;
}
