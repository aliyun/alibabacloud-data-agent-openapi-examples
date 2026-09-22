/**
 * pendingPermissions 的「重启动后还在卡上」回归验证。
 *
 * 痛点：后端重启后 journal 与 pendingPermissions 一起清空（进程级）。用户重开会话
 * 时 load 会把历史播种回来，里面仍可能含**待解答**的 permission_request；没有重建
 * 的话，那张卡的 DOM requestId 会还是撞空表 → 404「无法 response」（LIVE 变现过的情形）。
 */

import { describe, expect, it } from 'vitest';

import { permissionRequestEvent, permissionResolvedEvent } from '../src/daemon/events.js';
import { SessionJournal } from '../src/daemon/journal.js';
import type { DaemonEvent } from '../src/daemon/events.js';
import { rebuildPendingPermissions, SessionRegistry } from '../src/daemon/registry.js';

function journalWith(requestIds: Array<[string, 'request' | 'resolved']>): SessionJournal {
  const journal = new SessionJournal();
  for (const [requestId, kind] of requestIds) {
    journal.append(
      kind === 'request'
        ? permissionRequestEvent('sess-1', {
            requestId,
            toolCall: { toolCallId: `tc-${requestId}` },
            options: [{ optionId: 'proceed_once', name: '同意' }],
          })
        : permissionResolvedEvent('sess-1', requestId, { outcome: 'selected' }),
    );
  }
  return journal;
}

describe('pendingPermissions 重建（重启/置换场景）', () => {
  it('request 未解 → 出现在 pending；resolved 后出现 → 从 pending 移除', () => {
    const registry = new SessionRegistry();
    const record = registry.ensure('sess-1');
    record.journal = journalWith([
      ['req-a', 'request'],
      ['req-b', 'request'],
      ['req-b', 'resolved'],
    ]);

    // 模拟重启：清了 pending 但没有清 journal（实际是两项都丢，种子重新播种后重建读本）
    record.pendingPermissions.clear();
    rebuildPendingPermissions(record);

    expect([...record.pendingPermissions.keys()]).toEqual(['req-a']);
    // pending 里存的是事件 data 载荷（与 runner.set(requestId, event.data) 同形态）
    const pending = record.pendingPermissions.get('req-a') as { requestId?: string; sessionId?: string } | undefined;
    expect(pending?.requestId).toBe('req-a');
    expect(pending?.sessionId).toBe('sess-1');
  });

  it('resolved 后到 → 不再出现在 pending（响应已过的人卡不会再走起来）', () => {
    const registry = new SessionRegistry();
    const record = registry.ensure('sess-1');
    record.journal = journalWith([
      ['req-a', 'request'],
      ['req-a', 'resolved'],
    ]);
    rebuildPendingPermissions(record);
    expect(record.pendingPermissions.size).toBe(0);
  });

  it('clear 符号之外不会误带别的 requestId', () => {
    const registry = new SessionRegistry();
    const record = registry.ensure('sess-1');
    record.journal = journalWith([['req-a', 'request']]);
    // 启动前让一个看不见的 requestId 进 pending（不可能由 load 补出局外残民）
    record.pendingPermissions.set('req-ghost', permissionRequestEvent('sess-1', {
      requestId: 'req-ghost',
      options: [],
    }));
    rebuildPendingPermissions(record);
    expect([...record.pendingPermissions.keys()]).toEqual(['req-a']);
  });
});
