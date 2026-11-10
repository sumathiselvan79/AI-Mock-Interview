# Running the Mock Interview AI Application

The application is a multi-agent architecture: an MCP-based **Gateway** (REST + WebSocket API, `apps/gateway`, port `4000`) and a **Next.js web frontend** (`apps/web`, port `3000`). The Gateway can run against either in-memory storage (nothing to install, resets on every restart) or Postgres + Redis via Docker (persistent).

## 0. Prerequisites

- Node.js >= 20 (`node -v`)
- Docker Desktop — only required for the persistent-storage path (§2B)
- `npm install` at the repo root (installs all workspaces)

## 1. Configure environment variables

The app reads `.env` at the repo root. It is git-ignored and does not exist until you create it:

```bash
cp .env.example .env
```

The defaults are safe to run as-is:
- `STORAGE_DRIVER=memory` — no Postgres/Redis needed, data resets every restart
- `LLM_PROVIDER=fixture` — no API key needed, no network calls; the Resume Service/Question/Follow-up agents run a deterministic stand-in instead of a real model (see §4)

Everything else in `.env.example` (Google OAuth, Supabase archive, LangSmith tracing) is optional and can stay blank.

## 2. Choose a storage mode

### 2A. Quick start — in-memory (no Docker)

Nothing further to do; `.env`'s default `STORAGE_DRIVER=memory` is already set. Skip to §3.

**Tradeoff:** every account, session, and report is lost the moment the gateway process restarts — including an automatic restart. The gateway runs under `tsx watch`, which restarts on every source file save, so this mode is for quick, disposable testing, not a session you want to survive an edit.

### 2B. Persistent — Postgres + Redis via Docker

```bash
npm run infra:up        # starts mia-postgres and mia-redis (infra/docker-compose.yml)
npm run db:migrate      # applies schema to the primary database
npm run db:migrate:archive   # optional — only does anything if SUPABASE_DB_URL is set; safe to run either way
```

Then set in `.env`:

```
STORAGE_DRIVER=postgres
```

(`DATABASE_URL` and `REDIS_URL` are already pre-filled in `.env.example` to match `infra/docker-compose.yml`'s ports — Postgres on `5432`, Redis on host port `6380`, not `6379`, because another local project commonly holds `6379`.)

Verify both containers are healthy before starting the gateway:

```bash
docker ps --filter "name=mia-" --format "table {{.Names}}\t{{.Status}}"
```

## 3. Start the servers

Two separate terminals (or two background processes):

```bash
npm run dev        # Gateway — apps/gateway, port 4000
npm run dev:web    # Web frontend — apps/web, port 3000
```

Confirm the gateway came up with the storage driver you expect:

```bash
curl http://localhost:4000/health
# {"status":"ok","storage":"memory","mcp_servers":16}   (or "storage":"postgres")
```

Then open **http://localhost:3000**.

## 4. First login

There are no seeded accounts in either storage mode. Go to `http://localhost:3000/signup`, register a student account with any email + passcode, then log in with those same credentials. (Admin accounts are operator-provisioned only — see `CLAUDE.md` §11 — there is no self-service admin signup.)

## 5. LLM provider (optional)

`LLM_PROVIDER=fixture` (the default) needs nothing and makes no network calls — the Resume Service, Question, and Follow-up agents fall back to a deterministic Stage-2 path that still produces a real interview, just without generated rationale/reference-answer text. To use a real model instead, set in `.env`:

```
LLM_PROVIDER=groq            # or bedrock, openrouter, ollama
GROQ_API_KEY=...             # matching credential for whichever provider
```

Verify a configured provider actually connects and returns schema-valid output before relying on it in a live session:

```bash
npm run check:llm
```

A missing or invalid credential doesn't break the app — `resolveProvider` silently falls back to `fixture` — but `check:llm` is the only way to confirm you're actually getting real generations rather than the deterministic fallback.

## 6. Testing & typechecking

```bash
npm run typecheck      # tsc across the workspace, including apps/web
npm run test           # vitest, full suite
npm run test:watch     # vitest, watch mode
npm run test:e2e       # tests/e2e only
npm run lint           # typecheck + the agent-statelessness linter
```

## 7. Shutting down

Stop the gateway and web processes with `Ctrl+C` in their terminals, or if they were started in the background:

```bash
# find and kill whatever is listening on the app's ports
netstat -ano | grep ":4000 \|:3000 " | grep LISTENING
taskkill //F //PID <pid>
```

If you used the Docker path (§2B), stop the containers (data is preserved in the `mia-pgdata` volume):

```bash
docker compose -f infra/docker-compose.yml stop
```

Or tear them down completely, including the containers themselves (the named volume, and its data, still survives unless you also pass `-v`):

```bash
npm run infra:down
```

## Troubleshooting

- **"Port already in use" / the gateway answers with the wrong `storage` value in `/health`.** Something is already bound to `4000` or `3000` — most often a previous `npm run dev` that wasn't fully killed. Find and kill it (see §7's `netstat`/`taskkill`), confirm the port is free, *then* start a fresh instance. Don't start a second instance on top of a first; on Windows both can end up accepting connections and you'll get inconsistent responses depending on which one answers.
- **Signed-up accounts disappeared.** You're on `STORAGE_DRIVER=memory` (§2A) and the gateway restarted — either you edited a backend source file (`tsx watch` restarts on save) or the process was killed. Switch to §2B if you need accounts to survive restarts.
- **A resume upload / JD-fit check takes 30–60+ seconds.** Only relevant when `LLM_PROVIDER` is a real provider (§5). The Resume Service Agent's JD-fit enrichment call is bounded to a 30s timeout with one retry (`packages/llm-client/src/provider.ts`); a slow or overloaded provider can legitimately take up to ~60s before the deterministic fallback kicks in. This is expected, bounded behavior, not a hang.
- **`db:migrate:archive` says "SUPABASE_DB_URL is not set; nothing to migrate."** Expected and harmless when you haven't configured the optional Supabase archive store — the app runs fine without it (sessions just aren't archived).
