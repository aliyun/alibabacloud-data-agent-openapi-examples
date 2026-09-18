import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WIRE_CONTENT_TYPE, classifyError, type AcpFrame, type WireEvent } from '@das/shared';

import { turnStore } from '@/state/turnStore';

/**
 * 在途状态机（turnStore）。
 *
 * 这里是"运行态唯一事实源"——服务端问不出运行态（SessionStatus 恒为 RELEASED），
 * 所以这些行为错了没有任何别的层能兜住。而它们全都只在**时序**里出现：
 * 增量渲染、停止接收之后晚到的帧、clear 之后旧流把空视图重新填满。
 * 真实浏览器里肉眼很难稳定复现（自动化浏览器还是隐藏标签页，rAF 直接被暂停），
 * 所以用一条可控的假流把它们钉死。
 *
 * 环境是 node，不是 jsdom：turnStore 需要的浏览器 API 只有 requestAnimationFrame，
 * 而"它不触发"恰好就是要测的场景之一（隐藏标签页），所以显式 stub 比装一个 DOM 更诚实。
 */

const RID = 'rid-turn-1';
const MARKER = 'DAS-ABC123';

/** 一条由测试控制节奏的 NDJSON 流：push 什么、什么时候 push，全在手里。 */
function fakeStream(): { push: (event: WireEvent) => void; close: () => void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  // 每次 start() 都会新建一条流，fetch stub 要能拿到当前这条
  currentBody = body;

  return {
    push(event: WireEvent) {
      controller?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    },
    close() {
      controller?.close();
    },
  };
}

let currentBody: ReadableStream<Uint8Array> | undefined;

function meta(): WireEvent {
  return { type: 'meta', rid: RID, marker: MARKER, sessionId: 's1', mock: true, startedAt: 1_000 };
}

let offset = 0;
/** 一条只产出正文的帧。offset 递增，形状与真实 fixture 一致。 */
function chunk(text: string): WireEvent {
  offset += 1;
  const body: AcpFrame = {
    Jsonrpc: '2.0',
    RequestId: RID,
    Params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  };
  return { type: 'frame', rid: RID, offset, body };
}

function userChunk(text: string): WireEvent {
  offset += 1;
  const body: AcpFrame = {
    Jsonrpc: '2.0',
    RequestId: RID,
    Params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } } },
  };
  return { type: 'frame', rid: RID, offset, body };
}

/** 终态帧：终态只看顶层 `Result.stopReason`，形状与真实 fixture 一致。 */
function terminal(reason: string): WireEvent {
  offset += 1;
  const body: AcpFrame = { Jsonrpc: '2.0', RequestId: RID, Result: { stopReason: reason } };
  return { type: 'frame', rid: RID, offset, body };
}

/** fetch 之后与每次 push 之后都要让微任务跑完，否则事件还卡在 reader 里。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

const snap = () => turnStore.getSnapshot();

/** rAF 永不触发：模拟隐藏/后台标签页（实测 6s 内一次都不触发）。 */
function pauseRaf(): void {
  vi.stubGlobal('requestAnimationFrame', () => 0);
}

beforeEach(() => {
  vi.useFakeTimers();
  offset = 0;
  currentBody = undefined;
  vi.stubGlobal('fetch', async () => {
    const body = currentBody;
    if (!body) throw new Error('测试没有先建流');
    return new Response(body, { status: 200, headers: { 'content-type': WIRE_CONTENT_TYPE } });
  });
  pauseRaf();
  turnStore.clear();
});

afterEach(() => {
  turnStore.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function startTurn(): ReturnType<typeof fakeStream> {
  const stream = fakeStream();
  expect(turnStore.start('s1', '用户敲的原文')).toBe(true);
  return stream;
}

describe('增量渲染：帧到达 → flush → 视图长出内容', () => {
  it('帧只标脏，flush 之后才可见；后续帧继续可见地增长', async () => {
    const stream = startTurn();
    await settle();

    stream.push(meta());
    stream.push(chunk('第一段'));
    await settle();

    // meta 会 publish，但帧只标脏：rAF 被暂停、兜底定时器还没到点，正文此刻必须还是空的
    expect(snap().phase).toBe('streaming');
    expect(snap().rid).toBe(RID);
    expect(snap().messageText).toBe('');
    expect(snap().frameCount).toBe(0);

    await vi.advanceTimersByTimeAsync(250);
    expect(snap().messageText).toBe('第一段');
    expect(snap().frameCount).toBe(1);

    stream.push(chunk('第二段'));
    await settle();
    await vi.advanceTimersByTimeAsync(250);

    // 这条断言才是"增量"的证据：内容分两次长出来，不是结束时一次性出现
    expect(snap().messageText).toBe('第一段第二段');
    expect(snap().frameCount).toBe(2);

    // 后端只在 terminalOf 命中时才发 done，而那一帧同时也作为 frame 透传过：
    // 前端的终态就来自这一帧，done 只是收尾信号
    stream.push(terminal('end_turn'));
    stream.push({ type: 'done', rid: RID, stopReason: 'end_turn', rawStopReason: 'end_turn', frameCount: 3 });
    await settle();
    expect(snap().phase).toBe('done');
    expect(snap().stopReason).toBe('end_turn');
    expect(snap().messageText).toBe('第一段第二段');
  });

  it('rAF 正常触发时走 rAF，不必等到兜底定时器', async () => {
    // 前台标签页的正常路径：rAF 约 16ms 一跳，兜底定时器（250ms）应该被它抢先
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(1), 16));
    const stream = startTurn();
    await settle();

    stream.push(meta());
    stream.push(chunk('正文'));
    await settle();
    await vi.advanceTimersByTimeAsync(16);

    expect(snap().messageText).toBe('正文');
  });
});

describe('用户气泡显示用户自己敲的那句话', () => {
  it('发送后立刻可见，且不被流里回显的 user_message_chunk 顶掉', async () => {
    const stream = startTurn();
    await settle();

    // 第一帧都还没到，用户就该看见自己刚敲的话
    expect(snap().userText).toBe('用户敲的原文');

    stream.push(meta());
    // MOCK 下回显的是样例里的提示词，LIVE 下是服务端注入过校验码尾行的出站全文——
    // 两者都不是"用户敲的那句话"，所以不该拿它覆盖气泡
    stream.push(userChunk('样例里的另一句提示词'));
    await settle();
    await vi.advanceTimersByTimeAsync(250);

    expect(snap().userText).toBe('用户敲的原文');
  });
});

describe('marker 归属校验', () => {
  it('校验码从 meta 落进视图，正文里原样出现之后 verified 才翻 true', async () => {
    const stream = startTurn();
    await settle();

    // meta 之前既没有 rid 也没有校验码：此刻的内容无法证明属于本轮
    expect(snap().marker).toBeUndefined();
    expect(snap().verified).toBe(false);

    stream.push(meta());
    stream.push(chunk('前半段还没有校验码'));
    await settle();
    await vi.advanceTimersByTimeAsync(250);

    expect(snap().marker).toBe(MARKER);
    expect(snap().verified).toBe(false);

    // 实测存在跨会话串答案，所以"归属已校验"只能由正文里原样出现校验码来证明，
    // 不能靠"收到了帧"或"rid 对得上"来推断
    stream.push(chunk(` 结尾是 ${MARKER}`));
    await settle();
    await vi.advanceTimersByTimeAsync(250);

    expect(snap().verified).toBe(true);
  });
});

describe('作废的那一轮不再写视图', () => {
  it('点停止 = 发取消请求并继续收流：在途帧照常写入，cancelled 终态落「已取消」', async () => {
    const stream = startTurn();
    await settle();
    stream.push(meta());
    stream.push(chunk('已经收到的部分'));
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    expect(snap().messageText).toBe('已经收到的部分');

    // cancel 的 POST 不能复用 prompt 流的 stub（那条 ReadableStream 已被 reader
    // 锁住，再包一层 Response 会抛 TypeError）——单独给它一个纯 200 应答
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? '');
      if (url.includes('/cancel')) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const body = currentBody;
      if (!body) throw new Error('测试没有先建流');
      return new Response(body, { status: 200, headers: { 'content-type': WIRE_CONTENT_TYPE } });
    });

    turnStore.cancelTurn();
    await settle();
    // cancel 请求已被接受：进入取消中，流还开着
    expect(snap().phase).toBe('cancelling');

    // 取消在服务端生效需要一小会，这期间到达的帧照常写入视图
    stream.push(chunk('取消请求在途时又到的内容'));
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    expect(snap().messageText).toContain('取消请求在途时又到的内容');
    expect(snap().phase).toBe('cancelling');

    // 服务端停止执行：终态帧 stopReason=cancelled → 落「已取消」
    stream.push(terminal('cancelled'));
    stream.push({ type: 'done', rid: RID, stopReason: 'cancelled', rawStopReason: 'cancelled', frameCount: 4 });
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    expect(snap().phase).toBe('cancelled');
    expect(snap().stopReason).toBe('cancelled');
  });

  it('cancel 请求失败时退回 abandoned：晚到的帧被丢掉，phase 不被覆盖', async () => {
    const stream = startTurn();
    await settle();
    stream.push(meta());
    stream.push(chunk('已经收到的部分'));
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    expect(snap().messageText).toBe('已经收到的部分');

    // 只让 cancel 这个 POST 失败（503），prompt 的流 stub 保持原样
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? '');
      if (url.includes('/cancel')) {
        return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
      }
      const body = currentBody;
      if (!body) throw new Error('测试没有先建流');
      return new Response(body, { status: 200, headers: { 'content-type': WIRE_CONTENT_TYPE } });
    });

    turnStore.cancelTurn();
    await settle();
    expect(snap().phase).toBe('abandoned');

    // 这条流没有被真的掐断（prompt 的 fetch stub 不接 abort signal），正好模拟
    // "abort 之后 reader 里还缓冲着事件"这个真实场景
    stream.push(chunk('停止之后才到的内容'));
    await settle();
    await vi.advanceTimersByTimeAsync(250);

    expect(snap().messageText).toBe('已经收到的部分');
    expect(snap().phase).toBe('abandoned');
  });

  it('clear 之后旧流的帧不会把空视图重新填满', async () => {
    const stream = startTurn();
    await settle();
    stream.push(meta());
    stream.push(chunk('清空前的内容'));
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    expect(snap().messageText).toBe('清空前的内容');

    turnStore.clear();
    expect(snap().phase).toBe('idle');
    expect(snap().messageText).toBe('');

    stream.push(chunk('清空后才到的内容'));
    await settle();
    await vi.advanceTimersByTimeAsync(250);

    expect(snap().phase).toBe('idle');
    expect(snap().messageText).toBe('');
    expect(snap().frameCount).toBe(0);
  });

  it('在途时第二次 start 被拒（在途锁）', async () => {
    startTurn();
    await settle();
    expect(turnStore.isBusy()).toBe(true);
    expect(turnStore.busySessionId()).toBe('s1');
    expect(turnStore.start('s2', 'x')).toBe(false);
  });
});

describe('终态判定', () => {
  it('流结束却从未出现 done / error ⇒ 归断流，不算成功', async () => {
    const stream = startTurn();
    await settle();
    stream.push(meta());
    stream.push(chunk('半截回答'));
    await settle();
    await vi.advanceTimersByTimeAsync(250);

    stream.close();
    await settle();
    await vi.advanceTimersByTimeAsync(250);

    expect(snap().phase).toBe('break_recovering');
    expect(snap().error?.kind).toBe('stream_break');
    expect(snap().error?.retryable).toBe(false);
    // 已收到的内容必须留着：用户要靠它判断这一轮跑到哪了
    expect(snap().messageText).toBe('半截回答');
    // 探测时限从断流这一刻起算，不从本轮开始起算
    expect(snap().brokeAt).toBeTypeOf('number');
  });

  it('上游给了不认识的 stopReason 时留住原值', async () => {
    const stream = startTurn();
    await settle();
    stream.push(meta());
    stream.push(terminal('some_future_reason'));
    stream.push({
      type: 'done',
      rid: RID,
      stopReason: undefined,
      rawStopReason: 'some_future_reason',
      frameCount: 1,
    });
    await settle();
    await vi.advanceTimersByTimeAsync(250);

    expect(snap().phase).toBe('done');
    expect(snap().stopReason).toBeUndefined();
    // UI 靠这个原值如实显示"不在已知集合内"，不能被静默丢掉
    expect(snap().rawStopReason).toBe('some_future_reason');
  });

  it('error 事件按 kind 落 phase', async () => {
    const stream = startTurn();
    await settle();
    stream.push({
      type: 'error',
      rid: '',
      error: classifyError({
        code: -32603,
        errorCode: '0x48833000000000d1',
        message: 'prompt forward failed, upstream_status=422',
      }),
    });
    await settle();

    expect(snap().phase).toBe('ghost');
    expect(snap().error?.kind).toBe('session_ghost');
    expect(snap().brokeAt).toBeUndefined();
  });
});

describe('判活不挂在 rAF 上', () => {
  it('心跳不改内容也不触发重渲染，但超过 45s 没有任何事件要说出来', async () => {
    const stream = startTurn();
    await settle();
    stream.push(meta());
    await settle();

    stream.push({ type: 'hb', t: Date.now() });
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    expect(snap().messageText).toBe('');
    expect(snap().frameCount).toBe(0);
    expect(snap().stalled).toBe(false);

    // 什么都不发，把阈值熬过去：stallTimer（setInterval）必须自己判出来。
    // 推进 51s 而不是 46s —— 检查周期 5s 一跳、判据是严格 > 45s，
    // 45s 整点那一跳不翻转，最坏要到 50s 才报（UI 文案说"超过 45 秒"仍然成立）。
    await vi.advanceTimersByTimeAsync(51_000);
    expect(snap().stalled).toBe(true);

    stream.push({ type: 'hb', t: Date.now() });
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(snap().stalled).toBe(false);
  });
});
