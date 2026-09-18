# 贡献指南

感谢关注本仓库！这是一个把 **DataWorks DataAgent OpenAPI 实测行为固化成代码与测试** 的示例工程，
贡献时请遵循同样的原则：**每一条行为声明都要能指到代码或测试**。

## 开发环境

- Node ≥ 20.19（见 `package.json` 的 `engines`）
- 依赖安装：`npm ci --ignore-scripts`
- 一键验证：`npm run typecheck && npm test`

## 提交前自查

1. `npm run typecheck` 与 `npm test` 全绿；
2. 涉及接口行为的改动，同步更新 `README.md` 的约束清单（`docs/CONSTRAINTS.md`）与对应测试；
3. **不要提交任何真实凭证或真实接口抓包数据**——`.env` 已在 `.gitignore`，测试/fixtures 一律使用
   `server/test/fixtures/` 中的合成样例（编造的示例电商业务）；
4. 提交信息用中文一句话说清"为什么"，与现有风格保持一致。

## Pull Request

- 一个 PR 聚焦一件事；
- 新增行为约束时，在 `docs/CONSTRAINTS.md` 表格追加一行（含 `[LIVE MM-DD]` 实测标记与代码归属）；
- README 主文档只在影响快速上手路径时改动，长内容进 `docs/`。
