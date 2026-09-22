import { describe, expect, it } from 'vitest';

import { pendingInteractionOf, permissionResolvedOf, type AcpFrame } from '@das/shared';

/**
 * 人卡交互帧的解析契约。【LIVE 09-17】
 *
 * 下面两帧是 2026-09-17 cn-beijing 预发实测抓到的形状（内容为探针自己的
 * ask_user_question 问答，无内部业务语义）。这里钉住三件事：
 *  1. `_qwen/notify` + `Params.kind='permission_request'` + `data.requestId` 是
 *     permissionRequestId 的唯一来源——解析器认错了地方，回覆就打不中；
 *  2. ask_user_question 的选项只有 label/description，**没有 optionId**——
 *     回覆必须走 `answers`（索引键），这条约束写进了 InteractionCard 的交互设计；
 *  3. `permission_resolved` 是回覆被上游采纳的事实源，UI 靠它撤下交互卡。
 */
const ASK_FRAME: AcpFrame = {
  Jsonrpc: '2.0',
  Method: '_qwen/notify',
  Params: {
    kind: 'permission_request',
    data: {
      requestId: '56bb881d-97dd-4724-ac43-03cb7a564a5c',
      sessionId: '00000000-0000-4000-8000-000000000001',
      toolCall: {
        _meta: {
          toolName: 'ask_user_question',
          qwenInteractionKind: 'user_question',
          qwenQuestions: [
            {
              question: '你想让我接下来做什么？',
              header: '下一步',
              options: [
                { label: 'A. 查看当前时间', description: '执行 date 命令，返回当前实例的系统时间（含时区）。' },
                { label: 'B. 列出当前目录文件', description: '列出目录下的文件与子目录。' },
              ],
            },
          ],
        },
        content: [],
        kind: 'think',
        locations: [],
        rawInput: {
          questions: [
            {
              question: '你想让我接下来做什么？',
              header: '下一步',
              options: [
                { label: 'A. 查看当前时间', description: '执行 date 命令，返回当前实例的系统时间（含时区）。' },
                { label: 'B. 列出当前目录文件', description: '列出目录下的文件与子目录。' },
              ],
            },
          ],
        },
        title: 'AskUserQuestion',
      },
    },
    _meta: { offset: 12 },
  },
  RequestId: '0b33d9d2-6ec1-4a2f-9d13-2f0f0b9f6b1a',
  Timestamp: 1789635950330,
};

describe('pendingInteractionOf — 人卡请求帧解析', () => {
  it('从 _qwen/notify permission_request 帧提取 requestId / toolName / interactionKind', () => {
    const interaction = pendingInteractionOf(ASK_FRAME);
    expect(interaction).toBeDefined();
    expect(interaction?.requestId).toBe('56bb881d-97dd-4724-ac43-03cb7a564a5c');
    expect(interaction?.sessionId).toBe('00000000-0000-4000-8000-000000000001');
    expect(interaction?.toolName).toBe('ask_user_question');
    expect(interaction?.interactionKind).toBe('user_question');
    expect(interaction?.toolCallTitle).toBe('AskUserQuestion');
  });

  it('问题与选项来自 rawInput.questions；选项只有 label/description，没有 optionId', () => {
    const interaction = pendingInteractionOf(ASK_FRAME);
    const first = interaction?.questions[0];
    expect(first).toBeDefined();
    expect(first?.question).toBe('你想让我接下来做什么？');
    expect(first?.header).toBe('下一步');
    expect(first?.options).toEqual([
      { label: 'A. 查看当前时间', description: '执行 date 命令，返回当前实例的系统时间（含时区）。' },
      { label: 'B. 列出当前目录文件', description: '列出目录下的文件与子目录。' },
    ]);
  });

  it('普通 session/update 帧与非 permission 的 notify 帧都不算人卡', () => {
    expect(pendingInteractionOf({ Method: '_qwen/notify', Params: { kind: 'session_metadata_updated', data: {} } })).toBeUndefined();
    expect(pendingInteractionOf({ Params: { update: { sessionUpdate: 'agent_message_chunk' } } })).toBeUndefined();
    // 缺 requestId 的 permission_request 不能当有效交互：回覆没有目标
    expect(pendingInteractionOf({ Method: '_qwen/notify', Params: { kind: 'permission_request', data: {} } })).toBeUndefined();
  });

  it('工具授权类（qwenInteractionKind 缺省）归 permission，options 数组原样透出', () => {
    const frame: AcpFrame = {
      Method: '_qwen/notify',
      Params: {
        kind: 'permission_request',
        data: {
          requestId: 'req-1',
          toolCall: { _meta: { toolName: 'run_shell_command' }, title: 'Shell: rm /tmp/x' },
          options: [
            { optionId: 'proceed_once', name: '允许一次', kind: 'allow_once' },
            { optionId: 'cancel', name: '拒绝', kind: 'reject_once' },
          ],
        },
      },
    };
    const interaction = pendingInteractionOf(frame);
    expect(interaction?.interactionKind).toBe('permission');
    expect(interaction?.options).toEqual([
      { optionId: 'proceed_once', name: '允许一次', kind: 'allow_once' },
      { optionId: 'cancel', name: '拒绝', kind: 'reject_once' },
    ]);
    expect(interaction?.questions).toEqual([]);
  });
});

describe('permissionResolvedOf — 回覆采纳回执', () => {
  it('提取 requestId；其它帧返回 undefined', () => {
    const frame: AcpFrame = {
      Method: '_qwen/notify',
      Params: {
        kind: 'permission_resolved',
        data: { requestId: '56bb881d-97dd-4724-ac43-03cb7a564a5c', outcome: { outcome: 'selected', optionId: 'proceed_once' } },
      },
    };
    expect(permissionResolvedOf(frame)).toEqual({ requestId: '56bb881d-97dd-4724-ac43-03cb7a564a5c' });
    expect(permissionResolvedOf(ASK_FRAME)).toBeUndefined();
  });
});
