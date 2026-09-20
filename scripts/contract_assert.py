#!/usr/bin/env python3
"""契约断言：对任一 server 实现跑同一组 HTTP/NDJSON 断言。

用法：contract_assert.py <base-url>
全部通过 exit 0；任一失败打印差异并 exit 1。

这份脚本与 server-python/tests/test_contract.py 的断言同源：
三个 server 实现（node/java/python）的"契约一致"由同一组断言保证。
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:3000"
failures: list[str] = []
checks = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(f"{name}{': ' + detail if detail else ''}")
        print(f"  ✗ {name}{': ' + detail if detail else ''}")
    else:
        print(f"  ✓ {name}")


def request(method: str, path: str, body: dict | None = None, timeout: float = 30.0) -> tuple[int, dict | bytes, dict]:
    req = urllib.request.Request(f"{BASE}{path}", method=method)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
            headers = dict(resp.headers)
    except urllib.error.HTTPError as e:
        raw = e.read()
        status = e.code
        headers = dict(e.headers)
    try:
        return status, json.loads(raw), headers
    except (json.JSONDecodeError, ValueError):
        return status, raw, headers


def stream(method: str, path: str, body: dict, timeout: float = 30.0) -> tuple[int, list[dict], dict]:
    """读 NDJSON 流，返回 (status, 事件列表, headers)。"""
    req = urllib.request.Request(f"{BASE}{path}", method=method)
    req.add_header("Content-Type", "application/json")
    data = json.dumps(body).encode()
    events: list[dict] = []
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as resp:
            status = resp.status
            headers = dict(resp.headers)
            for raw_line in resp:
                line = raw_line.decode().strip()
                if line:
                    events.append(json.loads(line))
    except urllib.error.HTTPError as e:
        return e.code, [], dict(e.headers)
    return status, events, headers


print(f"== 契约断言：{BASE} ==")

# 1. health 结构
status, body, _ = request("GET", "/api/health")
check("health: HTTP 200", status == 200, f"got {status}")
result = body.get("result", {}) if isinstance(body, dict) else {}
check(
    "health: 字段结构与 Node 契约一致",
    isinstance(body, dict)
    and body.get("ok") is True
    and set(result.keys()) >= {"mock", "region", "agent", "sessionSource", "resourceGroupIdConfigured", "credentials"},
    f"keys={sorted(result.keys())}",
)

# 2. 会话列表 + 来源过滤
status, body, _ = request("GET", "/api/sessions")
check("sessions: HTTP 200", status == 200)
sessions = body.get("result", {}).get("sessions", []) if isinstance(body, dict) else []
ids = [s.get("sessionId") for s in sessions]
check("sessions: mock-short 在列", "mock-short" in ids)
check("sessions: 别的来源被过滤", "mock-other-source-1" not in ids)
short = next((s for s in sessions if s.get("sessionId") == "mock-short"), {})
check("sessions: status 恒 RELEASED", short.get("status") == "RELEASED")
check("sessions: updatedAt === createdAt", short.get("updatedAt") == short.get("createdAt"))

# 3. 建会话 + mode 校验
status, body, _ = request("POST", "/api/sessions", {"title": "契约验证", "mode": "default"})
check("create: HTTP 200", status == 200)
created_id = (body.get("result") or {}).get("sessionId", "") if isinstance(body, dict) else ""
check("create: SessionId 非空", bool(created_id), f"got {created_id!r}")
status, body, _ = request("POST", "/api/sessions", {"mode": "bogus"})
check("create: 非法 mode 业务拒绝（HTTP 200）", status == 200 and isinstance(body, dict) and body.get("ok") is False)

# 4. prompt 流（短轮）：meta → frame… → done
status, events, headers = stream("POST", f"/api/sessions/{created_id}/prompt", {"text": "回复且只回复：你好"})
check("prompt: HTTP 200", status == 200)
check("prompt: content-type x-ndjson", "x-ndjson" in headers.get("Content-Type", "") or "x-ndjson" in headers.get("content-type", ""))
check("prompt: 非 SSE", "text/event-stream" not in headers.get("Content-Type", "") + headers.get("content-type", ""))
check("prompt: 首帧 meta", bool(events) and events[0].get("type") == "meta")
check("prompt: meta 不含 marker（归属校验已退役）", not (events and "marker" in events[0]))
types = [e.get("type") for e in events]
check("prompt: 有 frame 帧", "frame" in types)
check("prompt: 以 done 或 error 收尾", types[-1] in ("done", "error"))
frames = [e for e in events if e.get("type") == "frame"]
check("prompt: 帧原样透传（body 带 Jsonrpc 键）", all("Jsonrpc" in e.get("body", {}) for e in frames))

# 5. 空文本拒绝
status, body, _ = request("POST", f"/api/sessions/{created_id}/prompt", {"text": "   "})
check("prompt: 空文本业务拒绝（HTTP 200）", status == 200 and isinstance(body, dict) and body.get("ok") is False)

# 6. reply 校验链
status, body, _ = request("POST", f"/api/sessions/mock-short/reply", {"answers": {"0": "A"}})
check("reply: 缺 permissionRequestId 被拒", isinstance(body, dict) and body.get("ok") is False and "permissionRequestId" in body.get("error", {}).get("message", ""))
status, body, _ = request("POST", f"/api/sessions/mock-short/reply", {"permissionRequestId": "req-x", "outcome": "selected"})
check("reply: selected 缺 optionId/answers 被拒", isinstance(body, dict) and body.get("ok") is False and "optionId" in body.get("error", {}).get("message", ""))

# 7. cancel 语义
status, body, _ = request("POST", "/api/sessions/mock-short/cancel")
check("cancel: HTTP 200", status == 200)
result = body.get("result", {}) if isinstance(body, dict) else {}
check("cancel: MOCK 下 delivered=false", result.get("delivered") is False)

# 8. usage / artifacts 校验
status, body, _ = request("GET", "/api/sessions/does-not-exist/usage")
check("usage: 未知会话业务拒绝", isinstance(body, dict) and body.get("ok") is False)
status, body, _ = request("GET", "/api/sessions/mock-short/artifacts")
result = body.get("result", {}) if isinstance(body, dict) else {}
check("artifacts: 恒返回空数组", result.get("artifacts") == [])

# 9. history 归约
status, body, _ = request("GET", "/api/sessions/mock-short/history")
result = body.get("result", {}) if isinstance(body, dict) else {}
check("history: 有轮次", len(result.get("turns", [])) >= 1)
check("history: 轮次判据 user_message_chunk", any(t.get("userText") for t in result.get("turns", [])))

# 10. probe 校验
status, body, _ = request("GET", "/api/sessions/mock-break/probe")
check("probe: 缺 rid 被拒", isinstance(body, dict) and body.get("ok") is False and "rid" in body.get("error", {}).get("message", ""))

# 11. 断流场景：error(stream_break) 收尾，不是 done
status, events, _ = stream("POST", "/api/sessions/mock-break/prompt", {"text": "hi"})
error_events = [e for e in events if e.get("type") == "error"]
check("break: 有 error 事件", len(error_events) > 0)
check("break: kind=stream_break", error_events and error_events[0].get("error", {}).get("kind") == "stream_break")
check("break: 不是 done 收尾", events[-1].get("type") == "error")

# 12. 零帧场景：error(prompt_not_dispatched) + POP 回执号进 message
status, events, _ = stream("POST", "/api/sessions/mock-ack-only/prompt", {"text": "hi"})
error_events = [e for e in events if e.get("type") == "error"]
check("ack: 有 error 事件", len(error_events) > 0)
check("ack: kind=prompt_not_dispatched", error_events and error_events[0].get("error", {}).get("kind") == "prompt_not_dispatched")
check("ack: POP 回执号进 message", error_events and "0dd3b146c75bf132a65efa7a3080e7cd" in error_events[0].get("error", {}).get("message", ""))

print()
if failures:
    print(f"结果：{checks - len(failures)}/{checks} 通过，{len(failures)} 失败")
    for f in failures:
        print(f"  ✗ {f}")
    sys.exit(1)
print(f"结果：{checks}/{checks} 全部通过")
