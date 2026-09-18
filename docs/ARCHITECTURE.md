# 架构导读（目录、HTTP 契约、事实源）

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
形状与上游"业务错误恒 200"的契约刻意保持一致，集成者不需要在两层之间来回换脑子。

| 端点 | 干什么 |
|---|---|
| `GET /api/health` | `{mock, region, agent, sessionSource, resourceGroupIdConfigured, credentials:'present'\|'missing'}`，MOCK 下另有 `mockReplay`；**不含任何凭证片段** |
| `POST /api/check` | 三步自检（与 `npm run check` 同一个 `runCheck`）。**用 POST 是安全考量**：第②步会真实建会话，而 GET 属 CORS 简单请求，任意网页都能跨源触发它一次 |
| `GET /api/sessions` | 强制带 `AgentName` + `SessionSourceList`；**不提供 q 参数**（标题过滤器被上游静默忽略） |
| `POST /api/sessions` | 建会话；成功判据只有 `SessionId` 非空，空 body 归 `create_empty_body` |
| `GET /api/sessions/:id/history` | `LoadAgentSession`，独立 30s readTimeout；返回 `{turns, droppedRidLess, nonTurnRids, totalFrames, elapsedMs}` |
| `GET /api/sessions/:id/usage` | token 用量（唯一可靠度量） |
| `GET /api/sessions/:id/artifacts` | 原样返回 `{artifacts:[]}`，不做兜底填充 |
| `POST /api/sessions/:id/cancel` | 返回 `{delivered:false, warning:'mock-replay-uncancellable'}`（MOCK 下准确：回放无可取消的执行）。**LIVE 下已生效**：`delivered=true` + 流以 `stopReason=cancelled` 终止，前端 Stop 已接入（见 [FAQ](FAQ.md)） |
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
| 历史内容 | `LoadAgentSession` | 但它**会缩水**，不是审计存档（见 [FAQ](FAQ.md)） |
| 会话归属（是不是我发的那条 prompt 的结果） | prompt 里注入的 marker | 并发收流会串答案（`[LIVE 09-17]` 4 路同时发 3/4 串，单条流可混入 3 个他会话回答），逐个顺序发则不串；串是上游**响应扇出错**——请求按 sessionId 路由没错，错的是回答回传 |
| 产出物 | 无 | 两个 artifact 接口实测恒空，只能让 agent 内联回传 |

---

