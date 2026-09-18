import { describe, expect, it } from 'vitest';

import { elapsedLabel, elapsedOf, elapsedTitle } from '@/lib/turnClock';

/**
 * 「这一轮跑了多久」该用哪个时钟。
 *
 * 数字一律用**字面量**断言：这里的失效模式不是崩溃而是"界面上显示了一个看着合理
 * 却是错的秒数"，自指断言（拿被测常量算期望值）对这种错零判别力。
 */

describe('elapsedOf：在途', () => {
  it('用本地时钟：now 减 startedAt', () => {
    const e = elapsedOf({ streaming: true, startedAt: 1_000, firstTimestamp: 5_000, lastTimestamp: 9_000, now: 4_500 });
    expect(e).toEqual({ ms: 3_500, source: 'local' });
  });

  /**
   * 这条是整个模块存在的理由：服务端 Timestamp 只在收到帧时前进，
   * 拿它做实时计时，帧一停数字就冻住——而"帧停了"恰恰是最需要计时的处境
   * （断流、上游挂起）。断流时 lastTimestamp 停在 9_000，但数字必须继续走。
   */
  it('帧停了数字也继续走：不受 lastTimestamp 冻结的影响', () => {
    const stalled = { streaming: true, startedAt: 1_000, firstTimestamp: 5_000, lastTimestamp: 9_000 };
    const earlier = elapsedOf({ ...stalled, now: 11_000 });
    const later = elapsedOf({ ...stalled, now: 21_000 });
    expect(earlier?.ms).toBe(10_000);
    expect(later?.ms).toBe(20_000);
  });

  it('还没有 startedAt（尚未发起调用）时不给数：显示 0 秒是一句谎', () => {
    expect(elapsedOf({ streaming: true, firstTimestamp: 5_000, lastTimestamp: 9_000, now: 4_500 })).toBeUndefined();
  });

  it('系统时钟被改过导致负数时夹到 0，不显示 "-3s"', () => {
    expect(elapsedOf({ streaming: true, startedAt: 10_000, now: 7_000 })?.ms).toBe(0);
  });
});

describe('elapsedOf：已结束', () => {
  it('用服务端 Timestamp：末帧减首帧', () => {
    const e = elapsedOf({ streaming: false, startedAt: 1_000, firstTimestamp: 5_000, lastTimestamp: 9_000, now: 99_000 });
    expect(e).toEqual({ ms: 4_000, source: 'server' });
  });

  /**
   * 结束态故意**不**用本地时钟：它含网络与排队，会比服务端那一段偏大，
   * 而"这一轮耗时多少"这个说法只有在量的是服务端那一段时才成立。
   */
  it('结束态不退回本地时钟，哪怕 startedAt 还在', () => {
    const e = elapsedOf({ streaming: false, startedAt: 1_000, firstTimestamp: 5_000, lastTimestamp: 9_000, now: 99_000 });
    expect(e?.source).toBe('server');
    expect(e?.ms).not.toBe(98_000);
  });

  it('缺任一服务端时间戳就不给数：宁可空着，也不拿本地时钟冒充服务端耗时', () => {
    expect(elapsedOf({ streaming: false, firstTimestamp: 5_000, now: 9_000 })).toBeUndefined();
    expect(elapsedOf({ streaming: false, lastTimestamp: 9_000, now: 9_000 })).toBeUndefined();
    expect(elapsedOf({ streaming: false, now: 9_000 })).toBeUndefined();
  });

  it('时间戳逆序（上游给脏数据）时夹到 0', () => {
    expect(elapsedOf({ streaming: false, firstTimestamp: 9_000, lastTimestamp: 5_000, now: 9_000 })?.ms).toBe(0);
  });
});

describe('elapsedLabel / elapsedTitle', () => {
  /**
   * 两个标签必须不同。收尾那一刻 source 从 local 换成 server、数字往回跳，
   * 标签一样的话用户读到的就是"计时器坏了"。
   */
  it('在途写「已运行」，结束写「耗时」', () => {
    expect(elapsedLabel({ ms: 1, source: 'local' })).toBe('已运行');
    expect(elapsedLabel({ ms: 1, source: 'server' })).toBe('耗时');
  });

  it('title 说清含不含网络与排队：这是两个数字对不上时唯一的解释入口', () => {
    expect(elapsedTitle({ ms: 1, source: 'local' })).toContain('含网络与排队');
    expect(elapsedTitle({ ms: 1, source: 'server' })).toContain('不含发起调用之前的网络与排队');
  });

  it('title 交代了帧停了也继续走，免得被读成"卡住了"', () => {
    expect(elapsedTitle({ ms: 1, source: 'local' })).toContain('帧停了它也继续走');
  });
});
