# 使用 Node.js 后端

需要 Node.js 22.x（至少 22.12）或 24.x（推荐 22.x）、npm 10+。所有命令在项目根目录执行。

```bash
npm ci
MOCK=1 npm start -- node
```

打开终端显示的网页地址。真实使用时，按[主 README](../README.md)填写 `.env`，去掉 `MOCK=1` 后启动。

## 只启动后端

```bash
bash scripts/dev-server.sh node
```

默认监听 `http://127.0.0.1:3000`。如果需要单独启动网页，在另一个终端执行 `npm run dev:web`；网页通过 `VITE_API_BASE` 指定后端地址。推荐使用一键入口自动匹配端口。

## 连接检查

```bash
npm run check -- --mock
npm run check
```

第一条只检查示例环境。第二条会调用云端并创建一个检查会话，使用 `.env` 中的账号；检查成功不代表所有权限、额度或长任务都已验证。

遇到 `tsx` 或依赖找不到时，在根目录重新执行 `npm ci`。改名后的目录是 `server-node`，旧的 `--workspace server` 命令请改为 `--workspace server-node`。

## 新会话配置与 OpenAPI

`DATAAGENT_AGENT_NAME` 指定默认已发布 Agent；创建请求可用 `agentName` 覆盖（去除首尾空格后1–128字符，不能包含控制字符）。LIVE 的 `/d/standalone/sessions` 列表及 `/d/standalone/sessions/:id` lookup 可通过 `?agentName=...` 选择 Agent；每个请求独立生效，不修改全局默认或旧会话，Prompt/load 仍只按 sessionId 路由。通过 `DATAAGENT_MODEL`、`DATAAGENT_MODE`、`DATAAGENT_REASONING_EFFORT` 设置新会话默认值；页面偏好保存在本地，下次创建复用，不弹框，不修改旧会话。

LIVE 改名、归档、删除调用真实 POP；订阅走 `GetAgentSessionEvents`，历史走 `LoadAgentSession`。固定 SDK 缺失的接口由窄适配器复用官方 SDK 签名；Events 直接读取 binary 流以保留游标和增量传输。目标地域需已发布相应接口。

独立管理示例见 [Agent 管理指南](../docs/AGENT-MANAGEMENT.md)及 [examples/agent-management.ts](examples/agent-management.ts)，不属于启动流程。可选角色启动脚本与凭证接入见 [AssumeRole 指南](../docs/ASSUME-ROLE.md)。

## LIVE 无状态协议

LIVE 前端读取 `/d/openapi/session-options` 的 `promptTransport: "http-stream"`，向 `POST /api/sessions/:id/prompt` 提交 `{text}`，并持续读取该请求的 NDJSON。响应头立即 flush；本请求的 `done/error` 才用于收口。首帧、远端 Events 的重放终态、HTTP EOF 都不能替代自己的成功终态。终态前断流表示结果未知；只读 Load 续接沿用有界 rid/offset 恢复，不自动重发 Prompt，不自动 Cancel。MOCK 声明 `promptTransport: "daemon"` 并保留 202/journal 协议。

LIVE `/d/session/:id/events` 仅代理远端 GetAgentSessionEvents，保留 POP 解包、会话校验和远端事件游标；只转发本次请求的 Last-Event-ID，无本地 control 或水位缓存。内容由 Events 渲染，NDJSON 的 frame 不应再次渲染。旧 LIVE 202 Prompt 和 receipt 端点返回 410。

LIVE 不保存会话 Registry、权限 pending/resolved、删除标记、配置或摘要缓存；列表、历史、权限和管理操作每次访问上游。无 sessionId 的旧 permission 路由返回 410。session/daemon status 返回 404，列表省略无法确认的活动状态和客户端数；调用方应视为未知，不能用 false 覆盖当前浏览器的在途请求。heartbeat 204 仅是协议应答。多实例或重启后通过路径 sessionId 和远端历史重新加载；未完成的 HTTP 连接不能跨进程恢复为成功。
