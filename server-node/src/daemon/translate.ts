import {
  errorOf,
  paramsOf,
  partitionByRid,
  pendingInteractionOf,
  permissionResolvedOf,
  sessionUpdateOf,
  stripMarkerInstruction,
  terminalOf,
  textOf,
  updateOf,
  type AcpFrame,
} from '@das/shared';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

import {
  permissionRequestEvent,
  permissionResolvedEvent,
  sessionUpdateEvent,
  type DaemonEvent,
} from './events.js';

export interface TranslateOptions {
  /**
   * 发起这轮 prompt 的客户端 id（X-Qwen-Client-Id）。挂到 user_message_chunk 的
   * originatorClientId 上——provider 靠它抑制"自己刚发的话"的回显（suppressOwnUserEcho），
   * 但 transcript 里仍保留，重放时能看到完整对话。
   */
  originatorClientId?: string;
  /**
   * 剥掉 user 回显里注入的 marker 说明。注入与剥离必须同源（shared/marker），
   * 这里默认剥；单测想看原始文本可显式关掉。
   */
  stripMarker?: boolean;
}

/**
 * 上游 ACP 帧 → daemon `session_update` 事件。
 *
 * update 载荷**整包透传**（与现行 pipeline「帧原样透传、不重塑」同一哲学）：
 * 两边同出 ACP 血统，tool_call / tool_call_update / usage_update /
 * config_option_update 的字段名天然对得上 web-shell 的 normalizer；
 * 未知 update 类型也原样带过——normalizer 容忍未知，重塑反而会把上游新字段静默丢掉。
 *
 * 返回 undefined 表示这帧不产出 session_update：排队通知帧（无 update）、
 * update 缺 sessionUpdate 键、以及纯终态/错误帧（它们走 turn_complete/turn_error）。
 */
export function frameToSessionUpdate(
  frame: AcpFrame,
  sessionId: string,
  opts: TranslateOptions = {},
): DaemonEvent | undefined {
  const update = updateOf(frame);
  if (!update) return undefined;
  const kind = sessionUpdateOf(frame);
  if (kind === undefined) return undefined;

  const payload: Record<string, unknown> = { ...update };
  if (kind === 'user_message_chunk' && opts.stripMarker !== false) {
    // 服务端注入的校验码说明会随上游回显一起回来，展示层必须剥掉。
    // content 重建为单文本块：回显的 content 形状一致（{type:'text',text}），重建即剥离。
    payload.content = { type: 'text', text: stripMarkerInstruction(textOf(update)) };
  }
  /**
   * agent 思考/回答的 chunk 文本在这一层**必须原样透传**：
   * 曾在这里按整文 stripMarkerToken 逐 chunk 处理——它会把段首的 '\n\n'、片尾的换行
   * 一并 trim 掉，markdown 段落分隔与代码块围栏的边界空白在在途流里被吃光
   * （load 路径大块返回不受影响，所以表现为"流式乱、刷新好"）。
   * token 剥离唯一正确的位置是紧随其后的 MarkerTokenScrubber（流式安全，runner 与
   * 历史种子两条路都已挂）——这一层再剥就是双重处理，而且剥错粒度。
   */
  return sessionUpdateEvent(sessionId, payload, opts.originatorClientId);
}

/**
 * 历史帧过滤：与 `reduceHistory` 同源的判据——按 rid 分组后，只有名下含
 * `user_message_chunk` 的 rid 才是真实轮次。
 *
 * 丢掉的两类都不能进 journal：
 *  · rid-less 帧：原始回放污染，是同一轮内容的第二份拷贝（实测 977 帧里 900 帧），不丢则显示两遍；
 *  · 无 user_message_chunk 的 rid：典型是 load 调用自己的 rid（一个伪 end_turn 空轮次）。
 */
export function filterHistoryFrames(frames: AcpFrame[]): AcpFrame[] {
  const { byRid } = partitionByRid(frames);
  const out: AcpFrame[] = [];
  for (const group of byRid.values()) {
    if (!group.some((frame) => sessionUpdateOf(frame) === 'user_message_chunk')) continue;
    out.push(...group);
  }
  return out;
}

/**
 * 历史帧 → journal 种子事件：过滤（同 reduceHistory 判据）+ 翻译 + user 回显去重。
 *
 * 去重判据与 shared reducer 同源：归档态里同一句提示词会出现两条完全相同的
 * user_message_chunk（一条 bridge-echo 拷贝），reducer 靠 `text !== 已累积文本`
 * 跳过整块重复；journal 不做同样的事，web-shell 就会把提示词显示两遍
 * （e2e 实测：mock-tools 历史里每个 prompt 都双份）。
 */
export function historyFramesToEvents(frames: AcpFrame[], sessionId: string): DaemonEvent[] {
  const { byRid } = partitionByRid(frames);
  const out: DaemonEvent[] = [];
  for (const group of byRid.values()) {
    if (!group.some((frame) => sessionUpdateOf(frame) === 'user_message_chunk')) continue;
    let userText = '';
    for (const frame of group) {
      // permission 通知也进种子：错过 resolution 的屏后到达事件照样有 journal、
      // 载荷上的 pending 状态才能被负载后的 load 还原（含 requestId 配对删 pending）。
      const permissionEvent = frameToPermissionEvent(frame, sessionId);
      if (permissionEvent !== undefined) {
        out.push(permissionEvent);
        continue;
      }
      const event = frameToSessionUpdate(frame, sessionId);
      if (!event) continue;
      const update = event.data.update as { sessionUpdate?: string; content?: { text?: string } };
      if (update.sessionUpdate === 'user_message_chunk') {
        const text = update.content?.text ?? '';
        if (text !== '' && text === userText) continue;
        userText += text;
      }
      // agent 思考/回答的 chunk 文本原样透传（marker 剥离机制已退役，不再有任何剥除器）
      out.push(event);
    }
  }
  return out;
}

/** 终态帧识别（Result.stopReason），收尾分类在 runner 里做。 */
export function terminalOfFrame(frame: AcpFrame): ReturnType<typeof terminalOf> {
  return terminalOf(frame);
}

export function errorOfFrame(frame: AcpFrame): ReturnType<typeof errorOf> {
  return errorOf(frame);
}

// ------------------------------------------------------------------
// permission：把 `_qwen/notify` 帧翻译成 daemon 的 permission 事件。
// 上游的通知不能当 session_update 发——它有专门的 permission 事件契约
// （DAEMON_KNOWN_EVENT_TYPE_VALUES 里的 permission_request/resolved），
// 否则 web-shell 就不会弹卡（此前这些帧被默默丢弃，即「没有弹框」的根因）。
// ------------------------------------------------------------------

export function frameToPermissionEvent(frame: AcpFrame, sessionId: string): DaemonEvent | undefined {
  const pending = pendingInteractionOf(frame);
  if (pending) {
    const params = paramsOf(frame);
    const data = params && isObject(params.data) ? params.data : undefined;
    const toolCall = data && isObject(data.toolCall) ? data.toolCall : undefined;
    return permissionRequestEvent(sessionId, {
      requestId: pending.requestId,
      toolCall,
      title: pending.toolCallTitle ?? null,
      options: pending.options,
    });
  }
  const resolved = permissionResolvedOf(frame);
  if (resolved) {
    const params = paramsOf(frame);
    const data = params && isObject(params.data) ? params.data : undefined;
    const outcome = data && isObject(data.outcome) ? data.outcome : { outcome: 'selected' };
    return permissionResolvedEvent(sessionId, resolved.requestId, outcome);
  }
  return undefined;
}
