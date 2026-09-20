#!/bin/bash
# 契约测试：对任一 server 实现跑同一组 HTTP/NDJSON 断言。
#
# 用法：contract-test.sh <node|python|java>
#
# 三个实现共用 scripts/contract_assert.py 的同一组断言——
# "三个 server 的契约一致"由这份脚本保证，而不是由三份各写各的测试保证。
set -u

IMPL="${1:-}"
if [[ -z "${IMPL}" ]]; then
  echo "用法: contract-test.sh <node|python|java>"
  exit 2
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${CONTRACT_TEST_PORT:-3999}"
BASE="http://127.0.0.1:${PORT}"
SERVER_PID=""

cleanup() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null
    wait "${SERVER_PID}" 2>/dev/null
  fi
}
trap cleanup EXIT

wait_healthy() {
  local base="$1" tries=60
  for _ in $(seq 1 "$tries"); do
    if curl -sf -m 2 "$base/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

echo "== 契约测试：${IMPL} 实现（MOCK 模式，端口 ${PORT}）=="

# 剥离本机 shell 导出的 demo 环境变量（2026-09-18 实测：login shell 会导出整套
# demo env，污染 region/sessionSource/凭证判断，让契约断言不可复现）。
unset ALIBABA_CLOUD_ACCESS_KEY_ID ALIBABA_CLOUD_ACCESS_KEY_SECRET DATAAGENT_REGION_ID \
      SESSION_SOURCE RESOURCE_GROUP_ID DATAAGENT_AGENT_NAME END_POINT DAS_ENV MOCK_REALTIME MOCK_SPEED

case "${IMPL}" in
  node)
    # 直接跑 tsx（非 watch 模式）：npm run dev:server 是 watch 态且派生子进程，
    # cleanup 杀 npm 进程杀不掉 tsx 子进程，端口会残留。
    (cd "$ROOT/server-node" && MOCK=1 PORT="${PORT}" "$ROOT/node_modules/.bin/tsx" src/index.ts >/tmp/contract-node.log 2>&1) &
    SERVER_PID=$!
    ;;
  python)
    # 优先用仓库内 venv；没有就退回系统 python（要求已 pip install -e）
    PY="$ROOT/server-python/.venv/bin/python"
    if [[ ! -x "$PY" ]]; then PY=python3; fi
    (cd "$ROOT/server-python" && MOCK=1 PORT="${PORT}" "$PY" -m das_python.main >/tmp/contract-python.log 2>&1) &
    SERVER_PID=$!
    ;;
  java)
    # JDK 17 优先（本机多有 Java 25 默认；Spring Boot 3.3 + release 17 以 17 构建/运行最稳）。
    if [[ -x /usr/libexec/java_home ]] && /usr/libexec/java_home -v 17 >/dev/null 2>&1; then
      export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
    fi
    JAR="$ROOT/server-java/target/das-server-java-0.1.0.jar"
    # 源码比 jar 新就重打；mvn 增量编译，重打成本秒级
    if [[ ! -f "${JAR}" || -n "$(find "$ROOT/server-java/src" -name '*.java' -newer "${JAR}" 2>/dev/null | head -1)" ]]; then
      echo "构建 server-java（mvn -DskipTests package）…"
      # 不加 -o：首次需要联网取打包插件；之后全部走本地 .m2 缓存，秒级。
      if ! (cd "$ROOT/server-java" && mvn -q -DskipTests package) >/tmp/contract-java-build.log 2>&1; then
        echo "✗ server-java 构建失败，日志："
        tail -30 /tmp/contract-java-build.log
        exit 1
      fi
    fi
    (cd "$ROOT/server-java" && MOCK=1 PORT="${PORT}" java -jar "${JAR}" >/tmp/contract-java.log 2>&1) &
    SERVER_PID=$!
    ;;
  *)
    echo "未知实现: ${IMPL}（可选 node|python|java）"
    exit 2
    ;;
esac

if ! wait_healthy "${BASE}"; then
  echo "✗ 服务在 30s 内没有就绪（端口 ${PORT}），日志："
  tail -20 "/tmp/contract-${IMPL}.log" 2>/dev/null
  exit 1
fi

PYTHON="${PYTHON:-python3}"
"${PYTHON}" "$ROOT/scripts/contract_assert.py" "${BASE}"
RESULT=$?

exit ${RESULT}
