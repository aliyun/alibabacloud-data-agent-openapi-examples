# 安全策略

## 报告漏洞

本工程是一个**持有云凭证的本地代理**的安全示例，安全问题请优先通过 GitHub 的
**Private vulnerability reporting**（仓库 Security 页签 → Report a vulnerability）私下报告，
**不要**在公开 issue 里描述可被利用的细节。

如果仓库尚未开启私密漏洞报告，请通过阿里云安全应急响应中心联系维护方，不要在公开 issue 中粘贴密钥或业务数据。

## 范围

- 本仓库代码本身（凭证处理、CORS/Host 白名单、流式转发的信任边界等）；
- 文档中给出的安全建议（如"建 RAM 用户、别用主账号 AK/SK"）若有误导性。

## 不在范围

- DataWorks / DataAgent 上游服务自身的漏洞——请通过[阿里云安全应急响应中心](https://security.alibaba.com/)报告；
- 你自己部署实例的配置问题。

## 设计上的安全边界（速览）

- 后端是唯一持有 AK/SK 的进程，前端永不接触凭证；
- 默认只监听 `127.0.0.1` 并开启 Host 白名单（防 DNS rebinding）；
- 日志任何级别都不打印凭证（配置里只有 present / missing 两种取值）；
- 回覆人卡交互的端点用 POST（GET 属 CORS 简单请求，可被任意网页跨源触发）。

`--lan` 会让前端监听所有网卡，通过同源代理访问回环后端。应用没有独立用户认证；访问者共享主机账号权限与会话，仅在可信网络使用，不直接暴露公网。

详见 [内网访问指南](docs/LAN_ACCESS.md)、[开发说明](docs/DEVELOPMENT.md) 及 `server-node/src/config.ts`。
