import { randomUUID } from 'node:crypto';

import type { FastifyBaseLogger } from 'fastify';

import { stripMarkerInstruction, type SessionSummary } from '@das/shared';

import type { AppConfig } from '../config.js';
import { liveListSessions, type LiveContext } from '../live.js';
import { mockSessions } from '../mock/fixtures.js';
import { SessionJournal } from './journal.js';

/**
 * webshell 语义下的会话摘要（standalone）。
 * 必填字段钉死在 @qwen-code/sdk 的 `parseStandaloneSummary` 校验器上：
 * sessionId / workspaceCwd（非空）/ sourceType:'standalone' / context.kind:'standalone'。
 */
export interface StandaloneSummary {
  sessionId: string;
  workspaceCwd: string;
  createdAt: string;
  updatedAt: string;
  displayName: string;
  clientCount: number;
  hasActivePrompt: boolean;
  isWaitingForPermission: boolean;
  sourceType: 'standalone';
  context: { kind: 'standalone' };
  /** MOCK 场景说明（排障 / e2e 断言用；LIVE 恒无此键）。 */
  mockScenario?: string;
}

/**
 * standalone 会话没有真实工作区，但契约要求 workspaceCwd 为非空字符串。
 * 用一个稳定的假路径：所有会话共用，侧栏不会按工作区分组出多个假区。
 */
export const WORKSPACE_CWD = '/data-agent';

export interface SessionRecord {
  /** 上游真实 SessionId——一切上游调用都用它。 */
  realId: string;
  /**
   * daemon 分配的客户端身份：create/load 响应里回显（session.clientId），客户端发
   * prompt 时经 X-Qwen-Client-Id 带回——我们再盖上 user 回显事件的 originatorClientId，
   * web-shell 的 suppressOwnUserEcho 靠它精确匹配抑制自己的回显。
   */
  clientId: string;
  /**
   * webshell 创建会话时自带的 id（客户端强制服务端回显同 id，而上游
   * CreateAgentSession 自己生成 id），所以只能做 alias 映射。进程级，重启即失——
   * 重启后该会话在侧栏以 real id 重新出现，journal 已丢，属已知降级（见 OPENAPI-GAPS）。
   */
  aliasId: string | undefined;
  journal: SessionJournal;
  /** rename 覆盖（进程级：上游没有改名接口，SessionTitle 恒为首条 prompt 原文）。 */
  displayName: string | undefined;
  archived: boolean;
  /** 本地删除标记（上游没有删除接口，只能挡住列表展示，进程级）。 */
  deleted: boolean;
  createdAt: number;
  /** 最近一次列表拉取缓存的上游摘要（createdAt / 标题等真实值），单会话 lookup 兜底用。 */
  cachedSummary: StandaloneSummary | undefined;
}

/**
 * 会话注册表：real id 与 alias id 都作键指向同一条记录，journal 因此天然共享——
 * 侧栏用 real id 打开、而 webshell 还握着 alias id 时，两边看到同一条事件日志。
 */
export class SessionRegistry {
  private byKey = new Map<string, SessionRecord>();
  /** 去重后的记录集合（byKey 里 alias 与 real 两个键指向同一条记录，不能直接遍历 values）。 */
  private records = new Set<SessionRecord>();

  resolve(id: string): SessionRecord | undefined {
    return this.byKey.get(id.toLowerCase());
  }

  ensure(realId: string): SessionRecord {
    const key = realId.toLowerCase();
    let record = this.byKey.get(key);
    if (!record) {
      record = {
        realId,
        clientId: randomUUID(),
        aliasId: undefined,
        journal: new SessionJournal(),
        displayName: undefined,
        archived: false,
        deleted: false,
        createdAt: Date.now(),
        cachedSummary: undefined,
      };
      this.byKey.set(key, record);
      this.records.add(record);
    }
    return record;
  }

  link(aliasId: string, realId: string): SessionRecord {
    const record = this.ensure(realId);
    if (record.aliasId === undefined) {
      record.aliasId = aliasId.toLowerCase();
      this.byKey.set(aliasId.toLowerCase(), record);
    }
    return record;
  }

  remove(id: string): boolean {
    const record = this.resolve(id);
    if (!record) return false;
    this.byKey.delete(record.realId.toLowerCase());
    if (record.aliasId !== undefined) this.byKey.delete(record.aliasId);
    return true;
  }

  /** 会话摘要列表（侧栏数据源）。上游失败时返回空列表并 warn——空侧栏比 500 诚实。 */
  async listSummaries(
    cfg: AppConfig,
    live: LiveContext | undefined,
    log?: FastifyBaseLogger,
  ): Promise<StandaloneSummary[]> {
    let base: SessionSummary[];
    if (live) {
      const result = await liveListSessions(live);
      if (!result.ok) {
        log?.warn({ kind: result.error.kind }, 'daemon 会话列表：上游 ListAgentSessions 失败，本次返回空列表');
        return [];
      }
      base = result.result.sessions;
    } else {
      base = mockSessions(cfg).sessions;
    }

    const out: StandaloneSummary[] = [];
    for (const summary of base) {
      const record = this.resolve(summary.sessionId);
      if (record?.deleted === true || record?.archived === true) continue;
      const standalone = this.toStandalone(summary, record);
      if (record) record.cachedSummary = standalone;
      out.push(standalone);
    }
    return out;
  }

  private toStandalone(summary: SessionSummary, record: SessionRecord | undefined): StandaloneSummary {
    const base: StandaloneSummary = {
      sessionId: summary.sessionId,
      workspaceCwd: WORKSPACE_CWD,
      createdAt: new Date(summary.createdAt).toISOString(),
      updatedAt: new Date(summary.updatedAt).toISOString(),
      displayName:
        record?.displayName ?? (stripMarkerInstruction(summary.title) || summary.sessionId.slice(0, 8)),
      clientCount: 0,
      hasActivePrompt: record?.journal.activePrompt ?? false,
      isWaitingForPermission: false,
      sourceType: 'standalone',
      context: { kind: 'standalone' },
    };
    if (summary.mockScenario !== undefined) base.mockScenario = summary.mockScenario;
    return base;
  }

  /** 归档视图（`?archiveState=archived`）：注册表里 archived 且未删除的记录。 */
  archivedSummaries(): StandaloneSummary[] {
    const out: StandaloneSummary[] = [];
    for (const record of this.records) {
      if (!record.archived || record.deleted) continue;
      out.push(this.summaryFor(record, record.aliasId ?? record.realId));
    }
    return out;
  }

  /** 状态面板（GET /daemon/status）用的注册表统计。 */
  stats(): { sessions: number; activePrompts: number } {
    let activePrompts = 0;
    for (const record of this.records) {
      if (record.journal.activePrompt) activePrompts += 1;
    }
    return { sessions: this.records.size, activePrompts };
  }

  /** 单会话 lookup（GET /standalone/sessions/:id）：优先列表缓存，没有就最小可用形状。 */
  summaryFor(record: SessionRecord, clientFacingId: string): StandaloneSummary {
    const cached = record.cachedSummary;
    if (cached) {
      return {
        ...cached,
        sessionId: clientFacingId,
        displayName: record.displayName ?? cached.displayName,
        hasActivePrompt: record.journal.activePrompt,
      };
    }
    return {
      sessionId: clientFacingId,
      workspaceCwd: WORKSPACE_CWD,
      createdAt: new Date(record.createdAt).toISOString(),
      updatedAt: new Date(record.createdAt).toISOString(),
      displayName: record.displayName ?? clientFacingId.slice(0, 8),
      clientCount: 0,
      hasActivePrompt: record.journal.activePrompt,
      isWaitingForPermission: false,
      sourceType: 'standalone',
      context: { kind: 'standalone' },
    };
  }
}
