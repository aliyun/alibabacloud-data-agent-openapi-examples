# OpenAPI 调用示例

使用 DataWorks API 版本 `2024-05-18`。下面展示的是 POP Action 和参数，不是 Workbench `/api`、`/d` 路由。三语言使用同一套参数；SDK 字段命名不同，由示例负责序列化和签名。

## 先选调用身份

- **管理身份**：创建、查询、更新和发布 Agent。先准备已发布的 Skill/套件，再执行[三语言管理示例](AGENT-MANAGEMENT.md)。
- **会话身份**：按根 README 启动，在网页“会话设置”填入已发布的 Agent 名称（默认 `dataworks_data_agent`）。后端直接调用未指定 Agent 时使用 `DATAAGENT_AGENT_NAME`。会话流程不需要创建或更新 Agent 的权限，也不会自动切换管理员身份。
- **需要 AssumeRole**：使用[独立角色示例](ASSUME-ROLE.md)取得临时凭证后启动任意后端；三语言均传递 SecurityToken。普通启动仍直接使用配置中的 AK/SK。

## 接口与参数

调用 `UpdateAgent`、`ArchiveAgentSession`、`DeleteAgentSession` 或 `GetAgentSessionEvents` 前，请确认当前账号及目标地域已开启对应灰度。

| POP Action / 字段 | 作用与调用参数 |
|---|---|
| `CreateAgent` | 顶层 `Name`、`SystemPrompt`、`Skills`、`ExpertSuites`；显式 `PublishImmediately=true` 才请求立即发布 |
| `GetAgent` | 顶层 `Name`；可选 `AgentVersion`，省略读取当前定义 |
| `UpdateAgent` | 顶层 `Name`、刚回读的 `ExpectedVersion`、要修改的字段；可选 `PublishImmediately`。未修改的引用列表应省略；当前新后端对 `Tools`/`Skills`/`CallableAgents` 的空数组保留引用，`ExpertSuites=[]` 清空套件引用；发布失败后先回读 |
| `CreateAgentSession` | `Params.Meta.Agent.AgentName` 指定已发布 Agent；`Params.Meta.InitialConfigOptions` 下的 `Model`、`Mode`、`ReasoningEffort` 设置新会话配置 |
| `UpdateAgentSessionTitle` | `Params={SessionId, Title}`，修改会话标题 |
| `ArchiveAgentSession` | `Params={SessionId, Archived:true}` 归档；`false` 取消归档；列表使用 `ListAgentSessions.Params.Archived` 选择范围，不能恢复已删除会话 |
| `DeleteAgentSession` | `Params={SessionId}`；删除前确认目标，不能把测试清理代码直接用于用户会话 |
| `GetAgentSessionEvents` | **GET**，query 为 `SessionCode=sessionId`，可选 header `Last-Event-Id` 与配套 query `EventEpoch`；使用同一远端事件流的游标及代次，返回独立实时 SSE |

除管理接口和 GET Events 外，这里的会话调用使用 POST form：`Id` 为本次调用唯一字符串、`Jsonrpc=2.0`、`Params` 为 JSON 编码字符串。管理接口直接使用顶层 form 字段，不能把定义塞进会话的 `Params`。引用对象/数组由管理示例编码为 JSON。

创建配置的线上参数结构：

```json
{
  "Meta": {
    "Agent": { "AgentName": "my-published-agent" },
    "Config": { "SessionSource": "my-app" },
    "InitialConfigOptions": {
      "Model": "替换为账号已授权的完整模型标识",
      "Mode": "yolo",
      "ReasoningEffort": "none"
    }
  }
}
```

模型留空时**省略 Model 字段**，沿用 Agent 配置；`none` 关闭思考，仍须由模型支持。`Mode` 支持 `default/yolo/plan/auto-edit/auto`。这些参数只在创建时应用，不能用它们修改已有会话。YOLO 不会自动回答 `ask_user_question`。ACS 不需要资源组或 ProjectId。

## 会话接口的三语言示例

先按对应语言 README 安装依赖。以下是独立片段，按需放入自己的服务端程序；不是需要逐段执行的脚本。示例读取当前服务端配置，不从 CLI profile 获取凭证。直接调用 SDK 的片段会访问真实 OpenAPI，不受 MOCK 回放保护；先确认账号、地域与目标会话。

### Node.js

从仓库根使用 `node --import tsx` 运行自己的 TypeScript 程序。使用本仓的 SDK 适配函数：

```typescript
import { loadConfig } from './server-node/src/config.ts';
import { createSdkClient } from './server-node/src/sdk.ts';
import { liveCreateSession, liveSessionMutation } from './server-node/src/live.ts';
const cfg = loadConfig();
const client = createSdkClient(cfg);
const ctx = { cfg, client };
const created = await liveCreateSession(ctx, {
  modelServiceId: cfg.model, approvalMode: 'yolo', reasoningEffort: 'none',
});
if (!created.ok) throw new Error(created.error.message);
const sid = created.result.sessionId;

// 下列操作各自返回 ApiResult，调用方须检查 ok/error。
const renamed = await liveSessionMutation(ctx, 'UpdateAgentSessionTitle', sid, { Title: '新标题' });
if (!renamed.ok) throw new Error(renamed.error.message);
const archived = await liveSessionMutation(ctx, 'ArchiveAgentSession', sid, { Archived: true });
if (!archived.ok) throw new Error(archived.error.message);
const restored = await liveSessionMutation(ctx, 'ArchiveAgentSession', sid, { Archived: false });
if (!restored.ok) throw new Error(restored.error.message);
// 仅在确认要删除时调用：
// const deleted = await liveSessionMutation(ctx, 'DeleteAgentSession', sid);
```

Node 使用正式创建参数模型，然后经统一 RPC 保留完整业务错误；没有 SDK 生成方法的 Action 使用同一官方 SDK client 签名。[POP 调用与 SSE 解码](../server-node/src/openapi.ts)、[业务结果校验](../server-node/src/live.ts)。

### Python

从已安装本项目的虚拟环境运行。以下 `rpc` 使用当前 SDK client 签名，检查 JSON-RPC Error，并返回 `result`：

```python
from das_python.config import load_config
from das_python.live import LiveContext, create_sdk_client
from das_python.pop import rpc

async def example():
    cfg = load_config()
    ctx = LiveContext(create_sdk_client(cfg), cfg)
    initial = {"Mode": "yolo", "ReasoningEffort": "none"}
    if cfg.model:
        initial["Model"] = cfg.model
    created = await rpc(ctx, "CreateAgentSession", {"Meta": {
        "Agent": {"AgentName": cfg.agentName},
        "Config": {"SessionSource": cfg.sessionSource},
        "InitialConfigOptions": initial,
    }})
    sid = created["result"]["sessionId"]
    if not sid:
        raise ValueError("CreateAgentSession returned no SessionId")
    renamed = await rpc(ctx, "UpdateAgentSessionTitle", {"SessionId": sid, "Title": "新标题"})
    if renamed["result"].get("title") != "新标题":
        raise ValueError("Title was not confirmed")
    archived = await rpc(ctx, "ArchiveAgentSession", {"SessionId": sid, "Archived": True})
    if archived["result"].get("archived") is not True:
        raise ValueError("Archive was not confirmed")
    restored = await rpc(ctx, "ArchiveAgentSession", {"SessionId": sid, "Archived": False})
    if restored["result"].get("archived") is not False:
        raise ValueError("Restore was not confirmed")
    # 仅在确认要删除时调用：
    # await rpc(ctx, "DeleteAgentSession", {"SessionId": sid})
```

[实际参数构造与结果校验](../server-python/src/das_python/live.py)、[签名 RPC 与 SSE 适配](../server-python/src/das_python/pop.py)。

### Java

在 `server-java` 项目的独立程序中按需调用；使用 SDK `9.0.17`：

```java
import com.das.java.config.AppConfig;
import com.das.java.config.SessionOptions;
import com.das.java.live.LiveClient;

var cfg = AppConfig.load();
try (var live = new LiveClient(cfg)) {
    var created = live.createSessionWithOptions(new SessionOptions(cfg.model(), "yolo", "none"));
    var sid = (String) created.get("sessionId");
    live.renameSession(sid, "新标题");
    live.archiveSession(sid, true);
    live.archiveSession(sid, false);
    // 仅在确认要删除时调用：
    // live.deleteSession(sid);
}
```

Java 创建和改名使用生成式方法，缺少生成方法的接口通过[PopAdapter](../server-java/src/main/java/com/das/java/live/PopAdapter.java)签名；[LiveClient](../server-java/src/main/java/com/das/java/live/LiveClient.java)负责业务错误与结果校验。上述代码放在方法体内，不要放进应用启动钩子。

## 订阅、发送与续接

**灰度长任务推荐使用两条流。** 当前账号和目标地域需开启 `GetAgentSessionEvents` 灰度。创建会话后，保存返回的 `SessionId`，用它作为 Events 的 `SessionCode`。先建立 Events 订阅，再发送 `PromptAgentSession`，同时读取两条流，无需等待订阅结束。Workbench LIVE 用 Events 渲染进度和内容，用 Prompt 流处理本轮结果和业务错误。同一内容只渲染一次。直调 POP 时也可以仅消费 Prompt 自带的 SSE。

- `PromptAgentSession.Params={SessionId, Prompt:[{Type:"text", Text:"本轮问题"}]}`。第二轮只发送新问题，历史由远端会话维护。人卡问题通过 `ReplyAgentSession` 回复，requestId、选项 ID 和答案结构取自实际事件。
- Prompt 在收到业务终态前超时或断流，本轮结果未知。保持 Events 订阅以观察后续进度，避免自动重发 Prompt。HTTP 200、心跳和连接关闭都不能用来判定本轮成功。
- Events 断流后，用同一远端事件流最后已消费的 `Last-Event-Id` 和对应的 `EventEpoch` 尝试续接。省略游标只接收实时事件，显式 `0` 只尝试回放有界缓存。下表的 Demo 辅助方法目前只接收游标，需要同时传代次时可直接调用 POP。
- 页面刷新、重开会话、游标失效或收到 `state_resync_required` 时，用 `LoadAgentSession` 恢复或核对历史，再按需重建订阅。历史回放结束只表示本次读取完成。Load 与 Events 之间没有已验证的共同水位，恢复时可能需要重新同步界面状态。

| 语言 | Events 入口 | 流处理与游标校验示例 |
|---|---|---|
| Node.js | `openSessionEvents(client, sid, lastEventId?)` | [remote-events.ts](../server-node/src/daemon/remote-events.ts) 使用 `parseSse` 和 `remoteEvent` 增量解码与校验 |
| Python | `session_events(ctx, sid, last_event_id)` | [pop.py](../server-python/src/das_python/pop.py)；缺省传 `None`，通过异步迭代读取 |
| Java | `live.events(sid, cursor)` | [RemoteSseRelay](../server-java/src/main/java/com/das/java/live/RemoteSseRelay.java)；缺省 cursor 为 `null`，流使用后须关闭 |

## 实现索引

| 能力 | Node.js | Python | Java |
|---|---|---|---|
| 创建、Prompt、Load、Reply、Cancel、列表、用量和产物 | [live.ts](../server-node/src/live.ts) | [live.py](../server-python/src/das_python/live.py) | [LiveClient](../server-java/src/main/java/com/das/java/live/LiveClient.java) |
| 管理：Create/Get/Update Agent | [agent-management.ts](../server-node/examples/agent-management.ts) | [agent_management.py](../server-python/examples/agent_management.py) | [AgentManagementExample](../server-java/src/main/java/com/das/java/live/AgentManagementExample.java) |

HTTP 200 不等于业务成功：会话接口须检查 `JsonRpcResponse.Error/Result`，创建须得到非空 SessionId；Agent 管理须回读发布定义。SDK 最新版本也可能暂未生成某个 Action 的方法，本仓适配器仍使用官方 SDK 签名与传输。不要为处理连接失败自动重试 Prompt。

## 排查失败请求

取得远端 OpenAPI RequestId 时，`/api` JSON 和 Prompt NDJSON 的错误对象包含 `error.requestId`；`/d` 的字符串错误响应在顶层提供 `requestId`。Events 同时透传上游 `x-acs-request-id` 响应头，断流后也可在 Network 查看。页面报错会显示该 ID。

```json
{"error":"CreateAgentSession: INSTANCE_START_FAILED","code":"create_failed","requestId":"upstream-request-id"}
```

排查时提供时间、地域、sessionId 和 requestId。连接尚未到达上游等本地故障可能没有远端 ID，此时省略该字段；不会拿轮次 rid、事件游标或人卡 requestId 冒充。

`INVALID_SESSION_INITIAL_CONFIG` 表示远端拒绝初始会话配置。若上游提供具体原因，错误信息会附带 `reason`：`model_not_available`（模型不在目标实例目录）、`ambiguous_model`（模型匹配不唯一）、`capabilities_unavailable`（模型目录未就绪）、`reasoning_not_available`（模型不支持指定思考选项）。模型需填写目标实例的 `modelId`；留空使用默认模型。样例不会自动换模型重试。
