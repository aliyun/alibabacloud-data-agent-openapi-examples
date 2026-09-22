# fixtures（全部为合成样例）

> **本目录没有任何真实抓包。** 每一份文件都是手写/脚本生成的合成样例，
> 帧形状（外层 `data` 信封、字段名、嵌套结构、错误码形态）与真实上游一致，
> 内容全部为编造的演示业务（示例电商表 `sales_orders` 等）。人物、数字、结论均属虚构。

## 帧流录制样例（`.jsonl`，每行 `{"data":{…帧…}}`）

样例保留了外层 `data` 信封；SDK 的 `*WithSSE()` yield 出来的 `resp.body` 已经剥好壳。
所以回放必须过 `unwrapEnvelope`，否则 mock 与真实链路走的不是同一份解析代码。

| 文件 | 帧数 | 它演示什么 |
|---|---|---|
| `prompt-short.jsonl` | 20 | 最短闭环：一问一答、无工具、校验码回显、`end_turn` |
| `prompt-tools.jsonl` | 49 | 工具状态机：6 次调用（5 completed + 1 failed）、`rawInput.command` 只在 in_progress 帧 |
| `prompt-long.jsonl` | 87 | 多步分析长轮：10 次工具调用 + Markdown 表格结论 |
| `error-stream-break.jsonl` | 46 | 断流：吐完内容后收尾一个 `-32603 / session stream ended without turn terminal`，**没有** `Result` 终态 |
| `error-session-ghost.jsonl` | 1 | 会话幽灵化：约 1s 返回单帧 `-32603 / prompt forward failed, upstream_status=422` |
| `error-concurrent-rejected.jsonl` | 1 | 并发被拒：`session_concurrent_operation_in_progress…`，**没有 `errorCode` 字段** |
| `load-clean.jsonl` | 28 | 空闲期拉历史：`config_option_update` 首帧 + 4 个轮次，全部带 `RequestId` |
| `load-polluted.jsonl` | 43 | RUNNING 期拉历史：混入 15 个**没有 `RequestId` 键**的重复帧，必须过滤，否则内容显示两遍 |
| `synthetic-render.jsonl` | 4 | 渲染覆盖：`python` 围栏代码块 + mermaid 流程图 + GFM 表格（手写） |

三种错误的 `code` 都是 `-32603`；断流与幽灵化连 `errorCode` 都相同（`0x48833000000000d1`），
只有 `message` 文本能分开——这就是 `classifyError` 只能按文本分类的原因。

## 非流式响应样例（`.json`）

| 文件 | 它演示什么 |
|---|---|
| `rest-list-agents.json` | 返回列表里**没有** `dataworks_data_agent`（只有 2 个 chatbi 系 agent），但用它建会话照样成功 |
| `rest-create-session.json` | 成功判据只有 `Result.SessionId` 非空 |
| `rest-token-usage.json` | 唯一可靠度量（`PromptTokens` 远大于用户输入，大头是 system prompt 与技能上下文） |

## 两个容易踩的形状细节

1. **rid 过滤判据是"键是否存在"**，不是"值是否为空"。`load-polluted.jsonl` 里的污染帧
   压根没有 `RequestId` 这个键，而不是 `"RequestId": ""`。
2. **长度按码点数，不按 `.length`**。若你要在文本长度上做断言，注意 JS 的 `.length` 数
   UTF-16 码元，而内容里有增补平面字符（如 `📌`）时两者不等。

## 校验码（marker）

prompt 首帧回显用户原文（含注入的校验码说明），回答第一行会带上形如 `DAS-ABC123` 的校验码
（正则 `^DAS-[0-9A-F]{6}$`）。样例里的校验码全部满足这个形状，仅保留为旧历史清洗兼容测试数据。当前应用不再向真实提示词注入或验证校验码。

## 如何再生成 / 扩展

样例文件是普通 JSON Lines，按上表帧形状手工编写即可；新增一条演示路径时，
同步更新 `server-node/src/mock/fixtures.ts` 里 `MOCK_SCENARIOS` 的会话条目（标题、帧数、
`teaches` 文案），mock 列表与界面就会自动带上它。
