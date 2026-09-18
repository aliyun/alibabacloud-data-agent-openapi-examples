/**
 * 复制到剪贴板。
 *
 * 带兜底是因为 `navigator.clipboard` **只在安全上下文里存在**：用 http://192.168.x.x:5173
 * 从局域网另一台机器访问这个 dev server 时（样板工程很常见的用法），它是 undefined，
 * 直接调用会抛 TypeError。原来的写法把失败静默吃掉，用户点了"复制"却没复制上，
 * 也得不到任何提示。
 *
 * 兜底走 `execCommand('copy')`：已被标记为废弃，但它是非安全上下文里唯一可用的路径，
 * 而且这里的用途（把已经在屏幕上的代码拷走）不涉及任何权限提升。
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 权限被拒或标签页失焦，继续走兜底
    }
  }

  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = text;
  // 放到视口外而不是 display:none —— 后者在某些浏览器里不会被选中
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
