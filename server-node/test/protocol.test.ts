import { describe, expect, it } from 'vitest';
import {
  WIRE_CONTENT_TYPE,
  offsetOf,
  parseWireLine,
  reduceFrames,
  requestIdOf,
  streamBreakWithoutTerminal,
  type AcpFrame,
  type WireEvent,
  type WireFrame,
} from '@das/shared';
import { FIXTURES, loadFixture } from './helpers/fixtures.js';

/**
 * wire 协议。这里最要紧的一条断言是最后一组：
 * **把 fixture 包成 wire 再解出来喂给同一个 reducer，结果必须与直接喂 fixture 逐字相同**。
 * 这条成立，mock 回放与真实链路才是同一份解析代码；否则"mock 下看着对"毫无意义。
 */

function encode(event: WireEvent): string {
  return JSON.stringify(event);
}

/** 按后端 ndjson.ts 将要采用的形状，把帧包成 wire frame 事件。 */
function toWireFrame(frame: AcpFrame): WireFrame {
  return {
    type: 'frame',
    rid: requestIdOf(frame) ?? '',
    offset: offsetOf(frame),
    body: frame,
  };
}

describe('parseWireLine', () => {
  it('五种事件都能往返', () => {
    const events: WireEvent[] = [
      { type: 'meta', rid: 'r1', sessionId: 's1', mock: true, startedAt: 1 },
      toWireFrame({ Jsonrpc: '2.0', Params: { _meta: { offset: 7 } } }),
      { type: 'hb', t: 1789026613210 },
      { type: 'error', rid: 'r1', error: streamBreakWithoutTerminal(12) },
      { type: 'done', rid: 'r1', stopReason: 'end_turn', rawStopReason: 'end_turn', frameCount: 22 },
    ];
    for (const e of events) {
      expect(parseWireLine(encode(e))).toEqual(e);
    }
  });

  it('空行、坏 JSON、非对象、未知 type 一律 undefined（前端跳过而不是崩）', () => {
    expect(parseWireLine('')).toBeUndefined();
    expect(parseWireLine('   \n')).toBeUndefined();
    expect(parseWireLine('{')).toBeUndefined();
    expect(parseWireLine('null')).toBeUndefined();
    expect(parseWireLine('123')).toBeUndefined();
    expect(parseWireLine('"frame"')).toBeUndefined();
    expect(parseWireLine('{"type":"brand_new_event"}')).toBeUndefined();
    expect(parseWireLine('{}')).toBeUndefined();
  });

  it('一行里带前后空白也能解（ReadableStream 分片不保证干净换行）', () => {
    expect(parseWireLine('  {"type":"hb","t":1}  ')).toEqual({ type: 'hb', t: 1 });
  });

  it('content type 固定，CORS 预检与 fetch 都要按它来', () => {
    expect(WIRE_CONTENT_TYPE).toBe('application/x-ndjson');
  });
});

describe('wire 与 fixture 同形', () => {
  it.each([FIXTURES.promptShort, FIXTURES.promptTools, FIXTURES.promptLong, FIXTURES.loadPolluted])(
    '%s 包成 wire 再解出来，聚合结果与直接喂 fixture 完全一致',
    (name) => {
      const frames = loadFixture(name);
      const direct = reduceFrames(frames);

      // 模拟前端：按行收 → parseWireLine → 取 body
      const lines = frames.map((f) => encode(toWireFrame(f)));
      const throughWire: AcpFrame[] = [];
      for (const line of lines) {
        const event = parseWireLine(line);
        expect(event?.type, `${name}: 有一行 wire 解不出来`).toBe('frame');
        throughWire.push((event as WireFrame).body);
      }
      expect(throughWire).toHaveLength(frames.length);

      const viaWire = reduceFrames(throughWire);
      expect(viaWire.userText).toBe(direct.userText);
      expect(viaWire.thoughtText).toBe(direct.thoughtText);
      expect(viaWire.messageText).toBe(direct.messageText);
      expect(viaWire.tools).toEqual(direct.tools);
      expect(viaWire.tokenUsage).toEqual(direct.tokenUsage);
      expect(viaWire.contextUsage).toEqual(direct.contextUsage);
      expect(viaWire.stopReason).toBe(direct.stopReason);
      expect(viaWire.frameCount).toBe(direct.frameCount);
      expect(viaWire.minOffset).toBe(direct.minOffset);
      expect(viaWire.maxOffset).toBe(direct.maxOffset);
    },
  );

  it('offset 缺失时 wire 上是 undefined，不会被 JSON 变成 null 再污染聚合', () => {
    const frame: AcpFrame = { Jsonrpc: '2.0', Params: { sessionId: 's' } };
    const parsed = parseWireLine(encode(toWireFrame(frame))) as WireFrame;
    expect(parsed.offset).toBeUndefined();
    expect(reduceFrames([parsed.body]).minOffset).toBeUndefined();
  });

  it('wire 上的 rid 与帧内 RequestId 一致（前端不必再看帧内部）', () => {
    for (const f of loadFixture(FIXTURES.promptShort)) {
      expect(toWireFrame(f).rid).toBe(requestIdOf(f));
    }
  });
});
