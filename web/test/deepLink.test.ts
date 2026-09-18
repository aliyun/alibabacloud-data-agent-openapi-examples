import { describe, expect, it } from 'vitest';

import { SESSION_PARAM, readSessionParam, writeSessionParam } from '@/lib/deepLink';

/**
 * `?session=` 深链的读写。
 *
 * 抽成纯函数的原因：这两个函数唯一的输入是 `location.search` 字符串，
 * 而"写回"用的是 `history.replaceState`——在隐藏标签页里既看不见地址栏，
 * 也无法用 DOM 断言历史栈是 replace 还是 push。判据钉在这里，
 * hook 只负责把它们接到 window 上。
 */
describe('readSessionParam', () => {
  it('参数名固定是 session', () => {
    expect(SESSION_PARAM).toBe('session');
  });

  it('读出一个普通的会话 id', () => {
    expect(readSessionParam('?session=b2000000-0000-4000-8000-0000000000b2')).toBe(
      'b2000000-0000-4000-8000-0000000000b2',
    );
  });

  it('没有 query、没有这个参数，都是 undefined', () => {
    expect(readSessionParam('')).toBeUndefined();
    expect(readSessionParam('?tab=usage')).toBeUndefined();
  });

  it('空值与纯空白算"没带"，不算"带了一个空 id"', () => {
    expect(readSessionParam('?session=')).toBeUndefined();
    expect(readSessionParam('?session=%20%20')).toBeUndefined();
  });

  it('两端空白被 trim 掉，中间的不动', () => {
    expect(readSessionParam('?session=%20abc%20')).toBe('abc');
    expect(readSessionParam('?session=a%20b')).toBe('a b');
  });

  it('只取第一个同名参数', () => {
    expect(readSessionParam('?session=first&session=second')).toBe('first');
  });

  it('其余参数原样共存', () => {
    expect(readSessionParam('?a=1&session=x&b=2')).toBe('x');
  });

  it('刻意不校验 id 是否存在：链接指向失效会话时要把故障显示出来', () => {
    expect(readSessionParam('?session=不存在的会话')).toBe('不存在的会话');
  });
});

describe('writeSessionParam', () => {
  it('空 query 写入一个会话', () => {
    expect(writeSessionParam('', 'abc')).toBe('?session=abc');
  });

  it('保留其余参数', () => {
    expect(writeSessionParam('?a=1', 'abc')).toBe('?a=1&session=abc');
    expect(writeSessionParam('?a=1&session=old&b=2', 'new')).toBe('?a=1&session=new&b=2');
  });

  it('覆盖已选中的会话，而不是追加第二个同名参数', () => {
    expect(writeSessionParam('?session=old', 'new')).toBe('?session=new');
  });

  it('没有选中会话就把参数摘掉；摘完为空则连问号也不留', () => {
    expect(writeSessionParam('?session=abc', undefined)).toBe('');
    expect(writeSessionParam('?a=1&session=abc', undefined)).toBe('?a=1');
    expect(writeSessionParam('', undefined)).toBe('');
  });

  it('读写往返不漂', () => {
    const id = 'b2000000-0000-4000-8000-0000000000b2';
    const search = writeSessionParam('?a=1', id);
    expect(readSessionParam(search)).toBe(id);
    expect(readSessionParam(writeSessionParam(search, undefined))).toBeUndefined();
  });
});
