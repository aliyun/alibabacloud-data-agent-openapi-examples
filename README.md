# DataAgent OpenAPI 示例工程

<a id="top"></a>
[![CI](https://github.com/aliyun/alibabacloud-data-agent-openapi-examples/actions/workflows/ci.yml/badge.svg)](https://github.com/aliyun/alibabacloud-data-agent-openapi-examples/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.19-brightgreen)](package.json)
[![测试](https://img.shields.io/badge/%E6%B5%8B%E8%AF%95-389%20passing-brightgreen)](docs/CONSTRAINTS.md)

**DataWorks DataAgent OpenAPI 最佳实践示例。** 覆盖 9 个 OpenAPI 的完整链路——会话管理、
SSE 流式交互、人卡回覆（工具授权与提问）、取消与历史拉取——并把**实测验证过的关键行为与最佳实践**
固化成代码与测试：业务错误以 HTTP 200 携带业务码、`SessionStatus` 恒为 `RELEASED`、
artifacts 接口恒返回空、流式响应存在约 220 秒的时长边界、历史拉取在运行期会阻塞——
**每一条都有代码归属与测试覆盖**，错误信息如实呈现（而不是含糊的"任务失败，请重试"）。[English](README.en.md)

其中几条与直觉不同、也最影响集成成败：`SessionStatus` 恒为 `RELEASED`（轮次状态要从流里判），
`CreateAgentSession` 的空响应与授权拒绝不可区分，`ListAgentSessions` 的标题过滤器被静默忽略，
人卡回覆必须携带 `optionId`。逐条见下方「最佳实践精选」。

覆盖 9 个 OpenAPI：`ListAgents`、`CreateAgentSession`、`ListAgentSessions`、`PromptAgentSession`（SSE）、
`LoadAgentSession`（SSE）、`GetAgentSessionTokenUsage`、`ListAgentSessionArtifacts`、`CancelAgentSession`、
`ReplyAgentSession`（人卡回覆：工具授权与 ask_user_question 的应答通道，见 §6.1）。

## 快速开始

唯一前置是 **Node ≥ 20.19**（`package.json` 的 `engines` 已钉，npm ≥ 10 随 Node 一起来）。三条安装路任选：

- [`fnm`](https://github.com/Schniz/fnm)：`fnm install 22 && fnm use 22`
- [`nvm`](https://github.com/nvm-sh/nvm)：`nvm install 22 && nvm use 22`
- 官网安装包：<https://nodejs.org/>

```bash
node -v             # 期望 v20.19 以上
npm install
```

接真实上游（主路径）：

1. 建 RAM 用户拿 AccessKey，**别用主账号**（第 3 节有分步指引与常见拒绝形态）
2. `cp .env.example .env`，填 AK/SK；DataWorks 实例不在 `cn-hangzhou` 时改 `DATAAGENT_REGION_ID`
3. `npm run dev`，打开 <http://localhost:5173>（后端在 3000）

发 prompt 前建议先跑 `npm run check` 三步自检（第 6 节），全绿再上界面。

没有云资源、只想先预览？`MOCK=1 npm run dev` 零配置起全栈，见第 11 节。

> **验证边界一句话**：解析层与错误分类有单测覆盖（`npm test`：33 个文件 / 389 条，见第 5 节）；
> MOCK 全链路可按第 11 节在浏览器里逐形态验收。真实链路已端到端验过一轮问答（`[LIVE 09-16]`），
> 218~258s 断流墙与探测器判据 B 仍未验。09-15~16 排查过的「prompt 只回 POP 回执就关流」，
> 真根因是**用户 Token 周限额计费闸门**且错误不透传回客户端——同款症状先查调用身份的限额，
> 别急着改代码；完整形态与处置见第 8 节 FAQ 与第 10 节。

---

## 1. 前置

- **Node ≥ 20.19**（`package.json` 的 `engines` 已钉）。装 Node 三条路任选：
  - [`fnm`](https://github.com/Schniz/fnm)：`fnm install 22 && fnm use 22`
  - [`nvm`](https://github.com/nvm-sh/nvm)：`nvm install 22 && nvm use 22`
  - 官网安装包：<https://nodejs.org/>
- **npm ≥ 10**（随 Node 一起来）。
- 一个已开通 DataWorks 且有**运行中实例**的阿里云账号（还没有？可先用 MOCK 预览，见第 11 节）。

检查：

```bash
node -v   # 期望 v20.19 以上
npm -v
```

---

## 2. npm registry

本工程依赖 `@alicloud/*` 与 `@darabonba/*`，公共源上都有。

```bash
npm config get registry          # 先看当前指向哪里
```

- 切回官方源：`npm config set registry https://registry.npmjs.org/`
- **只想对本仓库这一次安装生效、不改全局配置**：

```bash
npm install --registry=https://registry.npmjs.org/
```

---

## 3. 凭证：建 RAM 用户，别用主账号 AK/SK

1. RAM 控制台 → 身份管理 → 用户 → **创建用户** → 勾选「使用永久 AccessKey 访问」
2. 给该用户授权 DataWorks 相关权限策略
3. 创建 AccessKey，记下 ID 与 Secret（Secret 只显示一次）
4. 确认账号下 DataWorks **已开通且有运行中的实例**
5. **账号下运行实例为零时，必须准备一个 Serverless 资源组 ID**：
   DataWorks → 资源组列表 → Serverless 资源组 → 复制 ID

本工程**只从环境变量读这两个值**：不读 `~/.aliyun/config.json`，不调用 `aliyun` CLI，没有任何回落路径。
（原因：本机的 aliyun CLI profile 常常是 OAuth 模式，SDK 的凭证链拾取不到；
一条"看起来能用、实际拿不到凭证"的回落路径比直接失败更难排查。）

日志与 `/api/health` 里只会出现 `credentials: present | missing`，**不打印任何前缀或掩码形式**。

---

## 4. 配置 `.env`

```bash
cp .env.example .env
```

`.env` 已在 `.gitignore` 里。逐字段解释都写在 `.env.example` 的注释里，这里只列必填项：

| 字段 | 什么时候必填 | 说明 |
|---|---|---|
| `MOCK` | 想跳过凭证时填 `1` | 回放本仓库自带的合成样例帧流，完全不调真实接口 |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | `MOCK=0` 时必填 | 建议用单独的 RAM 用户 |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | `MOCK=0` 时必填 | 绝不入库 |
| `DATAAGENT_REGION_ID` | 有默认值 `cn-hangzhou` | DataWorks 实例所在 region；**实例不在杭州时必须改**，否则所有调用都打到错的 region |
| `END_POINT` | 接预发/日常网关时必填 | 显式上游域名，覆盖 SDK 的 region 内置映射。**留空时 SDK 在构造期就推导出 `dataworks.{region}.aliyuncs.com`（生产域名）**——所以接预发不填它，请求会静默打到生产（签名照样有效）。只填 host，不带 `https://` |
| `RESOURCE_GROUP_ID` | 账号零运行实例时必填 | 注意服务端**不校验有效性**，填错也一样建会话成功 |
| `DATAAGENT_AGENT_NAME` | 有默认值 | 固定 `dataworks_data_agent`，不要靠 `ListAgents` 去发现（见 [FAQ](docs/FAQ.md)） |
| `SESSION_SOURCE` | 有默认值 | 左栏只列带这个来源标记的会话 |
| `PORT` / `CORS_ORIGIN` / `VITE_API_BASE` | 有默认值 | 改端口时三个地方要同步 |

缺凭证且 `MOCK=0` 时，服务端**直接退出并打印一段指路文案**，不会起来一个半残的服务。

---

## 5. 启动

```bash
npm install
npm run dev
```

- 后端 `http://127.0.0.1:3000`（Fastify，`tsx watch`）
- 前端 `http://localhost:5173`（Vite）
- 打开 <http://localhost:5173>

**端口被占用**：改 `.env` 里的 `PORT`，同时把 `CORS_ORIGIN` / `VITE_API_BASE` 改成对应值；
前端端口改 `web/vite.config.ts` 的 `server.port`。

**前端刻意不走 Vite dev proxy**，直连后端 + 后端放行 localhost CORS。
理由：dev proxy 对长连接有缓冲与超时的整类风险，直连一次消掉，而且 dev 与生产形态一致。
如果你就是要用 proxy，必须设 `timeout: 0, proxyTimeout: 0`，否则 5 分钟以上的流会被掐。

其它命令：

```bash
npm test           # vitest（shared + server + web 的聚合器与纯函数；前端组件那批跑在 jsdom）
npm run typecheck  # 三个 workspace 各跑一次 tsc
npm run build      # typecheck + vite build
npm run check      # 三步自检（见下）
```

---

## 6. 三步自检 `npm run check`

**不经 HTTP、不依赖 dev server**，直接构造 SDK Client 调上游——自检要能在"服务起不来"的时候
照样告诉你哪一步坏了，而服务起不来的最常见原因就是自检要查的那几件事。

```bash
npm run check            # 用 .env 里的真凭证
npm run check -- --mock  # 回放合成样例，只验证工程本身装对了
```

| 步 | 接口 | 它在判什么 |
|---|---|---|
| ① | `ListAgents` | 网络通不通、AK/SK 对不对、签名过不过。**返回列表里没有 `dataworks_data_agent` 属正常** |
| ② | `CreateAgentSession` | DataWorks 是否开通、有没有运行实例/资源组。成功判据**只有 `Result.SessionId` 非空** |
| ③ | `GetAgentSessionTokenUsage` | 这个会话真的可用（约 0.3s 返回） |

输出是 `step / ok / ms / requestId / detail` 表 + 退出码。每步计时，失败不中断后续可诊断步。

`[LIVE 09-15]` 本轮实测：换过 AK/SK 之后**三步全绿**（① 约 0.2s，返回 2 个 chatbi agent；
② 拿到非空 `SessionId`；③ 约 0.3s，`PromptTokens=0`）。两点要提醒：

- **② 会抽风**：同形状入参、相隔数分钟，一次空响应一次成功（实测时间线里出现过
  "rg-only 探针空 → 紧接着 `npm run check` ② 成功"）。看到空响应先重试一次再怀疑配置。
- **三步全绿 ≠ prompt 能跑起来**：本轮 ②③ 全通，但 `PromptAgentSession` 仍然一帧不回
  （见 [已知限制](docs/KNOWN-LIMITATIONS.md)）。自检覆盖的是"身份、开通、会话可用性"，
  覆盖不到"上游愿不愿意把这一轮派发给执行端"。

`--mock` 的输出末尾会明说：它只证明"工程装对了、样例能被正确解析"，
**不能**证明你的 AK/SK、region、实例或资源组配置是对的。

### 6.1 人卡回覆 `ReplyAgentSession`（第 9 个 API）

`PromptAgentSession` 的流里会出现两类**需要人接话**的帧：工具授权（agent 想执行
写操作，等批准）与 `ask_user_question`（agent 主动提问）。不回覆，轮次就停在那里。

本仓库把回覆通道做成了第 9 个 API 的完整闭环：

- **建会话时的 Mode 开关**：`POST /api/sessions` 带 `mode`——`yolo`（默认，工具授权
  全部自动放行）或 `default`（会触发审批的工具调用停下等人）。`ask_user_question`
  是提问不是授权，**两种模式下都会出现**。
- **回覆端点**：`POST /api/sessions/:id/reply`，请求体两选一：
  - 提问 → `{ "permissionRequestId": "...", "answers": {"0": "<选项label或自定义文本>"} }`
  - 工具授权 → `{ "permissionRequestId": "...", "optionId": "proceed_once", "outcome": "selected" }`
  - 取消本次交互 → `{ "permissionRequestId": "...", "outcome": "cancelled" }`
- **关键实测约束**（完整版见 [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) 与 `shared/src/rest.ts` 注释）：
  - 回覆成功后**不要重发 prompt**——原 SSE 流还在，后续帧从原流继续；
  - ask_user_question 的回覆**必须带 optionId**（options 里 `kind==='allow_once'`
    的那个）加上 answers，缺 optionId 会被上游 400 拒收；
  - 用 POST 不是风格偏好：回覆会真实改变服务端执行走向，GET 属于 CORS 简单请求，
    任意网页都能跨源打一发。
- UI 侧：聊天流里的人卡卡片（`InteractionCard`）选中选项即回覆，流从原处继续。

---


---

## 最佳实践精选

45 条完整清单见 [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md)（每条都有代码归属与实测标记）。以下十条最值得先读：

| # | 约束 | 代码归属 |
|---|---|---|
| 1 | 业务错误恒 HTTP 200，只有传输故障才 5xx | `server/src/routes/rest.ts`、`shared/src/errors.ts` |
| 3 | 必须用 `*WithSSE` 变体，否则整体 buffer 且必然超时 | `server/src/sdk.ts` 的 `assertSseCapable` |
| 5 | 自动重试会重复写入，必须 `autoretry:false, maxAttempts:1` | `server/src/sdk.ts` 的 `runtimeFor` |
| 6 | `ListAgents` 找不到 `dataworks_data_agent` 但能建会话（别靠列表发现 agent） | `server/src/live.ts` 的 `liveListAgents` |
| 19 | `CancelAgentSession` 【LIVE 09-18】已生效：取消以 `stopReason=cancelled` 终态收场；但 **cancelled 终态不落库**（上游缺口） | `server/src/live.ts` 的 `liveCancel` |
| 21 | `GetAgentSessionTokenUsage` 是唯一可靠度量，但**数值不是常量**（不同账号/会话差异极大） | `server/src/selfcheck.ts` |
| 22 | `load` 在 RUNNING 期约一半概率阻塞（178s/81.6s 实测）⇒ 独立 30s readTimeout + 关闭聚焦重取 | `server/src/live.ts` 的 `liveHistory` |
| 24 | `[LIVE 09-17]` 并发收流可能出现**跨会话串答**（4 路同时发 3/4 串），属上游响应扇出问题——归属判别以注入的 marker 为准 | `shared/src/marker.ts`、`server/src/routes/prompt.ts` |
| 42 | `[LIVE 09-17]` 会话到执行端的绑定是**临时的**：闲置旧会话发 prompt 报 `Session is not ready`，要复用旧会话先预期"绑定已丢需重试" | `shared/src/errors.ts` 的 `classifyError` |
| 44 | `[LIVE 09-17]` ask_user_question 的回覆必须带 optionId，缺了被上游 400 拒收 | `shared/src/rest.ts`、`web/src/components/chat/InteractionCard.tsx` |

---

## 已知限制（完整版见 [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md)）

两个 artifact 接口恒空（不做兜底填充）；历史回放会缩水（不是审计存档）；
本工程只覆盖同步会话的交互形态，不承诺上游行为永远不变——以实测为准。

---

## MOCK 模式（可选）

没有凭证也能预览全部界面形态：`MOCK=1 npm run dev`。回放合成样例帧流
（含断流、幽灵化、并发拒绝等五种异常形态的演示）。完整说明见 [docs/MOCK.md](docs/MOCK.md)。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/FAQ.md](docs/FAQ.md) | 常见问题与最佳实践（SDK 选型、空响应、过滤器、取消、断流探测…） |
| [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) | 45 条实测约束全表（每条含代码归属与实测标记） |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构导读：目录、后端 HTTP 契约、"谁是事实源"设计核心 |
| [docs/MOCK.md](docs/MOCK.md) | MOCK 模式：合成帧流回放、时序压平/倍速 |
| [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) | 已知限制与免责声明 |

## 贡献

欢迎 issue 与 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。提交前请跑 `npm run typecheck && npm test`。

---

## 许可与用途

[MIT](LICENSE)。示例代码，随意参考、随意抄。`server/test/fixtures/` 里的样例全部为合成数据，无任何真实抓包；
你接入自己的账号后产生的会话数据属于你，本仓库不收集、不上传。

