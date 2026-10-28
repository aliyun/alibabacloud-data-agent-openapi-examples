# 使用 Python 后端

> 包含基础 API 和 `/d` Web Shell 协议适配。新增 POP 接口需在目标环境发布后使用；三语言官方 Agent 会话主链已完成真实回归；管理身份、全部配置组合与角色接入不在该结论内。调用示例见[接口速查](../docs/OPENAPI-EXAMPLES.md)。

需要 Python 3.11+，网页仍需要 Node.js 22.x（至少 22.12）或 24.x（推荐 22.x）与 npm 10+。所有命令在项目根目录执行。

首次安装：

```bash
npm ci
python3 -m venv server-python/.venv
server-python/.venv/bin/python -m pip install -e ./server-python
```

启动网页与后端：

```bash
MOCK=1 npm start -- python
```

打开终端显示的网页地址。真实使用时，按[主 README](../README.md)填写 `.env`，去掉 `MOCK=1` 后启动。

启动脚本优先使用 `server-python/.venv/bin/python`，不需要激活虚拟环境。没有这个环境时使用 `python3`，此时必须确保依赖已安装到该解释器。

## 只启动后端

```bash
bash scripts/dev-server.sh python
```

默认监听 `http://127.0.0.1:3000`。前端单独运行方式与端口设置见[主 README](../README.md)。

出现 `No module named das_python` 或 `fastapi` 时，重新执行上面的虚拟环境安装步骤。复制或移动仓库后建议重新创建虚拟环境，因为其中的路径可能指向旧目录。


## 会话配置与实时事件

`DATAAGENT_AGENT_NAME` 指定已存在的 Agent。创建默认值使用 `DATAAGENT_MODEL`、
`DATAAGENT_MODE`（默认 `yolo`）、`DATAAGENT_REASONING_EFFORT`；
`DATAAGENT_MODELS` 是逗号分隔的模型 ID 提示列表，不替代服务端模型校验。

`GET /d/standalone/session-options` 在标准 provider/model 列表外返回环境 `approvalMode`；
未指定模型时提供 `data-agent` 默认模型占位项。前端可直接使用环境默认值和现有选择器，
无需创建弹窗。`GET /d/openapi/session-options` 仅返回安全配置：
`{agentName, model?, approvalMode, reasoningEffort?, models:[string], promptTransport}`。
`promptTransport` 在 LIVE 为 `http-stream`，MOCK 为 `daemon`。
`POST /d/standalone/sessions` 接受
`{modelServiceId?, approvalMode?, reasoningEffort?}`，UI 值覆盖环境默认值。
`POST /api/sessions` 共用校验和请求构造，也保留原有 `mode` / `model` 参数。
旧 SDK 客户端传入的 `modelServiceId=data-agent` 是占位值：使用环境模型，未配置时省略 Model。
Mode 支持 `plan/default/auto-edit/auto/yolo`；思考深度由目标模型及 POP 校验，
不臆造所有模型通用的枚举。空字符串和错误类型会在调用上游前拒绝。
配置在创建时应用；已有会话的 model、approval-mode、config-option 修改返回 409
`requires_new_session`。没有运行时修改成功的模拟响应。

LIVE 改名、归档/取消归档和删除分别调用 `UpdateAgentSessionTitle`、
`ArchiveAgentSession`、`DeleteAgentSession`。归档目录使用远端 `ListAgentSessions`
的 `Archived` 过滤器；没有本地摘要、归档或删除缓存，批量操作逐项报告远端结果。

LIVE `GET /d/session/:id/events` 使用 `GetAgentSessionEvents`，GET query 为
`SessionCode`，续传通过 `Last-Event-Id` header。兼容 POP `Id/Event/Data`
包装及裸 daemon 帧，Event 可为对象或包含整帧的 JSON 字符串，Data 可为整帧或具名事件载荷。
扁平 `{sessionId,update}` / `{sessionId,stopReason}`（可附 promptId）会分别规范化为
`session_update` / `turn_complete`，不丢弃更新内容。
仅含 RequestId 的确认帧跳过。校验安全整数游标并优先保留外层 SSE 游标；同一远端游标同时写入 SSE id 行和
规范化 daemon JSON 的数值 id，供 SDK/harness 持久化续传，不生成本地序号。拒绝携带其他
sessionId 的事件，不会将其改写成本会话。显式 `Last-Event-Id: 0` 原样发送，保留从起点回放的语义；没有 header 时不附加游标。
Load 读取远端历史，Prompt 通过独立 HTTP 请求提交新问题；LIVE 不创建 Registry、journal、pending 权限表或完成回执缓存。
浏览器 epoch 由 endpoint、region、session 稳定导出，与本地 journal 纪元分离。
断线由客户端重订阅，后端不会为恢复 Events 重发 Prompt。

产品 SDK 9.11.0 已包含模型、思考深度和重命名；尚未包含 Events、归档、删除及 UpdateAgent，故窄适配器复用 SDK 的签名、endpoint、
禁用重试配置。Events 使用底层 `call_sseapi_async` 读取原始 SSE；
普通异步 `call_api_async` 的 binary 模式仍会 buffer，因此不用于 Events。
未来升级 SDK 时，仍需验证无缓冲、字段保留和空 Result 的删除成功语义。

## 独立 Agent 管理示例

[examples/agent_management.py](examples/agent_management.py) 提供异步
`create_agent` / `get_agent` / `update_agent`，仅在显式调用时执行。
应用启动、页面和创建会话不会自动调用管理接口。传入单独构造的管理员 SDK client，
与日常会话 client 分开配置。示例覆盖官方/自定义资源引用、`PublishImmediately`
和 `ExpectedVersion`；不包含 AssumeRole。

更新前读取当前 `GetAgent` 的 `Agent.AgentVersion`，作为 `expected_version`。
版本冲突需重新读取合并；发布失败可能已保存草稿，重试创建前先查询。
管理响应保留公开 wire 字段，不改写任意 map 中的键名。

## 离线验证

在 `server-python` 目录执行 `.venv/bin/python -m pytest -q`。
测试包含实际 SDK 对 localhost SSE 的增量读取与签名路由校验，使用合成凭据，
不创建云资源。线上权限、发布状态、模型实际配置和双端交互仍需单独验收。


## LIVE Prompt：HTTP 请求持有自己的终态

```http
POST /api/sessions/{sessionId}/prompt
Content-Type: application/json

{"text":"请查询已授权的数据。"}
```

响应为 `application/x-ndjson`。`StreamingResponse` 先发送 HTTP headers，客户端不必等待模型首帧即可取得 Response，再持续读取该请求的 NDJSON。收到响应头不代表任务已经执行成功；只有本请求的 `done` 且有效 stopReason 才表示完成，`error` 表示失败或结果未知。终态前 EOF 明确报 `stream_break`（零帧时为 `prompt_not_dispatched`），不能当成功或自动重发 Prompt。

本流保留官方 own 请求结果及归一化错误。WebShell 的内容来自独立 Events 订阅，浏览器消费 own NDJSON 来完成本次发送，不重复渲染其中内容。前端需有严格大小上限的 UTF-8/逐行解析，不得把无限 NDJSON 缓存在内存。

LIVE 不拿进程级 inflight 锁，同一 sid 的并发由上游判定；rid、offset、去重和有界 Load 恢复预算只属于本连接。恢复只读取原轮次的 Load，不重发 Prompt。客户端断开时关闭本请求的上游迭代器，不自动调用 Cancel；云端任务可能仍在执行，应由用户读取历史或显式取消。

旧 LIVE `POST /d/session/{sid}/prompt` 和
`POST /d/session/{sid}/openapi-prompt/{promptId}/receipt` 均返回 **410**，不创建后台任务、admission 或本地完成回执；不存在第二条 LIVE Prompt 执行路径。MOCK 仍使用原有 daemon 202、Registry、journal 和本地在途锁。

## LIVE 会话与权限：远端权威

- 会话列表和详情每次读取远端列表；详情查询包含活动和归档目录。未找到返回 404，目录被分页上限截断或查询失败时明确报错，不用旧摘要兜底。
- Load、Resume、Transcript 每次读取 `LoadAgentSession` 并做本次响应的纯转换。`compactedReplay` 来自本次 Load，`liveJournal=[]`；不分配本地事件 ID、不保存 session options，也不把创建时配置当作权威运行时配置返回。
- `/d/session/{sid}/permission/{requestId}` 使用路径 sid 直接调用 `ReplyAgentSession`，不要求本进程先收到人卡。不保存 pending/resolved，也不据本地状态跳过重复回复；是否受理由上游决定。问答 UI 合成选项只用于本地转换，不传到 POP。
- 无 sid 的旧 `/d/permission/{requestId}` 返回 400，不扫描进程 Map 猜测所属会话。
- `/d/session/{sid}/status` 和 `/d/daemon/status` 缺少远端权威运行态，返回 404 降级；目录中未知的活动状态不伪造为 false。404 不是重发 Prompt 的依据。
- `/d/session/{sid}/heartbeat` 返回 204 空响应，不创建会话状态，也不调用上游；前端须接受空返回。

LIVE Events 是纯远端代理：仅从当前请求的 `Last-Event-ID` header 读取游标，忽略 query 中的游标和 snapshot，不记住前一连接的最大 ID。保留 POP 解包、sessionId 校验、SSE id 与数值 data.id 映射；远端 EOF 立即结束，失败输出明确错误后结束，不等本地 receipt、不合并本地控制事件。

Load 没有已核实的历史快照水位，故省略 `lastEventId`。Load 与随后 Events 订阅不是原子操作，不能宣称消除了历史/订阅间隙。跨后端实例或进程重启后，历史、权限和会话元数据仍由远端读取；此改动不等于已验证前端恢复、网关长连接或生产多副本部署。

## 取消与兼容边界

LIVE Cancel 保留原始 POP `Delivered` / `Noop` 及 JSON-RPC Error；传输失败、RPC 拒绝、无效结果或未确认送达不会返回取消成功。`Noop=true` 是有效空闲取消，daemon 路由返回 204；失败返回 502。

兼容响应仅含匹配 `SessionId` 的 legacy ACK：报告 `accepted=true`、`delivered=false` 和 `cancel-accepted-legacy`，不推断 noop 或执行终态。显式 false 标记、SID 不匹配、RPC Error 或空结果仍失败。LIVE 不生成本地 cancelled 事件，也不因取消回执就判定自己的 HTTP Prompt 已完成。

可选角色启动脚本与临时 AK/SK/Token 配置见 [AssumeRole 指南](../docs/ASSUME-ROLE.md)；普通启动直接使用配置中的 AK/SK。
