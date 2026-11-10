# TRACKING.md

Build tracker for the AI Mock Interview platform. Five stages, sequenced by dependency, not by agent list — you can't sensibly test voice before the core question loop works, and you can't test the Admin dashboard before reports exist. Each stage ends with a **gate**: don't start the next stage until its tests pass.

Check items off as you go (`- [x]`). Full contracts for everything referenced here are in `INSTRUCTIONS.md`; values/behavior rules are in `soul.md`; repo layout is in `CLAUDE.md`.

**Post-MVP:** identity and session issuance were split apart post-Stage-4 — `mintSessionToken`/RBAC/role-allowlist are now permanent and shared by every identity path; `POST /auth/dev-login` (env-gated) and Google OAuth (`arctic`) both feed the same primitives with no changes to them. Not re-derived here; see the commit/PR for the design, or ask to have it formalized back into a stage doc.

## Progress at a glance

| Stage | Status |
|---|---|
| 1. Foundation — auth, gateway, data layer, harness skeleton | **Complete** — gate passes, see `docs/stage-1-foundation.md` |
| 2. Core interview loop — resume, questions, follow-ups, memory, timing | **Complete** — gate passes, see `docs/stage-2-interview-loop.md` |
| 3. Voice, coding round, monitoring | **Complete** — gate passes, see `docs/stage-3-voice-and-coding.md` |
| 4. Reporting, Admin, hardening | **Complete** — gate passes, see `docs/stage-4-reporting-and-admin.md` |
| 5. LLM-backed agents, structured tool calling, session archival | **Complete** — gate passes, see `docs/stage-5-llm-and-archival.md` |
| 6. Tiered concept-escalation model (systemBlueprint) | **Complete** — gate passes, see `INSTRUCTIONS.md §12` |
| 7. Admin directory, profile drill-down, interview scheduling | **Complete** — gate passes, see `ADMIN_FEATURE_PROMPT.md` |
| 8. UI foundation — Tailwind v4 + shadcn/ui across every page | **Complete** — gate passes, see `CLAUDE.md §15` |

---

## Stage 1 — Foundation

Auth, gateway, data layer, and a harness that can move a session through states with no real agent intelligence yet.

**Build**
- [x] Scaffold repo per `CLAUDE.md §3` (`/apps`, `/agents`, `/mcp-servers`, `/packages`, `/infra`, `/docs`) — npm workspaces; one package per agent and per tool
- [x] Postgres schema for `User`, `Session`, `TopicPlanEntry`, `Question`, `Answer`, `Evaluation`, `Report` (`INSTRUCTIONS.md §6`) — `apps/gateway/migrations/001_init.sql`, plus `session_state_transitions`, `passcode_reset_tokens`, `telemetry_events`
- [x] Redis wiring for live session state and timers — `apps/gateway/src/storage/redis.ts` (device checks, session MCP tokens, segment timers, rate-limit counters)
- [x] `POST /auth/login`, `POST /auth/reset-passcode/request`, `POST /auth/reset-passcode/confirm` — passcodes stored as salted hashes only (`INSTRUCTIONS.md §7–8`) — scrypt; reset tokens stored hashed, single-use, short-lived
- [x] Role-based access middleware (`admin` / `student`) enforced at the gateway, not just the frontend — `apps/gateway/src/http/middleware/auth.ts`
- [x] MCP Gateway skeleton: auth, per-session rate limiting, auto-emitted `tool_called` telemetry span — `apps/gateway/src/mcp/gateway.ts`, also validates request *and* response against `/packages/mcp-schemas`
- [x] Harness Agent skeleton: session state machine per `INSTRUCTIONS.md §3` (states wired as no-ops) — `agents/harness-agent`; `Session.state` writes are capability-gated to the harness
- [x] `packages/shared-types` and `packages/mcp-schemas` scaffolding, even if mostly empty stubs — schemas are real for all six tools; agent method schemas tighten in the stage that implements them

**Stage gate — testing instructions**
1. [x] Unit test passcode hashing: assert the plaintext value is never present anywhere in the `User` row or in logs. — `apps/gateway/tests/passcode.test.ts`
2. [x] Contract test `/auth/login`: student token rejected on any `/admin/*` route (expect 403); admin token behaves the same on student-only routes. — `apps/gateway/tests/auth-rbac.test.ts`
3. [x] Create a `Session` via `POST /sessions`, confirm it starts in `CREATED`, then manually drive it through `CONFIG -> TELEMETRY_CHECK` and confirm each transition is only ever made by the Harness Agent (nothing else writes `Session.state`). — `apps/gateway/tests/session-state.test.ts`, including forged-grant and no-grant attempts
4. [x] Fire one dummy MCP tool call through the gateway and confirm a `tool_called` telemetry event lands with latency and status — before writing any real tool, prove the instrumentation path works. — `apps/gateway/tests/mcp-gateway.test.ts` via the `_dev.ping` server; `POST /internal/mcp/call` does the same by hand
- **Gate:** ✅ **passed** — `npm test` (54 tests) covers all four, plus `tests/e2e/stage1-foundation.test.ts` which walks login → RBAC → session creation → `CREATED → CONFIG → TELEMETRY_CHECK → CALIBRATION` → MCP call → audit trail in one run, with every agent still a no-op. Run `npm run typecheck` alongside it.

**Notes for Stage 2**
- Storage has two drivers behind one port: `STORAGE_DRIVER=memory` (default, no infra) and `postgres`. Keep new persistence behind the same ports so tests stay infra-free.
- Every agent/tool is registered with the MCP Gateway and answers `not_implemented` with its target stage. Implementing one means replacing that body — the routing, schema and telemetry path around it already works.
- MCP servers currently run in-process behind the `McpServerHandler` interface. Swapping in the official MCP SDK transport is a change to that seam only.

---

## Stage 2 — Core interview loop

Get a full text-only interview working: resume in, calibrated and quota-capped questions out, follow-ups, timing, memory. No voice, no coding round yet.

**Build**
- [x] Resume Parser Tool (MCP server) + Resume Service Agent: `topic_relevance[]` and `jd_fit` output (`INSTRUCTIONS.md §4.2`) — real pdf/docx/txt/md extraction; every `evidence` string is a verbatim resume line
- [x] Eval Tool with a first versioned rubric (`rubric_id: "behavioral_v1"`) — plus `technical_v1` and `coding_round_v1`; persists an `Evaluation` per call
- [x] Question Agent: topic-plan generation + quota enforcement (`INSTRUCTIONS.md §4.3`) — floor 1 / ceiling 3 enforced in the agent *and* in the JSON Schema
- [x] Follow-up Question Agent — probes a named gap in the answer; refuses to probe a low-confidence transcript
- [x] Memory Agent: `session_context` incl. `topic_counts` (`INSTRUCTIONS.md §4.7`) — counts derived from persisted questions, so they cannot drift from what was asked
- [x] Time Tracking Tool + Time Tracking Agent — `nudge` before `expired`, paused time excluded from the budget
- [x] Interview Config page (role, job description, resume upload/delete) wired to the Resume Service Agent — `apps/web`, Next.js
- [x] `QUESTION_LOOP` running end-to-end with typed answers only

**Stage gate — testing instructions**
1. [x] Run the Resume Parser against 3–5 sample resumes of different formats/lengths; confirm every `topic_relevance` entry traces back to actual resume text. — `apps/gateway/tests/resume-parsing.test.ts`; four resumes (txt, md, docx, pdf) of varied length plus the unreadable/scanned case. The hand spot-check is automated as an exact-substring assertion, so paraphrasing fails the build.
2. [x] Unit test topic-plan generation: floor (1), ceiling (3), and a `required_topic` with zero resume relevance still gets a slot. — `apps/gateway/tests/topic-plan.test.ts`
3. [x] Topic excluded once capped; override only after every cap is hit, with `quota_override: true` set and logged. — `topic-plan.test.ts` for the selection rule, `question-loop.test.ts` for the `quota_override_used` telemetry event
4. [x] Scripted candidate persona through `CONFIG -> CALIBRATION -> QUESTION_LOOP` by typed text; question set topic-balanced and matching `topic_plan`. — `question-loop.test.ts`
5. [x] Upload a resume then delete it; confirm the stored file is actually gone. — `question-loop.test.ts`, asserting against the file store directly (also covers replace-hard-deletes-the-old-file)
- **Gate:** ✅ **passed** — `npm test` (102 tests). A full session runs start-to-finish with typed Q&A and the stored transcript matches what the frontend was shown, field for field.

**Known limitation carried into Stage 3**
- No agent calls an LLM yet. Every judgement (topic relevance, question selection, follow-up, scoring) is rule-based behind a single swappable function per agent — deterministic and testable without an API key, but not yet the Claude-backed behaviour `INSTRUCTIONS.md §10` assumes. See `docs/stage-2-interview-loop.md` §"The model seam".

---

## Stage 3 — Voice, coding round, monitoring

Layer on the Telemetry Check page, text-to-speech/speech-to-text, the coding round, and consent-gated monitoring.

**Build**
- [x] Speech Service Tool: `synthesize_speech` + `transcribe_speech`, callable only by the Harness Agent (`INSTRUCTIONS.md §5.6`) — implemented via `sherpa-onnx-node` (TypeScript-native, self-hosted ONNX runtime; no Python sidecar, no cloud API; resolves the open question in `INSTRUCTIONS.md §10`) — `mcp-servers/tool-speech-service`, with a deterministic fixture provider when the models aren't on disk
- [x] Telemetry Check page: mic/speaker device check + consent capture UI (telemetry, clipboard monitor, audio recording) — `apps/web/app/interview/[id]/telemetry-check`
- [x] Consent enforced at the tool level, not just the UI (`start_monitor` rejects a missing/invalid `consent_token`) — `mcp-servers/tool-clipboard-monitor`
- [x] Coding Agent + isolated sandboxed code execution runner — `agents/coding-agent`, `runner.ts` spawns a constrained child
- [x] Clipboard Monitor MCP server — `mcp-servers/tool-clipboard-monitor`
- [x] WebSocket audio events: `submit_answer_audio`, question/follow-up `audio_url` playback, `submit_answer_text` fallback — `apps/gateway/src/http/live-channel.ts`
- [x] Low-confidence transcript handling: re-prompt or drop to typed fallback, never silently scored — `agents/harness-agent/src/interview.ts` (`transcribe`)

**Addition — Signup page**
- [x] Signup page: self-service student registration (`POST /auth/register`), distinct from the existing operator-provisioned account creation (`INSTRUCTIONS.md §3.2`); role is always fixed to `student` and is never self-assignable — `apps/web/app/signup`

**Stage gate — testing instructions**
1. [x] Unit test `synthesize_speech` latency against sample question text — confirm it's under the 1.5s budget (`INSTRUCTIONS.md §9`). — `apps/gateway/tests/voice.test.ts` gate test 1
2. [x] Unit test `transcribe_speech` accuracy against a small set of audio clips with known transcripts. — `voice.test.ts` gate test 2; word-overlap scoring against real ASR, exact match against the fixture provider
3. [x] Manual run of the full voice loop: question is spoken, candidate answers by mic, transcript shown matches what was said, and the Follow-up Question Agent's probe is clearly based on that transcript. — automated as `voice.test.ts` gate test 3, since a manual run can't assert the transcript never reached Eval silently
4. [x] Force a low-confidence transcription and confirm the system re-prompts or falls back to typed text — confirm it does *not* pass that transcript into Eval or Follow-up silently. — `voice.test.ts` gate test 4
5. [x] Security test: attempt to start the Clipboard Monitor with no `consent_token` — must be rejected at the tool layer even if you bypass the UI. — `apps/gateway/tests/coding-monitoring.test.ts` gate test 5
6. [x] Trigger a paste event during the coding round and inspect the stored telemetry/DB record directly — confirm only a boolean + timestamp is stored, never the pasted content. — `coding-monitoring.test.ts` gate test 6
7. [x] Sandbox escape test: submit code that attempts filesystem or network access outside the sandbox; confirm it's blocked and doesn't affect the Coding Agent process. — `coding-monitoring.test.ts` gate test 7 (filesystem, network, process spawn, infinite loop)
- **Gate:** ✅ **passed** — `npm test` (137 tests at Stage 3 completion) plus `tests/e2e/stage3-voice-and-coding.test.ts`, which walks signup → voice Q&A → coding round with consented paste detection → wrap-up in one run. See `docs/stage-3-voice-and-coding.md`.

---

## Stage 4 — Reporting, Admin, hardening

Close the loop: reports get generated, persisted, and are visible to the right people only — then stress-test the whole thing.

**Build**
- [x] Report Agent: competency scores, evidence-linked strengths/focus areas, required disclaimer (`INSTRUCTIONS.md §4.8`) — `agents/report-agent`; every `evidence` entry is a verbatim slice of an actual answer transcript, a topic with nothing scoreable gets no score at all
- [x] `Report` persisted with `candidateId` so Admins can query across candidates — `apps/gateway/src/storage/interview-{memory,postgres}.ts` (`ReportStore`), backed by the `reports` table from Stage 1
- [x] Student Home page: past interview stats — `apps/web/app/home`
- [x] Admin Home dashboard: aggregated view across all candidates — `apps/web/app/admin`
- [x] `GET /admin/reports`, `GET /admin/reports/:sessionId` with RBAC enforced — `apps/gateway/src/http/routes/admin.ts`
- [x] Retention/deletion jobs: purge raw resume/audio/transcripts per the policy in `INSTRUCTIONS.md §8` — `agents/harness-agent/src/index.ts` (`generateReport`), runs once at the moment `INSTRUCTIONS.md §8` actually names: right after the report is persisted
- [x] Load test on the Harness Agent's routing path under concurrent sessions — `apps/gateway/tests/reporting.test.ts` gate test 5

**Stage gate — testing instructions**
1. [x] Unit test the Report Agent: assert every competency score has a non-empty `evidence` reference, and that the agent refuses to output a score it can't evidence (feed it a thin/ambiguous transcript and confirm it says so rather than guessing). — `apps/gateway/tests/reporting.test.ts` gate test 1 (4 cases, incl. the coding round folded in as its own evidenced competency)
2. [x] RBAC test: a student token gets 403 on `GET /admin/reports`; an admin token cannot hit any "start session as candidate" endpoint. — `reporting.test.ts` gate test 2, plus existing coverage in `auth-rbac.test.ts`
3. [x] Manual check: complete a session as a student, then confirm it appears on the Admin dashboard without the student's session still being connected. — automated as `reporting.test.ts` gate test 3: the admin read is a separate request with no reference to the student's session or token
4. [x] Retention test: after `REPORT_GENERATION`, confirm raw resume/audio/full transcripts are deleted per policy (or retained only where the candidate explicitly opted in) — check storage directly. — `reporting.test.ts` gate test 4, both branches
5. [x] Load test: run N concurrent sessions through the Harness Agent and confirm no state bleed between sessions — `topic_counts`, timers, and transcripts stay isolated per `session_id`. — `reporting.test.ts` gate test 5 (5 concurrent sessions, varied roles)
6. [x] Full regression: run 5 scripted candidate personas (varied roles, resumes, JDs) end-to-end and read their reports by hand for fabricated claims or inconsistent scoring, per `soul.md §3`. — `reporting.test.ts` gate test 6; the "read by hand" check is automated as an exact-substring assertion on every cited evidence quote, so a fabricated or paraphrased claim fails the build
- **Gate / MVP sign-off checklist:**
  - [x] All Stage 1–3 gates still pass (run them again — Stage 4 changes touch shared state) — `npm test` runs all 152 tests together
  - [x] No raw PII (resume, audio, clipboard content) found in logs, telemetry, or admin-visible data — telemetry sanitisation from Stage 1 (`mcp-gateway.test.ts`) is unchanged; Admin-visible data is structurally limited to `Report` fields, which have no resume/audio/transcript field to leak
  - [x] Every report in the regression run cites real evidence for every score — gate test 6
  - [x] RBAC holds under direct API calls, not just through the UI — gate test 2
- **Gate:** ✅ **passed** — `npm test` (152 tests). See `docs/stage-4-reporting-and-admin.md`.

---

## Stage 5 — LLM-backed agents, structured tool calling, session archival

**Status: Complete.** Design is written up in `INSTRUCTIONS.md §11`; the ethical/behavioral constraints are folded into `soul.md` at each relevant principle (search "Stage 5 addition"). What was built and why, including the decisions that departed from the illustrative code in §11: `docs/stage-5-llm-and-archival.md`.

**Build**
- [x] `packages/llm-client`: `ToolDefinition`, `PromptRegistry`, `createChatModel` (Bedrock/OpenRouter/Groq), `structuredCall` with schema re-validation + one retry (`INSTRUCTIONS.md §11.5`) — plus a deterministic `fixture` provider, so the whole path runs with no API key and CI exercises it for real
- [x] `packages/llm-client/grounding.ts`: cheap substring-match pass + expensive LLM-fallback pass (`INSTRUCTIONS.md §11.3`) — the expensive pass is implemented but off by default; it costs a second round trip inside the §9 budget
- [x] LLM Provider Tool (`INSTRUCTIONS.md §5.7`) wired into the MCP Gateway like every other tool — `mcp-servers/tool-llm-provider`. `.env.example` ships `LLM_PROVIDER=fixture` rather than `groq`: a checked-in default that silently needs a paid API key is a worse default than one that works offline, and groq is one line away with its terms documented alongside
- [x] Resume Service Agent: `jd_fit.rationale` + `jd_fit.topic_relevance` generation, grounded, `promptVersion` stamped (`INSTRUCTIONS.md §4.2`)
- [x] Question Agent: question + `reference_answer` generated together, `reference_answer` routed through the Memory Agent only, never into `Question` or the transcript (`INSTRUCTIONS.md §4.3`) — it is a sibling of `question` on the wire, never a field on it
- [x] Follow-up Question Agent: score-then-decide flow; primary-answer score persisted immediately as an `Evaluation`; follow-up-exchange score written onto `answers.follow_ups[i]` (`INSTRUCTIONS.md §4.4`, §11.2)
- [x] Memory Agent: session-scoped store for `reference_answer` and in-progress `jd_fit` fields (`INSTRUCTIONS.md §4.7`) — over a narrow `SessionScratchStore` port, Redis-backed in production
- [x] Migrations: `users.full_name`/`department`/`program_year`, `evaluations.prompt_version` on the primary Postgres (`003_stage5_llm_and_archive.sql`); `session_archives` on the **Supabase** instance (`migrations/supabase/001_session_archives.sql`, applied by its own `npm run db:migrate:archive`)
- [x] Profile-completion UI (Signup or a new profile step) to collect `fullName`/`department`/`programYear` — archiving refuses without these (`INSTRUCTIONS.md §11.4`) — at signup, with `PATCH /me/profile` and a Home-page prompt as the catch-up path for accounts that predate the fields
- [x] Archive-compile job: triggered by the Harness Agent at `COMPLETED`, strictly after the existing Stage 4 retention job, writes one `SessionArchive` per session (`INSTRUCTIONS.md §11.4`) — `agents/harness-agent/src/archive.ts`, which contains no redaction logic by design: ordering is the guarantee
- [x] `GET /admin/archives/:sessionId` + `GET /admin/archives/:sessionId/download`, RBAC-enforced, `archive_downloaded` telemetry on every read (`INSTRUCTIONS.md §7`, §8) — plus `GET /admin/archives` for the listing
- [x] Stateless-reducer lint rule: a custom ESLint (or equivalent) rule banning non-const module-scope state under `/agents/**`, so the contract in `INSTRUCTIONS.md §11.1` is enforced by CI, not just documentation — `packages/agent-lint`, a TypeScript-AST check rather than ESLint (the repo has no ESLint install; see the doc)
- [x] LangSmith tracing wired but env-gated off outside local development; `.env.example` documents data-use/retention terms for Groq, Bedrock, OpenRouter, and LangSmith — the gate *clears* `LANGCHAIN_TRACING_V2`/`LANGSMITH_TRACING` rather than merely not setting them, so an inherited value cannot enable it

**Stage gate — testing instructions**
1. [x] Contract test: feed `structuredCall` a deliberately malformed provider response; confirm it's rejected by the Zod schema (the same one registered in `/packages/mcp-schemas`) before it ever reaches an agent's return value, and that a second malformed response after one retry raises `StructuredCallError` rather than coercing. — `apps/gateway/tests/llm-client.test.ts` gate test 1. "The same one" is literal: the Ajv registry compiles `z.toJSONSchema()` of the Zod object, and the test asserts both reject the same payload.
2. [x] Grounding test: feed the Resume Service Agent a resume/JD pair plus a fixture that forces an ungrounded `jd_fit.rationale` claim; confirm `groundingCheck` returns `false` for that field, the agent returns `insufficient_signal: true` on it, and the rest of `jd_fit` is still returned. — `llm-client.test.ts` gate test 2, including the required-vs-optional split: an ungrounded `targeted_gap` rejects the whole follow-up response, an ungrounded `rationale` costs only that field.
3. [x] Prompt-version regression test: pin a fixture input per LLM-backed agent; snapshot the `promptVersion` tag on the persisted `Question`/`Evaluation`/`JdFit` record. Changing a prompt template's content without bumping its version string must fail CI. — `llm-client.test.ts` gate test 3, via a checked-in sha256 fingerprint per version; editing a prompt's text fails the build until `PROMPT_FINGERPRINTS` is updated alongside a new version string.
4. [x] Follow-up scoring test: script an answer + one follow-up exchange; confirm (a) an `Evaluation` exists for the primary answer immediately (not only after `REPORT_GENERATION`), and (b) `answers.follow_ups[0]` carries its own `score`/`rationale`/`evidence_spans`, with spans indexing into the follow-up's transcript, not the original answer's. — `apps/gateway/tests/stage5-llm-and-archival.test.ts` gate test 4; the span check asserts both in-range and non-empty against the follow-up's own text, and that no second top-level `Evaluation` was created.
5. [x] Stateless reducer test: run the same request+context against two separately-instantiated processes of the same agent (one fresh, one that already served other sessions) and assert byte-identical output; plus the ESLint rule from the Build list actually fails on a fixture agent file with module-scope mutable state. — `stage5-llm-and-archival.test.ts` gate test 5, for the Question and Follow-up Agents, plus both directions of the lint rule (a session-keyed cache fails; the `Readonly` constants a real agent has do not).
6. [x] Archive-ordering test: complete a session, confirm exactly one `session_archives` row is written on the Supabase instance, and that `document.answers[].transcript` is redacted whenever the primary `answers.transcript` was redacted — the archive must never be more permissive than the primary record at write time. — `stage5-llm-and-archival.test.ts` gate test 6, both branches (redacted, and retained where the candidate opted in), plus the §11.4 step 2 refusal when the candidate has no name.
7. [x] Archive RBAC test: a student-role token gets 403 on both `GET /admin/archives/:id` and its `/download` variant; confirm `archive_downloaded` telemetry fires with sanitized payload (no transcript/resume content) on a successful admin download. — `stage5-llm-and-archival.test.ts` gate test 7; the payload's key set is asserted exactly, so a future field carrying content fails the build.
8. [x] Third-party data-flow test: `.env.example` is checked in CI for the presence of documented data-use/retention notes for `GROQ_API_KEY`, the active Bedrock/OpenRouter config, and `LANGSMITH_*`; confirm LangSmith tracing is off by default when `NODE_ENV !== "development"` and no explicit opt-in env var is set. — `llm-client.test.ts` gate test 8, which also asserts the gate *clears* an inherited `LANGCHAIN_TRACING_V2`.
- **Gate:** ✅ **passed** — `npm test` (205 tests) covers all eight and re-runs every Stage 1–4 gate unchanged, plus `tests/e2e/stage5-llm-and-archival.test.ts`, which walks signup-with-profile → grounded JD-fit → generated question loop with scoring at follow-up time → report → retention → archive → admin download in one run. `npm run lint` now also runs the stateless-reducer rule. See `docs/stage-5-llm-and-archival.md`.

**Note on the Stage 1–4 re-run.** Getting the existing suite green first surfaced two pre-existing problems, both fixed before any Stage 5 code landed (commit `6cea3cc`): vitest's per-file module isolation defeated the Speech Service's provider cache, so every test file reloaded ~300MB of ONNX models and four concurrent loads pushed unrelated suites past their timeouts (`npm test` was 176s with 13 files red); and the fixture speech provider derived confidence by comparing an RMS against a peak, capping its own clean audio at 0.5 against a 0.6 floor, so no fixture-synthesised answer could ever be accepted on a machine without the models. Neither was introduced by Stage 5, but both had to be true before "all Stage 1–4 gates still pass" meant anything.

**Notes for whoever implements this stage** *(both were followed)*
- Build `packages/llm-client` and the LLM Provider Tool first, in isolation, with fixture/mock providers — same pattern as Stage 1's `_dev.ping` before any real tool existed. Don't wire a real agent to a real Groq call until `structuredCall` + grounding are independently tested.
- The three LLM-backed agents keep their existing Stage 2 deterministic/rule-based path as the fallback on `provider_unavailable` or a repeated grounding failure (`INSTRUCTIONS.md §5.7`) — don't delete it, route to it.

**Carried into whatever comes next**
- **No real provider call has been made from this repo.** Everything runs against the deterministic fixture model, which produces schema-valid, genuinely grounded output built from the caller's own source documents (the `FixtureSpeechProvider` pattern). The Groq/Bedrock/OpenRouter paths are wired and typed but unexercised — the first real run should be watched for providers that ignore their own structured-output contract, which is exactly what the retry and the `StructuredCallError` fallback exist for.
- **The expensive grounding pass is implemented but no agent enables it.** It is a per-call flag (`llm_grounding_fallback`); measure it against the §9 budget before making it a default.
- **Nothing prunes the archive.** §11.4 calls it a copy for admin export rather than a second source of truth, and a retention policy for the archive itself is not specified anywhere — it was not invented here. If archives are meant to expire, that needs deciding.

---

## Stage 6 — Tiered concept-escalation model (`systemBlueprint`)

**Status: Complete.** Design is written up in `INSTRUCTIONS.md §12`. Reshapes the flat `difficulty: 1-5` + `expectedSignals[]` question model into the three-tier `extractionMatrix` shape, and formalizes the Follow-up Agent's existing gap-detector output into an explicit `nextActionGenerator` directive (`escalate` / `pivot` / `drill_down`, plus `conclude` which only the Harness Agent sets). Additive throughout: every new field is optional on the wire and nullable in Postgres, so nothing from Stages 1–5 stopped working mid-upgrade — the full 205-test Stage 1–5 suite passes unchanged, plus a new 14-test file for the tier/concept behavior itself.

**Build**
- [x] `packages/interview-domain/blueprint.ts`: `buildSystemBlueprint(role)` — `roleProfileId`, `domainFocus`, and one `EvaluationTopicBlueprint` per bank topic, each with a 3-tier `extractionMatrix` (`targetConceptIds` + `escalationTriggerCondition`, null at tier 3) and a `dynamicFraming.resumeContextIntegrationRule` (the rule for picking a resume anchor — not a resolved value; resolution is per-session, in the Question Agent)
- [x] `question-bank.ts`: `BankQuestion` gains `tier` (derived from `difficulty` via `tierOf` — the existing 2/3/4-per-topic ladder *was* a tier ladder already) and `conceptIds` (derived from `expectedSignals` via `conceptId`); `difficulty` is unchanged and still what report/UI code reads
- [x] Eval Tool: `verify_concepts(answer_transcript, concepts[])` — same evidence-first term-matching discipline as `evaluate_answer`'s rubric signals, never an LLM guess (`mcp-servers/tool-eval`)
- [x] Question Agent: per-topic tier selection (`nextTierFor`/`pickByTier`) replaces the single global difficulty curve for topics the Memory Agent has a tier on record for; a topic with no tier yet falls back to the pre-Stage-6 curve unchanged — verified by the full pre-existing `topic-plan.test.ts` suite passing with zero edits
- [x] Follow-up Agent: reports the deterministic gap detector's *full* hit list as `antiPatternsDetected` (not just the one it probes), calls `verify_concepts` against the triggering question's `targetConceptIds`, and computes `nextActionGenerator` deterministically — the LLM call still only phrases the probe, never decides escalate/pivot/drill_down
- [x] Memory Agent: `get_session_context` gains `topic_tier`, derived from persisted `Question.tier` the same way `topic_counts` is derived — no new store
- [x] Harness Agent: threads `topic_tier` + per-topic score history into `get_next_question`, and the triggering question's `tier`/`targetConceptIds` into `consider_follow_up`; persists `tier`/`targetConceptIds` on `Question` and `extraction`/`nextAction` on `Answer` via a new `AnswerStore.recordExtraction`
- [x] Migration `004_stage6_tiered_concepts.sql`: nullable `questions.tier`, `questions.target_concept_ids`, `answers.extraction`, `answers.next_action`
- [x] `question-agent/v2` prompt (tier-aware instructions) registered alongside `v1`, which stays resolvable for old `Question.promptVersion` stamps — the fingerprint gate test (Stage 5, gate test 3) is what caught the first attempt at editing `v1`'s system text in place

**Stage gate — testing instructions**
1. [x] `systemBlueprint` shape test: every topic has exactly 3 tiers with non-empty `targetConceptIds`, and only tier 3 has a null `escalationTriggerCondition`. — `apps/gateway/tests/tiered-concepts.test.ts`
2. [x] Per-topic escalation test: a strong score run at a topic's tier escalates it, a weak run steps it back, an ambiguous run holds, and — critically — one topic's scores never move a different topic's tier. — `tiered-concepts.test.ts`
3. [x] Concept verification test: `verify_concepts` is evidence-first (verified only when the label's words are actually in the transcript) for both a real transcript and an empty one. — `tiered-concepts.test.ts`
4. [x] Anti-pattern completeness test: the gap detector's full hit list is reported, not just the one it probes; a clean answer reports none. — `tiered-concepts.test.ts`
5. [x] Redaction-safety regression: `answers.extraction` must never carry a second, redaction-blind copy of the transcript — caught live by the existing archive-ordering gate test (Stage 5, gate test 6) when `transcribedInputChunk` was first (wrongly) persisted; fixed by making the field ephemeral-only and stripping it in `AnswerStore.recordExtraction` before the write. — `tests/e2e/stage5-llm-and-archival.test.ts`, unchanged, now passing with the new field present
6. [x] Backward-compatibility regression: the full Stage 1–5 suite (205 tests) passes with zero test edits beyond two hardcoded `question-agent/v1` string literals updated for the legitimate `v2` prompt bump.
7. [x] Live-session test: drive the real Question Agent and Follow-up Agent MCP servers through the real gateway (`/internal/mcp/call`, same dev passthrough `mcp-gateway.test.ts` uses) for one topic across three real round trips, and assert on the values actually returned — not a pure-function unit test. Added after the first pass only proved the logic in isolation; a first attempt driving a realistic multi-topic session found that the pre-existing session-wide difficulty curve (Stage 2) escalates fast enough on an all-strong-answers script that most topics' *opening* question already lands at tier 2, which is a real property of the interaction between the old global curve and the new per-topic one, not a bug — the test now drives one topic directly to show the tier 1 → 2 → 3 mechanism unambiguously. — `apps/gateway/tests/tiered-live-session.test.ts`
8. [x] `liveSessionState` composed-snapshot test: a real `POST /sessions/:id/answers` call returns one coherent `live_session_state` object (`§12.6`) with every nested field populated by a real value from that turn — `session_id`/`candidate_id`/`active_topic_id`, `session_metrics` (elapsed time from the Time Tracking Tool, this-turn competency score, current tier), `context_engine` (a real resume evidence line, the real question text), `extraction_processor`, and `next_action_generator`. Added after Stop-hook feedback correctly pointed out that the first pass only ever showed individual fields (`question.tier`, `anti_patterns_detected`, ...) across separate calls, never one unified snapshot object the way the write-up's illustrative shape does. — `tiered-live-session.test.ts` gate test 8; the printed output is the actual composed object, not a hand-built example.
- **Gate:** ✅ **passed** — `npm test` (221 tests): the Stage 1–5 suite unchanged, 14 tests in `tiered-concepts.test.ts`, plus both live-session tests above.

**Deliberately not done in this stage**
- **No frontend UI for tiers/concepts.** The API surfaces `question.tier` and the answer response's `anti_patterns_detected`/`verified_concept_ids`/`unverified_concept_ids`/`next_action` (the directive string only), but `apps/web` does not render any of it yet — `target_concept_ids` is deliberately never sent to the candidate at all (same rule as `expected_signals` and `reference_answer`: rubric-adjacent hints don't reach the person being evaluated). Surfacing this in the Interview Environment or the Report page is unscoped design work, not a schema gap.
- **`nextActionGenerator.systemDirective` doesn't drive session flow yet.** `escalate`/`pivot` currently inform the *next* question's tier (via the per-topic score history the Harness Agent already threads through) but nothing reads the directive value itself to, say, skip straight to a different topic on `pivot`. It's computed, persisted, and returned — wiring it into `QUESTION_LOOP`'s actual routing is a reasonable next increment, not done here.
- **`LLM_PROVIDER` ships as `fixture`, not `groq`.** The Build list called for `groq` as the `.env.example` default; a checked-in default that silently requires a paid API key is a worse default than one that works offline, so the switch is one line with its terms documented alongside. Change it when a key is actually provisioned.
---

## Stage 7 — Admin directory, profile drill-down, report download, interview scheduling

**Status: Complete.** Spec and the full reconciliation against what the codebase already had: `ADMIN_FEATURE_PROMPT.md`. Three parts on top of the Stage 4 admin dashboard — a searchable candidate directory with aggregate stats, a per-candidate drill-down that reuses the candidate's own report renderer, and admin-assigned interviews that seed a session without bypassing anything the student would otherwise do.

Additive throughout: every Stage 1–6 wire shape, DB column and test still holds, and the 228-test Stage 1–6 suite passes with zero edits.

**Build**
- [x] `packages/shared-types/scheduling.ts`: `ScheduledInterview` + the enum sets (`INTERVIEW_TYPES`, `SCHEDULE_DIFFICULTIES`, `RECURRENCES`, `NOTIFY_CHANNELS`, `SCHEDULE_STATUSES`), the directory/profile view types, and `effectiveStatus`/`isStartable`/`runsCodingRound`/`meanCompetencyScore`
- [x] Migration `006_admin_scheduling.sql`: `scheduled_interviews` (one row per candidate per assignment), plus the `(candidate_id, created_at)` indexes the directory aggregate needs. **No `users.department` column** — migration 003 already added it in Stage 5 and the directory filters that one
- [x] `ScheduledInterviewStore` port with both drivers (`memory.ts`, `scheduled-postgres.ts`); a batch create is one transaction, so twelve assignments either all land or none do
- [x] `ReportStore.aggregateByCandidate()` — per-candidate counts/average/last-interview computed by the store (SQL in Postgres, one pass in memory) rather than by fetching every report. `SessionStore.countsByCandidate()` and `UserStore.listByRole()` alongside it
- [x] `src/admin/directory.ts` — search/filter/sort/paginate as a pure function over three bounded inputs; `src/admin/scheduling.ts` — draft validation plus the separate admin and student projections
- [x] Gateway: `GET /admin/users`, `GET /admin/users/:userId`, `GET /admin/users/:userId/reports/download`, `GET /admin/reports/:sessionId/download`, `GET|POST /admin/scheduled-interviews`, `POST /admin/scheduled-interviews/:id/{cancel,reschedule}`, `GET /me/scheduled-interviews`, and `scheduled_interview_id` on `POST /sessions`
- [x] `apps/web`: `/admin/users`, `/admin/users/[userId]`, `/admin/scheduled`, `/admin/schedule`, plus the assigned-interviews section on the student Home page
- [x] `app/components/report-view.tsx` — the report renderer extracted from the candidate's report page so the admin drill-down reuses it instead of growing a second copy
- [x] Telemetry: `admin_reports_downloaded`, `interviews_scheduled`, `scheduled_interview_cancelled`, `scheduled_interview_started`

**Stage gate — testing instructions**
1. [x] Directory aggregation test: a candidate's average is the mean of each report's OWN mean (not every score pooled, which would over-weight a session that scored more competencies); a candidate with no reports is `null`, never `0`; a started-but-unfinished session counts as activity; the route's numbers and the store's own aggregate agree. — `apps/gateway/tests/admin-directory-scheduling.test.ts` gate 1
2. [x] Filter/sort/paging test: search on name and email, department filter, score filter EXCLUDES unscored candidates rather than treating them as zero, null scores sort last in both directions, paging is server-side over the filtered set, and no row appears on two pages. — gate 2, plus gate 11 for the builder in isolation (page-size clamp, stable ties)
3. [x] Data-boundary test: a session with a real resume file and a real answer transcript on disk, then every admin route called and its response asserted not to contain those literal strings or the resume ref — not a field-name allowlist a future field could sidestep. Also asserts there is no `/admin/` transcript route at all. — gate 3
4. [x] RBAC test: every route this stage added returns 403 for a student token and 401 unauthenticated, enumerated as a list so a new route added without a gate fails here; and `GET /me/scheduled-interviews` returns 403 for an admin token, symmetric with every other role gate. — gate 4
5. [x] Scheduling lifecycle test: batch assign → candidate sees it → start → an ordinary `CREATED` session seeded with the assignment's role/JD → assignment marked `started` with the session id → a second start refused. Plus cross-candidate refusal (404, not 403, so ids cannot be enumerated), window-not-open and past-deadline refusals, cancel, and refusing to cancel one already started. — gate 5
6. [x] **Consent test:** a schedule carrying `consent_defaults`/`consent` is REJECTED rather than ignored (silently dropping it would leave the admin believing they had answered it); a session seeded from a schedule has every consent flag false, including when the assignment enables a coding round; the student projection carries a note saying consent is still theirs; and the assigned session is still gated behind the device check. — gate 6
7. [x] Student-projection test: the admin wire shape carries `notes`, the student one has no `notes` or `created_by` KEY at all, and the projection's exact key set is asserted — so a new field on `ScheduledInterview` cannot reach a candidate by default. — gate 7
8. [x] Validation test: deadline not after the window, out-of-range and non-integer durations, unparseable timestamps, empty candidate list, unknown enum values, scheduling for a non-student, and a batch containing one bad id writing NOTHING. — gate 8
9. [x] Profile drill-down + download test: history and an oldest-first score trend, session status derived from `Session.state` with a null duration while running, 404 for a non-student, single and bulk report download with `content-disposition`, and the `admin_reports_downloaded` audit payload's key set asserted exactly so a future field carrying content fails the build. — gate 9
10. [x] Derived-status test: `pending` → `sent` → `missed` purely from the clock with nothing writing a row, and terminal/candidate-driven states (`cancelled`, `started`, `completed`) never overridden by it. — gate 10
- **Gate:** ✅ **passed** — `npm test` (277 tests): the Stage 1–6 suite unchanged at 228, plus 49 here. `npm run lint` clean, `npm run build:web` builds all four new routes.

**Decisions worth knowing**
- **Consent is not schedulable, and the API refuses it.** `soul.md` §"Consent-first monitoring" makes consent the candidate's to give. The spec asked for this to be decided explicitly rather than left ambiguous: there is no `consentDefaults` field, no consent column on `scheduled_interviews`, and a request carrying one gets a 400. A schedule can say a coding round *will be offered*; the Telemetry Check page remains the only writer of `sessions.consent`.
- **`sent` and `missed` are derived, not stored.** Nothing in this repo runs on a timer, so a stored `sent` would be a lie until some job flipped it and a stored `missed` would be a lie the moment a deadline passed. Only the four states something actually writes are storable; the DB CHECK constraint enforces that.
- **The directory pages in the gateway, not in SQL.** Its filters span three stores and a candidate's average score is not a column on any of them, so a `LIMIT`/`OFFSET` at the storage layer would page the wrong set. The thing the spec actually rules out — N+1 report fetches — is gone: the page costs three aggregate queries plus one avatar lookup per *displayed row*, bounded by page size rather than by directory size.

**Deliberately not done in this stage**
- **`durationMinutes` is stored and shown but does not yet shorten the session.** The Time Tracking Tool takes a budget; wiring the assignment's duration through to override the default segment budget is a real change to `beginInterview`'s contract and was not made blind. The number is carried end to end and displayed to the candidate, so wiring it is additive when someone wants it.
- **`recurring` is stored, never expanded.** There is no scheduler process, so a `weekly` assignment does not spawn next week's row. It is recorded as the admin's intent; generating the series needs a job runner this repo does not have.
- **Email notification is recorded, not delivered.** The only mailer is `MemoryResetMailer`, dev/test-only. `notify_via: ["email"]` is stored and the scheduling form says plainly that it is not delivered; the in-app channel is the one that works.
- **No PDF export.** Download follows the precedent already set by `GET /admin/archives/:id/download` — JSON with a `content-disposition` attachment header — rather than adding a PDF toolchain for one button.

---

## Stage 8 — UI foundation: Tailwind CSS v4 + shadcn/ui

**Status: Complete.** Design notes and the rules worth keeping: `CLAUDE.md §15`. Every page in `CLAUDE.md §11` rebuilt on Tailwind v4 + shadcn/ui.

**Presentation-layer only.** No API contract, request/response shape, `lib/api.ts` signature, route, gateway or agent behaviour changed. The Stage 1–7 suite passes with zero edits, which is the point: if a test had needed changing, this stage had reached past its own boundary.

**Build**
- [x] Tailwind v4 (`@tailwindcss/postcss`, no `tailwind.config.js` — theme lives in `app/globals.css` under `@theme`), shadcn/ui via `npx shadcn@latest`, `components.json`, `@/*` path alias
- [x] The Stage 1 palette re-expressed under shadcn's variable names, with the old-name → new-name mapping recorded in `globals.css`
- [x] `--warn` / `--ok` registered as a theme extension, with `--destructive` reserved for genuinely destructive controls; `Button`/`Badge`'s destructive variants read `--destructive-foreground` rather than shadcn's hardcoded `text-white`, which fails contrast against this theme's dark-mode salmon
- [x] Theme switching moves from `@media (prefers-color-scheme)` to `next-themes` (`defaultTheme="system"`, class strategy) plus a header toggle
- [x] 23 shadcn primitives under `app/components/ui`; `app/components/shell.tsx` for shared page furniture; `app/components/auth-card.tsx`, `interview-steps.tsx`, `site-header.tsx`, `admin/nav.tsx`
- [x] `lib/format.ts` — display formatters shared by candidate and admin surfaces, re-exported by `app/admin/ui.tsx`
- [x] `app/admin/ui.tsx` rebuilt on shadcn primitives; `Sparkline` → `ScoreTrend` (Recharts, hoverable, same fixed 0–5 domain)
- [x] All 14 routes migrated, one commit per page or tightly related group
- [x] The pre-Tailwind stylesheet kept as a marked transitional block through the migration, then deleted once no page referenced it
- [x] Charts split out of `admin/ui.tsx` and `report-view.tsx` into their own modules and `next/dynamic`-imported. Three chartless admin pages were importing an avatar or a badge from `admin/ui.tsx` and getting ~130 kB of Recharts with it. First Load JS: report 234 → 122 kB, admin schedule 279 → 167 kB, directory 275 → 163 kB, profile 250 → 132 kB, scheduled list 254 → 142 kB

**Stage gate — testing instructions**
1. [x] `npm test` — the Stage 1–7 suite (277 tests) passes unmodified. A presentation-layer change that breaks one of these has touched something outside its scope.
2. [x] `npm run typecheck` and `npm run build:web` clean, all 14 routes building.
3. [x] Every route renders without a Next error boundary, and the `soul.md §3` disclaimer ("Practice, not a hiring decision") is present in the markup of all 14.
4. [x] Both themes' `--warn`/`--ok` values, the `bg-warn`/`text-ok` utilities and the `prefers-reduced-motion` rule are present in the generated stylesheet.
5. [x] The shared report renderer verified against a fixture for both audiences, including the empty-evidence path.
- **Gate:** ✅ **passed.**

**Decisions worth knowing**
- **`--warn`/`--ok` are an extension, not a re-use of `--destructive`.** shadcn ships no success or warning token. This app's error states are "that didn't work" rather than "you destroyed something", and had always been amber; making them red to fit the library's vocabulary would have changed what the UI says.
- **The chart tokens are not a validated categorical palette.** They pass the check that matters for a single series (≥3:1 against the chart surface, both themes) and fail categorical separation, because this palette is deliberately low-chroma. Both charts in the app are single-series. Recorded in `globals.css` so a future multi-series chart does not assume otherwise.
- **No computed "overall score" on the report, and no aggregate average on the admin dashboard.** Both would be one line of arithmetic. The Report Agent never emitted an overall score, so showing one would be a figure with no provenance (`soul.md §"No fabrication"`); and the gateway owns the directory's average, with a test asserting it never drifts from the store's own aggregate — a second average computed in the browser is how that drift starts.

**Deliberately not done in this stage**
- **No coding-round pane in the Interview Environment.** The `coding` phase exists in the room's state union but the Coding Agent's wire messages do not reach that page, so there was nothing to lay out. Unchanged from before this stage.
- **No candidate-facing report download route.** Every report-download route on the gateway is under `/admin`. The candidate's Download button serialises the report already in memory client-side; adding an endpoint would have been a backend change.
- **No sign-out control.** There is still no way to sign out anywhere in the app, and adding one is a behaviour change rather than a redesign. `auth.clear()` exists whenever someone wants it.
- **No print stylesheet.** Download is JSON, following the precedent set in Stage 7 rather than adding a PDF toolchain.

---

## Stage 9 — interview continuity and the grading scale

**Status: Complete.** Design: `INSTRUCTIONS.md §13`. Rules worth keeping: `CLAUDE.md §16`.

Two additions that fill gaps the earlier stages left open rather than changing anything they defined. Every Stage 1–8 wire shape, DB column and test still holds; each new field is optional, and an absent one reproduces the pre-addition behaviour exactly.

**Build — continuity (`INSTRUCTIONS.md §13.1`)**
- [x] `get_next_question` gains optional `next_action` and `recent_exchanges`, both assembled by the Harness Agent (`InterviewOrchestrator._continuity`) from its own stores. Neither agent reads the other — the hop stays a harness routing decision (`CLAUDE.md §5`)
- [x] `select_next_question` honours `escalate`/`drill_down` by trying the last topic first (`_stay_on_topic`), *inside* the cap. `pivot`/`conclude`/absent leave the pre-existing ordering untouched
- [x] `followed_directive` on the response + a `directive_followed` telemetry span, emitted only when the directive actually changed the pick
- [x] `question-agent/v4` — `RECENT EXCHANGES` and `DIRECTIVE` prompt blocks, a fourth worked example showing a `same_topic` escalation, and the two new rules: never assert whether the last answer was right, never re-ask ground the window shows was covered
- [x] The trailing window added to `source_documents` so a question that transitions from the previous answer can ground its citation in that answer (§11.3)
- [x] v3 restored to its committed text and `ACTIVE_PROMPT_VERSION` moved to v4 — see "Decisions worth knowing"

**Build — grading (`INSTRUCTIONS.md §13.2`)**
- [x] `backend/app/tools/eval/grading.py` — versioned A–E bands (`grade-scale/v1`), `grade_for`, `aggregate`, `STRENGTH_LETTERS`/`STRENGTH_THRESHOLD`
- [x] `tool-eval.grade_scores`; `evaluate_answer` returns the band for the score it just produced
- [x] Report Agent calls it once per report, annotates each competency, and partitions strengths/focus areas on `is_strength` — its own `STRENGTH_THRESHOLD` deleted, `me.py` reads the tool's
- [x] The band rides the live channel too: Eval Tool → Follow-up Agent `score.grade` → `AnswerResult.evaluation.grade` → `question`/`answers` payloads
- [x] `Report.overall_grade` + `CompetencyScore.grade`; migration `008_grading.sql` (nullable `reports.overall_grade JSONB`)
- [x] Report view renders `overallGrade` verbatim and pairs every letter with its score; the room shows the per-answer band on the answer it graded

**Build — the interview room**
- [x] `celestial-backdrop.tsx` — `display.html`'s particle field ported as the room's background: same ring physics, wobble, pulsing core and trail compositing, sized to the viewport, following the app's theme rather than its own toggle, dimmed and washed so it never competes with live text. Reduced motion composes one still frame
- [x] Two columns — the conversation on the left, the controls on the right, so the answer buttons do not walk off the bottom as the transcript grows
- [x] Questions revealed *as spoken*: `onboundary` char indices where the engine reports them, an audio-clock fraction for server clips, a paced estimate as the floor. The unspoken remainder stays in the DOM at low opacity, so the paragraph never reflows and the whole line is available to a screen reader and to select-and-copy
- [x] Answers transcribed live: `lib/speech.ts` dictation, settled text held visually apart from the in-flight guess
- [x] The report page handles `insufficient_evidence` as an outcome rather than an error — found by reading a real session's server log, see "Decisions worth knowing"

**Stage gate — testing instructions**
1. [x] `tests/smoke_stage3_question_loop.py` — six new checks pinning directive PRECEDENCE: no directive still picks least-covered; `escalate` holds the topic and moves up a tier; `pivot` does not hold it; a capped topic is released despite an `escalate`; a directive that changed nothing is not reported as followed.
2. [x] `tests/smoke_stage_admin.py` — every scored competency carries a band, each band's score equals its competency's score, no letter outside A–E, `overall_grade` present with its `scale_version`, and no graded-strength competency also filed under focus areas.
3. [x] `tests/smoke_stage_llm.py` — the fingerprint gate passes with v3 unmodified and v4 added; the passthrough call stamps `question-agent/v4`.
4. [x] A graded report round-trips through the real Postgres (written vs. read-back `overallGrade` identical, per-competency grades intact) — the read path is what `008_grading.sql` could have broken.
5. [x] Full backend smoke suite (stages 1, 2, 3, admin, coding, voice, voice-http, live-channel, llm, google-oauth, postgres) passes unmodified.
6. [x] `npm run typecheck` and `npx next build` clean; all 16 routes build.
- **Gate:** ✅ **passed.**
- **Not run:** no browser walkthrough of the rebuilt room — the Chrome extension was not connected in this session. Build, typecheck and the protocol-level tests pass; what has *not* been confirmed by eye is the backdrop's rendering and the word-by-word reveal timing against a real voice.

**Decisions worth knowing**
- **The directive was the missing wire, not a missing feature.** Stage 6 built both ends — `next_action` and per-topic tier escalation — and shipped them unconnected. The fix is ~40 lines in the harness and the selector; the reason it went unnoticed is that nothing *failed*, the interview just moved topic every turn and the escalation logic never got a chance to fire. Worth remembering when reading a "complete" stage gate: a field being persisted and displayed is not evidence that anything consumes it.
- **`grade_scores` interprets, it does not score.** It was tempting to have the Report Agent band its own averages — one dictionary lookup. Keeping it a tool call is what makes "the letter in the room and the letter in the report are the same judgement" true by construction rather than by review.
- **The room's live captions are deliberately not the submitted text.** Browser dictation is often *better* than the fixture Speech Service, and wiring it to the submission path would visibly improve the demo. It stays a preview: `soul.md §5` is about whether the candidate confirmed the words, not about which recogniser produced them. The one concession is that when the server returns no usable draft, the browser's text pre-fills the review box — still the candidate's to correct before anything is scored.
- **A session with nothing answered showed the candidate an internal refusal string.** Found in a real session's server log during this stage: `POST /sessions/:id/report` → 422. The DB confirmed the cause — four questions asked, zero answer rows — so the Report Agent's `insufficient_evidence` refusal was working exactly as designed (`soul.md §"No fabrication"`: never invent a report). But the room page navigated to the report page anyway, which rendered the refusal's engineer-facing message ("refusing to guess at a report rather than inventing scores") in a red error box. To the candidate that reads as a crash, not as "you skipped everything." The report page now treats that one code as an outcome and says so — with no score and no grade attached, which is the same absent-is-not-zero rule the grading scale is built on. Every other error path is untouched.
- **`question-agent/v3` was being edited in place.** The liveliness instructions arrived as an uncommitted change to v3's `system` text, which silently redefines every stored `question-agent/v3` stamp — the exact failure the fingerprint gate exists to catch, and it was failing at the start of this stage. Those edits are now v4's and v3 is back to its committed text. v4 has no TS counterpart (the TS registry is frozen at v3), so its fingerprint is derived here rather than transcribed; the gate still catches an unbumped edit, which is the part that matters.

**Deliberately not done in this stage**
- **No grade on the admin directory or the score trend.** Both show aggregates the gateway computes, and banding them would mean either a second ladder in the browser or a new gateway call per row. The per-report grade is visible in the drill-down, which renders the same `ReportView`.
- **No re-scoring of existing reports.** `overall_grade` is NULL for every report written before the migration and stays that way. Back-filling would mean re-deriving a band from scores whose session context is gone; the report card says "no overall grade was assigned" instead.
- **No coding-round pane.** Unchanged from Stage 8 — the Coding Agent's wire messages still do not reach the room page.

---

## Stage 10 — human interaction flow

**Status: Complete.** Design: `HUMAN_INTERACTION_FLOW.md` (all seven methods). Rules worth keeping: `CLAUDE.md §17`.

Seven additions that make the interview read as a conversation rather than a form being filled in. Every one follows the shape the Follow-up Agent's `_GAPS` table already proved and the design note names explicitly — **detector → directive → narrow phrasing**: a deterministic rule decides *whether* something happens, and an LLM at most decides *how it is worded*. No interview logic moved into a model, which is why every check in the stage gate below runs with no provider configured.

Additive throughout. Every Stage 1–9 wire shape, DB column and test still holds; each new field is optional and an absent one reproduces the pre-addition behaviour exactly.

**Build — §1 thinking gap / acknowledgment beat**
- [x] `interview_domain/acknowledgments.py` — two pools (substantive vs. thin), silence below the confidence floor, least-recently-used rotation. No model call: an acknowledgment carries no claim, so there is nothing to phrase and nothing to ground
- [x] `submit_answer` gains an `on_acknowledgment` hook, fired as soon as the ack is spoken and before the scoring/follow-up pipeline starts. The live channel pushes it as its own `acknowledgment` frame; REST callers read `AnswerResult.acknowledgment` at the end
- [x] Room page: `speakAside` (plays without driving the reveal or handing the turn back) plus a `ThinkingBeat` indicator for the gap between the ack and the real response

**Build — §2 struggle detection**
- [x] `detect_struggle` in `followup/server.py` — a sibling of `_GAPS` with four signals: an explicit "I don't know" as a whole clause, a second consecutive too-short answer, hedging that continues across turns, and a topic average at or below 2.0
- [x] New `support` directive + `supportive_reframe` transition style, threaded through `shared_types`, `transitions.py`, the schemas and `_STAY_DIRECTIVES`
- [x] The harness supplies the cross-turn half (`struggle_context`) — the Follow-up Agent still never queries the Memory Agent or the stores itself (§4.7)
- [x] `followup-agent/v2` — a second `support` job alongside v1's `probe` job, with the bar-preserving rules stated in the prompt itself
- [x] `struggle_detected` telemetry naming which signal fired

**Build — §3 meta-utterance detection**
- [x] `agents/harness/meta_utterance.py` — anchored whole-utterance patterns for repeat/clarify, capped at 12 words, run before anything is written or scored
- [x] `MetaUtteranceResult` as a distinct return type; `clarification` on the socket, `answered: false` on both REST answer routes
- [x] `meta_utterance_detected` emitted on every match, because a false positive here eats an answer and leaves no other trace
- [x] The per-question clock is deliberately *not* stopped — asking to hear a question again is not a turn

**Build — §4 phrasing variety**
- [x] `CUE_CATALOGUE` + `cues_used_in` in `transitions.py`; the harness observes which cue a generated question actually used rather than assuming one from the directive
- [x] Memory Agent `remember_used_phrase` / `get_used_phrases`, kind-namespaced so acknowledgments and transitions cannot exhaust each other
- [x] `used_transitions` passed into `get_next_question`; `question-agent/v5` is told not to reuse them

**Build — §5 long-range callbacks**
- [x] `agents/harness/callbacks.py` — one verbatim sentence per notable answer (scored ≥4, or naming a concrete measure), preferring the sentence that carries the measure
- [x] Memory Agent `remember_callback_fact` / `get_callback_facts`, capped at 5 and 30 words each
- [x] `session_callbacks` joins `recent_exchanges` in `_continuity`, de-duplicated against the window, and is added to `source_documents` so a question citing one can actually ground the citation

**Build — §6 audio pacing**
- [x] `split_leading_cue` (same closed catalogue §4 tracks) + `tools/speech_service/pacing.py` — cue and question synthesised separately and stitched with 350ms of real silence between them
- [x] Stitched server-side rather than client-side, so `audio_url` stays one ref and the playback path, reveal timing, retention rules and `/audio/{ref}` route are all untouched

**Build — §7 session-level arc**
- [x] `agents/harness/session_arc.py` — topics covered and answers given, derived from persisted rows; `wrap_up()` names them instead of reading a fixed script
- [x] Forms no judgement of its own and names no strongest/weakest topic — see "Decisions worth knowing"

**Stage gate — testing instructions**
1. [x] `tests/smoke_stage_human_flow.py` — a section per method, then an end-to-end pass through the real gateway. The checks that matter most: five real answers that look like meta-utterances are *not* swallowed; a `support` directive cannot buy a topic a question past its cap and steps its tier *down*, never up; the stitched clip is measurably ~350ms longer than the unpaced one; the closing line contains no evaluative word; and no acknowledgment in either pool reads as a verdict.
2. [x] `tests/smoke_stage_live_channel.py` — the `acknowledgment` frame arrives *before* the scored result (the ordering is the feature), and a repeat request produces `clarification` rather than an `answered` frame.
3. [x] `apps/web/tests/live-protocol.test.ts` — neither new frame is ever replied to with `next_question`; replying to either would skip a question nobody answered.
4. [x] `tests/smoke_stage_llm.py` — the fingerprint gate passes with v1–v4 unmodified and `question-agent/v5` + `followup-agent/v2` added.
5. [x] Full backend smoke suite (stages 1, 2, 3, admin, coding, voice, voice-http, live-channel, llm, google-oauth, human-flow) passes.
6. [x] `npx tsc --noEmit` clean.
- **Gate:** ✅ **passed.**
- **Not run:** no browser walkthrough. The acknowledgment's *timing* — how long the "Thinking…" beat actually lasts against a real provider, and whether 350ms reads as a pause or a stutter through a real voice — is the part these tests cannot answer. Both numbers are single constants (`PAUSE_MS`, and the ack pools) chosen to be easy to tune once heard.

**Decisions worth knowing**
- **Two prompt bumps, no in-place edits.** `question-agent/v5` and `followup-agent/v2`. v1–v4 are untouched and still resolvable for stored `prompt_version` stamps; the fingerprint gate confirmed every prior hash is unchanged. This is the failure Stage 9 caught v3 committing, and the cost of avoiding it is one new file per prompt.
- **`support` is safe to keep on-topic because nothing else about selection moved.** The worry is stranding a struggling candidate on a topic they cannot do. The cap still binds (so a three-question topic gets at most three), the tier still comes from `next_tier_for` (which steps *down* at exactly the score floor `detect_struggle` uses), and an asked question is still excluded. So a supported topic gets a lower tier and a gentler framing — never an extra turn and never a harder question. That is the same boundary Stage 9 drew for `escalate`, applied to a directive pointing the other way.
- **The meta-utterance detector is tuned against false positives, not for accuracy.** Scoring a "sorry, what?" as an answer is a bad turn; swallowing a real answer costs the candidate work they do not get a second chance to give. So the patterns are anchored at both ends, the word cap is low, and five adversarial cases are pinned in the test — including answers that *open* with "Sorry, um" and ones that contain "what do you mean by that" as a quoted clause.
- **A clarify request restates the question verbatim rather than explaining it.** Tempting to have the model paraphrase what the question is "really" asking. It has no rubric on that path, and a candidate who then answers against an invented reading would be scored against the real one.
- **The arc names topics, not verdicts.** The design note allowed a rolling summary of "impression so far". It is deliberately only coverage: the Report Agent aggregates the evidenced scores minutes later, and a second component forming its own view is how the closing line and the report start to disagree — with the report holding all the evidence.
- **The acknowledgment is not a transcript turn.** "Mm-hm." is a noise, not a line of the interview. Putting one between every question would make the thread harder to read, not warmer, so it lives in a beat that clears when the real response arrives.
- **`SHORT_ANSWER_WORDS`, `HEDGE_RE` and `METRIC_RE` moved to `interview_domain/signals.py`.** They were module-private in `followup/server.py` until the harness needed the same three answers over a different time horizon (across turns, rather than within one). Two copies of a regex become two regexes the first time one is tuned.

**Deliberately not done in this stage**
- **No mid-interview "let's push into X now" framing line.** §7 marked it optional, and `topic_shift` already owns the language for moving to a new topic. A second framing layer would compete with the transition cue for the same sentence.
- **No SSML.** §6 offered it as the first option; sherpa-onnx takes plain text and has no SSML support, so the two-clip stitch is the only route to a real pause.
- **The struggle detector does not consult the score of the answer that triggered it.** It runs before the Eval Tool is called, deliberately: a reframe is about the shape of the conversation, and the answer's mark is the same either way.

---

## Stage 11 — Whisper STT, VAD, and sound-source recognition

**Status: Complete.** Design: `INSTRUCTIONS.md §5.6`. Rules worth keeping: `CLAUDE.md §18`.

Swaps the STT engine off sherpa-onnx and onto `faster-whisper`, and uses the swap to fix a class of failure the old path had no defence against: audio that is not an answer being transcribed *as* one. TTS is untouched — sherpa's VITS voice still speaks every question — so the Speech Service now runs two independent engines composed behind one provider.

**Build — STT engine**
- [x] `tools/speech_service/whisper_provider.py` — `whisper tiny.en` on CTranslate2. No torch, no vendored ONNX files, Silero VAD bundled in the package. Resolves the model through the HuggingFace cache, or `STT_MODEL_DIR` for an air-gapped deployment
- [x] `CompositeSpeechProvider` — sherpa VITS for `synthesize`, faster-whisper for `transcribe`. Either half can be absent without taking the other down, and the startup log names both (`tts: …; stt: …`)
- [x] The sherpa ASR path is no longer selected. `sherpa_provider.py` keeps it, unused, rather than deleting a working implementation mid-swap
- [x] `STT_MODEL` / `STT_COMPUTE_TYPE` / `STT_MODEL_DIR` / `STT_TIMEOUT_SECONDS` / `STT_VAD_FILTER` in `config.py` and `.env.example`; `faster-whisper` added to the `speech` extra

**Build — VAD, silence, trimming**
- [x] `tools/speech_service/vad.py` — frame-energy scan with an *adaptive* threshold (the recording's own noise floor plus a margin, clamped), reporting speech/silence/leading/trailing durations, speech ratio, peak and noise floor
- [x] Silence is refused, never decoded → `no_speech_detected`. This is the point of the module: `tiny.en` answers two seconds of silence with `" You"`, and that word is indistinguishable downstream from a real one-word answer
- [x] Leading/trailing silence trimmed before decode, with padding so low-energy consonants survive. Measured at roughly half the audio on a realistically padded recording
- [x] Silero VAD enabled *inside* the decode as well. The two are complementary, not redundant — the energy scan is a cheap pre-model gate that also produces statistics; Silero is a precise in-decode filter
- [x] Confidence gains a third signal (speech ratio) alongside level and word density. An answer that was 90% silence used to score the same as a clean one

**Build — the 15-second timeout**
- [x] `STT_TIMEOUT_SECONDS=15`, enforced as a hard wall clock around the decode. Bounds an *unbounded* failure rather than describing expected latency: fed noise, a Whisper decoder can loop emitting repeated tokens
- [x] On its own `ThreadPoolExecutor`, not the event loop's shared one — see "Decisions worth knowing"
- [x] Client side: `lib/mic.ts` `watchSilence` stops a recording after trailing silence, and abandons one with no speech in it at all after the same 15 seconds. Nothing is submitted, so the candidate loses no turn

**Build — sound-source recognition**
- [x] `tools/speech_service/source.py` — is this the microphone, or the speakers playing our own question back? Two independent signals: the browser's device report (a hint) and the transcript itself (evidence the server derived)
- [x] Loopback devices (`Stereo Mix`, `Monitor of …`, `BlackHole`, …) rejected before the model runs
- [x] Echo detection on a **run of consecutive words**, not shared vocabulary — see "Decisions worth knowing"
- [x] `lib/mic.ts` `describeInputDevice` + `echoCancellation: true` requested explicitly on `getUserMedia`; `input_device` whitelisted field-by-field on both transports before it reaches a schema-validated MCP call
- [x] `source` on the response; `audio_source_rejected` when it is our own voice

**Build — telling the candidate which of the four happened**
- [x] `LowConfidenceTranscript.code` carries the refusal kind through the harness to both transports
- [x] Two refusals deliberately carry **no draft transcript**, and the room no longer falls back to the browser's own caption for them — see "Decisions worth knowing"
- [x] `transcription_no_speech`, `audio_source_rejected`, `transcription_completed` telemetry (durations and ratios only, never the transcript)
- [x] Room shows live "Hearing you / Waiting for sound…" from the same watcher that ends the recording

**Stage gate — testing instructions**
1. [x] `tests/smoke_stage_whisper_stt.py` — four sections. Sections 1–3 need no model at all (pure functions over synthetic audio); section 4 loads the real models and skips with a clear message when they are absent.
2. [x] VAD: 1s/1.5s/2s synthetic recording measured to within 100ms on every figure; digital silence, room tone, an empty array and a sub-frame recording all handled; quiet speech over a quiet floor still detected (the threshold adapts) while steady room noise is not.
3. [x] Source: loopback devices, full echo, **tail-only** echo, and echo with a stray recogniser filler all rejected — while an answer that reuses the question's own vocabulary is not, which is the false positive that matters.
4. [x] Timeout: a deliberately slow decode releases the caller at the deadline, timed *inside* the event loop (see "Decisions worth knowing"); silence is refused before the decode is ever reached.
5. [x] End to end with the real models: sherpa TTS → 5s of padding → faster-whisper. Transcript verbatim, confidence 1.0, ~4.9s trimmed away, decode ~1.0s against the 15s budget, and a recording of our own synthesised question caught as echo.
6. [x] Full backend smoke suite (12 suites) passes; `npx tsc --noEmit` clean; frontend protocol tests pass.
- **Gate:** ✅ **passed.**
- **Not run:** no browser walkthrough. What the tests cannot answer is whether `TRAILING_SILENCE_MS` (2.5s) is the right pause before a recording stops itself against real speech with real thinking pauses in it, and whether a real room with real speakers actually trips the echo check. Both are single constants.

**Decisions worth knowing**
- **The VAD gate exists because Whisper does not return an empty string for silence.** Handed two seconds of nothing, `tiny.en` returns `" You"` — confident, plausible, invented. Verified during this stage, not assumed. Once that reaches the harness it is a one-word answer that gets scored, and no amount of downstream care can undo it, so the fix has to be "never ask the model about silence". This is `soul.md §"No fabrication"` enforced at the only layer that can enforce it.
- **Echo is detected on a run of consecutive words, not on shared vocabulary.** The obvious test — "how much does the transcript overlap what we just said" — is actively dangerous: a candidate answering "we shipped the billing feature under deadline pressure" shares most of its content words with "tell me about a time you shipped something under deadline pressure", *because answering a question in its own terms is what answering a question looks like*. Rejecting that costs a turn the candidate cannot redo. An echo is not a paraphrase, it is a recording of the same sentence, so it preserves word order; six consecutive words is a threshold a real answer does not reach by coincidence. The bag-of-words version was written first and replaced after it flagged exactly that case in testing.
- **A client hint can accuse but not convict.** `input_device` is candidate-controlled. A `speaker` hint the transcript does not corroborate is *reported* and still transcribed; only a loopback device name or an actual transcript match rejects. The asymmetry is deliberate: a mislabelled device silently eating real answers is a much worse failure than an unflagged echo, which the transcript check catches anyway.
- **`unknown` means "carry on".** The classifier has three outcomes and the default is the pre-addition behaviour. It is not confident enough to be given the power to reject on a hunch.
- **The abandoned decode gets its own executor.** A CTranslate2 decode cannot be cancelled: when the 15s timeout fires, `wait_for` stops waiting but the thread runs on. Found because the test measured 5s for a 0.5s timeout — `asyncio.run` was joining the orphan at shutdown. In a live gateway the loop does not shut down, so the *request* is correctly released at the deadline; the real hazard is the orphan sitting in the event loop's **shared** default executor, where a run of them would stall unrelated `to_thread` calls (file reads, resume parsing) for reasons nothing in those code paths could explain. Decodes now run on a small dedicated pool, so an orphan can only ever slow down the next transcription. The test now times inside the loop, which is what a live gateway actually experiences.
- **Two refusals carry no draft transcript, and the room had to be taught not to fill the gap.** `no_speech_detected` has nothing to correct. `audio_source_rejected` is worse: the audio *was* the interview's own question, so the browser's live caption of it is the question too — and the room's existing "prefer the server's draft, fall back to what the browser heard" would have pre-filled the answer box with our own words for the candidate to submit. The refusal `code` exists to make that distinguishable; a missing `draft_transcript` alone could not.
- **TTS was not touched.** The instruction was to swap STT, and the VITS voice works. Composing the two rather than replacing both is also what makes the next swap cheap in either direction.

**Deliberately not done in this stage**
- **The sherpa ASR code is still there, unused.** Deleting a working implementation in the same change that adds its replacement leaves no way back if the new one misbehaves in a real room. It is unreachable through `select_speech_provider`; removing it is a follow-up.
- **No streaming/partial transcription.** The room already shows live captions from the browser recogniser (Stage 9), and those are explicitly a preview, not evidence. Server-side streaming would be a second preview with the same standing.
- **No speaker diarisation.** "Which person is talking" is a different question from "is this a microphone or a loopback", needs a different model, and nothing in the interview flow asks it.

---

## Stage 12 — conversational continuers

**Status: Complete.** Design: `HUMAN_INTERACTION_FLOW.md §8`. Rules worth keeping: `CLAUDE.md §19`.

The eighth method of the human-interaction flow, added after the first seven shipped. Stage 10 §1 gave the interview something to say the instant a candidate stops talking; this gives it something to say in the three places it still says nothing — the long wait *after* that acknowledgment, a follow-up answer, and the top of the session.

**Build — the vocabulary**
- [x] `interview_domain/continuers.py` — four kinds (`opening`, `holding`, `selection`, `follow_up_receipt`), three rotating pools and one fixed opening line. No model call anywhere in the file, not even the narrow phrasing slice the other seven methods allow: a continuer makes no claim, so there is nothing to phrase
- [x] Verdict-free by construction and by assertion — every continuer fires before the Eval Tool has said anything about the turn it sits in
- [x] `least_recently_used` promoted out of `acknowledgments.py` rather than copied. One rotation policy, two modules — same reasoning that moved `SHORT_ANSWER_WORDS` into `signals.py` in Stage 10
- [x] Memory kinds namespaced under `continuer:*`, so none of the five pools (two ack, one transition, plus these) can exhaust another's rotation. The `kind` field on `remember_used_phrase` was already free-form; only its schema *description* needed updating

**Build — the clock**
- [x] `InterviewOrchestrator._continuer_window` — an async context manager over the silence: speaks at most one line once `HOLDING_LINE_AFTER_MS` (3.5s) passes, and **cancels the continuer when the window closes**, so a slow synthesis can never add latency to the very turn it was meant to make feel faster
- [x] Opened across the **whole** post-acknowledgment pipeline in `submit_answer` (`holding`) and around `get_next_question` (`selection`) — see "Decisions worth knowing" for why the first version's narrower wrapper was wrong
- [x] `submit_follow_up_answer` gained the receipt beat, after the row is durable and before the scoring round trip
- [x] `HarnessAgent.opening_line` — its own call rather than something `begin_interview` returns, because a greeting is not session state and four callers already read that return value
- [x] `continuer_spoken` telemetry — emitted at the *end* of the wait, not at the threshold, so `waited_ms` reports the real round trip instead of always reporting 3500; `spoken` records whether the line reached the candidate or lost the race

**Build — the wire and the room**
- [x] `continuer` frame on the live channel, carrying `kind`/`text`/`audio_url` and deliberately no `answered` flag and no ids
- [x] `replyTo` leaves it unanswered, asserted for all four kinds in `live-protocol.test.ts`
- [x] Room: an `opening` becomes a labelled "Welcome" turn in the thread; the other three drive the existing `ThinkingBeat` indicator through `speakAside`
- [x] `Turn.kind` gained `greeting`, labelled apart from a question so the opener is not mistaken for the first thing to answer

**Stage gate — testing instructions**
1. [x] `tests/smoke_stage_continuers.py` — 61 checks, no provider configured, in two halves: the vocabulary and the timing.
2. [x] Vocabulary: no verdict words in any pool or the opening line; a holding line says nothing about the answer; a selection line names no topic, checked against the real `TOPICS` vocabulary rather than a hand-written word list; the opening line promises no time the session does not have; every pool namespaced apart; LRU rotation spends the pool before repeating.
3. [x] Timing: fast work speaks nothing and emits nothing; slow work speaks exactly one line, records it as spent, and emits one span carrying the wait; a synthesis slower than the remaining work is cancelled rather than delaying the reply (measured: 3.56s elapsed against a 5s synthesis); a failure in the covered work propagates unchanged; no push channel means nothing spoken and nothing delayed; a dead socket costs the continuer and never the answer.
4. [x] Wiring: all four harness entry points take the hook and default it to `None`; the frame carries its kind and no turn-advancing fields.
5. [x] Existing suites unaffected — `smoke_stage_human_flow` (all of §1-§7), `smoke_stage1`, `smoke_stage3_question_loop`, `smoke_stage_live_channel`, `smoke_stage_voice`, `smoke_stage_dynamic_eval` all pass; `npx tsc --noEmit` clean; `live-protocol.test.ts` 11/11.
- **Gate:** ✅ **passed.**
- **Not run:** no browser walkthrough. What the tests cannot answer is whether 3.5s is the right threshold against a real room — too low and the line collides with the reply it covers, too high and the candidate has already concluded something is broken. It is a single constant.

**Decisions worth knowing**
- **A window over the silence, not a wrapper around one call — and running the app is what proved it.** The first version wrapped only `consider_follow_up`. On the introduction turn the topic-plan fusion is a provider round trip of its own that runs *before* that call, so the live app produced `4.1s Mm-hm.` … `38.1s Let me sit with that for a second.` — thirty-four seconds of exactly the silence the stage exists to remove, with the continuer arriving too late to be one. Every unit assertion passed throughout, because they all measured the wrapped call rather than the candidate's experience. Widened to a window, the same turn speaks at 8.9s. The gate now pins the general case: two steps individually under the threshold and together over it must still produce a line.
- **The continuer is cancelled, not awaited, when the real work wins.** The first version awaited it, which meant a 5s synthesis added 5s to a turn whose whole purpose was to feel faster. The race has to be resolved in favour of the reply, always: a holding line that arrives after the answer it was covering for is worse than no holding line, because the candidate is now being asked to wait for something they already have.
- **Push-only, and that is not a gap.** A REST caller receiving "one moment" alongside the thing it was waiting for has not been reassured, it has been handed a log line. `on_continuer=None` short-circuits to a plain await, so the REST answer route is byte-for-byte what it was. This is the one place §8 deliberately diverges from §1, whose acknowledgment *is* worth showing after the fact and rides on `AnswerResult`.
- **The bare `§8` in the harness files used to mean `INSTRUCTIONS.md`.** Those files already wrote `§1`-`§7` for `HUMAN_INTERACTION_FLOW.md`, so the moment a §8 existed there the same token meant two things in one file. The pre-existing INSTRUCTIONS.md references are now spelled out; bare `§N` in `interview.py`, `harness.py` and `live_channel.py` is the design note, consistently.
- **One line per wait, then silence.** A second "bear with me" is not reassurance, it is an interview visibly stuck. The candidate still has the timer and the thinking indicator.

**Deliberately not done in this stage**
- **No continuer during the coding round or the report wait.** Both are surfaces where the candidate is looking at a screen doing something, not sitting in silence waiting to be spoken to. A voice interrupting someone mid-keystroke is not warmth.
- **No LLM-phrased continuer.** Every other method in the flow lets a model phrase a narrow slice. This one does not, because there is no slice: the line carries no claim about the candidate, the answer or the next question, so a model would be generating variety for its own sake and taking a provider round trip to do it — inside the very wait it exists to cover.
- **No second line for a very long wait.** Considered and rejected above; if waits are routinely long enough to want one, the fix is the provider, not more talking.

---

## Stage 13 — dynamic question synthesis and adaptive routing

**Status: Complete.** Design: `INSTRUCTIONS.md §14`. Rules worth keeping: `CLAUDE.md §20`.

Two changes that between them remove the last two places where a live interview followed a list written before the candidate arrived: the *text* of a question came out of the 175-question bank, and the *order* came out of a plan that could not react to what the candidate had just demonstrated.

**Build — decoupling the harness from the static bank**
- [x] `select_next_question` returns a `QuestionSlot` (topic, tier, type, difficulty, `expected_signals`, `concept_ids`, optional `bank_question`) instead of a `BankQuestion`. Every deterministic rule above it is untouched — cap, least-covered ordering, `next_tier_for`, `quota_override`
- [x] `_pick_from` gained a second pass: a topic with no unasked bank entry now yields a **bank-less slot** when synthesis is available, which is a topic+tier the interview previously could not ask at all. Bank-backed slots are still strictly preferred, so every session that selected before selects identically
- [x] `_bankless_slot` sources its signals from the blueprint's extraction matrix, falling back to the topic's own terms — a thin specification is still a specification, an empty one lets a model write anything and call it on-topic
- [x] `_synthesize_question` → `question-agent/v6`, with **no baseline text anywhere in the payload**: there is nowhere to put one, which is how the removal is enforced rather than requested
- [x] `_generate_question` (v5, the bank rewrite) demoted to the second path and otherwise unchanged — a deployment where synthesis misbehaves still has it underneath
- [x] `_source_documents` extracted and shared, so a synthesized scenario is grounding-checked against exactly the documents a rewritten bank question is
- [x] `target_concept_ids` minted from the generated `expected_signals`, so `verify_concepts` runs against what the question actually asked
- [x] `question_source` on the MCP response and on the `question_asked` span (`synthesized` / `bank_rewrite` / `bank`)

**Build — the routing controller**
- [x] `interview_domain/routing.py` — `InterviewSession`, `record_score` (EMA, α=0.4), `determine_next_node`, `rebuilt_from`. Pure; no I/O, no rubric, no model call
- [x] `app/http/session_tracker.py` — `active_sessions: dict[str, InterviewSession]` plus an injectable `SessionTracker` over it. Gateway-layer, and a cache of derived values rather than agent state (see "Decisions worth knowing")
- [x] Follow-up Agent: `routing_context` in, `next_topic`/`next_tier`/`routing_rationale` out on `next_action`. Deterministic — the LLM still only phrases the probe
- [x] `_with_routing` wraps **every** return in `_compute_next_action`, so "routing annotates, it does not decide" is true by construction rather than by four remembered call sites
- [x] Question Agent `_route_to_topic`: stay directive's topic first, `next_topic` second, cap/asked/tier binding unchanged. `followed_directive: "route"` when routing alone moved the pick
- [x] Harness: `_routing_context` (reconciled against the Memory Agent's counts and the plan's caps every turn), the tracker write on each scored answer, and a `routing_decision` span
- [x] `NextActionGenerator` gained the three fields, persisted and serialised on the answer route

**Build — strict schema enforcement**
- [x] `DynamicQuestionResponse` — `question_text`, `expected_signals`, `grounding_rationale`, plus `reasoning`, `topic`, `tier`, `reference_answer`. Registered as `llm:question-agent/dynamic_question@v1` with `grounding_rationale` as a required grounded path
- [x] Per-call constraints as Pydantic **validation context**, not schema fields: one registered schema, one JSON Schema sent to the provider, and a per-call violation that still fails loudly
- [x] `StructuredCallOptions.validation_context` + `validation_context`/`retries` on `tool-llm-provider.generate_structured`. An already-constructed model instance is re-validated from its dump when a context is present, so the check cannot apply to the fixture and not to a real provider
- [x] Two retries for the synthesis call; a violation's corrective message is the validator's own sentence

**Stage gate — testing instructions**
1. [x] `tests/smoke_stage_dynamic_routing.py` — six sections. Sections 1, 2, 4 and 5 need **no provider at all**; sections 3 and 6 inject a model rather than calling one.
2. [x] The snapshot: the EMA weights the newest answer, one bad answer after a good one does not collapse the trajectory, `rolling_score` is `null` (never `0`) before the first score, `record_score` returns a copy, and a snapshot rebuilt from persisted rows replays the identical EMA a live one held.
3. [x] The controller: `> 4.0` steps the tier up and queues the least-covered topic (the worked example — acing a covered area queues the untouched one, a tier higher); `< 2.5` keeps the topic for one recovery question and only pivots laterally on the second unrecovered answer; the lateral topic is same-kind; an exhausted topic is never proposed, including as the lateral escape; the middle band produces no directive; the proposed tier never leaves 1–3.
4. [x] The interaction with the detectors: no `routing_context` means no proposal at all; a stuck candidate's `support` becomes `pivot` *while keeping the reframe for the current turn*; one weak answer does not; a `drill_down` is annotated but never rewritten.
5. [x] Schema enforcement: a wrong topic, a wrong tier and a second question mark are each rejected; no context means no constraint check; a drifting model is retried automatically and the second attempt is what the caller sees, with the violation carried back as the correction; a model that never complies raises rather than being coerced.
6. [x] The prompt: the fingerprint gate passes with v1–v5 unmodified and v6 added; the two jobs are pinned separately; v5 still mentions a baseline and v6's only mention is the sentence saying there is not one; the synthesis payload contains no baseline and **not the bank question's text**, but does contain its signals.
7. [x] Selection: a routed topic is brought forward, a capped routed topic is refused, a stay directive keeps its own topic, a `pivot` hands the choice to routing; with the bank spent, synthesis off still refuses exactly as before and synthesis on yields a bank-less slot with an empty text and a `synth:` id.
8. [x] End to end through the real gateway with a model injected: all three content questions are synthesized, none is a verbatim bank question, the routing decision reaches the client on the answer that produced it, and the fixed opener is never proposed as a next topic.
9. [x] Existing suites unaffected — `smoke_stage1`, `smoke_stage2_resume`, `smoke_stage3_question_loop`, `smoke_stage_llm`, `smoke_stage_human_flow`, `smoke_stage_continuers`, `smoke_stage_dynamic_eval`, `smoke_stage_live_channel`, `smoke_stage_admin`, `smoke_stage_coding`, `smoke_stage_voice_http`, `smoke_stage_google_oauth`, `smoke_stage_postgres` all pass.
- **Gate:** ✅ **passed.**
- **Not run:** `smoke_stage_voice` and `smoke_stage_whisper_stt` — both fail at `import sherpa_onnx` in this environment (the optional `speech` extra is not installed) and neither touches anything this stage changed. No browser walkthrough, and no run against a real provider: what the tests cannot answer is whether a synthesized scenario reads better *to a candidate* than the bank question it replaced. The fallback chain is what makes that safe to find out in production rather than only in a review.

**Decisions worth knowing**
- **Removing the baseline is a new prompt file, not an edit.** `question-agent/v5` was going to be rewritten in place. That is exactly the failure §16's fingerprint gate exists to catch — every stored `question-agent/v5` stamp would silently start meaning a different prompt. v6 is the bump, and both stay live and pinned separately, because they are not versions of each other: they take different inputs, return different schemas, and v5 is still what runs when a bank entry is being sharpened.
- **The fixture cannot be allowed to take the synthesis path.** The first wiring enabled synthesis whenever a tool client existed, which meant the default no-API-key deployment started asking `Start with one concrete example from your own work on databases…` in place of a reviewed bank question. That is a *worse* interviewer than Stage 2 and breaks the founding rule of `fixture_model.py`. `synthesis_enabled` is resolved once in `gateway.py` from the real provider choice, with an injected `llm_model` counting as real so the gate can still reach the path.
- **A stay directive has to outrank a routing proposal, and the first version had it the other way round.** Preferring `next_topic` unconditionally reads as "the more informed signal wins" — routing sees the score, the detector sees only the text. It is wrong: `drill_down` means the detector found a specific gap in this answer, and a score band cannot know that. Cancelling it is the interview forgetting what it had just found. Routing gets the choice where the directive leaves it open — `pivot`, or no directive at all.
- **The lateral pivot must exclude the topic it is pivoting away from.** Caught by the gate on the first run: `_lateral_topic` sorted the candidates by adjacency to `current` and `current` is trivially most adjacent to itself, so "move sideways off databases" proposed databases. The one exception is when it is the only topic left, where the lower tier on the same topic beats dropping the proposal.
- **`routing_decision` is a sibling of `directive_followed`, not a replacement.** One records what routing asked for and one what selection did, and they legitimately disagree — a proposal loses to a cap spent moments earlier. Emitting only one of them makes that turn undiagnosable.
- **This turn's score is folded in before routing runs.** `_route` appends the score the Eval Tool has just returned to the topic history the harness assembled a few milliseconds earlier. Without that, every routing decision is one answer stale, and a "real-time performance trajectory" that lags by a turn is the one thing it must not be — the second consecutive weak answer would not be seen as a streak until the third.

**Deliberately not done in this stage**
- **The question bank was not deleted.** It is the signal source for every slot and the fallback text for two of the four generation paths. Deleting a working question set in the same change that introduces its replacement leaves no way back if synthesized questions read badly in a real room — the same reasoning that kept `sherpa_provider.py` around through Stage 11.
- **No LLM in the routing decision.** Every threshold here is arithmetic over scores the Eval Tool produced. This stage's shape is the one Stage 10 established and Stage 12 kept: a deterministic detector decides *whether* and *where*, and a model decides at most *how it is worded*. Asking a model to choose the next topic would move interview logic back into a place nothing can audit.
- **No cross-session routing.** `InterviewSession` is scoped to one session. "This candidate was weak on databases last month, open there" is a Memory Agent question with its own consent story (`soul.md`), not something to smuggle in through a cache.
- **`next_tier` does not reach tier selection.** It is reported and honoured only as an ordering signal; `next_tier_for` remains the one function that decides the tier a question is actually asked at. Two places computing a tier is how they start to disagree.
