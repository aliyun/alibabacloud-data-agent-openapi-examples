import { describe, expect, it } from 'vitest';
import { readFixtureFrames, MOCK_SCENARIOS } from '../src/mock/fixtures.js';
import { reduceFrames } from '@das/shared';

describe('public synthetic samples', () => {
  for (const scenario of MOCK_SCENARIOS) {
    if (!scenario.promptFixture) continue;
    it(`${scenario.sessionId} is parseable synthetic protocol data`, () => {
      const frames = readFixtureFrames(scenario.promptFixture!);
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) expect(frame.Jsonrpc).toBe('2.0');
    });
  }
  it('short response completes and includes answer text', () => {
    const result = reduceFrames(readFixtureFrames('prompt-short.jsonl'));
    expect(result.terminated).toBe(true);
    expect(result.stopReason).toBe('end_turn');
    expect(result.messageText.length).toBeGreaterThan(0);
  });
});
