# DataAgent OpenAPI 多语言示例

通过 OpenAPI 来体验 DataWorks DataAgent：创建会话、发送问题、查看流式回复和历史，并进行问答、停止、改名、归档及删除。

选择 Java、Python 或 Node.js 中的一个后端，使用同一套网页。Agent 管理由独立的后端示例完成；网页可指定已发布的 Agent，默认 `dataworks_data_agent`。

![Data Agent 页面预览](docs/images/data-agent-demo.png)

## 一键体验

所有语言都需要 Node.js 22.x（至少 22.12）或 24.x 和 npm 10+ 来运行网页。先在项目根目录安装依赖：

```bash
npm ci
```

暂时没有凭证时，任选一种语言启动固定示例：

### Node.js

```bash
npm start -- node --mock
```

### Java

额外需要 JDK 17+ 和 Maven 3.6.3+；首次启动自动构建。

```bash
npm start -- java --mock
```

### Python

额外需要 Python 3.11+，首次安装依赖：

```bash
python3 -m venv server-python/.venv
server-python/.venv/bin/python -m pip install -e ./server-python
npm start -- python --mock
```

Windows 使用 `py -3 -m venv server-python/.venv` 和 `server-python\.venv\Scripts\python.exe -m pip install -e ./server-python`。

打开终端提示的地址，默认 <http://127.0.0.1:5173>。每条命令同时启动后端与网页，按 `Ctrl+C` 一起停止。MOCK 回放固定数据，不调用云端，回答不会随问题变化。

## 使用真实 OpenAPI

准备已开通 DataWorks 的账号、具备所需权限的 RAM AccessKey，以及官方或已发布的自定义 Agent。

1. 将根目录 `.env.example` 复制为 `.env`。
2. 填写 RAM 的 AccessKey ID、AccessKey Secret 和目标地域，设置 `MOCK=0`。先体验官方 Agent 时，保留默认 `dataworks_data_agent`；使用自定义 Agent 时再填已发布名称。
3. 去掉启动命令的 `--mock`，任选一种语言：

```bash
npm start -- java
npm start -- python
npm start -- node
```

| 环境变量 | 用法 |
|---|---|
| `MOCK` | 真实调用为 `0`，固定示例为 `1` |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | 后端使用的 RAM AccessKey |
| `DATAAGENT_REGION_ID` | 目标地域，默认 `cn-hangzhou` |
| `DATAAGENT_AGENT_NAME` | 后端直接调用时使用的 Agent，默认 `dataworks_data_agent`；网页可显式覆盖 |
| `DATAAGENT_MODEL` | 新会话默认模型；留空沿用 Agent 配置 |
| `DATAAGENT_MODE` | 新会话审批模式，默认 `yolo`；支持 `default/plan/auto-edit/auto` |
| `DATAAGENT_REASONING_EFFORT` | 思考深度；`none` 关闭，留空沿用 Agent，须由模型支持 |
| `DATAAGENT_MODELS` | 可选模型列表，逗号分隔 |
| `SESSION_SOURCE` | 会话来源标记；修改后列表可能不显示原来源的会话 |
| `END_POINT` | 通常留空；指定网关时填域名，不带 `https://` |
| `RESOURCE_GROUP_ID` | ACS 留空，仅兼容旧资源组方案 |

凭证仅留在后端，不放入 `VITE_*`、浏览器或 Git。服务端使用配置中的凭证，不读取 CLI profile。三语言均支持直接 AK/SK，也支持同一组 STS 临时 AK/SK + `ALIBABA_CLOUD_SECURITY_TOKEN`。默认启动不会扮演角色；需要时使用独立的 [AssumeRole 示例](docs/ASSUME-ROLE.md)。

## 网页使用

新建会话自动使用默认配置，不弹框。点击侧栏左下角“会话设置”，指定 Agent、模型、审批模式和思考深度；浏览器保存主动修改的选项，后续创建自动读取。点击“恢复环境默认值”清除当前 Agent 的选项覆盖并将 Agent 恢复为 `dataworks_data_agent`。Agent 名称失焦或点击“完成”后保存到本浏览器；模型等默认值按后端地址和 Agent 隔离。自定义 Agent 必须已创建并发布，当前凭证需要有使用权限。设置只影响后续新会话，修改 `.env` 后须重启后端。新会话输入框使用原生模型和审批模式选择器，这里的选择仅覆盖当前新会话，不改写侧栏保存的默认值。思考深度和规划（Plan）模式在侧栏设置；选择 Plan 时不显示原生审批切换，以创建时配置为准。已有会话不提供配置修改入口。

会话地址为 `/session/{sessionId}`，支持刷新恢复。改名、归档、恢复、删除和问答回复调用真实 OpenAPI；目标地域需已部署并授权相关 Action。`yolo` 不会自动回答 `ask_user_question`。

如果回复断开，先刷新查看远端历史，**不要直接重发问题**：原任务可能仍在执行。HTTP 200、收到回执或本地健康检查通过，都不等于任务执行成功。 页面报错会附上已取得的远端 `requestId`，可连同时间和 sessionId 提供给维护者排查。

## 内网访问、端口与配置切换

```bash
npm start -- java --lan
# 也支持 python、node；免凭证演示可加 --mock
```

同事打开终端输出的内网地址，只需允许网页端口（默认 5173），后端仍监听本机。所有访问者共享当前账号权限与会话，仅用于可信内网，不直接映射公网。访问超时先检查防火墙、VPN/网络隔离；WSL2 还需宿主机网络转发。本机可访问但同事不可访问，通常不是 OpenAPI 的问题。

在 `.env` 中设置 `PORT=3100`、`WEB_PORT=5180` 可换端口；端口冲突会报错，不会自动关闭其他进程。

可为不同环境保存完整的 `.env.<name>`，通过 `DAS_ENV=<name>` 选择。文件不与默认 `.env` 合并，进程环境变量优先：

```bash
DAS_ENV=demo npm start -- java
```

PowerShell 使用 `$env:DAS_ENV="demo"`，cmd 使用 `set DAS_ENV=demo`，然后执行同一启动命令。

## 按需阅读

- [OpenAPI 调用速查](docs/OPENAPI-EXAMPLES.md)：新增/修改接口的参数、三语言片段、Events 续接与代码位置。
- [自定义 Agent](docs/AGENT-MANAGEMENT.md)：管理身份创建、发布、更新 Agent，引用 Skill/套件。
- [AssumeRole](docs/ASSUME-ROLE.md)：可运行的角色启动示例、SourceIdentity、权限与续期接入。

独立运行说明：[Java](server-java/README.md)、[Python](server-python/README.md)、[Node.js](server-node/README.md)。开发与测试命令见[开发说明](docs/DEVELOPMENT.md)。
