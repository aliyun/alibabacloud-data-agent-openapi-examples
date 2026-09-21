# 导出报告（dry-run）

- source_ref: `034c854f35f505978c4946d3762a205fb493a910`
- 导出时间: 2026-09-21T03:18:00.862Z
- 复制文件数: 160
- D3 脱敏: 无需替换
- D2 lockfile: 已用 registry.npmjs.org 重生成
- 门禁结论: **BLOCKED**

## BLOCKER（发布前必须补齐）
- Node SDK 仍为 vendor 包，需确认可公开分发或替换为已验证的公开依赖
- 内部录制数据尚需替换为公开合成样例，并重新验证三种后端

## 扫描 FAIL（0）
- 无

## 扫描 WARN（140）——D1 fixture 业务语义清单
- server-node/test/fixtures/error-stream-break.jsonl（26 处）
- server-node/test/fixtures/load-clean.jsonl（50 处）
- server-node/test/fixtures/load-polluted.jsonl（43 处）
- server-node/test/fixtures/prompt-long.jsonl（17 处）
- server-node/test/fixtures/rest-list-sessions.json（4 处）