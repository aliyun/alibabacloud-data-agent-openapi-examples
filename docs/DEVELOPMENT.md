# 目录与验证

使用方法见[主 README](../README.md)。这里面向需要修改或验证示例的维护者。

| 目录 | 内容 |
| --- | --- |
| `server-node/` | Fastify 与阿里云 Node SDK；另含现有 `/d` 兼容层 |
| `server-python/` | FastAPI 与阿里云 Python SDK |
| `server-java/` | Spring Boot 与阿里云 Java 异步 SDK（包含 SSE） |
| `web/` | 唯一的 web-shell 前端，通过 `/d` 连接所选后端 |
| `shared/` | TypeScript 类型、帧解析、聚合和错误分类 |
| `scripts/` | 启动与跨语言验收 |

三种后端读取根 `.env` 或 `DAS_ENV` 选中的文件。Python、Java 自己实现帧解析与错误分类，不依赖 Node 进程。当前 MOCK 数据共同读取 `server-node/test/fixtures/`；目录改名后必须同步检查三种语言的定位逻辑。

## Node.js 版本

支持 Node.js 22.x（至少 22.12）和 24.x，推荐使用 22.x。根目录 `.nvmrc` 选择 22，已安装 nvm 时执行 `nvm install && nvm use`；使用 fnm 时执行 `fnm install 22 && fnm use 22`。随后运行 `npm ci`，安装 Vitest 5 和对应依赖。Node 20 不再受支持；启动前检查也会拒绝旧版本。公共 CI 在 Node 22、24 上分别验证。

## 验证命令

```bash
npm run typecheck
npm test
npm run build
server-python/.venv/bin/python -m pip install -e './server-python[test]'
server-python/.venv/bin/python -m pytest server-python/tests
mvn -f server-java/pom.xml test
bash scripts/contract-test.sh node
bash scripts/contract-test.sh python
bash scripts/contract-test.sh java
```

三个契约测试使用同一组 `/api` HTTP/NDJSON 断言，默认使用 `3999` 端口，逐个运行；可用 `CONTRACT_TEST_PORT` 改端口。它们运行 MOCK，不消耗云端额度。三种后端均实现 `/d` 并有对应测试；`/api` 全绿不代表网页兼容。完整发布前，还需要分别连接三种后端检查创建会话、发送消息、历史和停止操作。

`npm run build` 检查 TypeScript 并构建网页，不构建 Python 或 Java。各语言的独立运行要求见对应目录的 README。

## OpenAPI SDK 版本

2026-09-22 核对官方包仓库后固定以下版本（各语言独立发布，版本号不要求相同）：

| 后端 | SDK | 版本 | 官方来源 |
| --- | --- | --- | --- |
| Java | `com.aliyun:alibabacloud-dataworks_public20240518`（异步） | `9.0.10` | [Maven Central](https://repo.maven.apache.org/maven2/com/aliyun/alibabacloud-dataworks_public20240518/maven-metadata.xml) |
| Node.js | `@alicloud/dataworks-public20240518` | `9.9.1` | [npm](https://www.npmjs.com/package/@alicloud/dataworks-public20240518) |
| Python | `alibabacloud-dataworks-public20240518` | `9.9.1` | [PyPI](https://pypi.org/project/alibabacloud-dataworks-public20240518/9.9.1/) |

Node.js 已移除本地 `9.9.0` vendor 包，通过 `package-lock.json` 固定官方 npm 包和完整性校验值。升级代码后运行 `npm ci`；Python 重新执行 `server-python/.venv/bin/python -m pip install -e ./server-python`；Java 重新运行 `mvn -f server-java/pom.xml verify` 打包。
