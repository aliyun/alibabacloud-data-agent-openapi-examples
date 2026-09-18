import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { buildCreateSessionRequest } from '../src/live.js';

/**
 * CreateAgentSession 的 wire 级契约。
 *
 * 这条测试钉的是一次真实发生过的静默失效：当初代码把
 * `{ agentId, sessionSource, tags, resourceGroupId, dmcPeerInfo }` 直接塞在
 * `params.initialConfigOptions` 上——`CreateAgentSessionRequestParams` 只声明了
 * `meta` 一个字段，`tea.Model` 基类的 `[key: string]: any` 让 tsc 全程一声不吭，
 * 而 `toMap()` 只认 names() 声明，于是 wire 上一直是 `"Params": {}`：每个会话
 * 都是在没有 agent 绑定、没有 lane、没有资源组的情况下建成的。
 * （2026-09-16 `toMap()` 实测实证，修复见 live.ts buildCreateSessionRequest 的注释。）
 *
 * 这里断言的正是 toMap() 之后的形状——契约的另一方是第三方 SDK 的序列化，
 * 只有拿到序列化结果对账，这条测试才能拦住"字段又塞回错误层级"的回归。
 */

interface WireMap {
  Id?: string;
  Jsonrpc?: string;
  Params?: {
    Meta?: {
      Agent?: { AgentName?: string };
      Config?: { SessionSource?: string; SessionTags?: Array<{ SessionTagCode?: string }> };
      InitialConfigOptions?: { ResourceGroupId?: string };
    };
    [stray: string]: unknown;
  };
}

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mock: false,
    mockRealtime: false,
    mockSpeed: 1,
    port: 3000,
    corsOrigin: [],
    regionId: 'cn-shanghai',
    endpoint: undefined,
    agentName: 'dataworks_data_agent',
    sessionSource: 'data-agent-openapi-example',
    resourceGroupId: '123456789012345',
    accessKeyId: undefined,
    accessKeySecret: undefined,
    ...overrides,
  };
}

describe('buildCreateSessionRequest — wire 序列化（防 Params:{} 回归）', () => {
  it('agentName 落在 Meta.Agent.AgentName（唯一有效位置）', () => {
    const map = buildCreateSessionRequest(cfg({ agentName: 'dataworks_data_agent' })).toMap() as WireMap;
    expect(map.Params?.Meta?.Agent?.AgentName).toBe('dataworks_data_agent');
  });

  it('sessionSource 与 SessionTags 落在 Meta.Config 下，且 SessionTags 是对象数组而不是字符串数组', () => {
    const map = buildCreateSessionRequest(cfg({ sessionSource: 'data-agent-openapi-example' })).toMap() as WireMap;
    expect(map.Params?.Meta?.Config?.SessionSource).toBe('data-agent-openapi-example');
    expect(map.Params?.Meta?.Config?.SessionTags).toEqual([
      { SessionTagCode: 'data-agent-openapi-example' },
    ]);
  });

  it('resourceGroupId 落在 Meta.InitialConfigOptions.ResourceGroupId', () => {
    const map = buildCreateSessionRequest(cfg({ resourceGroupId: '123456789012345' })).toMap() as WireMap;
    expect(map.Params?.Meta?.InitialConfigOptions?.ResourceGroupId).toBe('123456789012345');
  });

  it('Mode 默认 yolo：无人值守路径（自检/探针）不依赖调用方记得传', () => {
    const map = buildCreateSessionRequest(cfg()).toMap() as WireMap & {
      Params?: { Meta?: { InitialConfigOptions?: { Mode?: string } } };
    };
    expect(map.Params?.Meta?.InitialConfigOptions?.Mode).toBe('yolo');
  });

  it('Mode=default 落在 Meta.InitialConfigOptions.Mode：人卡路径的唯一开关', () => {
    const map = buildCreateSessionRequest(cfg(), 'default').toMap() as WireMap & {
      Params?: { Meta?: { InitialConfigOptions?: { Mode?: string } } };
    };
    expect(map.Params?.Meta?.InitialConfigOptions?.Mode).toBe('default');
  });

  it('RESOURCE_GROUP_ID 未配置时不炸，且不带出空 ResourceGroupId', () => {
    const map = buildCreateSessionRequest(cfg({ resourceGroupId: undefined })).toMap() as WireMap;
    expect(map.Params?.Meta?.Agent?.AgentName).toBe('dataworks_data_agent');
    expect(map.Params?.Meta?.InitialConfigOptions?.ResourceGroupId).toBeUndefined();
  });

  it('回归钉：Params 顶层只有 Meta 一个键——旧 bug 的散字段一个都不准回来', () => {
    const map = buildCreateSessionRequest(cfg()).toMap() as WireMap;
    expect(Object.keys(map.Params ?? {})).toEqual(['Meta']);
    for (const stray of [
      'InitialConfigOptions',
      'initialConfigOptions',
      'AgentId',
      'agentId',
      'SessionSource',
      'sessionSource',
      'Tags',
      'tags',
      'ResourceGroupId',
      'resourceGroupId',
      'DmcPeerInfo',
      'dmcPeerInfo',
    ]) {
      expect(map.Params, `Params 上不应存在 ${stray}`).not.toHaveProperty(stray);
    }
  });

  it('jsonrpc 与 Id 也在 wire 上', () => {
    const map = buildCreateSessionRequest(cfg()).toMap() as WireMap;
    expect(map.Jsonrpc).toBe('2.0');
    expect(typeof map.Id).toBe('string');
    expect(map.Id?.length).toBeGreaterThan(0);
  });
});
