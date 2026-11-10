# AI Mock Interview Platform

A timed, voice-driven mock interview run by a set of coordinated AI agents wired
together over MCP. A student uploads a resume, picks a target role, and gets a
structured, evidence-based report at the end; Admins review those reports across
candidates.

**Start here:** [`CLAUDE.md`](./CLAUDE.md) (architecture and conventions) ·
[`soul.md`](./soul.md) (values and guardrails — this one wins any conflict) ·
[`INSTRUCTIONS.md`](./INSTRUCTIONS.md) (technical spec) ·
[`TRACKING.md`](./TRACKING.md) (build stages and gates) ·
[`FASTAPI_MIGRATION.md`](./FASTAPI_MIGRATION.md) (the Python/FastAPI port —
now the active backend; see **Backend cutover** below).

## Backend cutover

The active backend is now **`backend/`** (Python/FastAPI), not
`apps/gateway`. `apps/gateway`, `agents/*`, and `mcp-servers/*` are **frozen**
— see [`apps/gateway/FROZEN.md`](./apps/gateway/FROZEN.md) — kept as the
reference implementation `backend/` was ported against, not for further
development. `apps/web` is unchanged and talks to whichever backend is
listening on `:4000`; `npm run dev` now starts the FastAPI backend by
default. See `FASTAPI_MIGRATION.md` for the full stage-by-stage port record.

## Status

Stages 1–4 are complete and their gates pass — see `docs/stage-1-foundation.md`
through `docs/stage-4-reporting-and-admin.md`. A full voice-driven interview
runs end to end: resume + JD in, quota-capped questions out, follow-ups,
coding round, consent-gated monitoring, scoring, evidence-linked report, and
an Admin dashboard across candidates. Self-service Student signup shipped as
part of Stage 3 (`POST /auth/register`, always `student`-role — see
`INSTRUCTIONS.md §3.2` and §7).

**Stage 5 is complete** — see
[`docs/stage-5-llm-and-archival.md`](./docs/stage-5-llm-and-archival.md). The
Resume Service, Question and Follow-up Question Agents now generate through a
shared provider abstraction (`packages/llm-client`, LangChain, optional
LangSmith tracing) behind the LLM Provider Tool (`INSTRUCTIONS.md §5.7`), with
Groq (`openai/gpt-oss-120b`) as the documented production provider and Bedrock
and OpenRouter available through the same seam. Every generated claim passes a
grounding check before it leaves an agent, and every failure path falls back to
the rule-based Stage 2 behaviour rather than blocking a session. Each completed
session is also compiled into a redacted, admin-only archive on a separate
Supabase-hosted Postgres instance (`INSTRUCTIONS.md §11.4`).

> **Note on providers and storage.** An earlier draft of this section described
> Stage 5 as defaulting to Gemini's free tier and persisting to MongoDB. That
> did not match `INSTRUCTIONS.md §5.7`/§11, `CLAUDE.md §6`, `TRACKING.md`, or
> `soul.md`, all four of which specify Groq with Bedrock/OpenRouter alternates
> and a Supabase-hosted **Postgres** archive alongside the existing primary
> Postgres. The implementation follows those four; this paragraph records the
> discrepancy rather than hiding it. Switching provider is a one-line
> `LLM_PROVIDER` change plus a binding in `packages/llm-client/src/provider.ts`;
> switching the primary datastore to MongoDB would be a much larger change than
> Stage 5's scope and is not what shipped.

## Quick start

```bash
npm install
cd backend && python -m venv .venv && .venv/Scripts/pip install -e ".[llm,speech,dev]" && cd ..
npm run dev:backend   # FastAPI on :4000 with the in-memory storage driver
npm run dev:web       # web on :3000
```

The backend defaults to `STORAGE_DRIVER=memory` and `LLM_PROVIDER=fixture`, so
it runs with nothing else installed and no candidate text leaves the machine.
For the real thing:

```bash
cp .env.example .env          # then set AUTH_TOKEN_SECRET
npm run infra:up              # Postgres + Redis via Docker
STORAGE_DRIVER=postgres npm run db:migrate
STORAGE_DRIVER=postgres npm run dev:backend
```

`backend/tests/smoke_stage*.py` are this backend's test suite (run directly
with the venv's python — `FASTAPI_MIGRATION.md` explains why they're plain
scripts rather than a pytest suite). The commands above start the frozen TS
gateway's equivalents (`npm test`/`npm run typecheck`/`npm run lint`) still
work against `apps/gateway` if you need to compare behavior, but that
package is no longer where new backend work happens (`npm run dev:ts-frozen`
starts it instead of the FastAPI backend).

For real generation, set `LLM_PROVIDER=groq` and `GROQ_API_KEY` (or the Bedrock
/ OpenRouter equivalents). **Read the data-sharing notes in `.env.example`
first**: this is the one documented exception to "nothing is shared with third
parties" (`soul.md §"Privacy by default"`), and each provider's terms are
recorded there. LangSmith tracing is a *second*, separate third-party recipient
of the same text and is off unless `NODE_ENV=development` **and**
`LANGSMITH_OPT_IN=true` **and** a key is set.

For session archiving, point `SUPABASE_DB_URL` at a Supabase-hosted Postgres —
a physically separate instance from `DATABASE_URL` — and apply its schema with
`npm run db:migrate:archive`. Left blank, sessions complete exactly as they did
at Stage 4 and the admin archive routes 404.

## Layout

```
apps/gateway        REST entry point, auth, RBAC, and the MCP Gateway
apps/web            Next.js frontend: login, new interview, Interview Config
agents/*            One package per agent; harness-agent owns the state machine
mcp-servers/*       One package per shared tool
packages/shared-types      Types and storage ports shared across every service
packages/mcp-schemas       JSON Schema + validator for every MCP call
packages/interview-domain  Topic vocabulary, role profiles, question bank
packages/llm-client        Provider-agnostic structured LLM calling + grounding
packages/agent-lint        The stateless-reducer rule (INSTRUCTIONS.md §11.1)
infra/              Docker Compose (Postgres, Redis) and the gateway image
docs/               Stage notes; the governing documents live at the root
```

Two rules the layout exists to protect (`CLAUDE.md §2`, §8):

1. Agents never call each other directly — every agent-to-agent interaction goes
   through the Harness Agent, so a session is auditable from one place.
2. Every MCP tool call goes through the MCP Gateway, which authenticates, rate
   limits, validates against the schema, and emits the telemetry span. No agent
   instruments itself.
