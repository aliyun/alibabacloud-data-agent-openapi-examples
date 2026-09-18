import { describe, expect, it } from 'vitest';
import { createTurn, type ToolCallView, type TurnAggregate } from '@das/shared';

import { buildExportHtml, exportFilename } from '@/lib/exportHtml';

/**
 * 导出 HTML。
 *
 * 这里最该钉住的是**转义**：导出件会被双击打开、可能被转发，而正文全是上游给的
 * 任意内容。一处漏转义就是一个能在别人机器上跑起来的脚本。其余断言围绕另一件事——
 * 界面上默认折叠的部分（思考过程、工具结果）在导出件里必须在场，
 * 否则"导出"就是静默丢内容。
 */

const AT = Date.parse('2026-09-16T12:00:00Z');

function tool(patch: Partial<ToolCallView>): ToolCallView {
  return {
    toolCallId: 'call-1',
    name: 'shell',
    title: '查询行数',
    status: 'completed',
    command: 'odps -e "select count(*) from t"',
    description: undefined,
    rawInput: { command: 'odps -e "select count(*) from t"' },
    locations: [],
    resultText: 'Exit Code: 0\n1234',
    firstOffset: 1,
    lastOffset: 9,
    firstTimestamp: undefined,
    lastTimestamp: undefined,
    ...patch,
  };
}

function makeTurn(patch: Partial<TurnAggregate>): TurnAggregate {
  return { ...createTurn(), ...patch };
}

describe('buildExportHtml', () => {
  it('正文里的尖括号与引号一律转义，导出件里不存在 script 标签', () => {
    const html = buildExportHtml({
      sessionId: 's-1',
      title: '会话',
      turns: [
        makeTurn({
          userText: '<script>alert(1)</script>',
          messageText: '<img src=x onerror="alert(2)"> & "引号" \'单引\'',
        }),
      ],
      exportedAt: AT,
      mock: false,
    });

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onerror="');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&#39;');
  });

  it('标题里的注入内容也走转义（title 可能是用户改的本地别名）', () => {
    const html = buildExportHtml({
      sessionId: 's-1',
      title: '</title><script>alert(3)</script>',
      turns: [],
      exportedAt: AT,
      mock: false,
    });
    expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(3)&lt;/script&gt;</title>');
  });

  it('界面上折叠的思考过程与工具结果在导出件里在场', () => {
    const html = buildExportHtml({
      sessionId: 's-1',
      title: '一轮',
      turns: [
        makeTurn({
          rid: 'rid-abc',
          userText: '统计行数',
          thoughtText: '先看看表结构',
          messageText: '一共 1234 行',
          tools: [tool({})],
          stopReason: 'end_turn',
          frameCount: 42,
          tokenUsage: { totalTokens: 8_888 },
        }),
      ],
      exportedAt: AT,
      mock: false,
    });

    expect(html).toContain('思考过程');
    expect(html).toContain('先看看表结构');
    expect(html).toContain('工具调用');
    expect(html).toContain('result:');
    expect(html).toContain('Exit Code: 0');
    expect(html).toContain('回答');
    expect(html).toContain('一共 1234 行');
    expect(html).toContain('rid=rid-abc');
    expect(html).toContain('stopReason=end_turn');
    expect(html).toContain('42 帧');
    expect(html).toContain('8888 tokens');
  });

  it('头部照实标出数据来源：MOCK 回放必须显眼，不能被当成线上结论转发', () => {
    const mockHtml = buildExportHtml({ sessionId: 's', title: 't', turns: [], exportedAt: AT, mock: true });
    const liveHtml = buildExportHtml({ sessionId: 's', title: 't', turns: [], exportedAt: AT, mock: false });
    expect(mockHtml).toContain('<strong>MOCK 回放数据</strong>');
    expect(mockHtml).not.toContain('LIVE 真实接口');
    expect(liveHtml).toContain('LIVE 真实接口');
    expect(liveHtml).not.toContain('MOCK 回放数据');
  });

  it('没有轮次时明说，而不是吐一个空 body（空文件分不清"没内容"和"导出坏了"）', () => {
    const html = buildExportHtml({ sessionId: 's', title: 't', turns: [], exportedAt: AT, mock: false });
    expect(html).toContain('0 轮');
    expect(html).toContain('这个会话没有可导出的轮次');
  });

  it('多轮按顺序编号', () => {
    const html = buildExportHtml({
      sessionId: 's',
      title: 't',
      turns: [makeTurn({ userText: '第一轮' }), makeTurn({ userText: '第二轮' })],
      exportedAt: AT,
      mock: false,
    });
    expect(html).toContain('第 1 轮');
    expect(html).toContain('第 2 轮');
    expect(html).toContain('2 轮');
    expect(html.indexOf('第一轮')).toBeLessThan(html.indexOf('第二轮'));
  });

  it('产出的是一个完整独立的文档：doctype / lang / charset 都在', () => {
    const html = buildExportHtml({ sessionId: 's', title: 't', turns: [], exportedAt: AT, mock: false });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });
});

describe('exportFilename', () => {
  it('带会话 id 与本地时间戳，扩展名是 html', () => {
    const name = exportFilename('abc-123', AT);
    expect(name).toMatch(/^das-session-abc-123-\d{8}-\d{6}\.html$/);
  });

  it('id 里的分隔符与非常规字符被替换掉，文件名始终是一个路径分量', () => {
    const name = exportFilename('../../etc/passwd', AT);
    expect(name.startsWith('das-session-')).toBe(true);
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(exportFilename('a/b:c*d?\u0000', AT)).toMatch(/^das-session-[A-Za-z0-9._-]+-\d{8}-\d{6}\.html$/);
  });

  it('空 id 回落到 session，不会产出 `das-session--20260916.html` 这种看不出来源的名字', () => {
    expect(exportFilename('', AT)).toMatch(/^das-session-session-/);
  });

  it('超长 id 截断到 64 字符，避免撞上文件系统的名字长度上限', () => {
    expect(exportFilename('x'.repeat(300), AT)).toMatch(/^das-session-x{64}-\d{8}-\d{6}\.html$/);
  });
});
