/** Administrator-only examples. Never imported or executed by server startup. */
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { UpdateAgentRequest } from '@alicloud/dataworks-public20240518';
import { cast } from '@darabonba/typescript';
import type { SdkClient } from '../src/sdk.js';
import { runtimeFor } from '../src/sdk.js';
import { headerRequestId } from '../src/normalize.js';
import { validRequestId } from '@das/shared';

async function agentCall(client: SdkClient, action: string, fields: Record<string, unknown>) {
  // Agent management uses top-level form fields, NOT session JSON-RPC Params.
  const body = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)]));
  const response = await client.callApi(new $OpenApiUtil.Params({ action, version: '2024-05-18', protocol: 'HTTPS',
    pathname: '/', method: 'POST', authType: 'AK', style: 'RPC', reqBodyType: 'formData', bodyType: 'json' }),
  new $OpenApiUtil.OpenApiRequest({ body }), runtimeFor());
  if (!response.body?.Agent || response.body?.Error) {
    const requestId = validRequestId(response.body?.RequestId) ?? headerRequestId(response.headers);
    throw Object.assign(new Error(`${action} 未返回有效 Agent；先查询结果，不能盲目重复写入`), requestId ? { requestId } : {});
  }
  return response.body as Record<string, unknown>;
}

export function getAgent(client: SdkClient, name: string, agentVersion?: number) {
  return agentCall(client, 'GetAgent', { Name: name, AgentVersion: agentVersion });
}

export function createAgent(client: SdkClient, definition: {
  Name: string; SystemPrompt: string; Skills?: Record<string, unknown>[];
  ExpertSuites?: Record<string, unknown>[]; PublishImmediately?: boolean;
}) {
  return agentCall(client, 'CreateAgent', definition);
}

export async function updateAgent(client: SdkClient, definition: {
  Name: string; ExpectedVersion: number; SystemPrompt?: string;
  Skills?: Record<string, unknown>[]; ExpertSuites?: Record<string, unknown>[]; PublishImmediately?: boolean;
}) {
  const request = cast(definition, new UpdateAgentRequest({}));
  const response = await client.updateAgentWithOptions(request, runtimeFor());
  if (!response.body?.agent) {
    const requestId = validRequestId(response.body?.requestId) ?? headerRequestId(response.headers);
    throw Object.assign(new Error('UpdateAgent 未返回有效 Agent；先查询结果，不能盲目重复写入'), requestId ? { requestId } : {});
  }
  return response.body.toMap() as Record<string, unknown>;
}
