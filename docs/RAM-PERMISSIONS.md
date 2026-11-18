# DataAgent：RAM 身份分工与权限配置

本文适用于“服务账号管理 Agent 和 Holo 账号映射，扮演运行角色后执行 Agent 会话”的接入方式。提供三份可复制的 JSON：运行角色权限、管理服务账号权限、运行角色信任策略。

配置中的 `<ACCOUNT_ID>`、`<SERVICE_USER_NAME>` 等均为占位符，使用前替换。本文不包含真实凭据。

## 1. 身份与职责

| 身份 | 职责 | 使用的凭据或标识 | 权限配置 |
| --- | --- | --- | --- |
| 管理服务账号（RAM User） | 创建、更新、发布、删除 Agent；管理 Skill/MCP；注册 Holo 账密映射；直接调用会话接口；扮演运行角色 | 服务端持有的 RAM AK/SK | 第 3 节策略 |
| 会话运行角色（RAM Role） | 创建和运行 Agent 会话，调用 DataWorks 只读接口 | AssumeRole 返回的临时 AK、SK、SecurityToken | 第 2 节策略及第 4 节信任策略 |
| 业务用户（SourceIdentity） | 标识本次会话和查询代表的真实用户，定位其 Holo 账号映射 | 可信服务端根据认证登录态确定的用户标识 | 不因设置 SourceIdentity 自动获得 RAM、工作空间或数据库权限 |
| Holo 数据库账号 | 实际通过 JDBC 连接目标数据库、执行 SQL | 安全中心保存的数据库用户名和密码 | 数据库内的连接、只读及按需行级权限 |
| DataWorks 服务 | 在运行链路中按角色信任配置代扮演角色 | 信任策略中的 `dataworks.aliyuncs.com` | 它是受信任服务主体，不是业务用户 |

调用链路：

```text
管理请求：RAM User → 创建/更新并发布 Agent、配置 Holo 账号映射

业务请求：RAM User → AssumeRole(SourceIdentity=可信业务用户标识)
                  → 角色临时凭证 → 创建会话、发送问题
                  → 语义 Skill → SQL 执行服务
                  → 按 SourceIdentity 查找 Holo 账密映射 → JDBC 查询
```

同一后台服务可以同时承担管理和业务入口：管理操作使用 RAM User；需要按 SourceIdentity 代表业务用户执行的会话使用角色 STS 凭据。第 3 节也允许服务账号直接调用会话接口，此时按服务账号自身身份及其资源授权执行，不代表其他业务用户。角色不会继承原 RAM User 的管理权限。

## 2. 会话运行角色权限策略

**绑定对象：实际执行 Agent 会话的 RAM Role。**

包含 DataWorks 读取/查询类权限，以及逐项列出的会话操作；不授予角色扮演、Agent/Skill/MCP 管理或 Holo 映射写入权限。会话 Action 使用明确名称，不使用 `*AgentSession*`。

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dataworks:Get*",
        "dataworks:List*",
        "dataworks:Query*",
        "dataworks:CreateAgentSession",
        "dataworks:ListAgentSessions",
        "dataworks:PromptAgentSession",
        "dataworks:LoadAgentSession",
        "dataworks:ReplyAgentSession",
        "dataworks:CancelAgentSession",
        "dataworks:UpdateAgentSessionTitle",
        "dataworks:ArchiveAgentSession",
        "dataworks:DeleteAgentSession",
        "dataworks:GetAgentSessionEvents",
        "dataworks:ListAgentSessionArtifacts",
        "dataworks:GetAgentSessionArtifactMeta",
        "dataworks:GetAgentSessionTokenUsage"
      ],
      "Resource": "*"
    }
  ]
}
```

`Get*`、`List*`、`Query*` 是读取/查询类 API 的通配授权基线，不是逐资源最小权限清单，也不能保证任意 SQL 都只读。数据库只读范围仍应由 Holo 账号权限控制。业务只使用确定接口时，可以进一步收紧这些读取/查询 Action。

本次成都验收使用的角色还绑定了两个系统策略，可作为同类接入的配套基线：

- `AliyunDataWorksReadOnlyAccess`
- `AliyunHologresReadOnlyAccess`

系统只读策略不能替代上述会话 Action。Hologres 云产品只读权限也不能替代数据库内的 `CONNECT`、对象读取和行级权限。

### 会话 Action 的作用

| Action | 作用 |
| --- | --- |
| `CreateAgentSession` | 基于指定 Agent 创建会话，按平台流程准备实例和运行环境 |
| `ListAgentSessions` | 列出当前身份可访问的会话 |
| `PromptAgentSession` | 发送问题并接收执行过程和回答 |
| `LoadAgentSession` | 加载已有会话历史 |
| `ReplyAgentSession` | 回复权限确认或 `ask_user_question` 等交互 |
| `CancelAgentSession` | 取消当前会话正在执行的任务 |
| `UpdateAgentSessionTitle` | 修改会话标题 |
| `ArchiveAgentSession` | 设置或取消会话归档 |
| `DeleteAgentSession` | 删除会话 |
| `GetAgentSessionEvents` | 订阅会话事件 SSE |
| `ListAgentSessionArtifacts` | 查询会话产物列表 |
| `GetAgentSessionArtifactMeta` | 获取指定会话产物的元信息 |
| `GetAgentSessionTokenUsage` | 查询会话 Token 用量 |

表中 Action 均使用 `dataworks:` 前缀。授予权限不代表目标地域的接口发布、路由及具体功能已验收通过。

## 3. Agent 管理服务账号权限策略

**绑定对象：后台服务使用的 RAM User。**

包含角色扮演、DataWorks 读取/查询、Agent/Skill/MCP 管理、完整 AgentSession 操作及 Holo 账密映射写入。服务账号既可直接调用会话接口，也可扮演第 2 节的运行角色；两种方式使用各自身份的会话与资源授权。

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sts:AssumeRole",
        "sts:SetSourceIdentity",
        "dataworks:Get*",
        "dataworks:List*",
        "dataworks:Query*",
        "dataworks:CreateAgent",
        "dataworks:GetAgent",
        "dataworks:UpdateAgent",
        "dataworks:DeleteAgent",
        "dataworks:ListCustomAgents",
        "dataworks:ListAgents",
        "dataworks:CreateSkill",
        "dataworks:GetSkill",
        "dataworks:UpdateSkill",
        "dataworks:DeleteSkill",
        "dataworks:ListSkills",
        "dataworks:CreateMcpServer",
        "dataworks:GetMcpServer",
        "dataworks:UpdateMcpServer",
        "dataworks:DeleteMcpServer",
        "dataworks:ListMcpServers",
        "dataworks:CreateAgentSession",
        "dataworks:ListAgentSessions",
        "dataworks:PromptAgentSession",
        "dataworks:LoadAgentSession",
        "dataworks:ReplyAgentSession",
        "dataworks:CancelAgentSession",
        "dataworks:UpdateAgentSessionTitle",
        "dataworks:ArchiveAgentSession",
        "dataworks:DeleteAgentSession",
        "dataworks:GetAgentSessionEvents",
        "dataworks:ListAgentSessionArtifacts",
        "dataworks:GetAgentSessionArtifactMeta",
        "dataworks:GetAgentSessionTokenUsage",
        "dataworks:CreateIdentifyCredential"
      ],
      "Resource": "*"
    }
  ]
}
```

这里按统一配置使用 `Resource: "*"`；最终能扮演哪些角色还受目标角色信任策略约束。若需进一步收紧，可将两项 STS 操作拆到独立 Statement，Resource 改为指定角色 ARN。

### 管理操作说明

- **Agent**：创建、查询、更新、删除和列出自定义 Agent；`CreateAgent` / `UpdateAgent` 可通过 `PublishImmediately=true` 同时发布，不需要另造 `PublishAgent` Action。
- **Skill / MCP**：上述 JSON 包含对应 OpenAPI 的创建、读取、更新、删除和列表权限。
- **会话**：包含第 2 节逐项列出的全部会话 Action，可直接创建、运行和管理服务账号自身有权访问的会话。
- **Holo 账密映射**：`CreateIdentifyCredential` 用于注册身份凭证映射。这里未声明其他映射更新或删除 Action；后续维护须按实际提供的接口另行配置，不能从名称推造接口。
- **自定义套件**：通过控制台准备并发布，Agent 引用已发布套件。本文不将控制台 BFF 操作名称当作 RAM OpenAPI Action，也不虚构套件创建/发布 Action。套件管理还需满足 DataWorks 产品内的资源归属及管理权限要求。

RAM API 策略不会自动授予 DataWorks 租户管理员身份、工作空间角色或他人资源的使用权限。个人 Agent 操作与企业级资源管理应分别核对产品内权限。

## 4. 运行角色的信任策略

**配置位置：RAM Role 的“信任策略管理”，不是绑定到用户的权限策略。**

在 `Principal.RAM` 中逐项填写所有允许扮演该角色的 RAM 主体 ARN；有几个就列几个，删除不使用的占位项。以下示例包含两个服务账号和 DataWorks 服务：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "RAM": [
          "acs:ram::<ACCOUNT_ID>:user/<SERVICE_USER_NAME_1>",
          "acs:ram::<ACCOUNT_ID>:user/<SERVICE_USER_NAME_2>"
        ],
        "Service": [
          "dataworks.aliyuncs.com"
        ]
      },
      "Action": [
        "sts:AssumeRole",
        "sts:SetSourceIdentity"
      ]
    }
  ]
}
```

需要允许另一个 RAM Role 扮演时，在 `RAM` 数组中加入其角色 ARN，例如 `acs:ram::<ACCOUNT_ID>:role/<CALLER_ROLE_NAME>`，并为该调用角色配置相应 STS 身份权限。不要填写临时 `assumed-role/.../session-name` ARN、SourceIdentity 或数据库账号。

`Principal.Service` 表示信任 DataWorks 服务代扮演该角色；它不等于授予角色调用 DataWorks API 的权限。API 权限仍由第 2 节配置。

携带 SourceIdentity 时，**调用方身份策略和目标角色信任策略两侧都需要允许 `sts:SetSourceIdentity`**。已有角色应合并必要授权，并保留现有有效主体及条件，不直接覆盖其他业务的信任配置。

## 5. RAM 策略之外的必要授权

| 配置项 | 要授权或配置的身份 | 要点 |
| --- | --- | --- |
| Agent 可见范围 | 会话运行角色 | Agent 发布后，应允许角色主体使用；需要填写用户 ID 的资源范围中，角色通常使用 `ROLE_<RoleId>` |
| 个人 Skill / 自定义套件分享 | 管理 RAM User 和运行 RAM Role | 管理用户需能引用资源，运行角色需能加载资源；只分享给其中一方不代表另一方也可用 |
| 语义任务及工作空间 | 会话运行角色 | 角色应加入语义任务所属工作空间，并获得任务及产物读取权限；RAM 的 Get/List/Query 授权不能代替空间成员权限 |
| Holo 账密映射 | 本次 SourceIdentity 对应的业务用户 | 映射 UserId 与 AssumeRole.SourceIdentity 保持一致，并匹配实际 Holo 实例和作用域 |
| Holo 数据权限 | 映射中的数据库账号 | 具备目标库连接、目标表读取及按需行级权限 |
| 地域与服务路由 | 管理身份和运行身份所在的实际链路 | 接口发布和灰度配置应覆盖目标地域及身份；接口不存在或走旧应用不应通过扩大 RAM 权限解决 |

角色名称、角色 ID 和角色 ARN 不能互换：

```text
角色 ARN：用于 AssumeRole、RAM 策略和信任配置
acs:ram::<ACCOUNT_ID>:role/<ROLE_NAME>

角色主体 ID：用于要求填写 DataWorks 角色用户 ID 的资源分享/可见性配置
ROLE_<RoleId>

SourceIdentity：用于标识真实业务用户及定位 Holo 账号映射
<TRUSTED_BUSINESS_USER_ID>
```

### Holo 映射示例

以下是 `CreateIdentifyCredential` 的业务请求参数，**不是 RAM 权限策略**：

```json
{
  "IdentifyCredential": {
    "UserId": "<与SourceIdentity相同的业务用户标识>",
    "UserType": "CustAccount",
    "DataSource": {
      "Type": "cust_holo",
      "Role": "RegularUser",
      "InstanceId": "<HOLO_INSTANCE_ID>",
      "InstanceName": "<HOLO_INSTANCE_NAME>",
      "UserName": "BASIC$<HOLO_USER_NAME>",
      "Password": "<通过安全通道注入的数据库密码>"
    }
  }
}
```

数据库名在后续 SQL 执行请求中指定。密码由可信管理端提交，不进入模型提示词、前端或文档。按本次已验证的租户级映射方式，不传 ProjectId；如使用工作空间级映射，需另行核对匹配作用域。

一个服务账号可代表多个业务用户：SourceIdentity 应来自已认证的业务登录态，不应将所有用户固定映射到服务账号 UID。本次按 RAM UID 测试时，该 RAM UID 就是本轮使用的 SourceIdentity。

## 6. 配置与验证顺序

1. 给管理 RAM User 绑定第 3 节策略。
2. 给运行 RAM Role 绑定第 2 节策略及所需系统只读策略。
3. 在运行角色信任策略中加入实际调用方 ARN 和 DataWorks 服务，允许两项 STS 操作。
4. 完成 Agent、Skill、套件的可见性/分享，以及角色的语义工作空间权限。
5. 管理 RAM User 创建并发布 Agent，核对发布版本及资源引用。
6. 管理 RAM User 为可信业务用户注册目标 Holo 实例的账号映射。
7. 用服务账号调用 AssumeRole，传入目标角色 ARN 和可信 SourceIdentity，核对响应中的角色、源身份及有效期。
8. 使用同一组临时 AK、SK、SecurityToken 创建会话、发送问题及调用后续会话接口。
9. 验证语义产物实际加载、Holo SQL 实际执行成功、回答与执行结果一致，再 Load 回读历史。

运行角色不需要为了执行会话而获得 Agent 管理、映射写入或租户管理员权限。若需管理企业级资源，应在管理身份上补齐对应产品内权限。

## 7. 常见问题

| 现象 | 优先检查 |
| --- | --- |
| AssumeRole / SetSourceIdentity 被拒绝 | 调用方身份策略、目标角色信任策略是否都允许对应操作；条件是否匹配 |
| 创建/更新 Agent 或注册映射被拒绝 | 是否使用管理 RAM User，Action 前缀是否为 `dataworks:`，而不是拼错的 `datworks:` |
| 角色调用会话接口被拒绝 | 会话 Action 是否绑定到了运行角色；只绑定到原 RAM User 不会被角色继承 |
| Agent 能读取，但加入套件时报“Agent 不存在” | 同时检查所引用套件对管理 RAM User 的可见性；不能仅凭该文案判断 Agent 真不存在 |
| 角色能看到套件，但管理用户无法引用 | 套件是否也分享给创建/更新 Agent 的 RAM User |
| 语义任务列表或产物下载无权限 | 实际运行角色是否具有语义任务所属空间及任务权限 |
| 获取 Hologres 执行身份失败 | 映射 UserId、SourceIdentity、实例和作用域是否一致，以及凭据是否有效；保留 requestId 查后端原因 |
| 无法列出安全中心映射 | 映射管理页面的读取授权与 SQL 执行取身份链路分开检查；不能由列表无权限推断映射不存在 |

## 8. 相关资料

- [本仓 AssumeRole 接入与凭据续期](ASSUME-ROLE.md)
- [本仓自定义 Agent 管理示例](AGENT-MANAGEMENT.md)
- [SourceIdentity 的双侧授权与信任配置](https://help.aliyun.com/zh/ram/user-guide/session-tagging-and-fine-grained-access-control-for-assumed-roles-using-sourceidentity)
- [CreateIdentifyCredential 接口及 RAM 授权](https://help.aliyun.com/zh/dataworks/developer-reference/api-dataworks-public-2024-05-18-createidentifycredential)
- [DataWorks 权限体系](https://help.aliyun.com/zh/dataworks/user-guide/member-permission-management)
- [Hologres 云产品只读系统策略](https://help.aliyun.com/zh/ram/developer-reference/aliyunhologresreadonlyaccess)
