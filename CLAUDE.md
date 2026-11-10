# CLAUDE.md

Project guide for anyone (human or AI) working in this repository. Read this before touching code. Read `soul.md` before writing any prompt, persona, or scoring logic. Read `INSTRUCTIONS.md` before implementing an agent or an MCP tool — it has the exact schemas.

> **Backend cutover.** The active backend is `backend/` (Python/FastAPI), not
> the TypeScript `apps/gateway` this document's architecture sections were
> originally written against. `apps/gateway`, `agents/*`, and `mcp-servers/*`
> are **frozen** (`apps/gateway/FROZEN.md`) — every rule below still applies,
> just read "the gateway"/"an agent's TS package" as "the equivalent module
> under `backend/app/`". `apps/web` is unchanged. See `FASTAPI_MIGRATION.md`
> for the stage-by-stage port record and which TS source file backs each
> Python module.

## 1. What this project is

An AI mock-interview web application with two roles: **Student** (takes interviews) and **Admin** (reviews reports). A student logs in, configures an interview (role, job description, resume), passes a device/telemetry check, then runs a timed, voice-driven mock interview (questions spoken via text-to-speech, answers captured via speech-to-text; behavioral + technical + optional live coding) against a set of coordinated AI agents. At the end they get a structured, evidence-based report — saved to their own history and visible to Admins.

The system is a **multi-agent architecture routed through MCP (Model Context Protocol)**: one orchestrating "harness" agent talks to the frontend and to a set of specialized agents, and those agents call a set of shared tools — all as MCP servers/clients rather than ad-hoc function calls. This gives every agent-to-agent and agent-to-tool interaction a uniform, inspectable, and swappable interface.

## 2. Architecture at a glance

```
Web client (Next.js)
      |  REST + WebSocket
      v
Harness Agent  (MCP Host — owns session state machine, the only agent
                 the frontend ever talks to directly)
      |  MCP
      v
Specialized agents (each an MCP server the harness calls as a client)
  - Resume Service Agent
  - Question Agent
  - Follow-up Question Agent
  - Coding Agent
  - Time Tracking Agent
  - Memory Agent
  - Report Agent
      |  MCP
      v
Shared tool servers (MCP servers called by whichever agent needs them)
  - Resume Parser Tool
  - Eval Tool
  - Time Tracking Tool
  - Telemetry Service
  - Clipboard Monitor
  - Speech Service Tool (TTS + STT — called only by the Harness Agent, see §5)
```

Full rationale, sequence diagrams, and per-agent contracts are in `INSTRUCTIONS.md`. Full behavioral/ethical rules for the agents are in `soul.md`.

**Golden rule:** agents never call each other directly. Every agent-to-agent interaction is mediated by the Harness Agent so the whole session stays auditable from one place. Tool calls, by contrast, may be made by any agent that needs them, but always through the MCP Gateway (see §5) so they're uniformly authenticated and logged.

## 3. Repository structure (proposed)

```
/apps
  /web                      Next.js frontend: login, home, interview config,
                             telemetry check, interview environment, report pages
  /gateway                  API gateway: REST + WebSocket entry point, auth
                             (login/passcode reset, role-based access), MCP Gateway
/agents
  /harness-agent            Orchestrator / MCP host, session state machine, speech I/O bridge
  /resume-service-agent     Resume parsing + JD-fit verification
  /question-agent
  /followup-agent
  /coding-agent
  /time-tracking-agent
  /memory-agent
  /report-agent
/mcp-servers
  /tool-resume-parser
  /tool-eval
  /tool-time-tracking
  /tool-telemetry
  /tool-clipboard-monitor
  /tool-speech-service      Text-to-speech + speech-to-text
/packages
  /shared-types              Session, Question, Answer, Evaluation, Report types shared across services
  /mcp-schemas                JSON Schemas for every MCP tool call in this repo
  /interview-domain           Topic vocabulary, role profiles, question bank — shared by the
                              Resume Service Agent and the Question Agent so `topic_plan` and
                              `topic_counts` speak the same names (added in Stage 2)
  /llm-client                 (Stage 5) Provider-agnostic structured LLM calling: prompt registry,
                              grounding checks, retry/validation against /packages/mcp-schemas —
                              used by the Resume Service, Question, and Follow-up Question Agents
                              only. See INSTRUCTIONS.md §11.5.
  /ui-components
/infra                       Docker / IaC for each service
/docs
  CLAUDE.md
  soul.md
  INSTRUCTIONS.md
  TRACKING.md                Build tracker: 5 stages with stage-gate tests, see below
```

Each agent and each tool is its own deployable service with its own MCP server. This keeps blast radius small (one bad agent doesn't take down the harness) and lets you scale the Coding Agent (expensive, sandboxed execution) independently of, say, the Time Tracking Agent (cheap, high frequency).

## 4. Agent roster

| Agent | Role | Calls these tools | Owns which session state |
|---|---|---|---|
| Harness Agent | Orchestrator, MCP host, single source of truth for session state | Telemetry (via gateway middleware) | The whole state machine |
| Resume Service Agent | Parses resume, extracts per-topic relevance, verifies resume-vs-JD fit | Resume Parser, LLM Provider Tool¹ | `CONFIG` |
| Question Agent | Selects/generates questions (+ reference answer) from a resume-derived, quota-capped topic plan | Eval (calibration only), LLM Provider Tool¹ | `QUESTION_LOOP` |
| Follow-up Question Agent | Probes candidate answers for depth; scores the triggering answer¹ | Eval¹, LLM Provider Tool¹ | Sub-state of `QUESTION_LOOP` |
| Coding Agent | Runs and evaluates live coding exercises | Eval, Clipboard Monitor | `CODING_ROUND` |
| Time Tracking Agent | Paces the session, enforces per-segment time budgets | Time Tracking Tool | Cross-cutting (all states) |
| Memory Agent | Session-scoped and (opt-in) cross-session candidate memory, incl. per-topic question counts | — | Cross-cutting |
| Report Agent | Compiles the final evidence-based report | Eval | `REPORT_GENERATION` |

Full I/O contracts for each agent are in `INSTRUCTIONS.md §4`. ¹ Stage 5 addition — see `INSTRUCTIONS.md §11`.

## 5. MCP routing summary

- The **Harness Agent is an MCP host**: it holds MCP client connections to every specialized agent's MCP server.
- Each **specialized agent is itself an MCP client** to the shared tool servers it needs (e.g. Coding Agent → Eval Tool + Clipboard Monitor).
- The **Speech Service Tool is the one exception to "agents call the tools they need"**: only the Harness Agent calls it, since text-to-speech/speech-to-text is a property of the live frontend bridge, not any single agent's job (details in `INSTRUCTIONS.md §5.6`).
- All MCP traffic passes through a lightweight **MCP Gateway** (in `/apps/gateway`) that adds auth, per-session rate limiting, and auto-emits a telemetry span for every tool call — so no individual agent has to remember to instrument itself.
- The frontend never speaks MCP directly. It talks REST/WebSocket to the gateway, which talks to the Harness Agent.

## 6. Tech stack (proposed — adjust as the team decides)

- **Frontend:** Next.js, TypeScript, Tailwind, WebSocket client for live interview + timer + coding events
- **Agent/tool runtime:** Node.js or Python services, each wrapping the Anthropic API (Claude) via the official MCP SDK. **(Stage 5 addition)** The Resume Service, Question, and Follow-up Question Agents instead generate through `packages/llm-client` (LangChain, structured/tool-calling output, LangSmith tracing) against the LLM Provider Tool (`INSTRUCTIONS.md §5.7`) — default provider Groq, model `openai/gpt-oss-120b`, with Bedrock/OpenRouter available through the same seam. Every other agent is unaffected.
- **State/session:** Redis for live session state and timers; PostgreSQL for durable session, candidate, and report records
- **Memory:** pgvector or a dedicated vector store for the Memory Agent's embeddings
- **Realtime:** WebSockets for question/answer/follow-up/timer/paste events, plus streamed audio for TTS playback and STT capture
- **Speech:** self-hosted, in-process, no cloud API and no subscription — but **two independent engines, not one** (`INSTRUCTIONS.md §5.6`). **TTS** is `sherpa-onnx`'s VITS/Piper voice (Stage 3 addition). **STT** is `faster-whisper` (`whisper tiny.en` on CTranslate2, Stage 11 addition) — *not* sherpa-onnx, which no longer transcribes anything. They are composed behind one `SpeechProvider` (`CompositeSpeechProvider`) so callers see one tool, and either can be missing without taking the other down.
- **Auth:** hashed passcodes, short-lived single-use reset tokens, role (`admin`/`student`) embedded in the session token and enforced at the gateway on every request
- **Sandboxed code execution:** isolated container/runner invoked by the Coding Agent (never execute candidate code in the same process as any agent)
- **Archive store (Stage 5 addition):** a separate Supabase-hosted Postgres instance holding one `session_archives` row per completed session (`INSTRUCTIONS.md §11.4`, §11.6) — reached only server-side via a service-role credential, never from a client, and never the same database as the primary application Postgres above. The same instance also holds `oauth_profiles` (Google OAuth addition): a per-user snapshot of the Google identity used to sign in (name, avatar, provider subject), captured on each Google login. It is a second, distinct table there, not folded into `session_archives` — the primary `users` row (email/role/passcode) still lives in the primary Postgres above exactly as before Google OAuth existed.
- **Deployment:** Docker per service, orchestrated via Kubernetes or a serverless-functions-per-agent model

## 7. Development commands (placeholders — replace once the stack is finalized)

```bash
npm install
npm run dev            # runs web + gateway + agents in dev mode
npm run test           # unit + contract tests
npm run test:e2e       # scripted end-to-end mock interview
npm run lint
```

## 8. Coding conventions

- TypeScript strict mode (or typed Python — no untyped agent I/O).
- One agent = one MCP server = one deployable service. Don't merge two agents' logic into one process "for convenience."
- All agent-to-agent calls go through the Harness Agent. No peer-to-peer agent calls.
- All MCP tool calls go through the MCP Gateway, which handles telemetry — don't hand-roll a second logging path.
- Every MCP tool input/output must be validated against its JSON Schema in `/packages/mcp-schemas` before use.
- Never log full resume text, full clipboard content, or full answer transcripts in plaintext application logs — see `INSTRUCTIONS.md §8` for what telemetry may capture.
- Scoring rubrics live only in the Eval Tool, not hardcoded inside any agent — see `soul.md §"No fabrication"`.

## 9. Testing strategy

- **Unit:** one suite per agent, with MCP tool responses mocked against their schemas.
- **Contract tests:** every MCP tool's request/response validated against `/packages/mcp-schemas` on every change.
- **E2E:** a scripted candidate persona runs a full session — resume upload through report generation — in CI.
- **Load:** concurrent-session test on the Harness Agent's routing path, since it's the single chokepoint.

## 10. Do's and don'ts for anyone (or any AI) working in this repo

- **Do** read `soul.md` before writing or editing any agent prompt, persona copy, or scoring logic.
- **Do** read `INSTRUCTIONS.md` for the exact MCP tool schema before wiring a new tool call.
- **Don't** hardcode a scoring rubric inside the Question Agent or Coding Agent — rubrics belong in the Eval Tool so every agent scores consistently.
- **Don't** let any agent manage its own timers — all time budgets go through the Time Tracking Agent/Tool.
- **Don't** enable the Clipboard Monitor for a session unless the session's consent flag is explicitly set — see `soul.md §"Consent-first monitoring"`.
- **Don't** add a new "shortcut" MCP connection between two specialized agents. If two agents need to coordinate, that coordination goes through the Harness Agent.
- **Don't** let any agent other than the Harness Agent call the Speech Service Tool directly — see `INSTRUCTIONS.md §5.6`.
- **Don't** grant the Admin role read access to raw resumes, audio, or transcripts beyond what a candidate's `Report` already contains — see `soul.md`.
- **Do** (Stage 5) write every agent, LLM-backed or not, as a stateless reducer — no module-level mutable state, no in-memory per-session cache inside an agent process. If something needs remembering, it goes through the Memory Agent — see `INSTRUCTIONS.md §11.1`.
- **Do** (Stage 5) call `packages/llm-client`'s `structuredCall`, never a provider SDK directly, from the Resume Service, Question, or Follow-up Question Agents — see `INSTRUCTIONS.md §11.5`.
- **Don't** (Stage 5) let an LLM-generated claim (`jd_fit.rationale`, `topic_relevance` evidence, etc.) skip the grounding check before it's returned — see `soul.md §"Grounding is checked, not assumed"`.
- **Don't** (Stage 5) compile or ship a session archive before the existing retention/redaction job has run for that session — see `INSTRUCTIONS.md §11.4` and `soul.md §5`.

## 11. Frontend page flow & roles

```
Login  ->  Home  ->  Interview Config  ->  Telemetry Check  ->  Interview Environment  ->  Post-Interview Report
(email +    (role-      (role, JD,          (mic/speaker         (the live agent-driven        (report saved to
 passcode,   dependent    resume upload/      check, consent       session — see                candidate history
 reset)      dashboard)   delete, JD-fit)     capture)             INSTRUCTIONS.md §3)           + Admin dashboard)
```

**(Stage 3 addition)** A Signup page precedes Login for new students — self-service registration via `POST /auth/register` (`INSTRUCTIONS.md §7`), always creating a `student`-role account. Admin accounts are still operator-provisioned only, never created through Signup.

- **Student home page:** the student's own past interview stats and a "start new interview" button that creates a session and moves to Interview Config.
- **Admin home page:** an aggregated dashboard of all students' reports and stats — no "start new interview" option, since Admins don't take interviews as candidates.
- **Interview Config page:** where role, job description, and resume are entered; resume can be replaced or deleted before proceeding; the JD-fit check (`INSTRUCTIONS.md §4.2`) runs here and its result is shown to the candidate before they continue.
- **Telemetry Check page:** mic/speaker check plus explicit consent capture for telemetry, clipboard monitoring, and audio recording — nothing in the Interview Environment starts until this passes (`INSTRUCTIONS.md §3`, state `TELEMETRY_CHECK`).
- **Interview Environment:** the full agent-driven session described in `INSTRUCTIONS.md §3`–§5, with questions delivered by text-to-speech and answers captured by speech-to-text.
- **Post-Interview Report page:** the candidate sees their own report; the same report is written to the database so it appears on the Admin dashboard, per `INSTRUCTIONS.md §4.8`.

Full page-to-state mapping and role rules are in `INSTRUCTIONS.md §3.1`–§3.2.

## 12. Stage 5 — LLM-backed agents, structured tool calling, session archival

Adds real LLM generation (Groq, `openai/gpt-oss-120b`, via `packages/llm-client`/LangChain, traced with LangSmith) to the Resume Service, Question, and Follow-up Question Agents; formalizes every agent as a stateless reducer; scores each answer at follow-up time instead of only at report time; and ships a redacted, admin-only session archive to a separate Supabase Postgres instance. Full design: `INSTRUCTIONS.md §11`. Behavioral/ethical constraints (grounding, third-party data flow, archive-vs-retention ordering): `soul.md`, throughout, marked "(Stage 5 addition)". Build status and stage-gate tests: `TRACKING.md` Stage 5.

## 13. Stage 6 — Tiered concept-escalation model (`systemBlueprint`)

Reshapes the flat `difficulty: 1-5` + `expectedSignals[]` question model into an explicit 3-tier `extractionMatrix` per topic (`packages/interview-domain/blueprint.ts`), and formalizes the Follow-up Agent's existing deterministic gap detector into a `nextActionGenerator` directive (`escalate`/`pivot`/`drill_down`, plus `conclude` which only the Harness Agent sets). Additive throughout — every Stage 1-5 wire shape, DB column, and test still holds. Full design: `INSTRUCTIONS.md §12`. Build status and stage-gate tests: `TRACKING.md` Stage 6.

## 14. Stage 7 — Admin directory, profile drill-down, interview scheduling

Extends the Stage 4 Admin dashboard with a searchable candidate directory (aggregate stats per student, server-side filter/sort/paging), a per-candidate profile drill-down with interview history and report download, and **admin-scheduled interviews** — an Admin assigns a mock interview to a student or a batch, and it appears on that student's Home page when the window opens. Full spec and the reconciliation against what already existed: `ADMIN_FEATURE_PROMPT.md`. Build status and stage-gate tests: `TRACKING.md` Stage 7.

Three rules from this stage that are easy to break later:

- **A schedule is session-seed data, not a new agent path.** `ScheduledInterview` is read once, by the gateway, when the student starts the session it seeds. No agent reads it, so scheduling does not violate the golden rule in §5.
- **An Admin cannot consent on a candidate's behalf.** There is no consent field on a schedule and the API rejects a request carrying one — the Telemetry Check page stays the only writer of `Session.consent` (`soul.md §"Consent-first monitoring"`). A scheduled interview still runs Interview Config, resume upload, the JD-fit check and the device check.
- **The `Report` boundary is unchanged.** Everything the new admin routes serve is either a candidate's own account metadata or something already inside their `Report`. The admin drill-down renders the *same* component as the candidate's own report page (`apps/web/app/components/report-view.tsx`) — don't add a second renderer, because the second one is the one that drifts.

## 15. Stage 8 — UI foundation: Tailwind CSS v4 + shadcn/ui

`apps/web` now depends on Tailwind CSS v4 and shadcn/ui. Every page listed in §11 was rebuilt on those primitives. This is a **presentation-layer change only**: no API contract, request/response shape, `lib/api.ts` signature, route, gateway or agent behaviour changed.

Stage 7 deliberately avoided adding a UI library ("don't introduce a second UI kit") because at the time the app had none — one hand-rolled stylesheet was the whole design system. That constraint was lifted on the user's explicit instruction. The point was to **re-implement the existing design system on better primitives, not adopt a new visual direction**: the Stage 1 palette (warm off-white/ink, slate-blue accent) is preserved and simply re-expressed under the variable names shadcn's components expect. `apps/web/app/globals.css` carries the full mapping and is the file to read first.

Where things live now:

- `apps/web/app/globals.css` — all design tokens, the old-name → shadcn-name mapping, the spacing/type conventions, the reduced-motion rule. There is no `tailwind.config.js`; Tailwind v4 keeps the theme in CSS under `@theme`.
- `apps/web/app/components/ui/*` — shadcn primitives, added via `npx shadcn@latest add`. Config in `apps/web/components.json`.
- `apps/web/app/components/shell.tsx` — page furniture (`Page`, `WidePage`, `PageHeader`, `InlineError`, `Notice`, `Stat`, `EmptyState`, …) shared by every route.
- `apps/web/lib/format.ts` — display formatters shared by candidate and admin surfaces. `apps/web/app/admin/ui.tsx` re-exports them.

Four rules from this stage that are easy to break later:

- **`--warn` and `--ok` are a theme extension, and `--destructive` is not a synonym for either.** shadcn ships no success or warning token. This app uses `--warn` for at-risk and error states that are *not* destructive actions (a failed sign-in, a missed deadline, "Job requirements") and `--ok` for healthy ones; `--destructive` is reserved for controls that actually destroy something. Don't collapse them, and don't hand-roll a one-off hex instead of using the tokens.
- **The chart tokens are not a validated categorical palette.** `--chart-1..5` pass the check that matters for a single series (≥3:1 against the chart surface in both themes) and fail categorical separation, because this palette is deliberately low-chroma. Both charts in the app are single-series on a fixed 0–5 domain. A multi-series chart needs these re-stepped first — see the note in `globals.css`.
- **Fixed score domains stay fixed.** The score trend (`app/admin/ui.tsx` `ScoreTrend`) and the competency breakdown (`app/components/report-view.tsx`) both hardcode a 0–5 domain and must never auto-scale to the data. A bar's length means "where this sat on the rubric", not "how it compared to the other answers in this session". Same reasoning as the null-score rule below.
- **`formatScore`/`formatScoreValue` return `—` for null, never `0`.** A candidate with no reports has not scored zero (`soul.md §"No fabrication"`). The rule now lives once, in `lib/format.ts`; before Stage 8 the Student Home page carried its own inline copy of it.

Two things the redesign deliberately did **not** do, both for `soul.md` reasons: the report shows no computed "overall score" (the Report Agent never emitted one, so presenting it would be a score with no provenance), and the admin dashboard shows no aggregate average (the gateway owns that number, and a second one computed in the browser is how the two start to disagree).

> **Update (interview-room UI changes).** `SiteHeader` no longer renders on
> `/interview/:id/room` (`INTERVIEW_ROOM_UI_CHANGES.md` §1), which makes the
> `soul.md §3` disclaimer the one piece of that bar with two render sites: the
> header on every other route, and the room's own `StatusBar`. It is exported as
> `SAFETY_DISCLAIMER` from `site-header.tsx` and imported by the room precisely
> so it stays one sentence — if a third surface ever needs it, import it there
> too rather than typing it again. The room is also the app's only non-admin
> route that opts into the 80rem column (`data-layout="wide"`), because it is a
> two-panel stage rather than prose; the 46rem reading measure left ~165px
> between the panels for the backdrop ring.

> **Update (Stage 9).** The first of those now reads differently, and the difference matters. The report *does* show an overall grade — but it is `report.overallGrade`, assigned by the Eval Tool from the same evidenced scores and rendered verbatim. The rule was never "no overall figure", it was "no figure this file computed", and that is unchanged: no `reduce` over `competencyScores`, no band picked from a threshold in the browser. The admin-average rule is untouched.

Build status and stage-gate notes: `TRACKING.md` Stage 8.

## 16. Stage 9 — interview continuity and the grading scale

Two additions that fill gaps the earlier stages left rather than changing anything they defined. Full design: `INSTRUCTIONS.md §13`. Build status and stage-gate tests: `TRACKING.md` Stage 9.

**Continuity.** Stage 6 built the Follow-up Agent's `next_action` directive and the Question Agent's tier escalation, and never connected them — the directive was computed, persisted, shown to the browser, and then read by nobody, so an `escalate` could not actually cause an escalation. The Harness Agent now routes it (plus a short window of recent exchanges) into `get_next_question`, and `question-agent/v4` writes a question that opens from what was just discussed instead of cold.

**Grading.** A versioned A–E band scale in the Eval Tool (`backend/app/tools/eval/grading.py`), applied per answer, per competency, and per session.

Five rules from this stage that are easy to break later:

- **A directive reorders the plan; it never overruns it.** `escalate`/`drill_down` move the last topic to the front of selection. The topic's cap still binds, an asked question is still excluded, and the tier still comes from `next_tier_for` — so a directive can never produce a harder question than the scores support, or a fourth question on a three-question topic. If you find yourself passing the directive further down into tier or quota logic, that is the line.
- **Grade bands live only in the Eval Tool, exactly like rubrics (§8).** Nothing else owns a threshold: the Report Agent partitions strengths from focus areas on the `is_strength` flag the tool returns, and the frontend renders the band it was handed. `STRENGTH_THRESHOLD` moved out of the Report Agent for this reason — a bare number is the fallback for a report written before grading existed, nothing more.
- **An absent grade is not the bottom band.** There is no "F", and `null` means "not assessed", never "assessed badly". This is `formatScore`'s `—`-not-`0` rule applied to letters, and it holds at every layer: the tool omits `overall_grade`, the column is nullable, the report card says so in words.
- **A letter never appears without the number it came from.** In the room, in the report, in the admin drill-down. A letter alone reads as a verdict; the pair reads as a measurement (`soul.md §3`).
- **The room's live transcript is a preview, not evidence.** `lib/speech.ts`'s dictation drives what the candidate sees while they speak and nothing else. What gets submitted and scored is still the Speech Service's transcript after they have read it back — `soul.md §5` does not let a transcript nobody confirmed become evidence, and a browser recogniser is no more confirmed than a server one.

One more thing worth knowing, because it will look like an oversight otherwise: `question-agent/v3` was being edited in place when this stage started. That silently redefines what every stored `question-agent/v3` stamp means, which is the exact failure the fingerprint gate exists to catch. Those edits are now `v4`'s, v3 is back to its committed text, and `ACTIVE_PROMPT_VERSION` pins v4. v4 has no TypeScript counterpart (the TS registry is frozen at v3), so its fingerprint is derived here rather than transcribed — the gate still catches an unbumped edit, which is the part that matters.

## 17. Stage 10 — human interaction flow

Seven additions that make the interview read as a conversation rather than a form being filled in: a micro-acknowledgment before the real reply, a struggle detector beside the gap detector, recognition of "can you repeat that?" as not-an-answer, phrasing-variety tracking, long-range callbacks, a real pause between a conversational cue and the question, and a closing line that names what the session covered. Full design: `HUMAN_INTERACTION_FLOW.md`. Build status and stage-gate tests: `TRACKING.md` Stage 10.

**The shape every one of them follows is the point of the stage**, and it is the thing to preserve when adding an eighth: **detector → directive → narrow phrasing**. A deterministic rule decides *whether* something happens; an LLM, at most, decides *how it is worded*. Making the interview feel human is not "give the model more freedom to improvise" — it is adding more small deterministic detectors like `_GAPS` and letting the model phrase an increasingly narrow slice of language for each. That is why every check in this stage's gate runs with no provider configured: nothing a provider returns changes what the interview does, only what it sounds like.

Six rules from this stage that are easy to break later:

- **`support` reorders selection exactly as far as `escalate` does, and no further.** It is the §16 rule applied to a directive pointing the other way: `support` brings the struggling topic to the front, and then the cap still binds, the asked-question exclusion still holds, and the tier still comes from `next_tier_for` — which steps *down* at the same score floor `detect_struggle` fires at. A supported topic therefore gets a gentler framing and a lower tier, never an extra turn and never an easier bar. A reframe changes the way *into* a question; the rubric it is scored against is the Eval Tool's and does not move.
- **Nothing spoken before the Eval Tool has answered may carry a verdict.** The acknowledgment beat, the supportive reframe, and the repeat/clarify reply all fire before a score exists. So the ack pools contain no "Great."/"Interesting.", the reframe talks about the question rather than the answer, and neither reply tells the candidate how they are doing. This is `soul.md §"No fabrication"` at its most literal: praise you have no score for is a claim you cannot support. It is also why the struggle detector deliberately runs *before* scoring and never consults the score.
- **The meta-utterance detector is tuned against false positives, not for accuracy.** Scoring a "sorry, what?" as an answer costs one bad turn; swallowing a real answer costs the candidate work they do not get a second chance to give. Hence anchored whole-utterance patterns, a low word cap, and a telemetry span on *every* match — a false positive leaves no other trace, because there is no `Answer` row to notice is missing. If you widen a pattern, widen the adversarial cases in `smoke_stage_human_flow.py` first.
- **A callback fact is a verbatim slice of what the candidate said, never a summary of it.** That is what lets it be handed to the Question Agent's grounding check as a source document. Paraphrase it and you have both an ungrounded claim about the candidate and a generation the check will silently discard on every turn that cites one. Same standard `recent_exchanges` is already held to (§11.3) — and the reason the callbacks are a separate, capped, chosen set rather than a longer trailing window is that the window is re-sent whole on every turn and the callbacks are not.
- **A conversational cue is a closed catalogue, in one place.** `CUE_CATALOGUE` in `interview_domain/transitions.py` is what §4's variety tracking records as spent and what §6's audio pause splits on — deliberately the same list, so a cue that is tracked is exactly a cue that gets the pause. It is not a general "does this sound like a transition" detector: matching loosely would forbid phrases the interview has never said and put pauses inside questions. A phrase absent from the list is untracked, which is the safe default.
- **The closing line describes; the report judges.** `session_arc.py` names topics covered and answers given, both read off persisted rows. It names no strongest or weakest topic and computes no figure. The Report Agent aggregates the evidenced scores minutes later and the Eval Tool bands them; a second component forming its own view of how the session went is how the closing line and the report start to disagree, with the report holding all the evidence. Same reasoning as §15's admin-average rule.

One thing worth knowing, because it will otherwise look like duplication: `SHORT_ANSWER_WORDS`, `HEDGE_RE` and `METRIC_RE` live in `interview_domain/signals.py` rather than in the Follow-up Agent that first defined them. The agent reads them over one answer; the harness reads the same three signals across turns (a hedging *streak*, a *second* short answer, an answer worth remembering). They are one judgement on two time horizons, and two copies of a regex become two different regexes the first time one is tuned.


## 18. Stage 11 — Whisper STT, VAD, and sound-source recognition

The Speech Service's STT engine is `faster-whisper` (`whisper tiny.en` on CTranslate2), not sherpa-onnx. TTS is unchanged — sherpa's VITS voice still speaks every question — so the tool now runs two independent engines composed behind one provider. Around the new engine sit a VAD gate, silence trimming, a 15-second timeout, and a check for whether the audio is the candidate's microphone or their speakers playing our own question back. Full design: `INSTRUCTIONS.md §5.6`. Build status and stage-gate tests: `TRACKING.md` Stage 11.

The single idea behind all four additions: **audio that is not an answer must never be transcribed as one.** Every gate below exists because something that is not a candidate speaking produces a transcript that is fluent, on-topic, and completely wrong to score — at which point nothing downstream can tell.

Six rules from this stage that are easy to break later:

- **Never ask the model about silence.** Whisper does not return an empty string for empty audio; `tiny.en` returns `" You"`. A confident invented word is indistinguishable from a real one-word answer by the time it reaches the harness, so the VAD gate in `vad.py` refuses silence *before* the decode rather than filtering it after. If you find yourself relaxing that gate to make a quiet recording work, raise the microphone gain or lower the adaptive margin — do not let silence through and plan to clean it up downstream, because there is no downstream that can.
- **Echo is a run of consecutive words, never shared vocabulary.** A candidate answering a question in its own terms shares most of its content words with it — that is what answering looks like, and a bag-of-words overlap test rejects real answers. `source.py` matches on word *order* because an echo is a recording of the same sentence, not a paraphrase of it. This is the one heuristic in the file whose false positives cost a candidate a turn they cannot redo, so it is tuned against them, not for recall.
- **A client hint can accuse but not convict.** `input_device` is candidate-controlled. A loopback device *name* is conclusive (it is system output by definition) and so is a transcript match, but a `speaker` hint on its own is reported and still transcribed. `unknown` always means "score this normally" — the pre-addition behaviour. The classifier is not confident enough to reject on a hunch, and it should not be given that power.
- **`STT_TIMEOUT_SECONDS` bounds an unbounded failure; it is not a latency target.** Fed noise, a Whisper decoder can loop emitting repeated tokens indefinitely. Do not tune it down as a performance measure — a decode that is merely slow still produces a real transcript, and killing it costs the candidate a retype. And keep decodes on their own executor: a CTranslate2 decode cannot be cancelled, so a timed-out one runs on as an orphan, and on the event loop's shared default executor a run of them would stall unrelated `to_thread` work for reasons nothing in that code could explain.
- **A refusal's `code` is what the caller acts on, not the absence of a draft.** There are four ways `transcribe_speech` can refuse and the candidate needs a different sentence for each. Two of them must carry no draft transcript: `no_speech_detected` has nothing to correct, and `audio_source_rejected` means the audio *was* the interview's own question — offering the browser's caption of it would invite the candidate to submit our words as their answer. The room checks the code before falling back to its own live caption; deleting that check silently reintroduces exactly that.
- **The two VAD passes are complementary, not redundant.** `vad.py`'s energy scan is a cheap pre-model gate that also produces the silence statistics the confidence score and the telemetry span use; Silero (bundled in faster-whisper, `vad_filter`) is a precise in-decode filter that cannot run before the model is loaded and reports no statistics. Removing either leaves a real gap.

One thing worth knowing, because it will look like dead code: `sherpa_provider.py` still contains a complete, working ASR implementation that nothing selects. Deleting a working engine in the same change that introduces its replacement leaves no way back if the new one misbehaves in a real room, so it stays until Whisper has run against real candidates. It is unreachable through `select_speech_provider` — that is the only place to check.

## 19. Stage 12 — conversational continuers

The eighth method of the human interaction flow (`HUMAN_INTERACTION_FLOW.md §8`), added after §1–§7 shipped. §1 gave the interview something to say the instant a candidate stops talking; this gives it something to say in the three places it still said nothing — the long wait *after* that acknowledgment, a follow-up answer, and the top of the session. Build status and stage-gate tests: `TRACKING.md` Stage 12.

It is the one method in the flow with **no model call at all**, and that is not an omission. Every other method lets an LLM phrase a narrow slice; a continuer carries no claim about the candidate, the answer or the next question, so there is no slice — a model here would generate variety for its own sake and spend a provider round trip doing it, inside the very wait it exists to cover.

Five rules from this stage that are easy to break later:

- **The clock measures the candidate's silence, not one round trip.** `_continuer_window` is a context manager over the whole gap between the acknowledgment and the real reply, and it has to stay that way. The first version wrapped just the `consider_follow_up` call; on the introduction turn the topic-plan fusion is another provider round trip *before* that, so the live app produced "Mm-hm." followed by 34 seconds of nothing — the exact failure this stage exists to remove. If you narrow the window back to a single call to make it read more simply, you reintroduce it.
- **The race resolves in favour of the reply, always.** The window cancels the continuer when it closes; it does not await it. The first version awaited, which made a 5s synthesis add 5s to a turn whose whole purpose was to feel faster. A holding line that arrives *after* the answer it was covering for is worse than no holding line — it asks the candidate to wait for something they already have. If you find yourself awaiting the filler task to tidy up a dangling-task warning, that is the line.
- **Nothing spoken before the Eval Tool has answered may carry a verdict — including the lines that are not about the answer at all.** This is §17's rule with a wider blast radius, because three of the four kinds fire around scoring rather than after it. A holding line therefore talks about the *interviewer* ("let me sit with that"), never about the answer ("that's a lot to unpack" is a reading of it, and no reading exists yet). A selection line names no topic, because the Question Agent has not returned one and announcing a question the interview then does not ask is its own small fabrication. The gate checks the latter against the real `TOPICS` vocabulary, not a word list.
- **A continuer ends no turn, and it is the only server frame pushed from inside a handler that has not returned.** `acknowledgment` and `clarification` arrive after their handler finishes; a `continuer` goes out while the client is still waiting on the reply to the message it sent. So a client that replied to one would put a `next_question` on the wire *ahead of* that reply — and the question it skipped is the one that reply was about to produce. The frame carries no `answered` flag and no ids, `replyTo` returns null for it, and `live-protocol.test.ts` pins that for all four kinds.
- **Push-only is deliberate, and it is where §8 diverges from §1.** A REST caller that receives "one moment" alongside the thing it was waiting for has been handed a log line, not a courtesy. `on_continuer=None` short-circuits to a plain await, so the REST answer route is byte-for-byte what it was. §1's acknowledgment is the opposite case — genuinely worth showing after the fact — which is why it rides on `AnswerResult` and this does not.
- **One line per wait, then silence.** A second "bear with me" is not reassurance, it is an interview visibly stuck; the candidate still has the timer and the thinking indicator. If waits are routinely long enough to want a second line, the fix is the provider, not more talking. `continuer_spoken` (kind, the real total wait, and whether the line was actually spoken or lost the race) is what makes that measurable: because this method's detector *is* a clock, a run of those spans is the plainest available signal that a round trip has gone long, measured where the candidate experiences it rather than inside the MCP client.

One thing worth knowing, because it will otherwise read as inconsistency: **bare `§N` in `interview.py`, `harness.py` and `live_channel.py` means `HUMAN_INTERACTION_FLOW.md`.** Those files already used `§1`–`§7` that way, so the moment a §8 existed there the same token meant two things in one file — the pre-existing `INSTRUCTIONS.md §8` (data minimisation) references in them are now spelled out in full.

## 20. Stage 13 — dynamic question synthesis and adaptive routing

Two changes that remove the last two places where a live interview followed a list written before the candidate arrived: the *text* of a question came out of the 175-question bank, and the *order* came out of a plan that could not react to what the candidate had just demonstrated. Full design: `INSTRUCTIONS.md §14`. Build status and stage-gate tests: `TRACKING.md` Stage 13.

**Selection produces a slot, not a question.** `select_next_question` returns a `QuestionSlot` (topic, tier, type, difficulty, `expected_signals`) and `question-agent/v6` writes the scenario from scratch against those signals and the candidate's own project history. The bank is demoted to two jobs — it supplies the signal list, and it is the fallback text when synthesis is unavailable — so a topic and tier it never covered can now be asked.

**A directive names where the interview goes next.** `interview_domain/routing.py` keeps a rolling EMA of the session's scores and turns it into a `NextNode`; the Follow-up Agent returns it on `next_action` as `next_topic`/`next_tier`/`routing_rationale`, and the Question Agent honours the topic exactly as far as it already honoured `escalate`.

Six rules from this stage that are easy to break later:

- **A routing proposal reorders the plan; it enforces nothing.** This is §16's directive rule with a wider surface, and it is the one most likely to be eroded because a `NextNode` *looks* authoritative — it names a topic and a tier. It is not: the cap still binds, an asked question is still excluded, and the tier still comes from `next_tier_for`, so a routed topic that is capped falls through to the normal ordering and `next_tier: 3` on a topic scoring 2s still gets a tier-1 question. If you find yourself passing a `NextNode` further down than selection's ordering step, that is the line — the same line the directive already has.
- **A stay directive outranks a score band.** `escalate`/`drill_down`/`support` came from a detector that *read the answer*; routing read a number. So `_route_to_topic` tries the directive's own topic first and `next_topic` second. The reverse ordering was written first and is wrong: it lets a routing decision quietly cancel a `drill_down`, which is the interview forgetting the gap it had just found.
- **Routing may change a directive in exactly one case, and it is not "the candidate answered badly".** `support` becomes `pivot` only when a topic has failed to recover across two consecutive answers — one weak answer is a question that landed badly, and pulling the candidate off the topic denies them the recovery question the lower tier exists to give them. Even then, `should_follow_up` and `follow_up_text` are untouched: they still get their reframe *now*, and only where the interview goes *next* changes.
- **`synthesis_enabled` is off without a real provider, and that is not a config oversight.** With no API key the fixture stands in for the model, and a fixture cannot write a scenario — only assemble one from the signal list, which is strictly worse than the reviewed bank question the same slot already has. `fixture_model.py`'s founding rule is that no key behaves like Stage 2, *not* like a worse interviewer than Stage 2. An injected `llm_model` counts as real, which is how the gate test reaches the path.
- **The per-call constraints are validation context, never schema fields.** One registered schema per LLM call is the whole premise of `llm_client/schemas.py`; baking "topic must be databases" into the JSON Schema would mean a different schema per topic. Context keeps one definition and still fails loudly, and — this is the part that matters — a failure is an ordinary `ValidationError`, so it takes the retry-with-correction path §11.5 already defines rather than needing a second error channel. A generation that never complies falls back to the bank and the candidate never sees it.
- **`active_sessions` is a cache of derived values, not state an agent holds.** It lives in `app/http/` because §10 forbids the latter, and the distinction is only real while every field can be rebuilt from persisted rows — which `routing.rebuilt_from` does, replaying the EMA through the same function rather than averaging it, and which `snapshot()` re-checks against the stores every turn. The moment something goes in that dict that cannot be rebuilt, it has become state and belongs in the Memory Agent.

Two things worth knowing, because they will otherwise look like inconsistencies:

- **`question-agent/v5` was not rewritten in place, and `v6` is not simply "the new active version".** §16's fingerprint gate exists precisely to stop a prompt's text changing under a version string that other records already reference, so the baseline removal is a new file. The two are also *both live* and pinned separately (`ACTIVE_PROMPT_VERSION["question_agent"]` = v5, `["question_agent_dynamic"]` = v6): they take different inputs and return different schemas, and v5 is still what runs when a bank entry is being sharpened rather than a scenario written. One key per prompt-shaped job, so neither can be bumped by accident while editing the other.
- **`routing_decision` and `directive_followed` are both emitted and can disagree.** The first records what routing *asked for*, the second what selection *did*. A turn where routing proposed `databases` and selection served `security` because the cap had just been spent is not a bug, and it is only diagnosable because both spans exist.

<!-- BEGIN AWS Agent Toolkit rules -->
# AWS Guidance for the new AWS experience

This user has signed up for the new AWS experience. This experience lets you sign into AWS using a social provider and requires the following additional context.

Where this guidance conflicts with the project's own instructions, the project's instructions take precedence.

## Context

### Terminology:

- Say "project" instead of "account" — a project contains an AWS account and settings for sharing with other collaborators
- Say "team member" instead of "IAM user" — users are invited by email, not created or federated in IAM
- Say "AWS Settings" when referring to management tasks at [settings.aws.com](https://settings.aws.com/) (project management, billing, team members, spend limits). Users view their actual AWS resources in the AWS Management Console.
- Say "selected Region" when referring to the user's Region — not "home Region"
- The user has a managed IAM experience. This includes a managed service control policies (SCP) and resource control policies (RCP) that govern the use of AWS. They will still need to use IAM to create policies to let services work with each other. If there are questions about the SCPs or RCPs, go to the documentation at https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html

### Constraints:

- All projects share a single AWS Region determined by the user's contact address. Resources cannot be created in other Regions
- When developing:
  - MUST create all Regional resources in the project's assigned Region
  - You CAN create AWS WAF and Cloudwatch Logs resources in us-east-1 when there are global resources (like a global WAF instance) that require a connection to dependencies in us-east-1. You should not use these for any other reason, because resources in the selected Region will provide lower cost (due to no cross-Region traffic), increased availability (due to no cross-Region traffic), and easier manageability (due to not needing to look in another Region). When you need to do an inventory of resources, you need to look in both the selected Region and us-east-1 for Cloudwatch Logs or WAF resources.
  - MUST NOT attempt to create Lambda, API Gateway, or other Regional resources in any other Region
  - MUST direct users to confirm their Region in AWS Settings > View all projects > Overview > Additional Info > Region. If the user cannot confirm their Region, check in ~/.aws/config
  - MUST NOT use Lambda@Edge — excluded from both Lambda and CloudFront
  - MUST NOT use CloudFormation StackSets — no multi-account or multi-Region deployments
  - MUST NOT attempt cross-Region actions — no cross-Region replication for DynamoDB/S3/RDS, no multi-Region KMS keys
  - MUST NOT use Route 53 cross-Region routing — geolocation, latency-based, and failover routing policies are not available
  - CloudFront is a global service and its actions ARE allowed in `us-east-1`. A user can create a CloudFront distribution pointing to their project-region Lambda function URL or API Gateway. However, Lambda and API Gateway themselves MUST NOT be created in `us-east-1` — they must be in the project Region.
  - Reduced availability in `eu-north-1` specifically: Amazon Rekognition, Amazon Textract, Amazon Personalize, AWS App Runner are not available in that Region.
- IAM permissions for human access are managed by AWS. Don't assign roles to team members unless absolutely necessary
- The user may have a spend limit if they are on the paid plan. The limit that pauses their project if it's exceeded. If resources suddenly become inaccessible, ask if they have a spend limit configured. Only project owners can modify a spend limit.
- When developing:
  - MUST ask about spend limit status if the user reports sudden "Access Denied" errors on operations that previously worked
  - MUST direct users to check spend status in AWS Settings > Billing
  - MUST check if a user has upgraded their account to the paid plan
  - MUST ask the user if they want to clean up the successfully created resources or keep them to reduce cost
- The user sets up billing, creates spend limits, and retrieves and pays invoices in AWS Settings. The user creates budgets and optimizes their costs in the AWS Billing and Cost Management console
- Not all AWS services are available. If a service isn't working, do the following:
  1. Run the command `aws freetier get-account-plan-state`
  2. If accountPlanType": "FREE", check the [Free Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-free-tier) next,
  3. If accountPlanType": "PAID", check the [Paid Tier supported services list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#supported-services-paid-plan).
  4. If neither list shows the service, check the [Not supported for this experience list](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html#unsupported-services). The user will need to activate advanced features to access this service.
- Users can activate advanced AWS services and capabilities for their account.
- For any AWS task or question — building, configuring, migrating, debugging, or operating a service, writing SDK code, authoring CDK/CloudFormation, or answering how a service works — first call `aws___search_documentation` with topic `agent_skills` and load the matching skill with `aws___retrieve_skill`. Do this even when you believe you know the answer: skills carry current service behavior that your training may not. Prefer the skill's guidance over general knowledge. Skip it only for work that does not involve AWS.

### Help level

- help_level (required): LOW, MEDIUM, or HIGH. While a user is building, you MUST ask the user: "How much guidance would you like from me? Low (I only flag security risks), medium (I ask a couple of clarifying questions if something seems off), or high (I explain what I'm doing, suggest alternatives, and flag best practices)."

You CAN update this rule file to save a user's help_level.

Constraints for each level:

**LOW:**

- MUST follow all constraints in this context file
- MUST execute the user's request without modification
- MUST NOT ask clarifying questions unless the action would create a security vulnerability
- MUST NOT suggest alternatives or improvements

**MEDIUM:**

- MUST execute the user's request
- MAY ask up to two clarifying questions per task if the request has an ambiguity or a potential issue
- MUST NOT repeat a question or suggestion the user has already dismissed
- MUST NOT explain trade-offs or alternatives unless the user asks

**HIGH:**

- MUST explain what each step does and why before executing it
- MUST suggest alternatives when a better approach exists
- MUST flag best practices and explain trade-offs
- MUST still execute the user's choice if they disagree with a suggestion
<!-- END AWS Agent Toolkit rules -->
