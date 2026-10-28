# 使用 Java 后端

Java 已实现 web-shell 会话接口，可独立运行完整网页交互，不需要同时启动 Node.js 后端。

需要 JDK 17+、Maven 3.6.3+，网页仍需要 Node.js 22.x（至少 22.12）或 24.x（推荐 22.x）与 npm 10+。所有命令在项目根目录执行。

确认环境并启动：

```bash
java -version
mvn -version
npm ci
MOCK=1 npm start -- java
```

首次启动自动下载 Maven 依赖并打包；以后源码或 `pom.xml` 更新时会重新打包。打开终端显示的网页地址。真实使用时，按[主 README](../README.md)填写 `.env`，去掉 `MOCK=1` 后启动。

macOS 安装了 JDK 17 时，脚本优先选用它；其他环境请保证 `JAVA_HOME`、`java` 和 Maven 使用兼容的 JDK。

## 只启动后端

```bash
bash scripts/dev-server.sh java
```

默认监听 `http://127.0.0.1:3000`。需要手动构建时：

```bash
mvn -f server-java/pom.xml package
```

若依赖下载失败，检查 Maven 网络或镜像配置后重试。启动脚本为了缩短等待跳过单元测试；上面的手动构建命令会运行测试。

使用外部取得的 STS 临时凭证时，须同时注入 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET` 和 `ALIBABA_CLOUD_SECURITY_TOKEN`。Java SDK 的 REST、SSE 和通用 POP 调用均透传 Token；本示例不自动扮演角色或续期，到期前需更新凭证并重启服务。详见 [AssumeRole 接入指南](../docs/ASSUME-ROLE.md)。

## LIVE 无状态会话代理

`GET /d/openapi/session-options` 返回 `{agentName, model?, approvalMode, reasoningEffort?, models, promptTransport}`；LIVE 的 `promptTransport` 为 `http-stream`，MOCK 为 `daemon`。默认值读取 `DATAAGENT_MODEL`、`DATAAGENT_MODE`（默认 `yolo`）、`DATAAGENT_REASONING_EFFORT` 和逗号分隔的 `DATAAGENT_MODELS`。

新建会话接受 `{modelServiceId?, approvalMode?, reasoningEffort?, agentName?}`，通过 POP `Params.Meta.InitialConfigOptions` 传递。支持 `plan/default/auto-edit/auto/yolo`，`data-agent` 占位符不作为真实模型 ID。配置仅在创建时应用，已有会话配置端点返回 409 `requires-new-session`。`/d/standalone/session-options` 的选择器显示创建默认值；Load 不以环境默认值冒充远端模型状态。

Agent 默认名为 `dataworks_data_agent`，环境变量 `DATAAGENT_AGENT_NAME` 可覆盖。创建时的 `agentName` 仅覆盖本次请求的 `Params.Meta.Agent.AgentName`，不修改进程默认配置。省略或 null 使用环境默认值；显式名称先去除两端空格，要求非空、不超过 128 字符且不包含控制字符。

`GET /d/standalone/sessions`、`GET /d/standalone/sessions/{id}` 和 `GET /api/sessions` 支持可选查询参数 `agentName`。LIVE 列表仍使用原有 session-source 和归档筛选；lookup 保留 SID 筛选，仅在显式提供时添加 Agent 筛选。没有会话到 Agent 的内存映射，Prompt/Load 继续只依赖 SID。

### 提交和本请求完成

LIVE 只使用 `POST /api/sessions/{id}/prompt`、body `{text}`，返回 UTF-8 NDJSON。参数校验后立即 flush 响应 headers，不等待模型首帧；HTTP 200 表示流已建立，不能单独当作 POP 已执行成功。浏览器持续消费自己请求的 `meta/frame/done/error`，按有效 `done.stopReason` 或 `error` 结算自己的 UI 请求；页面内容来自独立的远端 Events 订阅，不重复渲染 NDJSON 内容。

每个连接独立持有帧处理、rid/offset、只读恢复和有界输出队列；LIVE 不使用全局 inflight 锁。多个提交的业务准入交由 POP 判定。恢复只读当前轮次的远端 Load，并过滤其他轮次/Load 自身终态，不重发 Prompt。无真实终态的 EOF（含零帧/ACK-only）是 `stream_break`，结果未知；未知 stopReason 不能产生成功 done。客户端断开会关闭本地读取并释放连接资源，不自动 Cancel。需要取消时显式调用 cancel 端点。

旧 LIVE `POST /d/session/{id}/prompt`（202 后台提交）和 `POST /d/session/{id}/openapi-prompt/{promptId}/receipt` 均返回 410。没有本地 admission/completion/receipt 缓存或额外控制事件，也没有跨实例 waiter 状态。MOCK 保留原来的 daemon 202、journal 和演示准入锁。

### 远端事件和权威状态

LIVE `/d/session/{id}/events` 直接以路径 SID 调用 POP `GetAgentSessionEvents`：query 为 `SessionCode`，游标只读取 `Last-Event-Id` header。显式 `0` 原样上送，缺省 header 表示没有续接游标；不会从 Load、本地 Map 或其他连接补 cursor。保留现有 POP `{Id,Event,Data,RequestId}` 解包、daemon 事件展开、UTF-8、id/event/cursor 校验、跨 session 拒绝和业务 Error 拒绝；不生成本地 terminal。允许 idless `stream_open`，跳过 ACKRequestId-only 控制帧。首帧前失败为 502，响应开始后失败终止流。

LIVE 不构造 Registry/Runner，也不保存 session summary、creation options、pending/resolved permission、deleted/archived 标记或历史。列表直接取 POP；单会话 lookup 用 SDK 的精确 `SessionId` 过滤查询 active/archived。rename/archive/delete 只以远端操作结果确认，随后读取的标题/归档状态仍取远端，不用本地覆盖掩盖读回结果。批量失败逐项返回 errors。

Load、resume、transcript 每次都读取本次远端历史，转换为临时响应；Load 返回 idless `compactedReplay`、空 `liveJournal`、未知模型 `{currentModelId:null,availableModels:[]}`。未提供已核验的快照水位时省略 `lastEventId`。eventEpoch 稳定使用 region/session，不随进程重启改变。adapter workspace 等必需协议字段不代表远端文件系统观测；未观测到的状态/时间不合成缓存事实。

permission 必须有路径 SID，每次直接调用 POP 验证，不能凭本地缓存判断已处理；UI-only answers sentinel 会被移除。无 SID 的 legacy permission 返回 404。session/daemon status 无可靠远端数据时返回 404 降级，heartbeat 返回空 204；两者均不会触发 Prompt、重发或 Cancel。远端内容、历史和权限在跨 server/重启后仍由 POP 决定。Load/Events 没有已核验的原子快照订阅协议，本示例不宣称关闭该 gap。

Cancel 保留兼容：现代响应明确 Delivered/Noop 为 true，或旧响应仅有匹配 SID 且不含这两个字段时允许受理。legacy 返回 `accepted:true,delivered:false,warning:cancel-accepted-legacy`，不伪造 noop/取消终态；显式 false/false、SID 不匹配、业务错误与未知结果不当成功。

## SDK 覆盖与本地验证

使用官方异步 SDK `com.aliyun:alibabacloud-dataworks_public20240518:9.0.17`。创建会话、改名、列表使用生成式 `AsyncClient` 方法；Prompt/Load 保留生成式 SSE 方法。Agent Create/Get 和 Cancel 使用正式请求模型及 SDK core 原始响应，避免生成式响应丢失业务错误或兼容字段。未建模的操作通过官方 `BaseClientBuilder` / `TeaAsyncHandler` 扩展接口调用，原始 Events GET 使用 SDK 签名及字节流传输；没有自写签名、应用反射或运行时 AssumeRole。

按 9.0.17 的实际 JAR/source 核对（不是按 Node/Python SDK 推断）：

| 能力 | 正式 SDK 模型与本示例调用方式 |
| --- | --- |
| 会话创建配置 | `CreateAgentSessionRequest.InitialConfigOptions` 包含 `Model/Mode/ReasoningEffort/ProjectId/ResourceGroupId`，使用生成式 `createAgentSession`，未设置选项不发送。 |
| 改名 / 归档列表 | `UpdateAgentSessionTitleRequest` 和 `ListAgentSessionsRequest.Params.Archived` 已覆盖，使用生成式方法。 |
| 原始 Events | JAR 没有 `GetAgentSessionEventsRequest` 或同名 AsyncClient 方法；保留签名 GET，`SessionCode` query、`Last-Event-Id` header 和原始 SSE。 |
| 归档 / 删除会话 | JAR 没有 `ArchiveAgentSessionRequest` / `DeleteAgentSessionRequest`，保留通用 SDK POST 与原始 JSON-RPC 业务错误检查。 |
| Agent 创建 / 发布 | `CreateAgentRequest` 有顶层 `PublishImmediately`、Model、Skills、ExpertSuites 等；使用正式请求模型。`CreateAgentResponseBody.Agent` 缺 `AgentVersion`，保留原始响应；没有独立 `PublishAgentRequest`。 |
| Agent Get / Update | `GetAgentRequest.AgentVersion` 已覆盖；生成式 Get 响应没有顶层 Error，保留原始响应校验。JAR 没有 `UpdateAgentRequest`，Update 保留通用 POST、`ExpectedVersion` 和 `PublishImmediately`。 |
| Cancel | `CancelAgentSessionRequest.Params.SessionId` 已覆盖；响应 `Result` 只有 SessionId，缺 Delivered/Noop，且 JSON-RPC 响应缺 Error。使用正式请求、原始响应，保留本文末尾的 legacy ACK 与显式 false/false 语义。 |

验证命令（JDK 17+，本轮使用 JDK 21）：

```bash
mvn -f server-java/pom.xml clean package
```

依赖已缓存时可加 `-o`。测试只使用 MOCK、模拟客户端与 loopback HTTP，不调用云。覆盖无状态路由、跨实例历史/权限、每连接 NDJSON 并发/早发 headers/断线、独立 rid/offset 恢复、远端 SSE 校验、SDK wire 和 Cancel legacy。

## 显式调用的 Agent 管理示例

`com.das.java.live.AgentManagementExample` 提供 `createAgent`、`getAgent` 和 `updateAgent`，使用管理员显式传入的 `AppConfig` 创建私有 SDK 客户端。它没有 Spring Bean、启动钩子、管理路由或 UI；创建对象不发送请求，只有调用方法才会访问远端。管理员凭证可与会话调用身份分离，不执行运行时 AssumeRole，不输出配置或凭证。

以下代码仅演示按需调用，不接入应用启动。`administratorConfig` 由调用方注入；API 返回原始 `{Agent,RequestId}`：

```java
try (var admin = new AgentManagementExample(administratorConfig)) {
    var definition = Map.<String, Object>of(
        "DisplayName", "业务数据助手",
        "SystemPrompt", "基于授权范围内的查询结果回答。",
        "Model", Map.of("modelName", "provider/model"),
        "Skills", List.of(Map.of("Source", "DB", "Name", "business-skill", "Version", 2)),
        "ExpertSuites", List.of(Map.of("Source", "DB", "SuiteId", "suite-example", "Version", 3)),
        "PublishImmediately", true);
    var created = admin.createAgent("business-agent", definition);
    var current = admin.getAgent("business-agent", null);
    int expected = ((Number) ((Map<?, ?>) current.get("Agent")).get("AgentVersion")).intValue();
    var updated = admin.updateAgent("business-agent", expected,
        Map.of("Description", "更新说明", "PublishImmediately", true));
    var pinned = admin.getAgent("business-agent", expected);
}
```

这些管理请求是顶层 form：`Name`、`Model`、`Skills`、`ExpertSuites`、`PublishImmediately`、`ExpectedVersion` 等；没有 `Jsonrpc/Id/Params`。对象和数组分别 JSON 编码成其对应 form 字段。`PublishImmediately` 默认为 false，只有显式 true 才请求立即发布。更新用 `GetAgent.Agent.AgentVersion` 作为 `ExpectedVersion`，并发冲突不会自动重试。`Skills`、`ExpertSuites` 引用中的 `Version` 是各自已发布版本，不能用 Agent 定义版本替代。`RuntimePolicy` 不在已核验契约中，示例拒绝该字段。

可选角色启动脚本与临时 AK/SK/Token 配置见 [AssumeRole 指南](../docs/ASSUME-ROLE.md)；普通启动直接使用配置中的 AK/SK。
