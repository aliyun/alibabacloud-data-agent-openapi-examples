# 开发与验证

启动和环境配置见[README](../README.md)，接口用法见[调用速查](OPENAPI-EXAMPLES.md)。

## 目录与 SDK

| 目录 | 内容 | DataWorks SDK |
|---|---|---|
| `server-node/` | Fastify 后端 | Node.js SDK `10.0.0` |
| `server-python/` | FastAPI 后端 | Python SDK `10.0.0` |
| `server-java/` | Spring Boot 后端 | Java 异步 SDK `10.0.0` |
| `web/` | 统一网页 | — |
| `shared/` | TypeScript 协议与解析 | — |
| `scripts/` | 启动、测试与公开导出工具 | — |

Node.js 使用 22.x（至少 22.12）或 24.x；Python 3.11+；Java JDK 17+、Maven 3.6.3+。SDK 缺少生成方法的 Action 通过官方 SDK 通用签名调用，不能因此开启 Prompt 自动重试。

三种后端读取根 `.env`，或 `DAS_ENV` 指定的完整配置文件。Python/Java 不依赖 Node 后端；MOCK 数据共同读取 `server-node/test/fixtures/`。

## 本地验证

```bash
npm ci
npm run typecheck
npm test
npm run build
server-python/.venv/bin/python -m pip install -e './server-python[test]'
server-python/.venv/bin/python -m pytest server-python/tests
mvn -f server-java/pom.xml test
node --test scripts/test/assume-role.test.mjs scripts/e2e/*.test.mjs
bash scripts/contract-test.sh node
bash scripts/contract-test.sh python
bash scripts/contract-test.sh java
```

契约测试使用 MOCK、默认端口 3999，逐个运行；可设置 `CONTRACT_TEST_PORT`。`npm run build` 不构建 Python/Java。安装步骤见各语言 README。

## 真实 OpenAPI 回归

先确认配置中的账号、地域、Agent 与权限，真实脚本会创建会话并调用写接口。使用现有 LIVE 后端：

```bash
node scripts/e2e/run.mjs --base-url http://127.0.0.1:3000 --language node --region cn-beijing --mode yolo --reasoning-effort none
```

在提供 `UploadAgentSessionFile` 的环境中，设置 Workbench Node 后端的 `DAS_SESSION_ATTACHMENT_UPLOAD=1`。输入框支持拖入文件或点击 `+` 选择文件。配置下文的 OSS origin 后，单文件上限为 10 MiB。下列命令会验证满额上传、超限拒绝，以及 Agent 从实例附件中读回文件内容。

```bash
node scripts/e2e/run.mjs --base-url http://127.0.0.1:3000 --language node --region cn-beijing --mode yolo --attachments --attachment-max-mib 10
```

所有文件统一采用预签名对象暂存。浏览器向 Workbench 提交文件；Workbench 通过 `UploadAgentSessionFile` 的 prepare 阶段取得上传地址和签名请求头，将原始字节写入 OSS，再调用 complete。DataAgent 让实例内 runtime 下载、校验并原子写入文件，成功后返回实例路径。启用上传时必须配置 `DAS_SESSION_ATTACHMENT_OSS_ORIGIN`，值为环境精确的 HTTPS OSS 桶 origin。目标 POP 须已同步统一 OSS 契约并返回 `Signature.Headers`，Java 与 runtime 须已部署对应版本。客户端校验地址和签名头中的文件长度、MD5，再原样使用请求头。单文件最大 10 MiB，小文件也使用同一流程。该适配尚待统一 OSS 版本的真实预发复验，历史 Base64 验收不代表新版通过。

使用生产构建和同一 LIVE 后端复跑浏览器验收。脚本检查超限文件在客户端被拒绝、10 MiB 文件可通过 `+` 上传、小文件可拖入输入框、两条附件路径随 Prompt 提交，并在回复和历史中核对 Agent 从文件读到的内容。结束后只清理本次创建的会话。

```bash
npx playwright install chromium
node scripts/e2e/browser-attachments.mjs --base-url http://localhost:3000 --region cn-beijing
```

如果本机已安装 Chrome，可跳过 Chromium 安装，并给脚本加上 `--channel chrome`。

签发地址使用 OSS V4，将 `Content-Length` 和 `Content-MD5` 绑定到请求。暂存对象要保留到重试窗口结束，目标桶须为 `session-attachment-staging/` 前缀配置过期清理。签名有效期和对象过期是两项独立配置。上线前由桶所有者回读生命周期配置，核对规则已启用、覆盖此专用前缀，且过期时间超过确认重试窗口。可对已完成的合成测试对象执行 `HeadObject`，从 `x-oss-expiration` 核对实际到期时间和命中的规则 ID。若桶开启版本控制，还需核对非当前版本的清理规则。确认请求复用上传 ID 作为实例附件标识，实例仅在现存文件字节一致时返回同一回执。

验证双进程分流、完成首轮后重启代理并以原 sessionId 续问：

```bash
node scripts/e2e/managed.mjs --language node --region cn-shanghai-finance-1 --mode yolo --reasoning-effort none
```

`--language` 可改为 `python` 或 `java`，后者须先构建。受管脚本只停止自己启动的进程，不接管已占用端口。完整检查包括创建、Prompt 自身终态、独立 Events 回答、历史、游标续接和上下文、空闲取消、改名、归档/恢复及删除。成功才删除测试会话，失败保留 sessionId；`managed.mjs` 无论成功失败都会清理自己的代理进程。

需要空闲复测并保留失败进程时，使用 Node 专用入口：

```bash
node scripts/e2e/soak.mjs --region cn-shanghai-finance-1 --idle-seconds 0,15,45,75
```

首次失败即停止后续写入，保留会话、PID、base URL、流进度及连接元数据；不再 Prompt、Cancel、Delete 或重启。报告放在私有临时目录，不记录凭证、业务正文、请求 query 或任意原始异常。取证后核对 PID/启动命令再停止，不按端口清理。成功时自动清理自有资源。

测试中的语言、Git SHA/dirty 和请求配置是测试声明，不代表云端服务版本；MOCK 不作为云端验收证据。

## 文件变更与远端目录

Web Shell 使用官方 `@qwen-code/web-shell@0.27.1`，已包含上游 [#15070](https://github.com/QwenLM/qwen-code/pull/15070) 的无工作区 diff 展示修复。修改依赖声明后应执行 `npm ci` 并重启本地前端，避免仍加载旧安装产物或 Vite 缓存。

验证后端同源托管的生产页面时，使用 `VITE_API_BASE= npm run build`，防止本地 `.env` 中的开发 API 地址被写入构建产物。

OpenAPI 适配层的 `/data-agent/out/<sessionId>` 仅用于满足 SDK 的 standalone 响应协议，不代表已获取云端沙箱目录。前端在 SDK 校验通过后，只将当前会话的这个占位值归一化为未知目录；创建、加载和恢复保持一致。已知真实目录、其他会话目录及未安装此适配层的原生 SDK 客户端不受影响。不要直接把后端字段改为空字符串，SDK 会拒绝加载/恢复响应。

文件变更面板展示工具记录的 diff，不重新读取文件。无有效工作区权限时不提供文件预览或下载，也不注册虚拟工作区。验收需覆盖生成文件、展开文件 diff、刷新恢复；自动化回归同时验证真实目录保留、SDK 错误校验、游标和客户端隔离。

## 流与状态边界

- LIVE 后端不维护会话 Registry、journal、权限等待表或完成回执。sessionId 与远端游标由前端传入，历史和控制操作以远端为准；MOCK 保留独立内存状态。
- `promptTransport` 握手选择 LIVE HTTP NDJSON 或 MOCK daemon 协议，握手失败不降级写入。Prompt HTTP 提供本浏览器轮次内容及结果，独立 Events 提供观察通知；浏览器请求结果缓存上限 64，不跨整页刷新持久化。
- 断开本地读取不自动取消远端任务；显式停止才调用 Cancel。连接内有可信 rid/offset 时可尝试有界、只读 Load 续接，不重发 Prompt。后端重启或结果未知时先读取历史核对。
- Load 没有已核实的 Events 原子快照水位；不承诺历史/订阅无间隙、在途崩溃无缝恢复或远端跨节点恢复。heartbeat 只表示代理可达；无法权威查询的状态返回不可用。
- Node 用 SDK 支持的 `connection: close` 使响应结束后关闭连接，避免自身留下陈旧空闲连接；不提前结束 SSE、不改变 TLS 校验，代价是增加建连开销。这是缓解措施，不是所有 ECONNRESET 的根因证明。

## 排查失败

先保留 sessionId、时间、后端语言、实际返回的 requestId/rid/offset、已收帧数及错误码，再读取远端历史。不要因断流或 HTTP 200 就认定任务失败或成功，也不要直接重发 Prompt。

问答卡使用实际事件中的 requestId/选项 ID。后端为 ask_user_question 补充的 UI 提交动作不作为远端选项发送，答案按原始问题索引回传。已有问题可能已被其他端处理，Reply 被接受不代表本地断流已恢复。


## 页面实时连接恢复

Node/Java 的独立 Events 透传 `Last-Event-Id` 和原生 `EventEpoch`，只认真实上游 header 或 `stream_open.data.eventEpoch`，不再构造 `openapi:region:SID`。严格订阅的 epoch 缺失或不一致时拒绝该次订阅，保留已在消费的 Prompt。Load 仍无已核实的实时事件水位。

本轮 Prompt 内容为单一来源：已消费的首帧文字和权限卡照常展示，独立 Events 的同原生 Prompt 重复内容会过滤。缺少游标仍可由 Prompt 完成本轮。未消费内容每轮上限4 MiB；超过时明确要求核对历史，不无限积压或自动重发。浏览器最多保留64条请求结果，切换整页不持久化这些临时结果。

闲置产生的 `DAEMON_SESSION_NOT_FOUND`、`INSTANCE_NOT_FOUND`、`RUNTIME_NOT_READY` 不作为模型失败，也不循环 Load/唤醒实例；订阅暂停后由下一次真实 Prompt 恢复。恢复期间得到原生游标后重建 Events。SDK跨epoch时通过公共游标setter清除旧代事件号，旧连接迟到的数据不能覆盖新代状态。

独立 Events 建流或解码失败不打断已受理的 Prompt；Prompt 自己断流仍是结果未知，需要读取历史核对，不自动重发。用户主动停止与切换页面分开处理，只有主动停止才调用 Cancel。

独立公共入口回归（需云端写入授权）使用 `scripts/e2e/prompt-events-resume.mjs`，支持 `--language node|java`，两轮每轮仅提交一次Prompt，取得首个可信游标后才订阅、按事件ID比对独立Events与Prompt内容后缀，第二轮不Load。可指定 `--idle-ms 1860000` 覆盖真实闲置释放；默认不等待，未执行该选项不能宣称30分钟场景已真实验收。隔离服务使用 managed.mjs 的 startOwned/unusedPort，仅停止自己启动的进程；成功只删除自建Session，失败保留证据。
