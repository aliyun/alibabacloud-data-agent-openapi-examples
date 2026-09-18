import { describe, expect, it } from 'vitest';

import {
  distanceToBottom,
  followAfterScroll,
  hasOverflow,
  isNearBottom,
  metricsOf,
  scrolledUp,
  shouldAutoScroll,
  shouldShowJump,
} from '@/lib/scrollPolicy';

/**
 * 滚动跟随判据。
 *
 * 这一组规则在浏览器里几乎验不出来：流式期间每秒约 4.7 帧，"抢滚动条"与"不抢"的
 * 差别只出现在用户往上翻的那一瞬间，而内置浏览器是隐藏标签页（rAF 被暂停、
 * 动画冻结），恰好把这条路径整个屏蔽掉了。所以判据全部抽成纯函数在这里钉住，
 * DOM 胶水（useAutoScroll）只负责把它们接到 scroll 事件上。
 */

/** 一屏 500px、内容 2000px、当前停在某处。 */
function at(scrollTop: number, scrollHeight = 2000, clientHeight = 500) {
  return { scrollHeight, scrollTop, clientHeight };
}

describe('distanceToBottom', () => {
  it('按 scrollHeight - scrollTop - clientHeight 算', () => {
    expect(distanceToBottom(at(0))).toBe(1500);
    expect(distanceToBottom(at(1000))).toBe(500);
  });

  it('已经在底部时是 0', () => {
    expect(distanceToBottom(at(1500))).toBe(0);
  });

  it('内容不足一屏时不给负数（否则阈值判据会被负值悄悄放宽）', () => {
    expect(distanceToBottom(at(0, 300, 500))).toBe(0);
  });

  it('容忍小数 scrollTop（触摸板惯性滚动会给出一堆小数）', () => {
    expect(distanceToBottom(at(1499.4))).toBeCloseTo(0.6, 5);
  });
});

describe('isNearBottom', () => {
  /**
   * 这两条用字面量，不用 NEAR_BOTTOM_PX 自己算边界。
   *
   * 自指断言对**取值**零判别力：变异验证时把常量改成 0，
   * `at(1500 - NEAR_BOTTOM_PX)` 会跟着变成 `at(1500)`，用例照样全绿——
   * 而 0 意味着跟随永远不会脱离，长轮里滚动条会被一路抢到底。
   * 120px 是调出来的（约 5 行正文），要改它就得连带改这两条。
   */
  it('距底部 120px 以内算跟随', () => {
    expect(isNearBottom(at(1500))).toBe(true); // 距底 0
    expect(isNearBottom(at(1400))).toBe(true); // 距底 100
    expect(isNearBottom(at(1380))).toBe(true); // 距底 120，正好在阈值上
  });

  it('距底 121px 就脱离跟随', () => {
    expect(isNearBottom(at(1379))).toBe(false);
    expect(isNearBottom(at(0))).toBe(false); // 距底 1500
  });

  it('阈值不是 0：内容不足一屏时永远算在底部', () => {
    expect(isNearBottom(at(0, 300, 500))).toBe(true);
  });
});

describe('hasOverflow', () => {
  it('内容超过一屏才算有可滚动距离', () => {
    expect(hasOverflow(at(0, 2000, 500))).toBe(true);
  });

  it('正好一屏不算', () => {
    expect(hasOverflow(at(0, 500, 500))).toBe(false);
  });

  it('差 1px 不算：留给亚像素取整，否则缩放比例非整数时会挂着一个点了没反应的按钮', () => {
    expect(hasOverflow(at(0, 501, 500))).toBe(false);
    expect(hasOverflow(at(0, 502, 500))).toBe(true);
  });

  it('与滚到哪里无关（只看内容总高）', () => {
    expect(hasOverflow(at(1500, 2000, 500))).toBe(true);
  });
});

describe('shouldAutoScroll', () => {
  it('只有"仍在跟随且没在选中文本"才落底', () => {
    expect(shouldAutoScroll(true, false)).toBe(true);
    expect(shouldAutoScroll(true, true)).toBe(false);
    expect(shouldAutoScroll(false, false)).toBe(false);
    expect(shouldAutoScroll(false, true)).toBe(false);
  });
});

describe('shouldShowJump', () => {
  it('翻上去了且确实有得滚才显示按钮', () => {
    expect(shouldShowJump(false, at(0))).toBe(true);
  });

  it('仍在跟随时不显示', () => {
    expect(shouldShowJump(true, at(0))).toBe(false);
    expect(shouldShowJump(true, at(1500))).toBe(false);
  });

  it('脱离跟随但内容不足一屏时也不显示（那种情况下跟随态本就恒为 true，这里是双保险）', () => {
    expect(shouldShowJump(false, at(0, 300, 500))).toBe(false);
  });
});

describe('metricsOf', () => {
  it('只挑三个量，多余的属性不带进判据', () => {
    const el = { scrollHeight: 900, scrollTop: 10, clientHeight: 400, offsetTop: 77, id: 'x' };
    expect(metricsOf(el)).toEqual({ scrollHeight: 900, scrollTop: 10, clientHeight: 400 });
  });
});

/**
 * 方向判据。
 *
 * 这一组用例钉的是本批次唯一一处"按距离判会出错"的场景：流式期间内容一帧一帧长高，
 * `scrollHeight` 已经跳了而 `scrollTop` 还没跟上，这中间来一次滚动事件，
 * 按"离底部多远"判就会认为用户翻上去了——他什么都没做，跟随却断了，
 * 此后新内容不再落底，长轮里正文一路往上跑出视野。
 */
describe('scrolledUp', () => {
  const m = (scrollHeight: number, scrollTop: number, clientHeight = 400) => ({
    scrollHeight,
    scrollTop,
    clientHeight,
  });

  it('真的往上翻了一次才算', () => {
    expect(scrolledUp(m(2000, 800), m(2000, 700))).toBe(true);
  });

  it('往下滚不算上翻', () => {
    expect(scrolledUp(m(2000, 800), m(2000, 900))).toBe(false);
  });

  it('位置没动不算', () => {
    expect(scrolledUp(m(2000, 800), m(2000, 800))).toBe(false);
  });

  it('1px 以内的抖动不算（高分屏的亚像素滚动）', () => {
    expect(scrolledUp(m(2000, 800), m(2000, 799))).toBe(false);
  });

  it('2px 就是真的翻了', () => {
    expect(scrolledUp(m(2000, 800), m(2000, 798))).toBe(true);
  });

  it('内容长高而 scrollTop 还没跟上：不算上翻（这一条是跟随断掉的根因）', () => {
    expect(scrolledUp(m(2000, 1600), m(3000, 1600))).toBe(false);
  });

  it('内容长高的同时 scrollTop 也被自动落底推下去了：更不算', () => {
    expect(scrolledUp(m(2000, 1600), m(3000, 2600))).toBe(false);
  });

  it('内容变矮时浏览器把 scrollTop 夹小：被动位移，不算上翻', () => {
    expect(scrolledUp(m(2000, 1600), m(600, 200))).toBe(false);
  });
});

describe('followAfterScroll', () => {
  const m = (scrollHeight: number, scrollTop: number, clientHeight = 400) => ({
    scrollHeight,
    scrollTop,
    clientHeight,
  });

  it('没有上翻且仍在阈值内 ⇒ 继续跟随', () => {
    expect(followAfterScroll(m(2000, 1500), m(2000, 1600))).toBe(true);
  });

  it('距底 120px 还算跟随', () => {
    expect(followAfterScroll(m(2000, 1400), m(2000, 1480))).toBe(true);
  });

  it('距底 121px 就不算了', () => {
    expect(followAfterScroll(m(2000, 1400), m(2000, 1479))).toBe(false);
  });

  it('长高之后距底变远 ⇒ 这一次算脱离（长高本身不触发 scroll，自动落底那次触发时距底是 0）', () => {
    expect(followAfterScroll(m(2000, 1600), m(3000, 1600))).toBe(false);
  });

  it('用户自己滚回底部 ⇒ 恢复跟随', () => {
    expect(followAfterScroll(m(3000, 1000), m(3000, 2600))).toBe(true);
  });

  it('一旦真的上翻，即使距底很近也脱离跟随（方向优先于距离）', () => {
    expect(followAfterScroll(m(2000, 1600), m(2000, 1560))).toBe(false);
  });
});
