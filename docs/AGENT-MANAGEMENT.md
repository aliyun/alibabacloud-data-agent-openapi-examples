# 用后端示例准备自定义 Agent

管理员先创建并发布 Agent，再在网页“会话设置”中填入 Agent 名称（默认 `dataworks_data_agent`），或为后端直接调用配置 `DATAAGENT_AGENT_NAME`。网页不提供管理入口，不在启动或每次创建会话时自动创建 Agent。

| 语言 | 独立示例 | 客户端 |
|---|---|---|
| Node.js | [agent-management.ts](../server-node/examples/agent-management.ts) | 用管理身份调用 `createSdkClient`，传给示例函数 |
| Python | [agent_management.py](../server-python/examples/agent_management.py) | 用管理身份构造 SDK client，传给异步示例函数 |
| Java | [AgentManagementExample.java](../server-java/src/main/java/com/das/java/live/AgentManagementExample.java) | 用管理身份的 AppConfig 构造示例对象 |

管理身份与会话身份分别授权，不能因调用失败切换管理员身份重试：

| 权限层 | 需要检查 |
|---|---|
| RAM API | 管理需要 `dataworks:CreateAgent`、`dataworks:GetAgent`、`dataworks:UpdateAgent` 及目标地域、资源范围授权；会话 Action 另行授予 |
| DataWorks 产品侧 | Agent 所有权/可见性及引用资源权限；准备企业级 Skill/套件等资源时须满足租户管理员要求。RAM API 授权不会自动授予租户管理员，也不表示所有个人 Agent 操作都必须由租户管理员执行 |
| 数据源 | Agent 执行 SQL、读取表或调用工具所用身份的实际数据权限；发布 Agent 不会自动授权数据访问 |

以下命令从仓库根执行，使用 Bash/zsh。先执行 `cp .env.example .env.admin`，在本地受保护的 `.env.admin` 中配置管理身份、`MOCK=0`、地域、endpoint 与目标 `DATAAGENT_AGENT_NAME`。不要复制他人的凭证。会话服务仍使用自己的 `.env`；`DAS_ENV=admin` 只为独立管理进程选择配置，不是自动扮演角色。进程已导出的变量优先于文件，运行前确认凭证来源，勿打印完整环境。修改环境文件后重新运行命令；CLI 登录/profile 不会被这些 SDK client 自动读取。

独立管理函数没有 MOCK 回放分支，即使设置 `MOCK=1`，显式调用仍会请求真实 OpenAPI。只读核对使用 Get；Create/Update 只在确认目标身份、地域和名称后执行。

## 调用顺序

1. 在控制台准备并发布依赖 Skill/套件，取得 ID、来源及发布版本；按公开契约填写引用，不混用目录 ID、数据库 ID 和包版本。
2. 先选定唯一名称；已有同名 Agent 时使用 Get/Update，不重复创建。调用 `CreateAgent`，提供 `Name`、`SystemPrompt`，按需传 `Skills`、`ExpertSuites`。立即使用时显式传 `PublishImmediately=true`，省略/false 保存草稿。
3. 调用 `GetAgent` 核对保存的定义、引用和发布版本。保存与发布可能不是原子操作；失败先回读，不盲目重试 Create。
4. 更新时读取当前 `Agent.AgentVersion`，传入 `UpdateAgent.ExpectedVersion`，按需传 `PublishImmediately=true`。冲突后重新读取并决定修改，不自动覆盖。省略引用列表表示不修改；不要为了补齐参数把 `Skills`/`ExpertSuites` 写成空数组，空数组会请求清空引用。
5. 将已发布名称写入会话服务环境配置，启动任一语言后端：

```dotenv
DATAAGENT_AGENT_NAME=my-published-agent
DATAAGENT_MODE=yolo
DATAAGENT_MODEL=
DATAAGENT_REASONING_EFFORT=none
```

模型与思考值需由目标模型支持；`none` 关闭思考，留空沿用 Agent 配置。`DATAAGENT_MODE` 默认 `yolo`，模型默认不代表审批模式默认。修改配置后重启会话后端，再在网页会话设置填入目标 Agent 名称并按需调整选项，创建新会话验证；不会修改已有会话。ACS 无需 ProjectId 或资源组。目标地域需部署对应接口，依赖须已发布且可见，HTTP 200 不等于发布成功。

## Node.js：先只读核对

先在根目录安装 `npm ci`。示例文件只导出函数，直接执行它不会发起管理请求。下面显式构造 client 并调用 Get，仅打印名称、版本与请求 ID：

```bash
DAS_ENV=admin node --import tsx --input-type=module <<'JS'
import { loadConfig } from './server-node/src/config.ts';
import { createSdkClient } from './server-node/src/sdk.ts';
import { createAgent, getAgent, updateAgent } from './server-node/examples/agent-management.ts';
const cfg = loadConfig();
const client = createSdkClient(cfg);
const result = await getAgent(client, cfg.agentName);
console.log({ Name: result.Agent?.Name, AgentVersion: result.Agent?.AgentVersion, RequestId: result.RequestId });
JS
```

创建新名称时，将上面 `const result = ...` 替换为以下调用；这一步会写入并请求发布：

```typescript
const result = await createAgent(client, {
  Name: cfg.agentName,
  SystemPrompt: '你是数据分析助手，请基于授权范围内的查询结果回答。',
  PublishImmediately: true,
});
```

更新时，把已回读并核对的正整数版本填入 `ExpectedVersion`，再替换调用；不要把 POP API 版本 `2024-05-18` 当作 AgentVersion：

```typescript
const result = await updateAgent(client, {
  Name: cfg.agentName,
  ExpectedVersion: 1, // 替换为刚回读并核对的 Agent.AgentVersion
  SystemPrompt: '请先核对数据口径，再基于授权范围内的查询结果回答。',
  PublishImmediately: true,
});
```

写入后再次执行只读 Get，核对定义、引用及发布信息。上述摘要只用于定位版本，不足以证明发布成功；通过单独授权的会话身份创建新会话，验证已发布定义。不要整包打印 Agent 响应，MCP 配置或 Metadata 可能包含敏感信息。

引用由示例序列化为 JSON form 字段，但示例不会验证目标接口是否支持各引用键。`ExpertSuites` 使用 `SuiteId`/可选 `Version`；省略版本时由服务端固定到当前发布版本，后续套件更新不会自动改变 Agent 引用。`Skills` 的名称、来源、目录 ID 和版本字段须按目标地域已发布的公开契约填写，不能仅凭示例注释判断支持 `Source`/`SkillId`/`Version`。不要把占位 ID 发到线上。

### Skill 与套件引用

对支持官方目录引用的新应用，按资源来源选择键；ID 必须从目标地域的已发布资源取得，不能按展示名猜 ID。

| 引用 | 示例对象 | 版本 |
|---|---|---|
| 官方 Skill | `{ "Source": "OFFICIAL", "SkillId": "替换为官方目录ID" }` | 不传 DB Version |
| 官方套件 | `{ "Source": "OFFICIAL", "SuiteId": "替换为官方目录ID" }` | 不传 DB Version |
| 自定义 Skill | `{ "Source": "DB", "Name": "替换为已发布Skill名称", "Version": 2 }` | 使用该资源的发布版本 |
| 自定义套件 | `{ "Source": "DB", "SuiteId": "替换为已发布套件ID", "Version": 3 }` | 使用该资源的发布版本 |

将 Skill 对象放入 `Skills`，套件对象放入 `ExpertSuites`，然后传给各语言的 create 函数。上述占位符必须替换，不可直接执行；Source 等扩展键须在目标地域公开契约中已发布。管理接口仅引用资源，不上传 ZIP，也不创建 Skill/套件。

如果只需引用自定义套件，可使用下面的最小 Node 定义；Python 用同一对象列表传 `expert_suites`，Java 放入定义 Map 的 `ExpertSuites`：

```typescript
const definition = {
  Name: cfg.agentName,
  SystemPrompt: '基于所选套件的规则和授权范围回答。',
  ExpertSuites: [{ Source: 'DB', SuiteId: '替换为已发布套件ID', Version: 3 }],
  PublishImmediately: true,
};
// 核对并替换 ID/版本后：await createAgent(client, definition)
```

## Python 与 Java

两者也都是函数/类示例，没有管理 CLI 或独立 `main`；先完成对应语言依赖安装。以下 Python 命令只读：

```bash
DAS_ENV=admin server-python/.venv/bin/python - <<'PY'
import asyncio
import sys
sys.path.insert(0, 'server-python/examples')
from agent_management import get_agent
from das_python.config import load_config
from das_python.live import create_sdk_client
cfg = load_config()
r = asyncio.run(get_agent(create_sdk_client(cfg), cfg.agentName))
print({'Name': r['Agent'].get('Name'), 'AgentVersion': r['Agent'].get('AgentVersion'), 'RequestId': r.get('RequestId')})
PY
```

Python 的准确写入签名如下；创建函数要求显式提供两份引用列表，空列表仅适合不引用资源的新 Agent。当前更新示例只更新展示名，不能直接传 `system_prompt`、`skills` 等参数：

```python
await create_agent(client, name, system_prompt='基于授权数据回答。',
                   skills=[], expert_suites=[], publish_immediately=True)
await update_agent(client, name, expected_version=version,
                   display_name='数据分析助手', publish_immediately=True)
```

Java 在独立管理程序中调用以下类，传入管理进程自己的 AppConfig；`getAgent(name, null)` 读取当前版本，传正整数读取指定版本：

```java
try (var manager = new com.das.java.live.AgentManagementExample(
        com.das.java.config.AppConfig.load())) {
    var current = manager.getAgent("my-published-agent", null);
    // 确认 current 中 Agent.AgentVersion 后，显式选择 createAgent 或 updateAgent。
    // manager.createAgent(name, Map.of("SystemPrompt", prompt, "PublishImmediately", true));
    // manager.updateAgent(name, version, Map.of("SystemPrompt", prompt, "PublishImmediately", true));
}
```

三语言示例支持的更新字段不完全相同，以各函数签名为准。管理接口为 DataWorks `2024-05-18`，使用顶层 form 参数，返回 `{Agent, RequestId}`；会话接口使用 JSON-RPC `Params`，不可混用包装。

Node/Python SDK 9.11.0 已生成 `Model`、`ReasoningEffort` 创建参数及 `UpdateAgentSessionTitle` 方法，但仍未生成 `GetAgentSessionEvents`、`ArchiveAgentSession`、`DeleteAgentSession`、`UpdateAgent` 方法。本仓为这些缺口保留限定 Action/参数包装的适配器，复用官方 SDK 签名和传输；升级 SDK 不表示全部接口均已有生成方法。Node/Python 创建会话均使用正式字段模型构造并序列化，再通过统一 RPC 保留完整业务错误；Java 使用生成式创建方法。管理函数的调用方式不因此改变。

AssumeRole 仅见[独立接入指南](ASSUME-ROLE.md)。当前示例不自动获取 STS，也未透传 SecurityToken；不要把 STS 临时 AK/SK 当作长期 AK/SK 直接使用。管理凭证不进入前端、localStorage、导出配置或日志。
