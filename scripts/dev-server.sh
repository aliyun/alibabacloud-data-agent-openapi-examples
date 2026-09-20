#!/bin/bash
# 三个 server 实现的统一启动入口（同一前端、同一 HTTP/NDJSON 契约，可随意切换）。
#
# 用法：
#   ./scripts/dev-server.sh <node|python|java> [环境变量先行照常生效]
#
#   MOCK=1 ./scripts/dev-server.sh java                     # MOCK 回放（免凭证预览）
#   DAS_ENV=beijing-pre ./scripts/dev-server.sh python      # 选上游环境（.env.beijing-pre）
#
# 三个实现都读仓库根同一份 .env（DAS_ENV 规则一致），都从 PORT（默认 3000）起服务。
# 同时启动前端请用 npm start -- <node|python|java>。
set -euo pipefail

IMPL="${1:-}"
if [[ -z "${IMPL}" ]]; then
  echo "用法: dev-server.sh <node|python|java>"
  echo "  MOCK=1 dev-server.sh java        # MOCK 回放（免凭证预览）"
  echo "  DAS_ENV=xxx dev-server.sh node   # 选上游环境（.env.xxx）"
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "${IMPL}" in
  node)
    # 直跑 tsx（非 watch）：与 dev:server 的 watch 态不同，起停干净，适合与另两个 server 对齐用法。
    cd "$ROOT/server-node"
    exec "$ROOT/node_modules/.bin/tsx" src/index.ts
    ;;
  python)
    PY="$ROOT/server-python/.venv/bin/python"
    if [[ ! -x "${PY}" ]]; then
      PY=python3
    fi
    cd "$ROOT/server-python"
    if ! "${PY}" -c 'import das_python, fastapi' >/dev/null 2>&1; then
      echo '请先按 server-python/README.md 安装 Python 依赖。' >&2
      exit 1
    fi
    exec "${PY}" -m das_python.main
    ;;
  java)
    # JDK 17 优先（本机多有 Java 25 默认；Spring Boot 3.3 + release 17 以 17 构建/运行最稳）。
    if [[ -x /usr/libexec/java_home ]] && /usr/libexec/java_home -v 17 >/dev/null 2>&1; then
      export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
    fi
    JAR="$ROOT/server-java/target/das-server-java-0.1.0.jar"
    # 源码比 jar 新就重打；mvn 增量编译，重打成本秒级
    if [[ ! -f "${JAR}" || "$ROOT/server-java/pom.xml" -nt "${JAR}" || -n "$(find "$ROOT/server-java/src" -type f -newer "${JAR}" 2>/dev/null | head -1)" ]]; then
      echo "构建 server-java（mvn -DskipTests package）…" >&2
      (cd "$ROOT/server-java" && mvn -q -DskipTests package)
    fi
    cd "$ROOT/server-java"
    exec java -jar "${JAR}"
    ;;
  *)
    echo "未知实现: ${IMPL}（可选 node|python|java）" >&2
    exit 2
    ;;
esac
