# 使用 Java 后端

Java 已实现 web-shell 会话接口，可独立运行完整网页交互，不需要同时启动 Node.js 后端。

需要 JDK 17+、Maven 3.6.3+，网页仍需要 Node.js 20.19+（或 22.12+）与 npm 10+。所有命令在项目根目录执行。

确认环境并启动：

```bash
java -version
mvn -version
npm ci
MOCK=1 npm start -- java
```

首次启动自动下载 Maven 依赖并打包；以后源码或 `pom.xml` 更新时会重新打包。打开终端显示的网页地址。真实使用时，按[主 README](../README.md)填写 `.env`，去掉 `MOCK=1` 后启动。

macOS 安装了 JDK 17 时，脚本优先选用它；其他环境请保证 `JAVA_HOME`、`java` 和 Maven 使用兼容的 JDK。

## 只启动后端

```bash
bash scripts/dev-server.sh java
```

默认监听 `http://127.0.0.1:3000`。需要手动构建时：

```bash
mvn -f server-java/pom.xml package
```

若依赖下载失败，检查 Maven 网络或镜像配置后重试。启动脚本为了缩短等待跳过单元测试；上面的手动构建命令会运行测试。
