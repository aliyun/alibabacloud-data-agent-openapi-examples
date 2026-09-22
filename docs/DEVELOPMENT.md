# 目录与验证

使用方法见[主 README](../README.md)。这里面向需要修改或验证示例的维护者。

| 目录 | 内容 |
| --- | --- |
| `server-node/` | Fastify 与阿里云 Node SDK；另含现有 `/d` 兼容层 |
| `server-python/` | FastAPI 与阿里云 Python SDK |
| `server-java/` | Spring Boot 与阿里云 Java 异步 SDK（包含 SSE） |
| `web/` | 唯一的 web-shell 前端，通过 `/d` 连接所选后端 |
| `shared/` | TypeScript 类型、帧解析、聚合和错误分类 |
| `scripts/` | 启动与跨语言验收 |

三种后端读取根 `.env` 或 `DAS_ENV` 选中的文件。Python、Java 自己实现帧解析与错误分类，不依赖 Node 进程。当前 MOCK 数据共同读取 `server-node/test/fixtures/`；目录改名后必须同步检查三种语言的定位逻辑。

## Node.js 版本

支持 Node.js 22.x（至少 22.12）和 24.x，推荐使用 22.x。根目录 `.nvmrc` 选择 22，已安装 nvm 时执行 `nvm install && nvm use`；使用 fnm 时执行 `fnm install 22 && fnm use 22`。随后运行 `npm ci`，安装 Vitest 5 和对应依赖。Node 20 不再受支持；启动前检查也会拒绝旧版本。公共 CI 在 Node 22、24 上分别验证。

## 验证命令

```bash
npm run typecheck
npm test
npm run build
server-python/.venv/bin/python -m pip install -e './server-python[test]'
server-python/.venv/bin/python -m pytest server-python/tests
mvn -f server-java/pom.xml test
bash scripts/contract-test.sh node
bash scripts/contract-test.sh python
bash scripts/contract-test.sh java
```

三个契约测试使用同一组 `/api` HTTP/NDJSON 断言，默认使用 `3999` 端口，逐个运行；可用 `CONTRACT_TEST_PORT` 改端口。它们运行 MOCK，不消耗云端额度。三种后端均实现 `/d` 并有对应测试；`/api` 全绿不代表网页兼容。完整发布前，还需要分别连接三种后端检查创建会话、发送消息、历史和停止操作。

`npm run build` 检查 TypeScript 并构建网页，不构建 Python 或 Java。各语言的独立运行要求见对应目录的 README。

## OpenAPI SDK 版本

2026-09-22 核对官方包仓库后固定以下版本（各语言独立发布，版本号不要求相同）：

| 后端 | SDK | 版本 | 官方来源 |
| --- | --- | --- | --- |
| Java | `com.aliyun:alibabacloud-dataworks_public20240518`（异步） | `9.0.10` | [Maven Central](https://repo.maven.apache.org/maven2/com/aliyun/alibabacloud-dataworks_public20240518/maven-metadata.xml) |
| Node.js | `@alicloud/dataworks-public20240518` | `9.9.1` | [npm](https://www.npmjs.com/package/@alicloud/dataworks-public20240518) |
| Python | `alibabacloud-dataworks-public20240518` | `9.9.1` | [PyPI](https://pypi.org/project/alibabacloud-dataworks-public20240518/9.9.1/) |

Node.js 已移除本地 `9.9.0` vendor 包，通过 `package-lock.json` 固定官方 npm 包和完整性校验值。升级代码后运行 `npm ci`；Python 重新执行 `server-python/.venv/bin/python -m pip install -e ./server-python`；Java 重新运行 `mvn -f server-java/pom.xml verify` 打包。


## 问答卡提交排查

线协议的选项类型必须放在 `options[].kind`。`@qwen-code/sdk` 会将整个选项包入 `raw`，web-shell 再读 `option.raw.kind`。后端提前发送 `raw.kind` 会造成双重嵌套，提交仍报“提交选项不可用”。`web/test/permission-wire.test.ts` 使用项目实际安装的 SDK 验证这一边界，覆盖有选项与无选项两种问答。

OpenAPI 的 `ask_user_question` 通知可能只含 `toolCall.rawInput.questions`，不含权限 `options`。web-shell 提交问答时要求存在 `allow_once` 选项，因此三个后端会为此类问答补一个仅供 UI 使用的提交动作。收到提交时，后端移除该动作 ID，使用原始 `permissionRequestId` 和索引形式的 `answers` 调用 `ReplyAgentSession`，例如 `{"0":"选择的答案"}`。普通工具授权不补造允许选项。

- **“提交选项不可用”**：前端尚未发出回复请求。检查 `/d` 的 `permission_request` 是否含 `options[].kind=allow_once`（线协议）；SDK 归一化后才是 `option.raw.kind`；升级并重启后端，再重新加载会话，使历史问题卡也经过兼容处理。
- **回复接口返回 404**：检查请求是否已经处理，或上游是否返回 `accepted=false`。不要自动重发原始提示词，以免重复执行工具。
- **`PromptAgentSession: aborted` / `session stream ended without turn terminal`**：提示词流异常中断，与前端提交选项缺失不是同一个错误。保留真实 sessionId、时间、后端类型及脱敏后的错误日志进行关联排查。待答卡会保留，但回复被接受不代表已经恢复后续流；本修复不自动重发提示词，也不把断流标记为完成。

回归测试包含不带权限选项的问答、历史恢复后提交、仅答案的上游请求，以及 Node 流中断后待答卡仍可提交。上线验收还需在真实 OpenAPI 环境检查“收到问题 → 选择答案 → 提交 → 收到后续回复”的完整链路。


### Node SSE 空闲超时

Node SDK 的 `httpx` 将 `connectTimeout` 传给 `node:http` 的 socket timeout，连接建立后没有清除。给 SSE 使用普通请求的 10 秒连接超时，会在等待用户回答或模型输出的空闲间隔中触发 `Error: aborted`，即使 `readTimeout` 已设为 600 秒。

`PromptAgentSession` 与 `LoadAgentSession` 使用 `runtimeForSse`，将两个超时都设为对应流的读取预算（提示词 600 秒，历史 30 秒）。普通请求仍使用原有 10 秒连接超时；SSE 的连接建立也会等待更久，这是兼容当前 SDK 的取舍。重试保持关闭，真实断流仍报错，不自动重发提示词。

`server-node/test/sse-idle-timeout.test.ts` 使用真实 SDK 和本地 HTTP SSE 服务验证：旧配置可复现 `aborted`，修复后超过 10 秒无数据仍能收到终态，且只发送一次请求。这证明客户端缺陷及修复，不代表所有线上 `aborted` 都由同一原因引起。

### 本地定位提示词断流

网页 `/d` daemon 链路的三种后端默认记录 `prompt_stream_start` / `prompt_stream_end`。启动时保存终端输出，例如（已有 `.env` 配置，无需把凭证写入命令）：

```bash
npm start -- node 2>&1 | tee /tmp/data-agent-node.log
# 或 npm start -- java / npm start -- python
rg 'prompt_stream_start|prompt_stream_end' /tmp/data-agent-node.log
```

按页面 URL 中的完整 sessionId 找到本轮 promptId，再比对开始和结束日志。记录包括 backend、pid、startedAt/endedAt（毫秒时间戳）、lastFrameAt、idleMs、frames、upstreamRequestId（帧内 RequestId）、popRequestId（仅 POP 回执）、pendingPermissions 和异常类型。promptId 是本地轮次关联 ID，不是上游 requestId。新增诊断字段不记录提示词、答案、请求头、凭证或完整异常对象；原有应用日志/会话 transcript 仍可能含业务数据，不应直接发到公共仓库。

| outcome | 可确认的事实 | 下一步 |
|---|---|---|
| `terminal` | 已收到协议终态 | 不再等待 HTTP EOF；终态后的连接问题不改变完成结果 |
| `upstream_error_frame` | 上游发来了业务错误帧 | 结合本轮错误事件与 requestId 查上游 |
| `transport_exception` | SDK/读取路径抛出异常 | 看异常类型、Node error code 和 idleMs；仅 `aborted` / `ECONNRESET` 无法证明是超时或谁断开 |
| `eof_without_terminal` | 流正常结束，但缺少协议终态 | 查网关和上游结束记录；不要自动重发 prompt |
| `local_hard_limit` | 旧版命中本地整轮限制 | 当前版本已移除 daemon 的整轮 330 秒截止时间；看到此项时核对实际部署版本 |
| `ack_without_frames` | 只有 POP 回执，没有业务帧 | 用 popRequestId 查派发链路 |
| `task_cancelled`（Python） | 后台任务被取消 | 结合进程退出/服务生命周期日志判断；不等同于用户点取消 |

异常类如 `SocketTimeoutException` / `SocketTimeoutError` 是读取超时的重要直接证据，`ConnectionResetError` / `ECONNRESET` 只说明连接重置。若有 start 而没有 end，应先查同一 pid 的退出日志；仅缺日志不能证明进程崩溃。用户点击取消则应同时核对 transcript 中的 `prompt_cancelled` 和上游 `stopReason=cancelled`。浏览器 SSE 断开不会直接取消 daemon 后台轮次。

本地排查建议先直连本地前端和 server，记录实际后端、版本、完整 sessionId、发生时间、上述日志。若要对比代理链路，使用新的测试轮次对比直连与代理，勿自动重放已经发出的业务请求。读取历史可帮助确认上游是否继续完成，但不能证明此前连接断开的原因。

新增回归验证了三种 daemon 收到 `Result.stopReason` 后立即结束消费，不会因继续等待连接关闭而报错；终态前异常仍然失败。这是独立的客户端修复，不能据此认定某一次线上 `aborted` 的根因。历史 Load 必须继续读取多个轮次，不应用“首个终态即停止”的规则。

Java `SdkIdleTimeoutTest` 与 Python `test_sdk_idle_timeout.py` 使用真实 SDK、合成凭证和只绑定本机的 SSE 服务，验证当前配置在首帧后静默 22 秒仍能收取终态。它们只验证该空闲窗口，不证明更长等待或真实代理链路不会断开。


### 刷新后一直加载

同一个后端进程仍在执行会话时，`load` 直接回放本地 journal 和待回答卡片，不再等待上游历史接口。完整历史到达后会补齐先前缓存的历史快照，并保持已有事件游标。进程重启或请求到另一实例后，本地 journal 不存在，仍需要上游历史接口；这项修复不提供跨实例持久化。

历史请求失败时，网页会显示加载失败和真实会话 ID，并继续现有重连流程。请保留发生时间、后端类型、HTTP 状态以及脱敏后的 `prompt_stream_end` 诊断字段。一次刷新成功不代表先前的流中断已恢复；失败轮次仍明确显示失败。

### 交付边界

- 已移除三种后端的整轮 330 秒截止时间，包括等待人工回答的时间。SDK/socket 等待超时、反向代理和上游服务限制仍然存在；不能据此保证无限时长。
- 本样例不自动重发有歧义的提示词，不把缺少终态的流记为成功。上游 SSE 游标续传、远端错误归档和创建错误透传取决于所连接服务的部署版本，无法由下载本仓库代码完成升级。
- 消息串行队列尚未实现，同一会话已有活动提示词时仍拒绝重复提交；`pending-prompts` 查询、删除接口尚不支持。
- 用户规则自动加载已由上游 LSP 修复。已部署该修复的环境无需再通过首条提示词注入规则来绕过；旧环境应先核对服务部署版本。本项不再列为未修复问题。
- 若连接服务存在 600 秒执行限制，本样例无法取消该服务限制。客户验收应使用其实际部署区域和网络代理，不应仅依赖 MOCK 契约测试。
