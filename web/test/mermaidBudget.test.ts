import { describe, expect, it } from 'vitest';

import { MAX_MERMAID_CHARS, MAX_MERMAID_EDGES, mermaidBudget } from '@/lib/mermaidBudget';

/**
 * mermaid 的规模护栏。
 *
 * 上限一律用**字面量**断言（50000 / 500），不用被测常量算期望值：
 * 这条判据的唯一失效模式是"上限被改宽了、护栏形同不存在"，自指断言对取值零判别力。
 */

/** 生成 n 条边、每条一行的最小图。 */
function graphWithEdges(n: number): string {
  const lines: string[] = ['graph TD'];
  for (let i = 0; i < n; i += 1) lines.push(`n${i} --> n${i + 1}`);
  return lines.join('\n');
}

describe('mermaidBudget：正常规模的图放行', () => {
  it('一张十几个节点的流程图不触发任何护栏', () => {
    const b = mermaidBudget(graphWithEdges(12));
    expect(b.refusal).toBeUndefined();
    expect(b.edges).toBe(12);
    expect(b.chars).toBeLessThan(300);
  });

  it('常量取值本身就是护栏的全部效力，钉住字面量', () => {
    expect(MAX_MERMAID_CHARS).toBe(50_000);
    expect(MAX_MERMAID_EDGES).toBe(500);
  });
});

describe('mermaidBudget：边数上限', () => {
  it('正好 500 条边放行', () => {
    expect(mermaidBudget(graphWithEdges(500)).refusal).toBeUndefined();
  });

  it('501 条边拒绝：布局成本随边数涨，几百条边就能占住主线程几十秒', () => {
    const b = mermaidBudget(graphWithEdges(501));
    expect(b.edges).toBe(501);
    expect(b.refusal).toBeDefined();
    expect(b.refusal).toContain('501');
    expect(b.refusal).toContain('500');
  });

  it('拒绝文案说清"没有送去渲染"与主线程会被占住，不是一句空泛的"太大了"', () => {
    const refusal = mermaidBudget(graphWithEdges(900)).refusal ?? '';
    expect(refusal).toContain('没有送去渲染');
    expect(refusal).toContain('主线程');
  });
});

describe('mermaidBudget：字符上限', () => {
  it('正好 50000 字放行', () => {
    expect(mermaidBudget('a'.repeat(50_000)).refusal).toBeUndefined();
  });

  it('50001 字拒绝，文案里带上实际字数与上限', () => {
    const b = mermaidBudget('a'.repeat(50_001));
    expect(b.chars).toBe(50_001);
    expect(b.refusal).toContain('50,001');
    expect(b.refusal).toContain('50,000');
  });

  it('字符超限优先于边数超限报告：先说"这张定义有多长"，比说边数更接近用户的直觉', () => {
    // 50001 字、且每条边都在里面（远超 500 条）
    const code = graphWithEdges(900) + 'a'.repeat(60_000);
    const b = mermaidBudget(code);
    expect(b.refusal).toContain('字');
    expect(b.refusal).not.toContain('边');
  });
});

describe('mermaidBudget：数箭头的启发式', () => {
  /**
   * 这条钉的是"一支箭头只数一条"。
   * 数错方向虽然是"多算"（护栏可接受），但拒绝文案里的数字是用户判断
   * "要不要拆图"的唯一依据，明显偏大就等于给了假情报。
   * 注：分支先后顺序实测不影响计数，所以这里不针对顺序做断言。
   */
  it('各种箭头写法各算一条，不会把一支数成两支', () => {
    expect(mermaidBudget('a --> b').edges).toBe(1);
    expect(mermaidBudget('a -.-> b').edges).toBe(1);
    expect(mermaidBudget('a ==> b').edges).toBe(1);
    expect(mermaidBudget('a ~~~ b').edges).toBe(1);
    expect(mermaidBudget('a <-- b').edges).toBe(1);
    expect(mermaidBudget('Alice ->> John: hi').edges).toBe(1);
  });

  it('链式的每一支都数到', () => {
    expect(mermaidBudget('a --> b --> c --> d').edges).toBe(3);
  });

  it('没有箭头就是 0 条边', () => {
    expect(mermaidBudget('graph TD\n  A[开始]\n  B[结束]').edges).toBe(0);
  });

  it('重复调用结果稳定：正则带 /g，lastIndex 漏复位会让第二次少算', () => {
    const code = graphWithEdges(30);
    expect(mermaidBudget(code).edges).toBe(mermaidBudget(code).edges);
    expect(mermaidBudget(code).edges).toBe(30);
  });
});
