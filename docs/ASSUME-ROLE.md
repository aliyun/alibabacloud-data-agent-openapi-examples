# 使用 RAM 角色调用

**不需要角色时**，直接在 `.env` 配置 RAM AK/SK、地域和 Agent，执行 `npm start -- java`（也支持 `node`、`python`）。角色是可选接入方式，不是使用自定义 Agent 的前提。

## 一键运行角色示例

独立启动脚本支持 macOS/Linux。先完成 README 中的依赖安装。在本地 `.env` 中配置用于扮演角色的 RAM AK/SK，再增加：

```dotenv
DATAAGENT_ROLE_ARN=acs:ram::<account-id>:role/<role-name>
# 可选；仅填写由可信服务端配置或已验证登录身份确定的主体。
DATAAGENT_SOURCE_IDENTITY=trusted-business-user-id
DATAAGENT_AGENT_NAME=my-published-agent
```

将角色 ARN、主体及 Agent 名替换为实际值。无需 SourceIdentity 时，删除该行。使用官方 Agent 时可保留 `dataworks_data_agent`。然后运行：

```bash
node scripts/assume-role.mjs -- npm start -- java
# 或将 java 替换为 node / python
```

使用另一份完整配置：

```bash
DAS_ENV=demo node scripts/assume-role.mjs -- npm start -- java
```

[独立脚本](../scripts/assume-role.mjs)使用官方 SDK 调用 STS，检查返回凭证和有效期，再把临时 AK/SK/Token 传给子进程。不会改写 `.env`、创建 Agent 或把凭证送到浏览器；扮演失败时不会回退到原始身份。普通 `npm start` 不读取角色配置，也不会自动扮演。

**此示例一次签发、不自动续期。** 以终端显示的 Expiration 为准，到期前停止并重新运行脚本即可获取新凭证。重启本机代理不等于取消远端任务；结果未知时先读取会话历史，不要重复发送问题。长期服务请按下方方式接入可刷新的凭证提供器。

## 哪些权限需要配置

| 环节 | 所需配置 |
|---|---|
| STS | 调用方允许对目标角色执行 `sts:AssumeRole`，目标角色信任策略允许该调用方。调用者使用 RAM 用户或角色，不能使用主账号 |
| SourceIdentity（可选） | 额外配置 `sts:SetSourceIdentity`，并在信任策略及相关条件中限制允许的源身份 |
| 会话接口 | 角色获得实际使用的 DataWorks Action：创建、Prompt、Reply、Load、List、Events、Cancel、改名、归档、删除等。按需授权，不因报错直接提升为管理员 |
| Agent 与数据 | 已发布 Agent 对当前身份可见；引用资源及最终执行查询所用身份具有相应访问权限 |

角色扮演授权与 DataWorks API 授权是两件事，配置依据见 [AssumeRole 官方文档](https://help.aliyun.com/zh/ram/developer-reference/api-sts-2015-04-01-assumerole)。SourceIdentity 在 STS 签发时绑定，用于传递主体和审计，不会自动授予产品或数据库权限；详细条件见 [SourceIdentity 官方说明](https://help.aliyun.com/zh/ram/user-guide/session-tagging-and-fine-grained-access-control-for-assumed-roles-using-sourceidentity)。

管理员先按[自定义 Agent 示例](AGENT-MANAGEMENT.md)创建、发布 Agent；会话服务只需配置它的名称。管理账号与会话角色可以不同，服务不会在权限失败后切到管理员重试。

## 在自己的应用中复用

三语言后端均支持注入同一次 STS 响应中的三项值：

```text
Credentials.AccessKeyId     → ALIBABA_CLOUD_ACCESS_KEY_ID
Credentials.AccessKeySecret → ALIBABA_CLOUD_ACCESS_KEY_SECRET
Credentials.SecurityToken  → ALIBABA_CLOUD_SECURITY_TOKEN
```

SDK 客户端的关键字段如下；仓库已实现，通常无需修改：

```typescript
// Node.js: server-node/src/sdk.ts
new $OpenApiUtil.Config({
  accessKeyId: cfg.accessKeyId,
  accessKeySecret: cfg.accessKeySecret,
  securityToken: cfg.securityToken,
  // 其余地域、endpoint、超时等配置沿用项目实现
});
```

```python
# Python: server-python/src/das_python/live.py
Config(access_key_id=cfg.accessKeyId,
       access_key_secret=cfg.accessKeySecret,
       security_token=cfg.securityToken)
```

```java
// Java: LiveClient.java 与 PopAdapter.java 均使用同一凭证
Credential.builder()
    .accessKeyId(cfg.accessKeyId())
    .accessKeySecret(cfg.accessKeySecret())
    .securityToken(cfg.securityToken())
    .build();
```

REST、Prompt/Load 流和 Events 都必须使用同组凭证。更新环境变量不会改变已构造的客户端。接入自动续期时：

1. 按 `Expiration` 提前刷新，缓存完整凭证快照并合并并发刷新；按角色和可信 SourceIdentity 隔离。
2. 原子切换新请求使用的客户端；保留在途 SSE 的旧客户端，等流释放后再关闭。
3. 刷新失败明确报错，过期后不继续发起请求，不回退管理员，也不因刷新或断流自动重发 Prompt。

这是固定身份的单用户 Demo。多用户应用须从已验证的登录态推导 SourceIdentity，并在自己的服务端校验会话归属；不能把浏览器提交的 UID、角色 ARN 或 sessionId 直接当成授权依据。凭证不放入 `VITE_*`、localStorage、URL 或 Git。
