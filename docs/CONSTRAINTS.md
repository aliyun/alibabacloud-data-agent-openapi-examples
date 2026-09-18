# 实测约束清单（代码归属）

下面每条都能在仓库里指到一处代码。它们不是文档摘抄：是真实链路实测（标了 `[LIVE MM-DD]` 的条目）
与此前的独立实测共同钉住的行为，公开仓库的样例与测试覆盖其中可自动化的部分。主 README 的「实测约束精选」是本表的子集。

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

