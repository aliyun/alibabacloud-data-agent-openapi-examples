# 目录与验证

使用方法见[主 README](../README.md)。这里面向需要修改或验证示例的维护者。

| 目录 | 内容 |
| --- | --- |
| `server-node/` | Fastify 与阿里云 Node SDK；另含现有 `/d` 兼容层 |
| `server-python/` | FastAPI 与阿里云 Python SDK |
| `server-java/` | Spring Boot；普通请求使用 Java SDK，流式请求使用签名 HTTP |
| `web/` | 唯一的 web-shell 前端，通过 `/d` 连接所选后端 |
| `shared/` | TypeScript 类型、帧解析、聚合和错误分类 |
| `scripts/` | 启动与跨语言验收 |

三种后端读取根 `.env` 或 `DAS_ENV` 选中的文件。Python、Java 自己实现帧解析与错误分类，不依赖 Node 进程。当前 MOCK 数据共同读取 `server-node/test/fixtures/`；目录改名后必须同步检查三种语言的定位逻辑。

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

三个契约测试使用同一组 `/api` HTTP/NDJSON 断言，默认使用 `3999` 端口，逐个运行；可用 `CONTRACT_TEST_PORT` 改端口。它们运行 MOCK，不消耗云端额度。当前 Node.js、Java 均实现 `/d` 并有测试，Python 的 web-shell 适配仍在开发范围中；`/api` 全绿不代表网页兼容。完整发布前，还需要分别连接三种后端检查创建会话、发送消息、历史和停止操作。

`npm run build` 检查 TypeScript 并构建网页，不构建 Python 或 Java。各语言的独立运行要求见对应目录的 README。
