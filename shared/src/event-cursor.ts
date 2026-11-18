import type { AcpFrame } from './frames.js';

export interface EventCursor {
  sessionId: string;
  eventEpoch: string;
  eventId: string;
  promptId: string;
  eventType: string;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const field = (value: Record<string, unknown>, name: string) => value[name] ?? value[name[0]!.toUpperCase() + name.slice(1)];

/** The cursor belongs to a complete, applied native event, never to a POP acknowledgement or a history offset. */
export function eventCursorOf(frame: AcpFrame, expectedSessionId?: string): EventCursor | undefined {
  const meta = frame._meta ?? frame.Meta ?? frame.meta;
  if (!object(meta)) return undefined;
  const raw = field(meta, 'eventCursor');
  if (raw === undefined) return undefined;
  if (!object(raw)) throw new Error('无效的原生事件游标');
  const value = Object.fromEntries(['sessionId', 'eventEpoch', 'eventId', 'promptId', 'eventType'].map(key => [key, field(raw, key)]));
  if (Object.values(value).some(entry => typeof entry !== 'string' || !entry)
    || !/^[A-Za-z0-9_-]{1,64}$/.test(String(value.eventEpoch))
    || !/^[0-9]{1,16}$/.test(String(value.eventId)) || !Number.isSafeInteger(Number(value.eventId))
    || Number(value.eventId) < 1 || (expectedSessionId !== undefined && value.sessionId !== expectedSessionId)) {
    throw new Error('原生事件游标与会话不匹配');
  }
  return value as unknown as EventCursor;
}
