# 让同事通过内网访问本机服务

本机启动一套前端和后端后，同一内网或可互通的公司 VPN 内的同事可以通过浏览器访问，无需在他们的电脑上安装 Node.js、Java 或 Python。

## 一键启动

先按照主 README 安装依赖并配置 `.env`。选择一个后端，加上 `--lan`：

```bash
npm start -- java --lan
# 或 npm start -- python --lan
# 或 npm start -- node --lan
```

先体验免凭证回放可使用 `npm start -- java --mock --lan`。

指定配置文件的方式不变，例如使用 `.env.demo`：

```bash
# macOS / Linux / Git Bash
DAS_ENV=demo npm start -- java --lan
```

```powershell
# Windows PowerShell
$env:DAS_ENV="demo"
npm start -- java --lan
```

```bat
:: Windows cmd
set DAS_ENV=demo&& npm start -- java --lan
```

终端会输出本机网卡地址，例如 `同事访问：http://192.168.1.20:5173`。把可与同事网络互通的地址发给同事。多网卡或 VPN 环境可能显示多个地址，需要选择公司网络可达的那个。不要把 `127.0.0.1`、`localhost` 或监听地址 `0.0.0.0` 发给同事。

保持终端运行；按 `Ctrl+C` 同时停止前后端。不加 `--lan` 时仍默认仅供本机访问。端口已占用时先停止原服务，或修改 `.env` 中的 `PORT`（后端）与 `WEB_PORT`（网页）后重启。

## 访问范围与数据

`--lan` 让网页监听所有 IPv4 网卡，包括 VPN 网卡；用系统防火墙限制为需要访问的可信网络。所有访问者共用当前配置的云账号权限和会话列表，当前示例没有登录、用户隔离或每人独立凭证。不要将此开发服务映射到公网。需要长期、多用户部署时，应另行配置 HTTPS、身份认证和访问控制。

浏览器只访问网页端口（默认 5173）。网页会将 `/api` 和 `/d` 请求转发到本机后端，后端仍固定监听 `127.0.0.1`。不需要开放 3000 端口，也不需要手工设置 `SERVER_HOST=0.0.0.0`、`VITE_API_BASE` 或宽泛的 CORS 白名单。内网模式会覆盖这些前端/监听配置以保持同源访问。

聊天、流式回复和 `/session/{sessionId}` 刷新/分享支持普通内网 HTTP。浏览器的部分高级能力（如语音、某些剪贴板操作）可能仍需要 HTTPS。

## 排查连接问题

1. 本机访问终端给出的 `http://内网IP:5173`，确认页面可打开，再由同事访问。
2. 本机可访问、同事超时：检查系统防火墙是否允许网页端口，以及 Wi-Fi、VPN、访客网络之间是否隔离。电脑休眠、断网或关闭终端也会导致无法访问。Windows WSL2 还需要宿主机到 WSL 的网络转发或适当的网络模式；仅加 `--lan` 不保证 WSL 能被其他电脑访问。
3. 页面能开、会话连接失败：访问 `http://内网IP:5173/api/health`，应返回 `ok: true`；检查启动终端的后端日志。若浏览器仍请求 `127.0.0.1:3000`，说明前端没有以新的 `--lan` 模式启动，停止旧进程后重新运行命令。
4. 新建会话失败但健康检查正常：继续按主 README 检查云账号、地域、实例和资源组。健康检查通过只代表本地进程正常。

## 实现说明

一键脚本对三个后端使用相同的内网模式。Vite 只代理 `/api` 与 `/d`，保留事件续传头和流式响应，并关闭代理层额外超时。代理先验证浏览器的请求来源，再将 Host/Origin 改为本机后端地址，使 Java 的同源检查与各后端 Host 检查保持有效。`/session/{sessionId}` 留给前端路由处理。

普通内网 HTTP 下，浏览器客户端 ID 使用 `crypto.getRandomValues()` 生成，兼容缺少 `crypto.randomUUID()` 的环境；会话 ID 仍使用 OpenAPI 返回的真实值。

参考：[Vite 监听与代理配置](https://vite.dev/config/server-options)、[randomUUID 的安全上下文要求](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID)、[getRandomValues](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues)。
