import { describe, expect, it } from 'vitest';

import { isSafeHref, isSafeImageSrc } from '@/lib/safeUrl';

/**
 * 这是全工程唯一的**安全**单测：回答正文是 agent 产出的、不受本工程控制的内容，
 * 过滤判据一旦放宽就是一个点击即执行的注入面。
 *
 * 所以这里的用例是**攻击形态清单**而不是"正常链接能用"的冒烟测试：
 * 每条 deny 都对应一种真实绕过手法，任何一条翻成 true 都必须让 CI 红。
 */

describe('isSafeHref', () => {
  it('放行 http/https/mailto', () => {
    expect(isSafeHref('http://example.com/a')).toBe(true);
    expect(isSafeHref('https://example.com/a?b=1#c')).toBe(true);
    expect(isSafeHref('mailto:someone@example.com')).toBe(true);
    expect(isSafeHref('HTTPS://EXAMPLE.COM')).toBe(true);
  });

  it('放行相对路径与锚点', () => {
    expect(isSafeHref('/docs/guide')).toBe(true);
    expect(isSafeHref('#section')).toBe(true);
    expect(isSafeHref('?page=2')).toBe(true);
    expect(isSafeHref('guide.md')).toBe(true);
  });

  it('挡掉 javascript: 及其常见变形', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('JaVaScRiPt:alert(1)')).toBe(false);
    // 前导空白：URL 解析器会 trim，但判据不能依赖它
    expect(isSafeHref('   javascript:alert(1)')).toBe(false);
    // 内嵌制表符/换行：某些浏览器会先剥掉再解析
    expect(isSafeHref('java\tscript:alert(1)')).toBe(false);
    expect(isSafeHref('java\nscript:alert(1)')).toBe(false);
    expect(isSafeHref('javascript\u0000:alert(1)')).toBe(false);
  });

  it('挡掉其它可执行协议', () => {
    expect(isSafeHref('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeHref('file:///etc/passwd')).toBe(false);
    expect(isSafeHref('blob:https://example.com/uuid')).toBe(false);
  });

  it('挡掉空值与解析不出来的地址', () => {
    expect(isSafeHref(undefined)).toBe(false);
    expect(isSafeHref('')).toBe(false);
    expect(isSafeHref('   ')).toBe(false);
    expect(isSafeHref('http://')).toBe(false);
  });
});

describe('isSafeImageSrc', () => {
  it('放行 http(s) 图片', () => {
    expect(isSafeImageSrc('https://example.com/a.png')).toBe(true);
    expect(isSafeImageSrc('/img/a.png')).toBe(true);
  });

  it('放行位图 data-uri（必须 base64）', () => {
    expect(isSafeImageSrc('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isSafeImageSrc('data:image/jpeg;base64,/9j/4AAQ')).toBe(true);
    expect(isSafeImageSrc('DATA:IMAGE/WEBP;BASE64,xxx')).toBe(true);
  });

  it('挡掉 svg data-uri：SVG 能内嵌 script，在新标签页打开就会执行', () => {
    expect(isSafeImageSrc('data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==')).toBe(false);
    expect(isSafeImageSrc('data:image/svg+xml;utf8,<svg/>')).toBe(false);
  });

  it('挡掉明文 data-uri 与非图片 MIME', () => {
    expect(isSafeImageSrc('data:image/png,<script>alert(1)</script>')).toBe(false);
    expect(isSafeImageSrc('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
  });

  it('挡掉可执行协议', () => {
    expect(isSafeImageSrc('javascript:alert(1)')).toBe(false);
    expect(isSafeImageSrc('java\tscript:alert(1)')).toBe(false);
  });
});
