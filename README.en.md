# DataAgent OpenAPI Examples

<a id="top"></a>
[![CI](https://github.com/aliyun/alibabacloud-data-agent-openapi-examples/actions/workflows/ci.yml/badge.svg)](https://github.com/aliyun/alibabacloud-data-agent-openapi-examples/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.19-brightgreen)](package.json)
[![Tests](https://img.shields.io/badge/tests-389%20passing-brightgreen)](docs/CONSTRAINTS.md)

**This is not a "runs-once" API sample.** It turns the *battle-tested* behaviors of the
**DataWorks DataAgent OpenAPI** into code and tests: business errors always come back as
HTTP 200, `ListAgents` never lists the agent you need, a ~220s stream-break wall, answers
crossing over between concurrent streams, the human-in-the-loop reply channel —
**every claim points at code and tests**, and errors are surfaced honestly instead of a
vague "task failed, please retry".

Integrating straight from the official docs? These are the places you will get bitten:
business errors always return HTTP 200, `SessionStatus` is always `RELEASED`, the artifact
APIs always return empty, streams break around 220 seconds and **cannot be resent**, and
history pulls may block during a running turn.

Covers 9 OpenAPIs: `ListAgents`, `CreateAgentSession`, `ListAgentSessions`,
`PromptAgentSession` (SSE), `LoadAgentSession` (SSE), `GetAgentSessionTokenUsage`,
`ListAgentSessionArtifacts`, `CancelAgentSession`, and `ReplyAgentSession` (the
human-in-the-loop reply channel — see [§6.1](#61-human-in-the-loop-reply-replyagentsession-9th-api)).

> 📖 中文文档：[README.md](README.md)。The deep-dive docs under `docs/` are currently
> Chinese-only; the main flow is fully documented below.

## Quick start

The only prerequisite is **Node ≥ 20.19** (pinned in `package.json` `engines`; npm ≥ 10
comes with Node). Three ways to install:

- [`fnm`](https://github.com/Schniz/fnm): `fnm install 22 && fnm use 22`
- [`nvm`](https://github.com/nvm-sh/nvm): `nvm install 22 && nvm use 22`
- Official installer: <https://nodejs.org/>

```bash
node -v             # expect v20.19+
npm install
```

Against the real upstream (the main path):

1. Create a RAM user for the AccessKey — **never use the primary account** (step-by-step in §3)
2. `cp .env.example .env`, fill in AK/SK; set `DATAAGENT_REGION_ID` if your DataWorks
   instance is not in `cn-hangzhou`
3. `npm run dev`, open <http://localhost:5173> (backend on 3000)

Before sending prompts, run `npm run check` (§6) — go to the UI only after all three steps pass.

No cloud resources yet? `MOCK=1 npm run dev` boots the full stack with zero config (§ MOCK mode).

> **Verification boundary in one line**: the parsing layer and error classification are
> covered by unit tests (`npm test`: 33 files / 389 tests, §5); the full MOCK flow can be
> accepted in the browser (§ MOCK mode); the real chain has been verified end-to-end once
> (`[LIVE 09-16]`). Deeper caveats live in [docs/FAQ.md](docs/FAQ.md) (Chinese).

---

## 1. Prerequisites

- **Node ≥ 20.19** (pinned via `engines`). npm ≥ 10 ships with it.
- An Alibaba Cloud account with DataWorks enabled and **a running instance**
  (no instance yet? preview with MOCK mode first).

Check:

```bash
node -v   # expect v20.19+
npm -v
```

---

## 2. npm registry

This project depends on `@alicloud/*` and `@darabonba/*` packages — all on the public registry.

```bash
npm config get registry          # check where you currently point
```

- Switch to the official registry: `npm config set registry https://registry.npmjs.org/`
- One-off install without touching global config:

```bash
npm install --registry=https://registry.npmjs.org/
```

---

## 3. Credentials: create a RAM user, never use the primary account

1. RAM console → Identities → Users → **Create User** → check "OpenAPI Access"
2. Attach DataWorks-related permission policies to that user
3. Create an AccessKey, note the ID and Secret (the Secret is shown only once)
4. Make sure DataWorks is **activated with a running instance** under the account
5. **If the account has zero running instances, you need a Serverless resource group ID**:
   DataWorks → Resource Groups → Serverless Resource Group → copy the ID

This project reads these two values **only from environment variables**: it does not read
`~/.aliyun/config.json`, does not call the `aliyun` CLI, and has no fallback path.
(Reason: local aliyun CLI profiles are usually OAuth-mode, which the SDK credential chain
cannot pick up — a "looks-usable but isn't" fallback is harder to debug than failing fast.)

Logs and `/api/health` only ever show `credentials: present | missing` — **never a prefix
or masked form**.

---

## 4. Configure `.env`

```bash
cp .env.example .env
```

`.env` is git-ignored. Field-by-field notes live in `.env.example` comments; the required ones:

| Field | When required | Notes |
|---|---|---|
| `MOCK` | set `1` to skip credentials | Replays the bundled synthetic frame streams; never calls the real API |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | required when `MOCK=0` | Use a dedicated RAM user |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | required when `MOCK=0` | Never commit |
| `DATAAGENT_REGION_ID` | defaults to `cn-hangzhou` | Region of your DataWorks instance; **must change if not in Hangzhou** |
| `END_POINT` | for pre/internal gateways | Overrides the SDK's region→host mapping. **When empty, the SDK derives `dataworks.{region}.aliyuncs.com` (production) at client construction** — pointing at a pre-prod gateway without this silently hits production. Host only, no `https://` |
| `RESOURCE_GROUP_ID` | required with zero running instances | The server does **not validate** it — a wrong ID still "creates" sessions |
| `DATAAGENT_AGENT_NAME` | has default | Always `dataworks_data_agent`; don't discover via `ListAgents` (see FAQ) |
| `SESSION_SOURCE` | has default | The sidebar lists only sessions tagged with this source |
| `PORT` / `CORS_ORIGIN` / `VITE_API_BASE` | have defaults | Change all three together when moving ports |

With missing credentials and `MOCK=0`, the server **exits immediately with guidance** —
it never boots half-configured.

---

## 5. Run

```bash
npm install
npm run dev
```

- Backend `http://127.0.0.1:3000` (Fastify, `tsx watch`)
- Frontend `http://localhost:5173` (Vite)
- Open <http://localhost:5173>

**Port busy**: change `PORT` in `.env`, and keep `CORS_ORIGIN` / `VITE_API_BASE` in sync;
frontend port lives in `web/vite.config.ts` (`server.port`).

**The frontend deliberately does not use the Vite dev proxy** — it talks to the backend
directly, with the backend allowing localhost CORS. Reason: dev proxies carry a whole
class of buffering/timeout risks for long-lived streams; direct connection removes them
and keeps dev/prod shapes identical. If you insist on a proxy, set `timeout: 0,
proxyTimeout: 0` or streams longer than 5 minutes will be cut.

Other commands:

```bash
npm test           # vitest (shared + server + web; frontend component tests run in jsdom)
npm run typecheck  # tsc per workspace
npm run build      # typecheck + vite build
npm run check      # three-step self-check (§6)
```

---

## 6. Three-step self-check: `npm run check`

**No HTTP, no dev server** — it builds the SDK client and calls the upstream directly, so
it still tells you which step failed when the server cannot even boot.

```bash
npm run check            # real credentials from .env
npm run check -- --mock  # replay synthetic samples; only proves the project is wired up
```

| Step | API | What it proves |
|---|---|---|
| ① | `ListAgents` | Network, AK/SK, signature. **Not listing `dataworks_data_agent` is normal** |
| ② | `CreateAgentSession` | DataWorks activated, running instance / resource group present. Success criterion: **`Result.SessionId` non-empty** |
| ③ | `GetAgentSessionTokenUsage` | The session actually works (~0.3s) |

Output is a `step / ok / ms / requestId / detail` table + exit code. Steps are timed;
failures don't stop later diagnostic steps.

`[LIVE 09-15]` With fresh AK/SK credentials **all three steps passed** (① ~0.2s, returned
2 chatbi agents; ② non-empty `SessionId`; ③ ~0.3s, `PromptTokens=0`). Two caveats:

- **② can be flaky**: same-shaped input minutes apart — one empty response, one success.
  Retry once before suspecting configuration.
- **Three green steps ≠ prompts will run**: ②③ passed but `PromptAgentSession` still
  returned zero frames. The self-check covers identity, activation and session
  availability — not whether the upstream dispatches this turn to an executor.

`--mock` explicitly says so in its output: it only proves the project is wired up and the
samples parse — **not** that your AK/SK, region, instance or resource group are correct.

### 6.1 Human-in-the-loop reply: `ReplyAgentSession` (9th API)

The `PromptAgentSession` stream contains two kinds of frames that **need a human**:
tool approvals (the agent wants to run a write operation) and `ask_user_question` (the
agent asks a question). Without a reply, the turn stalls there.

This repo implements the full loop for the 9th API:

- **Mode switch at session creation**: `POST /api/sessions` with `mode` — `yolo`
  (default: all tool approvals auto-approved) or `default` (approval-triggering tool
  calls stop and wait). `ask_user_question` is a question, not an approval — it appears
  in **both** modes.
- **Reply endpoint**: `POST /api/sessions/:id/reply`, two payload shapes:
  - Question → `{ "permissionRequestId": "...", "answers": {"0": "<option label or custom text>"} }`
  - Tool approval → `{ "permissionRequestId": "...", "optionId": "proceed_once", "outcome": "selected" }`
  - Cancel the interaction → `{ "permissionRequestId": "...", "outcome": "cancelled" }`
- **Key tested constraints** (full list in [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) and
  the `shared/src/rest.ts` comments):
  - After a successful reply, **do not resend the prompt** — the original SSE stream is
    still alive; subsequent frames continue on it;
  - An ask_user_question reply **must carry optionId** (the `kind==='allow_once'` entry)
    plus answers — missing optionId is rejected by the upstream with 400;
  - POST is not a style choice: a reply really changes server-side execution, and GET is
    a CORS simple request any web page could fire cross-origin.
- UI: the interaction card in the chat stream (`InteractionCard`) replies on selection;
  the stream continues from where it was.

---

## Constraint highlights

The full list of 45 tested constraints (each with code attribution) lives in
[docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) (Chinese). The ten most likely to bite:

| # | Constraint | Code |
|---|---|---|
| 1 | Business errors always return HTTP 200; only transport faults are 5xx | `server/src/routes/rest.ts`, `shared/src/errors.ts` |
| 3 | Must use the `*WithSSE` variants, or the whole response buffers and times out | `server/src/sdk.ts` `assertSseCapable` |
| 5 | Auto-retry duplicates writes — must set `autoretry:false, maxAttempts:1` | `server/src/sdk.ts` `runtimeFor` |
| 6 | `ListAgents` never lists `dataworks_data_agent`, but creating a session with it works | `server/src/live.ts` `liveListAgents` |
| 19 | `CancelAgentSession` works: cancellation ends the stream with `stopReason=cancelled`; but the cancelled state is **not persisted** (upstream gap) | `server/src/live.ts` `liveCancel` |
| 21 | `GetAgentSessionTokenUsage` is the only reliable meter, but **the numbers are not constants** | `server/src/selfcheck.ts` |
| 22 | `load` blocks ~50% of the time during RUNNING turns (measured 178s/81.6s) ⇒ separate 30s readTimeout + no refetch-on-focus | `server/src/live.ts` `liveHistory` |
| 24 | Concurrent streams **cross-contaminate answers** (3/4 crossed with 4 concurrent turns) — the fan-out error is upstream; attribution only via injected markers | `shared/src/marker.ts`, `server/src/routes/prompt.ts` |
| 42 | The session→daemon binding is **ephemeral**: an idle old session answers `Session is not ready` — expect "binding lost, retry/recreate" | `shared/src/errors.ts` `classifyError` |
| 44 | An ask_user_question reply **must include optionId**, or the upstream rejects with 400 | `shared/src/rest.ts`, `web/src/components/chat/InteractionCard.tsx` |

---

## Known limitations (full version in [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md), Chinese)

Both artifact APIs always return empty (no fallback padding); history replay shrinks
(it is not an audit archive); this project covers the synchronous-session interaction
shape only — upstream behavior may change; trust measurements, not assumptions.

---

## MOCK mode (optional)

Preview every UI shape without credentials: `MOCK=1 npm run dev`. It replays synthetic
sample frame streams (including demos of stream breaks, ghosted sessions, concurrent
rejections…). Full details in [docs/MOCK.md](docs/MOCK.md) (Chinese).

---

## Docs index

| Doc | Contents |
|---|---|
| [docs/FAQ.md](docs/FAQ.md) | Pitfalls written as Q&A (Chinese) |
| [docs/CONSTRAINTS.md](docs/CONSTRAINTS.md) | All 45 tested constraints with code attribution (Chinese) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Repo layout, backend HTTP contract, "source of truth" design (Chinese) |
| [docs/MOCK.md](docs/MOCK.md) | MOCK mode details (Chinese) |
| [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) | Known limitations & disclaimer (Chinese) |

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Run
`npm run typecheck && npm test` before submitting.

---

## License

MIT — see [LICENSE](LICENSE). The measurement notes describe behaviors observed at
specific dates against a live service; they may change without notice.
