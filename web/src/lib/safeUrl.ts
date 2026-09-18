/**
 * URL 安全过滤。
 *
 * 回答正文是 agent 产出的、**不受本工程控制**的内容，直接渲染成 `<a href>` /
 * `<img src>` 就是一个注入面：`javascript:alert(1)` 在点击时执行，
 * `data:text/html,…` 在图片解析失败时也可能被某些浏览器当文档打开。
 * Markdown 语法本身挡不住这些——`[点我](javascript:…)` 是完全合法的 Markdown。
 *
 * 判据用**白名单协议**而不是黑名单关键词：黑名单要枚举 `java\u0000script:`、
 * 前导空白、大小写混写、HTML 实体编码等绕过形态，漏一个就是漏洞；
 * 白名单只需列出这个场景真会用到的两种协议。
 */

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** 图片只允许 http(s) 与 data:image/*；`data:text/html` 必须挡掉。 */
const SAFE_IMAGE_PROTOCOLS = new Set(['http:', 'https:']);

function parse(url: string | undefined): URL | undefined {
  if (url === undefined) return undefined;
  /**
   * 去掉所有控制字符与空白再解析。
   *
   * 真正靠这一步挡住的是 **NUL 字节**：WHATWG URL 自己会剥掉制表符与换行
   * （`java\tscript:` 剥完仍是 javascript:，会被协议白名单挡下），但**不剥 NUL**，
   * 于是 `javascript\u0000:alert(1)` 会被解析成一个协议未知的相对路径，
   * 走到下面 `!raw.includes(':')` 那条相对路径放行分支上去。
   * 这一条由 `web/test/safeUrl.test.ts` 钉住：删掉这行清洗，测试会红。
   */
  const cleaned = url.replace(/[\u0000-\u0020\u007f]/g, '');
  if (cleaned === '') return undefined;
  try {
    return new URL(cleaned, 'http://invalid.local');
  } catch {
    return undefined;
  }
}

/** 解析失败一律当成不安全：判不出来就不渲染成链接，比猜错方向安全。 */
export function isSafeHref(url: string | undefined): boolean {
  // 相对链接与纯锚点没有协议部分，本身不可执行脚本
  const raw = url?.trim();
  if (raw === undefined || raw === '') return false;
  if (raw.startsWith('/') || raw.startsWith('#') || raw.startsWith('?')) return true;

  const parsed = parse(raw);
  if (parsed === undefined) return false;
  if (SAFE_LINK_PROTOCOLS.has(parsed.protocol)) return true;
  // `new URL('foo:bar')` 会把 foo: 当协议；没有冒号的就是相对路径
  return !raw.includes(':');
}

export function isSafeImageSrc(url: string | undefined): boolean {
  const raw = url?.trim();
  if (raw === undefined || raw === '') return false;

  if (raw.toLowerCase().startsWith('data:')) {
    /**
     * 只放行位图 MIME，且要求 base64（明文 data-uri 里可以塞 HTML 片段）。
     *
     * **刻意不放行 `image/svg+xml`**：SVG 能内嵌 `<script>` 与外部引用。它在 `<img>`
     * 里确实不执行，但用户把地址复制到新标签页打开就会执行——一个"看着是图片"的
     * 链接不该有这种第二形态。少支持一种格式，换掉一整类绕过。
     */
    return /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,/i.test(raw);
  }

  const parsed = parse(raw);
  if (parsed === undefined) return false;
  if (SAFE_IMAGE_PROTOCOLS.has(parsed.protocol)) return true;
  return !raw.includes(':');
}
