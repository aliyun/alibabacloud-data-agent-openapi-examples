# 开发与验证

启动和环境配置见[README](../README.md)，接口用法见[调用速查](OPENAPI-EXAMPLES.md)。

## 目录与 SDK

| 目录 | 内容 | DataWorks SDK |
|---|---|---|
| `server-node/` | Fastify 后端 | Node.js `9.11.0` |
| `server-python/` | FastAPI 后端 | Python `9.11.0` |
| `server-java/` | Spring Boot 后端 | Java `9.0.17` |
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

## 流与状态边界

- LIVE 后端不维护会话 Registry、journal、权限等待表或完成回执。sessionId 与远端游标由前端传入，历史和控制操作以远端为准；MOCK 保留独立内存状态。
- `promptTransport` 握手选择 LIVE HTTP NDJSON 或 MOCK daemon 协议，握手失败不降级写入。Prompt HTTP 确认自己的结果，独立 Events 提供实时内容；浏览器请求结果缓存上限 64，不跨整页刷新持久化。
- 断开本地读取不自动取消远端任务；显式停止才调用 Cancel。连接内有可信 rid/offset 时可尝试有界、只读 Load 续接，不重发 Prompt。后端重启或结果未知时先读取历史核对。
- Load 没有已核实的 Events 原子快照水位；不承诺历史/订阅无间隙、在途崩溃无缝恢复或远端跨节点恢复。heartbeat 只表示代理可达；无法权威查询的状态返回不可用。
- Node 用 SDK 支持的 `connection: close` 使响应结束后关闭连接，避免自身留下陈旧空闲连接；不提前结束 SSE、不改变 TLS 校验，代价是增加建连开销。这是缓解措施，不是所有 ECONNRESET 的根因证明。

## 排查失败

先保留 sessionId、时间、后端语言、实际返回的 requestId/rid/offset、已收帧数及错误码，再读取远端历史。不要因断流或 HTTP 200 就认定任务失败或成功，也不要直接重发 Prompt。

问答卡使用实际事件中的 requestId/选项 ID。后端为 ask_user_question 补充的 UI 提交动作不作为远端选项发送，答案按原始问题索引回传。已有问题可能已被其他端处理，Reply 被接受不代表本地断流已恢复。
