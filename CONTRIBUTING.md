# Contributing / 贡献指南

Use Node.js 20.19+ (or 22.12+) and npm 10+. See [development](docs/DEVELOPMENT.md) for Python and Java requirements and all validation commands.

1. Run `npm ci`, `npm run build`, and `npm test`.
2. For backend changes, run the corresponding language tests and `bash scripts/contract-test.sh node|python|java`.
3. Use only synthetic fixtures in `server-node/test/fixtures/`. Never submit cloud credentials, real API recordings, business data, private endpoints, or personal information.
4. Update [中文说明](README.md) and [English guide](README.en.md) when user-facing behavior changes. Keep each language's setup instructions accurate.
5. Keep pull requests focused and describe the behavior and validation performed. Do not add a LIVE verification claim unless it was actually checked with an authorized account.

The public CI uses MOCK data without cloud credentials. Report security concerns according to [SECURITY.md](SECURITY.md).
