# FAQ：把坑写成问答

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

