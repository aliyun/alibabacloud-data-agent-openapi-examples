# 使用 Node.js 后端

需要 Node.js 22.x（至少 22.12）或 24.x（推荐 22.x）、npm 10+。所有命令在项目根目录执行。

```bash
npm ci
MOCK=1 npm start -- node
```

打开终端显示的网页地址。真实使用时，按[主 README](../README.md)填写 `.env`，去掉 `MOCK=1` 后启动。

## 只启动后端

```bash
bash scripts/dev-server.sh node
```

默认监听 `http://127.0.0.1:3000`。如果需要单独启动网页，在另一个终端执行 `npm run dev:web`；网页通过 `VITE_API_BASE` 指定后端地址。推荐使用一键入口自动匹配端口。

## 连接检查

```bash
npm run check -- --mock
npm run check
```

第一条只检查示例环境。第二条会调用云端并创建一个检查会话，使用 `.env` 中的账号；检查成功不代表所有权限、额度或长任务都已验证。

遇到 `tsx` 或依赖找不到时，在根目录重新执行 `npm ci`。改名后的目录是 `server-node`，旧的 `--workspace server` 命令请改为 `--workspace server-node`。
