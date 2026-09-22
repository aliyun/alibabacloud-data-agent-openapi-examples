# 使用 Python 后端

> 当前基础 API 可用，web-shell 的会话适配仍待完成。下面的一键命令会启动两个进程，但暂不能用于完整网页对话；体验网页请先选 Node.js。

需要 Python 3.11+，网页仍需要 Node.js 22.x（至少 22.12）或 24.x（推荐 22.x）与 npm 10+。所有命令在项目根目录执行。

首次安装：

```bash
npm ci
python3 -m venv server-python/.venv
server-python/.venv/bin/python -m pip install -e ./server-python
```

启动网页与后端：

```bash
MOCK=1 npm start -- python
```

打开终端显示的网页地址。真实使用时，按[主 README](../README.md)填写 `.env`，去掉 `MOCK=1` 后启动。

启动脚本优先使用 `server-python/.venv/bin/python`，不需要激活虚拟环境。没有这个环境时使用 `python3`，此时必须确保依赖已安装到该解释器。

## 只启动后端

```bash
bash scripts/dev-server.sh python
```

默认监听 `http://127.0.0.1:3000`。前端单独运行方式与端口设置见[主 README](../README.md)。

出现 `No module named das_python` 或 `fastapi` 时，重新执行上面的虚拟环境安装步骤。复制或移动仓库后建议重新创建虚拟环境，因为其中的路径可能指向旧目录。
