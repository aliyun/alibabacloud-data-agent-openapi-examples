# DataAgent OpenAPI — Multi-Language Examples

Experience DataWorks DataAgent in the web-shell: create a session, ask questions, watch the step-by-step reply, stop the run, and review history. The project ships **three independent backend implementations — Node.js, Python, and Java** — all behind the same web frontend.

You run exactly one backend and one frontend at a time. Picking a language changes nothing about how the pages work, and you never need to install all three runtimes.

> All three backends are fully wired to the web-shell (sessions, streaming replies, stop, history). Each carries parity assertions spanning sessions / streaming / in-flight locking / lifecycle semantics, and all three implementations were verified end-to-end against a live gateway. The internal container deployment stays on Node.js.

## Quick Start

Every backend needs **Node.js 20.19+ (or 22.12+)** and **npm 10+** to run the frontend. Commands below work on macOS, Linux, Windows native (cmd / PowerShell), Git Bash, and WSL.

Install shared dependencies at the repository root:

```bash
npm ci
```

Pick a backend:

| Backend | Extra setup | Start frontend + backend | Web support |
| --- | --- | --- | --- |
| Node.js | none | `MOCK=1 npm start -- node` | wired |
| Python | Python 3.11+; install per the [Python notes](server-python/README.md) | `MOCK=1 npm start -- python` | wired |
| Java | JDK 17+, Maven 3.6.3+; see the [Java notes](server-java/README.md) | `MOCK=1 npm start -- java` | wired |

Open the URL printed in the terminal — default <http://127.0.0.1:5173>. Pick a sample session, send a question, and watch the reply stream in. `MOCK=1` replays sample data without calling any cloud service; answers don't regenerate based on what you type.

The first Java start downloads dependencies and builds, which can take a few minutes — wait for the web URL before opening the browser. `Ctrl+C` stops both processes; to switch languages, stop, then run the other command.

`npm start` defaults to Node.js; `npm run dev -- python` is equivalent to `npm start -- python`; `bash scripts/dev.sh java` uses the same entry point. Backend-only startup is covered in each language's notes.

## Use Your Own DataAgent

You need an Alibaba Cloud account with DataWorks enabled, a running DataAgent instance, and an AccessKey for a RAM user with the right permissions. RAM-user credentials are recommended; if the account has no running instance, prepare a Serverless resource group ID.

1. Run `cp .env.example .env` at the repository root.
2. Edit `.env` with the values below.
3. Run `npm start -- node`, `npm start -- python`, or `npm start -- java`.
4. Open the page, create a session, and ask.

| Setting | How to fill in |
| --- | --- |
| `MOCK` | `0` for real use; `1` for credential-free replay |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | RAM user's AccessKey ID |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | matching AccessKey Secret |
| `DATAAGENT_REGION_ID` | region of your instance; default `cn-hangzhou` |
| `RESOURCE_GROUP_ID` | Serverless resource group ID when the account has no instance |
| `END_POINT` | usually empty; fill a gateway domain when needed (no `https://`) |
| `DATAAGENT_AGENT_NAME` | leave as `dataworks_data_agent` |
| `SESSION_SOURCE` | session source tag; changing it hides sessions with other sources |

Credentials are used **only by backends**. Never put them in `VITE_*` variables, and never commit `.env`. `MOCK=1` on the command line overrides the file; remove it for real use.

## What You Can Do in the Page

Against any backend (Node.js / Python / Java), you can create or open sessions, send text questions, and watch streaming replies with thought traces and tool call results. Click stop to cancel. Human-in-the-loop cards (permission confirmations and ask-user-question follow-ups) are wired: when the agent asks for a decision, a card appears; pick an option or type an answer and the reply goes back through ReplyAgentSession while the turn resumes. Note the pending card state lives in the running backend process — a backend restart invalidates that particular card (a fresh prompt will issue a new one); streaming and history playback are unaffected.

History comes from the cloud; save important results promptly. Rename / archive / delete marks are stored only in the running backend process and may revert after restart. Token-usage queries are backend capabilities; the page doesn't promise a full usage dashboard. Context usage and parts of web-shell functionality may be unavailable where backends lack corresponding capabilities.

Real tasks may read or modify data you have permissions for. Try small, easy-to-verify questions first, then run the real ones.

## Ports and Environment Profiles

The backend defaults to `3000`, the page to `5173`. The one-command starter wires the page to the backend it just launched:

```bash
PORT=3100 WEB_PORT=5180 npm start -- python
```

If a port is taken, the starter reports an error. Stop the existing service or pick another port — it won't kill other processes for you.

## Start Backend and Web Separately (Skip the one-command launcher)

A single `npm start` does three independent things for you: build the jar when sources changed, boot the backend, and launch the web dev server pointed at it. Splitting them manually has the same effect:

```bash
# 1) Build the jar (first run or after source change)
mvn -f server-java/pom.xml -q -DskipTests package

# 2) Backend (terminal 1): defaults to http://127.0.0.1:3000
java -jar server-java/target/das-server-java-0.1.0.jar
#   MOCK credential-free (replays synthetic scenarios):
#   mac/Linux/Git Bash: MOCK=1 java -jar ...
#   Windows PowerShell: $env:MOCK="1"; java -jar ...
#   Windows cmd.exe: set MOCK=1 && java -jar ...
#   LIVE against your real DataAgent: reads .env at repo root (or DEMO via DAS_ENV=<name>)
#   Other port: java -jar ... --server.port=3999  (or PORT=3999)

# 3) Frontend (terminal 2): point it at your backend
cd web && VITE_API_BASE=http://127.0.0.1:3000 npm run dev
#   Windows PowerShell: cd web; $env:VITE_API_BASE="http://127.0.0.1:3000"; npm run dev
#   Windows cmd.exe: cd web && set VITE_API_BASE=http://127.0.0.1:3000 && npm run dev
```

Open <http://127.0.0.1:5173>. If you hit **"daemon server unreachable"**, take these two steps:

1. `curl http://127.0.0.1:3000/api/health` — prove the backend is alive; no response = start the backend first.
2. `VITE_API_BASE` must match the backend port (and **restart the web dev server** when you change it — the dev server reads compile env at startup, not on hot reload).

Create self-contained profiles per account or environment as `.env.<name>` (e.g., `.env.demo`), then:

```bash
DAS_ENV=demo npm start -- java
```

The chosen file must contain full configuration; it is not merged with `.env`. A missing named file aborts startup. Process environment variables win over file values.

## FAQ

**Page won't open / says backend disconnected?** Check the terminal process is still running and look for missing runtimes, missing credentials, or port conflicts. Use the URL printed by the starter. The one-command entry waits for backend readiness; if you start the frontend alone, you must point it at your backend yourself.

**Why are demo answers unrelated to my question?** `MOCK` replays a fixed fixture. Configure a real account and restart with `MOCK=0`.

**Session creation failed?** Check region, RAM permissions, and whether an instance / resource group is available. Healthy local service only proves local availability, not cloud permission or quota.

**Reply cut off mid-way — send again?** Don't. The cloud turn may still be running, and resending can execute your write twice. Reopen the session and check history first. Long turns can hit stream duration limits; a page reconnect does not imply the upstream turn can resume.

**Got a receipt but no answer?** Check account quota and permissions first, then load history to see whether anything landed. A bare receipt does not mean the turn ran.

**Cancelled, but history doesn't show it?** Real-time cancel results and history aren't perfectly consistent. Absence of a terminal record in history does not prove the cancel failed.

**Old session can't continue?** The session-to-executor binding can expire. Save what's there and create a new one.

**Are the languages identical?** All three aim at the same web-shell feature set and are fully wired; contract asserts (34×3 at the HTTP/NDJSON layer and 14×3 at the daemon layer) pass. That doesn't prove every behavior of every cloud environment is verified — outside real-link connectivity, upstream behavior leads.

## More Docs

- [Node.js setup & standalone startup](server-node/README.md)
- [Python setup & standalone startup](server-python/README.md)
- [Java setup & standalone startup](server-java/README.md)
- [Layout & verification commands](docs/DEVELOPMENT.md)

This example is meant for local hands-on by default. Before exposing it to other people, configure authentication, access control, and credential isolation yourself.
