# DataAgent OpenAPI 示例工程

基于 **DataWorks DataAgent OpenAPI** 的可运行示例：Node.js 后端（Fastify 框架）+ React 三栏前端，一条 `npm run dev` 起两边。后端是唯一持有 AK/SK 的进程，把上游 SSE 流转发给浏览器（NDJSON）。

这个仓库的价值不在"能跑起来"，而在于**把实测出来的接口行为固化成了代码和文案**。
照官方文档直接写集成，大概率会在下面这些地方被打穿：业务错误恒 HTTP 200、`SessionStatus` 恒 `RELEASED`、
artifacts 恒空、220 秒左右断流且**不能重发**、拉历史在运行期会阻塞、且可能混入大量重复帧。
每一条都在本仓库里有明确的代码归属，错误信息都会如实呈现（而不是含糊的"任务失败，请重试"）。

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

> **验证边界一句话**：解析层与错误分类有单测覆盖（`npm test`：33 个文件 / 388 条，见第 5 节）；
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
| `DATAAGENT_AGENT_NAME` | 有默认值 | 固定 `dataworks_data_agent`，不要靠 `ListAgents` 去发现（见 FAQ） |
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
  （见开头「先说清楚验证边界」与 §10 那条 FAQ）。自检覆盖的是"身份、开通、会话可用性"，
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
- **关键实测约束**（完整版见 §9 与 `shared/src/rest.ts` 注释）：
  - 回覆成功后**不要重发 prompt**——原 SSE 流还在，后续帧从原流继续；
  - ask_user_question 的回覆**必须带 optionId**（options 里 `kind==='allow_once'`
    的那个）加上 answers，缺 optionId 会被上游 400 拒收；
  - 用 POST 不是风格偏好：回覆会真实改变服务端执行走向，GET 属于 CORS 简单请求，
    任意网页都能跨源打一发。
- UI 侧：聊天流里的人卡卡片（`InteractionCard`）选中选项即回覆，流从原处继续。

---

## 7. 目录导读

```
shared/    @das/shared —— 前后端共用的唯一解析权威
  src/frames.ts    ACP 帧的读取（含"双层嵌套取 text"、容忍未知 update、POP 回执识别）
  src/rid.ts       rid 过滤（判据是"键是否存在"）
  src/turn.ts      帧流 → 一轮对话的 reducer（thought/message 拼接、工具状态机、终态判定）
  src/errors.ts    -32603 三形态分类 + 面向用户的文案（前后端同源）
  src/marker.ts    归属校验码的生成与剥离
  src/protocol.ts  NDJSON wire envelope
  src/rest.ts      REST 端点的响应类型（前后端共用，改一处两边同时红）
  src/constants.ts 默认值：agent 名、会话来源、回放压平/倍速

server/    Fastify 代理层 —— 唯一持有 AK/SK 的进程
  src/index.ts    启动、CORS 预检、`requestTimeout:0` + 断言 `server.timeout===0`、路由注册、MOCK 分支
  src/config.ts   .env 校验；缺凭证且非 MOCK 直接退出并打印指引
  src/sdk.ts      唯一 Client 构造点 + RuntimeOptions（autoretry:false, maxAttempts:1）
  src/live.ts     9 个 OpenAPI 的真实调用与归一化（含 ReplyAgentSession 人卡回覆）
  src/pipeline.ts 帧源（live 或 mock）→ wire 事件，两种模式共用同一条管道
  src/ndjson.ts   hijack + 15s 心跳 + 背压 + close 时 iterator.return()
  src/inflight.ts 进程级单轮在途锁（跨标签页也生效）
  src/normalize.ts SDK 异常 / 帧内 error / 空响应体 → shared 的 ApiError
  src/routes/     rest.ts（9 个端点）+ prompt.ts（流式）
  src/selfcheck.ts 三步自检的实现（含②失败时的只读授权判别探针）
  src/check.ts    `npm run check` 的 CLI 壳：装配 stderr logger + 打印表格 + 退出码
  src/mock/       fixtures.ts（8 条场景）+ replay.ts（按 Timestamp 差回放）
  test/           vitest；fixtures/ 是合成样例（见 server/test/fixtures/README.md）

web/       React + TS + Vite + Tailwind v4 + shadcn/ui
  src/api/        client.ts（REST）+ stream.ts（fetch + ReadableStream 手解 NDJSON）
  src/state/      turnStore.ts（mutable 聚合器 + rAF flush，运行态唯一事实源）
                  inflight.ts（本地在途标记）、layout.ts（栏宽/折叠/抽屉/narrow）
                  theme.ts、sessionMeta.ts（别名·置顶·归档·隐藏）、composerMemory.ts（草稿·历史）
                  toast.ts、session.ts、useTurnStream.ts、rightTab 见 components/right
  src/hooks/      useSessions / useSessionHistory / useUsage / useArtifacts / useCheck / useProbe
                  useHealth / useAutoScroll / useDeepLink / useGlobalShortcuts / useNow / useThrottledText
  src/lib/        纯函数层：scrollPolicy、shortcuts、usageBars、exportHtml、highlight、tableModel
                  safeUrl、composerPolicy、sessionGroups、deepLink、turnText、format、persist、clipboard
                  streamText（流式文本的节流降级）、turnClock（活性计时）、turnCollapse（工具组折叠）
                  mermaidBudget（渲染前的尺寸/复杂度护栏）
  src/components/ layout（TopBar / Rail / Splitter / Drawer / ShortcutHelp）
                  left（SessionList 会话列表 + SessionRenameInput 重命名框）
                  chat（时间线、composer、工具卡片、错误横幅、探测动作、Markdown/Mermaid/表格）
                  right（Artifact / 用量 / 对账 / 自检 / 会话 五个 tab + PanelLoading 骨架屏）
                  ErrorBoundary.tsx（分栏与根两种兜底）
  test/           node 环境：turnStore、scrollPolicy、shortcuts、layout、exportHtml、usageBars、deepLink
                  streamText、turnClock、turnCollapse、mermaidBudget、usageRefresh、format …
  test/dom/       jsdom 环境（文件顶部 `// @vitest-environment jsdom`）：ErrorBoundary、两支空态、抽屉焦点、
                  骨架屏与错误条的读屏层级 + 重命名框键盘语义（都在 a11yBatchJ）、
                  会话列表接线（sessionList）、节流文本（useThrottledText）
```

### 后端自己的 HTTP 契约

前端只跟这一层说话，**AK/SK 从不出现在浏览器里**。非流式端点一律用 HTTP 200 承载业务错误
（只有传输故障才 5xx），响应体是 `{ok:true, result}` 或 `{ok:false, error:{kind,…}}`——
形状与上游那个"业务错误恒 200"的坑刻意保持一致，抄的人不会在两层之间来回换脑子。

| 端点 | 干什么 |
|---|---|
| `GET /api/health` | `{mock, region, agent, sessionSource, resourceGroupIdConfigured, credentials:'present'\|'missing'}`，MOCK 下另有 `mockReplay`；**不含任何凭证片段** |
| `POST /api/check` | 三步自检（与 `npm run check` 同一个 `runCheck`）。**用 POST 是安全考量**：第②步会真实建会话，而 GET 属 CORS 简单请求，任意网页都能跨源触发它一次 |
| `GET /api/sessions` | 强制带 `AgentName` + `SessionSourceList`；**不提供 q 参数**（标题过滤器被上游静默忽略） |
| `POST /api/sessions` | 建会话；成功判据只有 `SessionId` 非空，空 body 归 `create_empty_body` |
| `GET /api/sessions/:id/history` | `LoadAgentSession`，独立 30s readTimeout；返回 `{turns, droppedRidLess, nonTurnRids, totalFrames, elapsedMs}` |
| `GET /api/sessions/:id/usage` | token 用量（唯一可靠度量） |
| `GET /api/sessions/:id/artifacts` | 原样返回 `{artifacts:[]}`，不做兜底填充 |
| `POST /api/sessions/:id/cancel` | 返回 `{delivered:false, warning:'mock-replay-uncancellable'}`（MOCK 下准确：回放无可取消的执行）。**LIVE 下已生效**：`delivered=true` + 流以 `stopReason=cancelled` 终止，前端 Stop 已接入（见 FAQ） |
| `GET /api/sessions/:id/probe?rid=&tokens=` | 断流后的完成探测器（判据 A + B） |
| `POST /api/sessions/:id/prompt` | **唯一的流式端点**，`application/x-ndjson`，见下 |

流式端点的 wire 事件只有五种，帧**原样透传不重塑**（所以 live 与 mock 共用同一个 reducer）：

```jsonc
{"type":"meta","rid":"…","marker":"DAS-3F9A1C","sessionId":"…","mock":false,"startedAt":…}
{"type":"frame","rid":"…","offset":17,"body":{…ACP 帧原样…}}
{"type":"hb","t":…}
{"type":"error","rid":"…","error":{"kind":"stream_break","code":-32603,"retryable":false,…}}
{"type":"done","rid":"…","stopReason":"end_turn","rawStopReason":undefined,"frameCount":22}
```

`frame.offset` 可能是 `undefined`（归档合并态的帧就没有序号），而且**绝不持久化**：
空闲约 5 分钟后服务端计数器会重置，存一个旧的大 offset 会把之后所有新帧都滤掉。

`done` 只在后端认出终态帧时才发，而那一帧本身也已经作为 `frame` 透传过——
所以**前端判终态的事实源是帧，不是 `done`**，少一条事件不会让界面卡在"接收中"。

### 谁是事实源

这张表是整个工程的设计核心。搞混了就会写出"问服务端要运行态"这种拿不到答案的代码。

| 你想知道 | 事实源 | 为什么不是别的 |
|---|---|---|
| **这一轮跑完没有 / 还在跑吗** | **前端自己收到的流**（`turnStore` + `inflight`） | `SessionStatus` 恒 `RELEASED`，`SessionUpdatedAt` 恒等于 `SessionCreatedAt`，服务端问不出来 |
| token 用量、耗时 | `GetAgentSessionTokenUsage` | 唯一可靠度量，约 0.3s |
| 历史内容 | `LoadAgentSession` | 但它**会缩水**，不是审计存档（见 FAQ） |
| 会话归属（是不是我发的那条 prompt 的结果） | prompt 里注入的 marker | 并发收流会串答案（`[LIVE 09-17]` 4 路同时发 3/4 串，单条流可混入 3 个他会话回答），逐个顺序发则不串；串是上游**响应扇出错**——请求按 sessionId 路由没错，错的是回答回传 |
| 产出物 | 无 | 两个 artifact 接口实测恒空，只能让 agent 内联回传 |

---

## 8. FAQ：把坑写成问答

**Q：为什么必须用 `promptAgentSessionWithSSE()`，普通的 `promptAgentSessionWithOptions()` 不行？**
A：普通变体走 `callApi` + `bodyType:'json'`，`@alicloud/openapi-core` 的 `callApi` 从不路由到 `callSSEApi`，
会整体 buffer。一轮 7~220 秒的调用你既拿不到中间帧、也必然超时。
`*WithSSE` 变体底层是 `@darabonba/typescript` 的 `Stream.readAsSSE`，真增量、逐帧 yield。
**SDK 版本下限 8.2.0**（本仓库钉 `^9.7.0`）；启动时会断言 `typeof client.promptAgentSessionWithSSE === 'function'`，
缺失即报"SDK < 8.2.0，无 SSE 变体"。

**Q：`ListAgents` 里找不到 `dataworks_data_agent`，是不是我没开通？**
A：不是。实测 `ListAgents` 恒只返回 2 个 chatbi agent（服务端硬编码），
但用 `dataworks_data_agent` 建会话照样成功。**不要靠列表接口去发现 agent 名**，直接写死。
`CreateAgentSession` 只认 `Meta.Agent.AgentName` 这一个位置。

**Q：`CreateAgentSession` 返回了空 body，什么意思？**
A：非流式响应模型里**没有 error 字段**，所以"业务错误"和"空响应体"在 SDK 层不可区分，
而且 HTTP 状态码还是 200。本仓库把这种情况归成 `create_empty_body`。
成功判据只有一条：`Result.SessionId` 非空。

这里补两条 2026-09-15 的实测：

1. **它是真的空，不是 cast 丢字段**。绕过 SDK 的 `$dara.cast`、直接打印 `callApi` 的原始返回，
   响应体是 `{"RequestId":"…","JsonRpcResponse":{"Jsonrpc":"2.0","Id":"1"}}`（`content-length: 97`）
   ——既无 `Result` 也无 `Error`。所以别指望换个姿势能读出错误详情，上游根本没给。
2. **空响应分不出"账号无运行实例"和"身份被授权层拒绝"**，两者长得一模一样。
   所以 `npm run check` 在②失败时会追跑一次**只读**的 `ListAgentSessions` 做判别：
   它也被拒 ⇒ 问题在身份/授权层，改 `.env` 里的 `RESOURCE_GROUP_ID` 不会有用；
   它通了 ⇒ 才轮到"查有没有运行中的实例"这条路径。
   最常见原因仍然是账号下没有运行中的 DataWorks 实例，或没传 `ResourceGroupId`。

**Q：`ResourceGroupId` 填错了会报错吗？**
A：不会。服务端不校验有效性——写个不存在的 ID 一样建会话成功。所以**别把它当排错信号**。
它藏在未文档化的 `InitialConfigOptions.ResourceGroupId` 里。

**Q：为什么搜不到会话标题？我传了 `SessionTitle` 过滤器。**
A：`ListAgentSessions` 的 `SessionTitle` 过滤器实测被**静默忽略**（不报错、也不生效）。
生效的是 `AgentName`（必填）、`SessionSourceList`、`TagList`、`SessionId`。
所以本仓库的 `GET /api/sessions` **不提供 q 参数**，标题搜索在前端做纯字符串 `includes`。

**Q：我点了 Stop，为什么服务端还在跑？**
A：`[LIVE 09-18]` 这个问题已经不存在了——`CancelAgentSession` 已生效：点 Stop 会向上游
发取消请求（HTTP 200），执行中的轮次随后以 `stopReason=cancelled` 终态收场
（实测 3/3：1200 字长文在 432 字处被截断；第二次在 3 帧时就停了）。
前端 `turnStore.cancelTurn()` 发完取消请求后**继续收流**，等 cancelled 终态到达后
界面显示"已取消"。两个已知口径：
**空闲会话**上的取消是 no-op（本来就没东西可取消，同样返回 200）；
**cancelled 终态目前不落库**——稍后 `LoadAgentSession` 里那一轮 `terminated=false`、
无 stopReason，是上游已知缺口（历史侧无法区分"已取消"与"断流"），不代表取消失败。
历史里因此欠终态的轮次，界面上会标注"这一轮在上游没有终态记录"。

**Q：`npm run check` 三步全绿，但发一句话出去一帧都不回，几秒就结束了？**
A：`[LIVE 09-15]` 真实碰到过，这是**上游收下了请求却没派发给执行端**，本仓库归成
`prompt_not_dispatched`。形态很具体：HTTP 200 + `content-type: text/event-stream`，
SSE 里只有一个事件 `{"RequestId":"<32位十六进制>"}`，0.1~0.7 秒关流。
那是一个纯 POP 层回执，**不是 ACP 帧**——所以它不能当内容渲染，更不能当本轮 rid
（真 rid 是 UUID；拿这个十六进制串去过滤历史必然一无所获，这正是约束 34 收紧判据的原因）。
事后 `LoadAgentSession` 回看，历史里只有一个 `config_option_update` 帧加一个
`Result.stopReason:"end_turn"` 的空轮次：**没有你那句话的回显，也没有任何回答**。

它和断流**处置恰好相反**，别搞混：

| | 收到帧数 | 含义 | 该做什么 |
|---|---|---|---|
| `prompt_not_dispatched` | 0 | 任务**根本没开始** | 先拉历史确认没留内容，确认后**可以**重发 |
| `stream_break` | >0 | 任务**很可能还在跑** | 探测/拉历史接管，**绝不重发** |

想自证不是自己的问题，按这个顺序换变量（本轮全部试过，响应逐字相同）：
换 wire body 形状、换 User-Agent、换一个**不存在**的 `SessionId`（也是 200 + 回执，
文档承诺的 400 错误帧并不出现）、换 `ResourceGroupId`、换 endpoint、
最后换执行路径——用官方 CLI 走同一条链路。
最有说服力的一条证据是：**prompt 前后拉历史逐字相同**，说明这一轮在服务端没留下痕迹。
唯一剩下没排除的旋钮是 `InitialConfigOptions` 里的 `ExecutionLane` / `Mode`
（词汇表见约束 37），但显式传值会让建会话直接返回空响应（2/2），所以**可用性未证明**。

**Q：跑到 220 秒左右流断了，报 `-32603`，我该重发吗？**
A：**绝对不要重发。** 实测断流墙在 218~258 秒，收尾帧是
`-32603 / session stream ended without turn terminal`。
断流**只关掉了回复通道，任务很可能还在服务端执行**——重发等于把同一个写操作执行两遍
（建表、ETL、发布都会重复）。UI 上因此用琥珀色而不是红色，动作只有
「探测是否已完成」和「拉取历史接管」，并明确写着不会自动重发。
后端另有 330s 硬上限主动收尾为 `stream_break`，对齐这堵墙。

**Q：同一个 `-32603`，为什么有时候是断流、有时候是会话失效、有时候是并发被拒？**
A：这三种处境的 `code` 全是 `-32603`，断流与会话幽灵化连 `errorCode` 都相同（`0x48833000000000d1`），
**只有 `message` 文本能分开**：

| 处境 | message 特征 | 本仓库的 kind | UI |
|---|---|---|---|
| 断流 | `session stream ended without turn terminal` | `stream_break` | 琥珀色，可探测/接管 |
| 会话幽灵化 | `prompt forward failed, upstream_status=422`（约 1s 单帧） | `session_ghost` | 红色，会话标死，只能新建 |
| 并发被拒 | `session_concurrent_operation_in_progress…`（**没有 `errorCode` 字段**） | `concurrent_rejected` | 灰提示，不弹对话框 |

所以错误横幅里 `code` / `errorCode` / `message` 三样都原样给用户看——只给一个码是没法排查的。

**Q：拉历史（`LoadAgentSession`）为什么把每轮内容显示了两遍？**
A：在会话 RUNNING 期拉历史，返回的帧里会混进一大批**没有 `RequestId` 键**的帧
（实测一次 977 帧的返回里 900 帧如此），那是同一轮内容的第二份拷贝。
过滤判据必须是**"键是否存在"而不是"值是否为空"**——
`"RequestId": ""` 在那份返回里命中 0 行，过滤后 977 → 77。
mock 长轮会话的历史用的是带这类污染的合成样例（`load-polluted.jsonl`），可以直接肉眼验收。

**Q：`BeginLogOffset` 能断点续传吗？**
A：不能，**它是死参数**，服务端没有增量续传能力。这也是本仓库选 NDJSON 而不选 SSE 的关键理由：
SSE 的 `id:` / `Last-Event-ID` 语义在协议层暗示"可以续传"，那是撒谎。
同理，前端本地持久化在途标记时**绝不存 offset**——空闲约 5 分钟后计数器会重置，
存一个旧的大 offset 会把之后所有新帧都滤掉。

**Q：为什么 artifacts 永远是空的？**
A：`ListAgentSessionArtifacts` 实测恒返回空数组。本仓库原样返回 `{artifacts:[]}`，
**不做任何兜底填充**，右栏渲染一段诚实的空态说明。
要拿到产出物，只能让 agent 把内容**内联回传**在回复里（marker 校验也依赖这一点）。

**Q：agent 反问我一句之后就永久挂住了，怎么回答它？**
A：**OpenAPI 没有应答接口**。挂起轮次只能到 DataWorks 界面里去处理确认码，确认码 TTL 约 18 分钟，
过期这一轮就废了。挂住的机制见约束 37：权威 configOptions 里 `mode` 默认是 `default`，
含义就是**每次工具调用前请求批准**——而 OpenAPI 侧没有任何接口能给出这个批准。

本仓库**不注入任何内容模板**（只在 prompt 末尾注入 marker 尾行用于归属校验），
所以"别反问、一次性做完"这类约束要你自己写进提示词里。
界面上这一轮的可见症状是：流结束后工具卡片停在 `in_progress`，
`ToolCard` 会显示琥珀色的**「未回传终态」**并停止转圈——它不会假装那个工具还在跑。

**Q：我只发了一句话，为什么 PromptTokens 有 5.8 万？**
A：那是 agent 的 system prompt 与技能上下文，不是你的输入。实测一轮短对话
`TotalTokens=58271 / PromptTokens=58209`。右栏会把 prompt/completion/thoughts/cached 拆开显示。

但**别把这个数字当常量**：`[LIVE 09-15]` 换账号后实测新建空会话 `PromptTokens=0`，
`usage` 三项全 0。所以自检③的文案是按本次观测值分岔的，两种情况都会说明"这不是你的输入"。

**Q：昨天拉的会话历史有 5875 帧，今天只剩 192 帧，数据丢了吗？**
A：`LoadAgentSession` 返回的历史**会缩水**，它不是审计存档。
重要内容必须**当轮落盘**（写库、写文件、回传给自己的系统），别指望以后再来拉。

**Q：多个会话并发跑，答案会串吗？**
A：会，而且**只在并发收流时串**（`[LIVE 09-17]` 受控实测：4 会话同时发 3/4 串、单条流可混入多达 3 个他会话的回答；逐个顺序发则 4/4 隔离）。
注意串的机制是上游**响应扇出错**而非请求路由错——每个会话仍回显自己的 marker（请求按 sessionId 路由是对的），但流里混进了他会话的回答帧。
所以每条 prompt 都注入唯一 marker（`DAS-XXXXXX`），回来后检查 message 里有没有这个 marker：中栏的徽标会显示「归属已校验」或「归属未校验」。
**并发时别信原始流、信徽标。** 未校验不代表答案错了，只代表**没法证明它是回给你的**。
marker 是尾行注入的，左栏显示标题时会正则剥掉（`SessionTitle` = 首条 prompt 原文，会带着注入文本）。

**Q：为什么后端要显式设 `autoretry:false, maxAttempts:1`？**
A：Tea/Dara 的自动重试会在超时或 socket 错误时**重发 prompt POST**——这是"断流不能重发"的隐藏放大器，
一次自动重试就等于把写操作执行两遍。`server/src/sdk.ts` 里有一条注释专门说这件事。

**Q：为什么用 Fastify 而不是 Express？**
A：两个理由。① `reply.hijack()` 让"这条路由接管裸 socket"成为显式代码，是最好的流式教学范式；
② 它把超时暴露成明确的配置项，而不是留给你一个默认值去踩。

顺便纠正一个流传很广的说法：Node 的 `server.requestTimeout`（18 起默认 300s）管的是
**从客户端收完整个请求**，prompt 的 body 只有几百字节、一瞬间就收完了，它跟长达几分钟的
**响应**毫无关系。真能静默掐断长响应的是 `server.timeout`（socket **不活动**超时，Node 13 起默认 0）
和反向代理的 read timeout。`server/src/index.ts` 因此显式写 `requestTimeout: 0`（与 Fastify 默认一致），
并在启动时**断言** `app.server.timeout === 0`，非 0 就打一条 warn。
如果你换 Express 或在前面加反代，要确认的是这两个，而不是 `requestTimeout`；
反代的 read timeout 还必须大于 `STREAM_HARD_LIMIT_MS`（330s），否则中间层会先断。

**Q：前端为什么不用 react-query 管流式数据？**
A：react-query 只管**服务端事实源**（会话列表、历史、用量、artifact、health）。
在途的流平均约 4.7 帧/s（901 帧 / 191s），最密的 1 秒里有 15 帧，
immutable 缓存每帧整树替换会把 GC 打爆。
那部分走 `state/turnStore.ts`：mutable 聚合器 + `subscribe`，`useSyncExternalStore` 订阅，
帧到达只标脏、flush 时 publish 一次 ⇒ 每批帧最多一次 React 更新。
聚合器**只存聚合结果不存原始帧**（thought/message 字符串追加，tools 是 `ToolCallView[]`
数组 + 按 `toolCallId` 查找更新的状态机）。

flush 有**两条**触发路径：`requestAnimationFrame`（前台的正常路径）与一个 250ms 的兜底
`setTimeout`。兜底不是保险起见加的——实测隐藏标签页里 rAF 会被**整个暂停**，
只靠 rAF 的话长轮期间中栏一片空白，直到本轮结束才一次性长出全部内容；
后台定时器只是被降频到约 1s 一次，不会暂停，所以能兜住。两条路径共用一个幂等 flush。

**Q：为什么 `refetchOnWindowFocus` 关掉了？**
A：切回标签页时对每个可见会话重取历史，等于对可能正在 RUNNING 的会话触发 `load`——
实测 `load` 在 RUNNING 期有约一半概率阻塞到那一轮跑完（观测到 178s / 81.6s），界面会莫名卡死。
`/history` 端点因此还带了独立的 `readTimeout: 30_000`：快速失败优于挂死。

**Q：切到后台标签页，流会不会丢？**
A：不丢，而且**内容还在长**，只是节奏慢下来。rAF 在隐藏标签页里会被整个暂停，
所以 flush 另有 250ms 的兜底 `setTimeout`；后台定时器被浏览器降频到约 1s 一次，
于是渲染从每秒十几次掉到约每秒一次。本轮浏览器实测过这个形态：把标签页藏起来 6 秒，
rAF 只触发了 1 次，正文长度仍然增长了 5 次——那 5 次全是兜底定时器干的。
切回前台 rAF 恢复，自动滚到底会补上。

**存活/超时判定完全不走 rAF**：用心跳帧（`hb`）的时间戳 + `setInterval`（5s 一跳），
超过 45 秒没收到任何事件就在头部显示「超过 45 秒没有收到任何事件」的警示徽标。
挂在 rAF 上的话，切到后台就会误报"卡住了"。

---

## 9. 实测约束清单（代码归属）

下面每条都能在仓库里指到一处代码。它们不是文档摘抄：是真实链路实测（标了 `[LIVE MM-DD]` 的条目）
与此前的独立实测共同钉住的行为，公开仓库的样例与测试覆盖其中可自动化的部分。

| # | 约束 | 代码归属 |
|---|---|---|
| 1 | 业务错误恒 HTTP 200，只有传输故障才 5xx | `server/src/routes/rest.ts`、`shared/src/errors.ts` |
| 2 | 非流式响应模型没有 error 字段 ⇒ 空 body 与业务错误不可区分 | `server/src/normalize.ts` 的 `missingResultError` |
| 3 | 必须用 `*WithSSE` 变体，否则整体 buffer | `server/src/sdk.ts` 的 `assertSseCapable` |
| 4 | SDK 已剥掉外层 `data` 信封，`resp.body` 直接是 ACP 帧 | `shared/src/frames.ts` 的 `unwrapEnvelope`（mock 回放必须过它） |
| 5 | 自动重试会重复写入，必须 `autoretry:false, maxAttempts:1` | `server/src/sdk.ts` 的 `runtimeFor` |
| 6 | `ListAgents` 找不到 `dataworks_data_agent` 但能建会话 | `server/src/live.ts` 的 `liveListAgents` |
| 7 | 建会话成功判据只有 `Result.SessionId` 非空 | `server/src/live.ts` 的 `liveCreateSession` |
| 8 | `ResourceGroupId` 服务端不校验有效性 | `.env.example`、`server/src/config.ts` |
| 9 | `ListAgentSessions` 的 `AgentName` 必填、`SessionTitle` 过滤器被静默忽略 | `server/src/live.ts` 的 `liveListSessions`、`web/src/components/left/SessionList.tsx`（前端搜索） |
| 10 | `SessionStatus` 恒 `RELEASED`，`SessionUpdatedAt===SessionCreatedAt`（`[LIVE 09-15]` 复现） | `server/src/mock/fixtures.ts` 的 `mockSessions`（照真实形状给）、`web/src/state/inflight.ts` |
| 11 | 运行态的事实源是前端流，不是服务端 | `web/src/state/turnStore.ts`、`web/src/state/inflight.ts` |
| 12 | rid 过滤判据是"缺 `RequestId` 键"，不是空串（实测一次 977→77，`droppedRidLess===900`） | `shared/src/rid.ts`、`server/test/fixtures/load-polluted.jsonl` |
| 13 | 历史会缩水，不能当审计存档 | `server/src/live.ts` 的 `liveHistory`、`server/test/fixtures/README.md` |
| 14 | `BeginLogOffset` 是死参数，无增量续传；本地持久化绝不存 offset | `web/src/state/inflight.ts`、`web/src/api/stream.ts`（选 NDJSON 而非 SSE 的理由） |
| 15 | 断流墙 218~258s；`-32603 / session stream ended without turn terminal`；绝不重发 | `server/src/ndjson.ts`（`STREAM_HARD_LIMIT_MS=330s` 硬上限）、`web/src/components/chat/ErrorBanner.tsx` |
| 16 | `-32603` 三形态同码同 errorCode，只有 message 能分开 | `shared/src/errors.ts` 的 `classifyError`、`server/test/fixtures/error-*.jsonl` |
| 17 | 会话幽灵化 = `upstream_status=422`，约 1s 单帧，会话标死只能新建 | `shared/src/errors.ts`、`web/src/components/left/SessionList.tsx` |
| 18 | 并发被拒那一帧**没有 `errorCode` 字段** | `shared/src/errors.ts`、`server/test/fixtures/error-concurrent-rejected.jsonl` |
| 19 | ~~`CancelAgentSession` 未实现~~ 【LIVE 09-18】**已生效**：上游 200 + 流以 `stopReason=cancelled` 终态收场（实测 3/3，长文 432 字截断）；空闲会话 no-op；**cancelled 终态不落库**（历史 `terminated=false`，上游缺口） | `server/src/live.ts` 的 `liveCancel`（`delivered` 如实反映上游 200）、`server/src/routes/rest.ts` 的 cancel 端点、`web/src/state/turnStore.ts` 的 `cancelTurn`（发取消 + 继续收流等终态）、`ChatPanel.tsx` 的"已取消"/"无终态记录"标注 |
| 20 | 两个 artifact 接口恒空，不做兜底填充（`[LIVE 09-15]` 复现） | `server/src/live.ts` 的 `liveArtifacts`、`web/src/components/right/EmptyArtifactNotice.tsx` |
| 21 | `GetAgentSessionTokenUsage` 是唯一可靠度量（`[LIVE 09-15]` 约 0.3s 返回）；但**数值不是常量**：2026-09-10 一句话有 5.8 万 PromptTokens，2026-09-15 新建空会话是 0 ⇒ 文案必须按本次观测值分岔 | `web/src/components/right/ArtifactPanel.tsx`、`server/src/selfcheck.ts` |
| 22 | `load` 在 RUNNING 期约一半概率阻塞（178s / 81.6s）⇒ 独立 30s readTimeout + 关掉聚焦重取 | `server/src/live.ts` 的 `liveHistory`、`web/src/main.tsx` |
| 23 | OpenAPI 无应答接口，agent 提问即永久挂起（确认码 TTL ~18min）；`mode` 默认 `default` = 每次工具调用前请求批准（见约束 37），而 OpenAPI 侧给不出这个批准 ⇒ 本工程**不注入任何内容模板**，"别反问"要你自己写进提示词 | `web/src/components/chat/ToolCard.tsx` 的 `UNSETTLED_META`（流已结束而工具停在 `in_progress` ⇒ 显示「未回传终态」并停止转圈，不假装还在跑） |
| 24 | `[LIVE 09-17]` 串答案的触发条件是**并发收流**：4 会话同时发 3/4 串、单条流可混入多达 3 个他会话的回答；逐个顺序发则 4/4 隔离。且串是**响应扇出错**而非请求路由错——每个会话仍回显自己的 marker（请求按 sessionId 路由正确），但流里混入他会话 marker（回答回传被并发会话共享/错配）⇒ marker 注入 + 归属校验，并发时别信原始流、信徽标 | `shared/src/marker.ts`、`server/src/routes/prompt.ts` 的 `withMarker`（注入点在服务端）、`web/src/components/chat/MarkerBadge.tsx` |
| 25 | 帧内文本是双层嵌套（`content[0].content.text`），直接取 `content.text` 得空串 | `shared/src/frames.ts`、`server/test/fixtures/prompt-tools.jsonl` |
| 26 | `load` 首帧是 `update.configOptions`，**没有 `sessionUpdate` 键**，不容忍未知 update 就进会话即崩 | `shared/src/turn.ts`、`server/test/fixtures/load-clean.jsonl` |
| 27 | 工具命令只在 `in_progress` 帧的 `rawInput.command` 上 ⇒ 聚合必须"有值才覆盖" | `shared/src/turn.ts` |
| 28 | generator 正常结束但从未出现 `Result.stopReason` ⇒ 归 `stream_break`（静默截断不能当成功） | `server/src/pipeline.ts`、`shared/src/turn.ts` |
| 29 | `application/x-ndjson` 是非简单类型 ⇒ 必须正确处理 CORS 预检 | `server/src/index.ts` |
| 30 | `res.write` 背压：长轮 901 帧（最密的 1 秒里 15 帧）+ 慢客户端 ⇒ 等 `drain` | `server/src/ndjson.ts` |
| 31 | `@darabonba/typescript@1.0.5` 编译到 ES5，`instanceof ResponseError` **恒 false**（原型链只剩 `Error → Object`）⇒ 上游 4xx 只能按形状认（`name` / 数字 `statusCode`），否则 401/403/422/429 全被误归成 `transport` 且 `retryable:true`，`upstreamStatus` 恒丢 | `server/src/normalize.ts`、`server/test/normalize.test.ts` |
| 32 | 上游鉴权报文会**回显调用方自己的 AccessKeyId**（401 的 `Message` 形如 `Deny: LTAI…\|source ip: …`）⇒ 归一化出口必须统一脱敏，否则 AK 会被抄进终端日志与前端页面 | `server/src/normalize.ts` |
| 33 | `CreateAgentSession` 失败时回 **HTTP 200 + 空 `JsonRpcResponse`**（无 `Result` 也无 `Error`），"账号无运行实例"与"身份未授权"在响应里长得一模一样 ⇒ 要用只读的 `ListAgentSessions` 做判别探针 | `server/src/selfcheck.ts` |
| 34 | `[LIVE 09-15]` **POP 层回执 `{"RequestId":"…"}` 不是 ACP 帧**：判据必须"命中 ≥1 个 ACP 层键（`Jsonrpc`/`Method`/`Params`/`Result`/`Error`）"，否则回执会被当帧透传、并被 `requestIdOf` 冒充成本轮 rid（回执是 32 位十六进制，真 rid 是 UUID，拿它过滤历史必然一无所获）。依据：真实链路全部帧 **100% 带 `Jsonrpc`** | `shared/src/frames.ts` 的 `POP_ONLY_KEYS` / `popAckRequestId`、`server/src/mock/fixtures.ts` |
| 35 | `[LIVE 09-15]` 收尾分类必须分两种：**零帧 ⇒ `prompt_not_dispatched`**（任务根本没开始，不该去探测是否完成）、**有帧无终态 ⇒ `stream_break`**（很可能还在跑，绝不重发）。两者处置恰好相反 | `server/src/pipeline.ts`、`shared/src/errors.ts`、`server/test/pipeline.test.ts` |
| 36 | `[LIVE 09-15]` **prompt 会被上游收下却不派发**：SSE 只回一个 POP 回执（0.1~0.7s）就关流，`load` 回看只有一个 `config_option_update` + 一个 `end_turn` 空轮次。六种正交手段（wire ×4 / UA / 假 SessionId / RG / endpoint / 换 CLI 路径）排除调用方因素，prompt 前后历史逐字相同 ⇒ 服务端没留下痕迹 | `server/src/live.ts` 的 `livePromptFrames`、`shared/src/errors.ts` 的 `promptNotDispatched` |
| 37 | `[LIVE 09-15]` **权威 configOptions 词汇表**（取自 live load 的 `config_option_update` 帧）：`execution_lane` = auto\|chat\|cli（默认 `auto`）、`mode` = plan\|default\|auto-edit\|yolo（默认 `default`，即**每次工具调用前请求批准**）、`skills` = []（最多 8）、`web_search` = false | `shared/src/frames.ts`（容忍该 update）、`shared/src/turn.ts` |
| 38 | `[LIVE 09-15]` 建会话时显式传 `Meta.InitialConfigOptions.ExecutionLane=chat` + `Mode=yolo` 会拿到**空响应**（2/2），而 wire body 本身合法 ⇒ 被上游静默吞掉，这两个字段**可用性未证明**，别照 SDK 类型定义就以为能设 | `server/src/live.ts` 的 `liveCreateSession` |
| 39 | `[LIVE 09-15]` `CreateAgentSession` 会**抽风**：同形状入参、相隔数分钟，一次空响应一次成功；另实测 CLI 不带 `ResourceGroupId` 能建成，SDK 不带 RG（且不带 `SessionTags`）返回空 ⇒ 建会话必须可重试，且成功判据只有 `SessionId` 非空 | `server/src/selfcheck.ts`、`server/src/live.ts` |
| 40 | **rAF 在隐藏标签页里被整个暂停**（浏览器实测：藏起来 6s，rAF 只触发 1 次），只靠 rAF 的话长轮期间中栏一片空白、直到本轮结束才一次性长出全部内容 ⇒ flush 必须有定时器兜底（250ms；后台被降频到约 1s 一次但不暂停）。实测同一窗口里正文长度增长了 5 次，全是兜底定时器干的 | `web/src/state/turnStore.ts` 的 `FLUSH_FALLBACK_MS` / `markDirty`、`web/test/turnStore.test.ts` |
| 41 | 在途锁的 rid 必须**在流进行中**回填，不能等流结束：长轮实测 191s，期间用户完全可能再点一次发送，而 `heldByRid` 是去历史里定位那一轮的唯一线索。等 `streamWire` 返回再赋值，锁条目在整个运行期都是 `undefined` | `server/src/ndjson.ts` 的 `onRid`、`server/src/routes/prompt.ts`、`server/test/ndjson.test.ts` |
| 42 | `[LIVE 09-17]` **会话到执行端（qwen-daemon）的绑定是临时的**：闲置旧会话发 prompt 报 `Session is not ready`（`no daemon binding found…` / `the session binding is incomplete. Please retry later`，未识别形态落 `rpc_error` 兜底）；新建会话立即发则绑定当场就绪（无需重试）。绑定状态服务端问不出来，只能从这条报错反推——要复用旧会话先做好"绑定已丢、需重建/重试"的预期 | `shared/src/errors.ts` 的 `classifyError`（未识别形态落 `rpc_error` 兜底）、报错原文来自上游 |
| 43 | `[LIVE 09-17]` **回覆成功后不要重发 prompt**：ReplyAgentSession 只是往原轮次里注入人的决定，原 SSE 流还在，后续帧从原流继续；重发 prompt 会开新轮 | `server/src/live.ts` 的 `liveReply`、`shared/src/rest.ts` 的 `ReplyResult` |
| 44 | `[LIVE 09-17]` ask_user_question 的回覆**必须带 optionId**（options 里 `kind==='allow_once'` 的那个）+ answers，缺 optionId 被上游 400 拒收；宽松环境的旧版本曾宽容裸 `selected`（解锁但 agent 收不到答案），按严格版对齐 | `shared/src/rest.ts` 的 `ReplyResult` 注释、`web/src/components/chat/InteractionCard.tsx` |
| 45 | `[LIVE 09-17]` 回覆端点用 **POST** 不是风格：回覆真实改变服务端执行走向，GET 属 CORS 简单请求，任意网页都能跨源打一发；回覆载荷只接受 `selected`（带 optionId）或 `cancelled` 两种 outcome | `server/src/routes/rest.ts` 的 reply 端点、`shared/src/rest.ts` |

---

## 10. 已知限制与免责

- **流式一轮的真实链路验收（`[LIVE 09-16]` 已补上）**：
  ① 界面上一轮真的拿到 `end_turn` + 徽标「归属已校验」✅（message 原样带回每轮注入的 `DAS-XXXXXX`）；
  ② 真实 `load` 的 `droppedRidLess` ✅（真实轮次恒为 0：帧全部携本轮 rid，无 rid-less 污染）；
  ③ 218~258s 断流墙与探测器判据 B——**仍未在真实链路上验证**（需要一轮真的长时间任务，
  目前只跑过 4~9s 的短轮次，这部分由 MOCK 样例回放演示，`MOCK=1 npm run dev` 可肉眼验收）。
  另注：09-15~16 曾出现的"prompt 只回 POP 回执就关流、历史无痕迹"，真根因是
  **用户 Token 周限额触发服务端 POP 计费闸门**（`FEATURE_CHECK_FAILED / 0x488305000000002a`），
  不是派发故障——换用未超限身份当天即恢复。该配额错误**不透传回 SSE 帧**
  （客户端只能看到裸 `{RequestId}` 空帧），遇到同款症状先查限额身份，别再改代码。
- **探测器判据强弱不同**：判据 A（该 rid 的帧数 > 2，看到了产物）可以说"已完成"；
  判据 B（`TotalTokens` 相比断流时跳变）**只验证过 1 次**，零 token 轮次可能不跳变，
  所以 B 只能加强 A 的结论、不能单独否定 A，命中 B 时 UI 说的是"很可能已完成，请拉历史确认"。
  没有基线时不会传 `tokens` 参数（传个假 0 会让 B 永远命中）。
- **探测有代价**：每次探测都触发一次完整 `load`，RUNNING 期约一半概率阻塞。
  所以限频 60s，总时限 300s，到点显示「无法判定是否完成」并只给「拉取历史」，不给「重发」。
- **本地在途标记不是权威**：只有写它的那个标签页真在收流。别的标签页读到它，
  只能说"这个会话上可能有一轮在服务端执行"，UI 文案就是这么写的。
  超过 10 分钟的标记视为过期自动忽略。
- **`npm audit` 的结果取决于你的 registry**：部分镜像源不提供 audit 端点
  （`POST …/-/npm/v1/security/advisories/bulk` 直接 404），此时 `npm audit` 会报错而不是"零漏洞"。
  在官方源上跑时曾看到 2 条 vitest 的 moderate 提示，修复要升到 vitest 5（breaking），本仓库未处理。
  vitest 只在开发期跑，不进生产构建。
- **`GetAgentSessionTokenUsage` 的粒度边界**：只回**会话级**的 prompt / completion / cached / total
  四个累计数，没有分模型维度，也不返回上下文窗口容量——别凭"假设窗口是 128k"造一个
  看起来精确、实则编造的占用百分比。
- **样例全部为合成数据**（见 `server/test/fixtures/README.md`）。

---

## 11. MOCK 模式（可选：没有凭证也能预览全部形态）

主路径是接真实上游（见「快速开始」）。还没有云资源、只想先预览时，MOCK 一条命令起全栈：

```bash
MOCK=1 npm run dev
# 或者写进 .env：MOCK=1
```

MOCK 回放的是 `server/test/fixtures/` 下的**合成样例**：帧形状与真实上游一致
（外层 `data` 信封、字段名、错误码形态），内容是编造的演示业务，仓库里没有任何真实抓包。
左栏预置 8 条会话，一条对一份样例（ack-only 那条没有样例文件——它演示的正是"零帧"），
点进去发任意 prompt 就会回放对应帧流：

| 会话 | 帧数 | 你会看到 |
|---|---|---|
| `[MOCK] 短轮 · 20 帧 · end_turn` | 20 | 一问一答逐字出现，秒级收尾，`stopReason=end_turn` |
| `[MOCK] 工具轮 · 49 帧 · 6 次调用` | 49 | 工具卡片状态流转：5 completed + 1 failed，`rawInput.command` 只在 in_progress 帧 |
| `[MOCK] 长轮 · 87 帧 · 10 次调用` | 87 | 多步分析 + Markdown 表格结论；历史用**带 rid-less 重复帧污染**那份，验证不会显示两遍 |
| `[MOCK] 断流 · -32603 · 46 帧` | 46 | 琥珀色横幅「回复通道已中断，任务可能仍在服务端执行」+「探测是否已完成」 |
| `[MOCK] 会话幽灵化 · 422 · 单帧` | 1 | 红色横幅「该会话已失效」，左栏标死，唯一动作是新建会话 |
| `[MOCK] 并发被拒 · 单帧` | 1 | 灰色提示，不弹错误对话框 |
| `[MOCK] prompt 不派发 · 零帧 · 只有 POP 回执` | 0 | 琥珀色横幅「上游收下了这一轮，但没有派发给执行端」，message 里带 POP 回执号；**没有探测器**，只有「拉取历史确认这一轮没留下内容」 |
| `[MOCK] 渲染覆盖 · 代码块 + mermaid（合成）` | 4 | shiki 代码块高亮与 mermaid 图渲染这两条纯前端路径 |

每份样例演示什么、帧形状长什么样，见 [`server/test/fixtures/README.md`](server/test/fixtures/README.md)。
"零帧 + POP 回执"是 `[LIVE 09-15]` 真实碰到的形态，也是目前**唯一**能在
MOCK 下看到的 `prompt_not_dispatched`——它和断流长得像但处置相反：
断流给探测器、这条不给（零帧意味着任务根本没开始，"探测是否完成"是错误指引）。

MOCK 下中栏的归属徽标**恒为「归属未校验」**：回放的是固定样例，正文里不可能出现本轮新生成的校验码。
这不是 bug，「归属已校验」只在真实模式下有意义。另有 2 条「别的来源」的会话，
用来证明 `SessionSource` 过滤真的生效——它们不该出现在列表里，只体现在 `filteredOut` 计数上。

回放时序：真实链路里长轮能跑约 190 秒（断流墙在 218~258s），按真实间隔等一轮当演示等不起，
所以默认**把过长的帧间隔压平到 400ms 再叠 4x 倍速**（`MOCK_REALTIME=0`、`MOCK_SPEED=4`）。
压平和倍速**只改等待时间**：帧序、帧数、帧内容、相对顺序全部保真。
想验证前端在真实节奏下的表现，设 `MOCK_REALTIME=1`（此时 `MOCK_SPEED` 不生效）。

---

## 许可与用途

[MIT](LICENSE)。示例代码，随意参考、随意抄。`server/test/fixtures/` 里的样例全部为合成数据，无任何真实抓包；
你接入自己的账号后产生的会话数据属于你，本仓库不收集、不上传。
