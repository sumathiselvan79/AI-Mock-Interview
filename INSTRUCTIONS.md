# INSTRUCTIONS.md

Detailed technical specification for the AI Mock Interview platform. This is the implementation-level companion to `CLAUDE.md` (project map) and `soul.md` (values/voice). Read the relevant section before building the corresponding piece.

---

## 1. System overview

Two roles use this system: **Student** (takes mock interviews) and **Admin** (reviews reports across candidates). A student logs in, lands on a home page showing their past interview stats, configures a new interview (role, job description, resume), passes a telemetry/device check, then runs a timed interview session where questions are spoken to them (text-to-speech) and their spoken answers are captured and transcribed (speech-to-text). Behind the scenes, a **Harness Agent** orchestrates seven specialized agents and six shared tools, all connected via **MCP (Model Context Protocol)**, to move the candidate through resume/JD intake, calibrated questions, live follow-ups, an optional coding round, and a final evidence-based report — which is saved for the candidate and made visible to Admins.

```
Web client
   |
Harness Agent  (MCP host, session state machine, only agent the client talks to)
   |
   |-- Resume Service Agent -----> Resume Parser Tool
   |-- Question Agent -----------> Eval Tool (calibration only)
   |-- Follow-up Question Agent
   |-- Coding Agent --------------> Eval Tool, Clipboard Monitor
   |-- Time Tracking Agent -------> Time Tracking Tool
   |-- Memory Agent
   |-- Report Agent --------------> Eval Tool
   |
   +--------------------------------> Speech Service Tool (TTS out / STT in — see §5.6)

   All tool calls pass through the MCP Gateway, which also feeds Telemetry Service.
```

---

## 2. MCP routing architecture

**Roles, precisely:**

- **Harness Agent = MCP host.** It holds MCP client connections to each specialized agent's MCP server. It is the only component with a connection to *every* agent, and the only component the frontend talks to.
- **Specialized agents = MCP servers to the harness, MCP clients to tools.** Each agent (e.g. Coding Agent) exposes a small set of tools/methods the harness can call (e.g. `start_coding_round`, `submit_code`, `get_round_result`), and internally acts as an MCP client to whatever shared tool servers it needs.
- **Shared tools = MCP servers only.** Resume Parser, Eval, Time Tracking, Telemetry, Clipboard Monitor, and Speech Service never initiate calls — they only respond to calls from agents.
- **MCP Gateway** sits between every MCP client and server pair. It performs auth (per-session token), rate limiting, and automatically emits a `tool_called` telemetry event with latency and status for every call — no agent has to instrument this itself.

**Why route this way instead of direct function calls:** every interaction is uniform (same protocol, same schema validation, same telemetry), any agent or tool can be swapped or scaled independently, and the whole session is reconstructable from the MCP call log alone — which is what the Report Agent and any later audit rely on.

**Hard rule:** specialized agents never call each other directly. If the Coding Agent needs something from the Question Agent, it asks the Harness Agent, which makes the call and relays the result back. This keeps the harness's session state machine authoritative and keeps the call graph a tree, not a mesh.

---

## 3. Session lifecycle (state machine)

Login and the home page happen *before* a session exists — they're handled by the Gateway's auth layer (§3.2), not by the Harness Agent. A `Session` is only created when a student clicks "start new interview."

```
CREATED
  -> CONFIG                owned by Resume Service Agent (role, job description, resume
                             upload/delete, JD-fit verification) — maps to the Interview
                             Config page
  -> TELEMETRY_CHECK        device check (mic, speaker) + consent capture (telemetry,
                             clipboard monitor, audio recording) — maps to the Telemetry
                             Check page; nothing downstream of this state may start until
                             it passes
  -> CALIBRATION             owned by Question Agent (role, seniority, difficulty target,
                              topic plan with per-topic question quotas built from the
                              resume's topic relevance + the role's required topics +
                              any JD-fit gaps from CONFIG)
  -> QUESTION_LOOP          owned by Question Agent + Follow-up Question Agent (repeats N times)
  -> CODING_ROUND (optional) owned by Coding Agent
  -> WRAP_UP                owned by Harness Agent (final candidate-facing message)
  -> REPORT_GENERATION      owned by Report Agent
  -> COMPLETED
```

- `CONFIG` + `TELEMETRY_CHECK` + `CALIBRATION` through `WRAP_UP` together are what the candidate experiences as the **Interview Environment** page.
- The **Time Tracking Agent and Memory Agent are cross-cutting** — they're active throughout, not owners of a single state.
- The Harness Agent is the only component allowed to transition state. Every other agent returns a result and a "done" signal; the harness decides what happens next.
- A session may branch: `CODING_ROUND` is skipped entirely for non-technical roles, decided during `CALIBRATION`.
- Any state can transition to a terminal `ABORTED` state (candidate leaves, unrecoverable error) — the harness must always be able to hand back a partial report rather than nothing.

### 3.1 Page-to-state mapping

| Page | Backing state(s) | Primary owner |
|---|---|---|
| Login | none (pre-session) | Gateway auth |
| Home | none (pre-session) — reads past `Report`s | Gateway (`GET /me/stats` or `GET /admin/reports`) |
| Interview Config (pre-exam) | `CONFIG` | Resume Service Agent |
| Telemetry Check | `TELEMETRY_CHECK` | Harness Agent + Telemetry Service |
| Interview Environment | `CALIBRATION` → `WRAP_UP` | Harness Agent, routing to every specialized agent |
| Post-Interview Report | `REPORT_GENERATION` → `COMPLETED` | Report Agent, then persisted for both the candidate and Admins |

### 3.2 Roles: Admin and Student

- **Student:** can create sessions, see only their own past `Report`s and stats on the Home page, and run interviews.
- **Admin:** cannot start interviews as a candidate. Sees an aggregated dashboard of all students' reports and stats on the Home page, and can open any individual `Report` in detail. Admins do not get elevated access to raw resumes, audio, or transcripts beyond what a `Report` already contains — see `soul.md` and §8.
- Role is fixed at account creation and carried in the auth token issued by `POST /auth/login` (§7); the Gateway enforces it on every request, not just the frontend routing.
- **(Stage 3 addition)** Self-service signup (`POST /auth/register`, Signup page) can only ever create a `student` account. Admin accounts are still operator-provisioned only — there is no self-service path to the `admin` role.

---

## 4. Agent specifications

Each spec: purpose, inputs, outputs, tools it calls, and an example MCP call shape. Treat these JSON shapes as a starting contract — formalize them in `/packages/mcp-schemas` before implementation.

### 4.1 Harness Agent
- **Purpose:** own session state, route every cross-agent interaction, be the sole interface to the frontend, and bridge voice I/O since that's a property of the frontend connection, not any single agent.
- **Input:** frontend events (`start_session`, `submit_answer_audio`, `submit_answer_text`, `pause`, `end_session`) over the gateway.
- **Output:** state-appropriate instructions to the frontend (`show_question` with synthesized `audio_url`, `show_timer`, `show_report`) and MCP calls to the appropriate specialized agent.
- **Calls:** every other agent's MCP server, plus the Speech Service Tool directly (§5.6) — every question or follow-up text an agent produces is sent through `synthesize_speech` before reaching the frontend, and every candidate audio answer is sent through `transcribe_speech` before its transcript is handed to the Follow-up Question Agent, Coding Agent, or Eval Tool. No other agent calls the Speech Service Tool directly, so audio handling stays in one place.

### 4.2 Resume Service Agent
- **Purpose:** parse the uploaded resume into a structured candidate profile, including which interview topics the resume actually supports; verify how well the resume matches the job description before the interview starts; and handle resume replace/delete requests from the Interview Config page.
- **Input:** raw resume file (PDF/DOCX) + target role + job description text. Also receives explicit `delete_resume` requests.
- **Output:** `{ skills[], experience[], education[], seniority_estimate, keywords[], topic_relevance[], jd_fit }`, where each `topic_relevance` entry is `{ topic, relevance_score: 0-1, evidence: string }`, and `jd_fit` is `{ fit_score: 0-1, matched_requirements[], gaps[] }`. `gaps` are JD requirements the resume gives no evidence for; these are folded into the role's `required_topics[]` (§4.3) so the interview actually probes the JD-critical areas the resume is thin on, instead of quietly avoiding them.
- **Calls:** Resume Parser Tool. **(Stage 5 addition)** `packages/llm-client`, for the JD-fit judgment call only — the resume/JD *parsing* stays with the Resume Parser Tool, LLM judgment is layered on top of its structured output, never a replacement for it.
- **Rule:** never invents or embellishes resume content — every `topic_relevance` and `jd_fit` entry must be traceable to specific parsed text, not inferred from a job title alone. A `delete_resume` request must result in the stored file actually being deleted (§8), not just unlinked from the session.
- **(Stage 5 addition)** `jd_fit` gains two fields: `rationale` (a short natural-language explanation of the fit score, e.g. "Strong overlap on distributed systems and API design; no evidence of the Kubernetes experience the JD asks for") and `topic_relevance` (the same `TopicRelevance[]` shape as the candidate profile, but scored against *JD emphasis* rather than resume content — how much the job description itself weights each topic, independent of whether the resume supports it). Both are generated by `packages/llm-client` in the same call that produces `jd_fit.gaps`, tagged with the active `promptVersion` (`resume-service-agent/v1`), and both pass through the grounding check (§11.3) before being returned — `rationale` must cite resume or JD text, `topic_relevance` evidence must trace to JD text specifically. A field that fails grounding is omitted with an `insufficient_signal: true` flag on that field, never guessed (`soul.md §"No fabrication"`).

```json
// Resume Service Agent -> Resume Parser Tool
{
  "method": "parse_resume",
  "params": { "file_ref": "s3://.../resume.pdf", "job_description": "Senior Backend Engineer — owns service reliability, distributed systems, mentors juniors..." }
}
```

### 4.3 Question Agent
- **Purpose:** select/generate the main interview questions, driven by the candidate's actual resume content and capped per topic so the session stays balanced; progressively adjust difficulty based on prior answers.
- **Input (every call):** candidate profile (including `topic_relevance[]` from the Resume Service Agent), the role's `required_topics[]`, the session's `topic_plan[]` and current `topic_counts` (both supplied by the Harness Agent, sourced from the Memory Agent — see §4.7), and the running performance signal.
- **Output:** one `Question` at a time — `{ id, text, topic, type: "behavioral"|"technical", difficulty, expected_signals[] }`. The `topic` field is required so the Harness/Memory Agent can increment that topic's count.
- **Calls:** Eval Tool (only to calibrate difficulty against prior answer quality, not to score). **(Stage 5 addition)** `packages/llm-client`, to generate the question itself.
- **(Stage 5 addition)** The question and its `reference_answer` are generated in the same `packages/llm-client` call (`soul.md §"A reference answer is a comparison aid"`), tagged with `promptVersion: "question-agent/v1"`. The `reference_answer` is passed to the Memory Agent (§4.7) alongside the `Question` so the Eval Tool can compare against it later — it is never included in the `Question` object returned to the Harness Agent, never synthesized to speech, and never persisted in any table the candidate or Admin can read (§6, §11.4). Grounding here means the question and reference answer must be consistent with `candidate_profile`/`topic_plan` inputs — a question about a topic with no plan entry, or a reference answer that assumes facts not in the candidate profile, fails the grounding check (§11.3) and the agent retries generation once before falling back to the deterministic Stage-2 question-bank path for that slot rather than asking an inconsistent question.

**Topic planning (at CALIBRATION):**
1. Start from the resume's `topic_relevance[]` (highest-signal topics first) and union it with the role's fixed `required_topics[]` plus any `jd_fit.gaps[]` from the Resume Service Agent (§4.2) — topics the role or job description demands regardless of what the resume happens to showcase. A thin resume in a required area is a reason to ask about it, not to skip it.
2. Distribute the session's total question budget (`question_budget`, default 8, configurable per role) across this topic set, weighted by relevance score, with a floor of 1 question and a ceiling of 3 questions per topic. Every `required_topic` gets at least 1 slot even if its resume relevance score is 0.
3. The result is the session's `topic_plan[]`: `{ topic, max_questions, source: "resume" | "role_requirement" }[]`.

**Quota enforcement (during QUESTION_LOOP):** before selecting each question, the agent checks `topic_counts[topic] < topic_plan[topic].max_questions`. Any topic already at its cap is excluded from selection for the rest of the session. If every topic in the plan hits its cap before the overall `question_budget` is used up, the agent may exceed an individual topic's cap as a last resort — but it must return this as an explicit `quota_override: true` flag on that `Question` so the Harness Agent logs it, rather than silently over-drilling one topic.

```json
// Harness Agent -> Question Agent
{
  "method": "get_next_question",
  "params": {
    "candidate_profile": { "topic_relevance": [
      { "topic": "distributed systems", "relevance_score": 0.8, "evidence": "led sharded event bus migration" }
    ]},
    "topic_plan": [
      { "topic": "distributed systems", "max_questions": 3, "source": "resume" },
      { "topic": "system design", "max_questions": 2, "source": "role_requirement" },
      { "topic": "behavioral: leadership", "max_questions": 2, "source": "resume" }
    ],
    "topic_counts": { "distributed systems": 1, "system design": 0, "behavioral: leadership": 2 },
    "difficulty_target": 3
  }
}
```

### 4.4 Follow-up Question Agent
- **Purpose:** given the candidate's answer to the current question, decide whether to probe deeper and generate that probe.
- **Input:** `{ question, answer_transcript }` — `answer_transcript` is text produced by the Speech Service Tool's `transcribe_speech` (relayed by the Harness Agent) when the candidate answered by voice, or typed text if they used the text fallback. **(Stage 5 addition)** also receives the question's `reference_answer` from the Memory Agent (§4.7), for scoring only — never surfaced to the candidate.
- **Output:** `{ should_follow_up: boolean, follow_up_text?: string, reason: string, score: { rubric_id: string, value: number, rationale: string, evidence_spans: {start:number,end:number}[] } }` — `follow_up_text` is synthesized to audio by the Harness Agent before the candidate hears it. **(Stage 5 addition)** `score` is new; see below.
- **Calls:** **(Stage 5 addition)** Eval Tool — scores `answer_transcript` against `reference_answer` *before* deciding on a follow-up, so scoring isn't deferred entirely to the Report Agent's final pass. `packages/llm-client` for the follow-up-generation call itself, tagged `promptVersion: "followup-agent/v1"`.
- **Rule:** a follow-up must target a specific gap or claim in the answer, never a generic "tell me more."
- **(Stage 5 addition — follow-up scoring)** The `score` returned here is persisted immediately as an `Evaluation` (§6) rather than waiting for `REPORT_GENERATION`, so a dropped session still has scored answers on record. The score *may* inform `should_follow_up` (a shaky answer is a reason to give the candidate a chance to recover), but per `soul.md §"Growth-oriented follow-ups"` it must never be phrased as a verdict, and a high score must never suppress a follow-up that's otherwise warranted by a specific gap. If the candidate goes on to answer the follow-up itself, that follow-up exchange is scored the same way on the *next* call (when the harness is about to move to the next question) and the result is written onto that specific `follow_ups[]` entry (`{ text, transcript, score, rationale, evidence_spans, rubric_id }`, §6) rather than creating a second top-level `Evaluation` — a follow-up exchange is a sub-unit of the answer it belongs to, not a new evaluable object, so `evidence_spans` here indexes into that follow-up's own transcript, not the original answer's.

### 4.5 Coding Agent
- **Purpose:** run a live coding round — present a problem, accept submissions, execute them in a sandbox, evaluate correctness and reasoning.
- **Input:** candidate profile (for problem selection), submitted code, language, and — if the candidate talks through their approach out loud — the transcribed talk-through from the Speech Service Tool, relayed by the Harness Agent.
- **Output:** `{ problem, test_results[], eval_result, reasoning_notes }`.
- **Calls:** Eval Tool (score the submission + the candidate's talk-through), Clipboard Monitor (only if consent flag set for this session).
- **Rule:** code execution always happens in an isolated sandbox process, never inline in the agent.

```json
// Coding Agent -> Eval Tool
{
  "method": "evaluate_answer",
  "params": {
    "rubric_id": "coding_round_v1",
    "question": "Implement a rate limiter...",
    "answer_transcript": "...",
    "test_results": [{ "case": "basic", "passed": true }]
  }
}
```

### 4.6 Time Tracking Agent
- **Purpose:** enforce and communicate per-segment time budgets (per question, per coding round, overall session cap).
- **Input:** segment start/stop events from the Harness Agent.
- **Output:** `{ elapsed_ms, remaining_ms, segment_state: "on_track"|"nudge"|"expired" }`, pushed periodically over the WebSocket.
- **Calls:** Time Tracking Tool.
- **Rule:** never silently ends a segment — always gives the harness a heads-up state before `expired` so the candidate can be nudged, per `soul.md`.

### 4.7 Memory Agent
- **Purpose:** maintain session-scoped working memory (what's been asked, what's been covered, and the running per-topic question counts against the session's topic plan) and, if the candidate has opted in, cross-session memory (recurring weak areas, previously asked questions to avoid repeats).
- **Input:** session events, including each `Question`'s `topic` as it's asked (so it can increment that topic's count); on session start, a request for relevant prior context (opt-in only).
- **Output:** `{ session_context: { asked_question_ids[], topic_counts: { [topic]: number } }, prior_context? }`. The Harness Agent reads `topic_counts` from here and passes it to the Question Agent on every `get_next_question` call (§4.3) — the Question Agent never queries the Memory Agent directly.
- **Calls:** none directly — reads/writes its own store.
- **Rule:** cross-session recall is opt-in at the account level and must never surface something outside what the candidate would reasonably expect it to remember.
- **(Stage 5 addition)** Two new pieces of session-scoped, non-durable data route through the Memory Agent rather than getting a new table each: (1) each question's `reference_answer`, written when the Question Agent generates it and read by the Follow-up Question Agent for scoring (§4.4) — never written to `questions` or `answers`, and dropped when the session ends; (2) `jd_fit.rationale` / `jd_fit.topic_relevance` working state from the Resume Service Agent (§4.2) during `CONFIG`, so a mid-config resume replace can regenerate them without a fresh LLM call if the resume didn't actually change. The rule that governs both: *if a piece of data is ephemeral by design (soul.md §"No fabrication" reference-answer note; §"Privacy by default"), it lives here — a new durable table is the wrong default.* Only the final, report-facing versions of `jd_fit` fields get written to `sessions.jd_fit` (§6) once `CONFIG` completes.

### 4.8 Report Agent
- **Purpose:** compile the final report — scores per competency, evidence-linked strengths/weaknesses, and suggested focus areas.
- **Input:** the full session transcript, all per-answer evaluations, timing data.
- **Output:** `Report` object (see §6), persisted to the database so it's available on the candidate's Home page stats and in the Admin dashboard independent of whether the candidate's live session is still connected.
- **Calls:** Eval Tool (final holistic scoring pass).
- **Rule:** every score in the report must cite the transcript span it came from; no unevidenced claims (`soul.md §"No fabrication"`).

---

## 5. Tool specifications

### 5.1 Resume Parser Tool
- **Method:** `parse_resume(file_ref) -> { skills[], experience[], education[], keywords[] }`
- **Errors:** `unsupported_format`, `parse_failed` (scanned/unreadable file) — agent must surface these plainly, never guess at content.
- **Privacy:** resume file is processed and the structured result persisted; the raw file is deleted after the session unless the candidate opts into longer retention.

### 5.2 Eval Tool
- **Method:** `evaluate_answer(rubric_id, question, answer_transcript, extra?) -> { score, rationale, evidence_spans[] }`
- Rubrics are versioned and stored in the tool, not in any agent — this is what keeps scoring consistent across the Question Agent, Coding Agent, and Report Agent.
- Every call is persisted by the tool as an `Evaluation` record (§6) in Postgres, not just returned in-memory — scores survive a dropped session and are what the Report Agent and Admin dashboard ultimately read from.
- **Errors:** `unknown_rubric_id`, `insufficient_transcript` (answer too short/off-topic to score meaningfully — tool returns this rather than a low score, so the caller can decide how to handle it).

### 5.3 Time Tracking Tool
- **Methods:** `start_timer(segment_id, budget_ms)`, `pause_timer(segment_id)`, `resume_timer(segment_id)`, `get_elapsed(segment_id) -> { elapsed_ms, remaining_ms }`
- Backed by Redis for low-latency reads during a live session.

### 5.4 Telemetry Service
- **Method:** `emit_event(event_type, payload)` — fire-and-forget, called automatically by the MCP Gateway for every tool call (`tool_called`), plus explicit calls from agents for domain events (`question_asked`, `follow_up_triggered`, `segment_expired`, `device_check_passed`/`device_check_failed` during `TELEMETRY_CHECK`).
- **Privacy:** payloads must never contain full resume text, full answer transcripts, raw audio, or clipboard content — reference IDs only (see §8).

### 5.5 Clipboard Monitor
- **Methods:** `start_monitor(session_id, consent_token)`, emits `paste_event_detected(timestamp)` events to the Harness Agent during `CODING_ROUND` (or any free-text round where it's enabled).
- **Hard requirement:** `start_monitor` must reject the call if no valid `consent_token` for that session is present — this is enforced at the tool level, not just the UI, so a misconfigured agent can't silently enable monitoring.
- **Privacy:** by default only a boolean + timestamp is recorded, never the pasted content itself (see `soul.md §5`).

### 5.6 Speech Service Tool
- **Methods:** `synthesize_speech(text) -> { audio_url, duration_ms }` — converts an agent-generated question or follow-up into spoken audio; `transcribe_speech(audio_ref, input_device?, spoken_recently?) -> { transcript, confidence, source, speech? }` — converts a candidate's spoken answer into text.
- **Called by:** the Harness Agent only (§4.1). No specialized agent talks to this tool directly — audio is a property of the live frontend connection, and centralizing it in one place keeps the voice pipeline auditable and swappable.
- **Implementation:** self-hosted and in-process — no sidecar, no cloud API, no subscription — but **two independent engines composed behind one provider**, not one engine doing both jobs (`CompositeSpeechProvider`):
  - **TTS (Stage 3 addition):** `sherpa-onnx`, running a VITS/Piper-compatible voice. Unchanged.
  - **STT (Stage 11 addition):** `faster-whisper` — `whisper tiny.en` on CTranslate2. This **replaces the sherpa-onnx ASR path entirely**; sherpa no longer transcribes anything. No torch, and Silero VAD ships inside the package so VAD filtering works offline. The model resolves through the HuggingFace cache by default (`STT_MODEL`), or from a vendored CTranslate2 directory (`STT_MODEL_DIR`) for a deployment with no network at all.
  - Composing them means either half can be missing without taking the other down: a machine with the voice but no Whisper model speaks its questions and refuses transcription, which is a far better failure than no speech at all.
- **The transcription pipeline (Stage 11 addition).** `transcribe_speech` is four gates and a decode, in this order, and the order is the design:
  1. **Loopback check**, before the model. A capture device that is a monitor of system output (`Stereo Mix`, `Monitor of …`) is conclusively not a voice — decoding it would spend the whole timeout budget transcribing our own question back at us. → `audio_source_rejected`.
  2. **VAD gate** (`vad.py`), before the model. An energy scan measures the recording's speech, silence, leading/trailing silence and adaptive noise floor; a recording with no speech in it is refused rather than decoded. This is not an optimisation: `tiny.en` answers two seconds of silence with a confident invented word (`" You"`), and downstream that is indistinguishable from a real one-word answer. → `no_speech_detected`.
  3. **Trim, then decode.** Leading and trailing silence is cut (with padding, so low-energy consonants survive), which typically halves the audio the model sees. The decode runs Silero VAD as an in-decode filter on top, under a hard **15-second wall clock** (`STT_TIMEOUT_SECONDS`). The two VAD passes are complementary, not redundant — the energy scan is a cheap pre-model gate that also produces statistics, Silero is a precise in-decode filter. → `transcription_failed` on expiry.
  4. **Echo check**, after the model, because it needs the words. The transcript is compared against `spoken_recently` — the last lines this session synthesised, supplied by the Harness Agent from its own persisted questions, since the tool holds no session state of its own. Matching is on a **run of consecutive words**, not shared vocabulary: answering a question in its own terms is what answering a question looks like, and a bag-of-words test would reject real answers. → `audio_source_rejected`.
  5. **Confidence floor**, unchanged. → `transcription_low_confidence`.
- **Sound source (`source` in the response).** `microphone`, `speaker` or `unknown`. Two independent signals: what the browser reports about the capture device (a hint — it is candidate-controlled, so it can raise suspicion but a `microphone` claim never suppresses the server's own transcript check), and what the audio actually says. `speaker` never appears in a successful response, because it errors; `unknown` means "score this normally", which is the pre-addition behaviour and the correct default — wrongly rejecting a real answer costs a candidate a turn they cannot redo.
- **Errors:** `synthesis_failed` (Harness Agent falls back to displaying the question as text only), `transcription_low_confidence` (prompt the candidate to repeat or offer the typed-text fallback, rather than pass a low-confidence transcript silently into the Follow-up Question Agent or Eval Tool), `no_speech_detected`, `audio_source_rejected`, `transcription_failed`. The last three are distinguished by code rather than by message text because the candidate needs a different sentence for each — and because two of them must carry **no draft transcript**: there is nothing to correct after silence, and offering the candidate a transcript of the interview's own question would invite them to submit it as their answer.
- **Privacy:** raw audio is retained only as long as needed to produce a transcript, then deleted by default — the same rule as clipboard content (§8) — unless the candidate opts into keeping recordings for their own review. Deletion happens on every refusal path too, not only the success path. The `speech` statistics on the response are durations and ratios only, never any part of the audio or the transcript, which is what makes them safe in a telemetry span.

### 5.7 LLM Provider Tool *(Stage 5 addition)*
- **Purpose:** a single provider-agnostic seam for every LLM-backed generation call in the system, so no agent hardcodes a specific model vendor's SDK. Implemented as the thin server side of `packages/llm-client` (§11.5) — the "tool" here is a routing/config layer, not a new place where prompts or business logic live.
- **Method:** `generate_structured(tool_name, prompt_version, input, schema_ref) -> { output, prompt_version, provider, grounded }` — `schema_ref` points into `/packages/mcp-schemas`, the same schema the calling agent's own MCP contract uses, so the LLM's structured output and the agent's return value are validated against one definition, not two that can drift.
- **Providers:** `bedrock` (production default, `CLAUDE.md §6`), `openrouter` (free alternate for local dev), `groq` (Stage 5: wired up for the Resume Service, Question, and Follow-up Question Agents, model `openai/gpt-oss-120b`, chosen for low-latency interactive generation). Selected via `LLM_PROVIDER` env var per-deployment; nothing in an agent's own code names a provider directly.
- **Calls:** the configured provider's API only. Never calls another agent or another shared tool.
- **Errors:** `provider_unavailable` (agent falls back to the deterministic rule-based path that already exists for that agent from Stage 2, per `TRACKING.md` "The model seam" — never blocks the session), `schema_validation_failed` (one retry with a corrective message, then `insufficient_signal` per `soul.md §6`), `grounding_check_failed` (§11.3 — the specific ungrounded field is dropped, not the whole response, unless the whole response depends on it).
- **Privacy:** every call's prompt/response passes through whatever the configured provider's data-use terms are — see `soul.md §"Privacy by default"` (Stage 5 addition) for the third-party-sharing exception this represents, and `.env.example` for the currently-documented terms per provider.

---

## 6. Data models (illustrative TypeScript)

```typescript
interface User {
  id: string;
  email: string;
  role: "admin" | "student";
  // passcode is stored as a salted hash, never plaintext — see §8
  fullName?: string;    // (Stage 5 addition) collected at signup/profile; required before a session can be archived (§11.4)
  department?: string;  // (Stage 5 addition)
  programYear?: string; // (Stage 5 addition) — string, not int: covers "3rd Year", "Alumni", "Grad", etc.
}

interface JdFit {
  fitScore: number; // 0-1
  matchedRequirements: string[];
  gaps: string[]; // folded into required_topics for the topic plan, §4.3
  rationale: string;                  // (Stage 5 addition) — grounded natural-language explanation, §4.2
  topicRelevance: TopicRelevance[];    // (Stage 5 addition) — JD-anchored, distinct from CandidateProfile.topicRelevance (resume-anchored), §4.2
  promptVersion: string;               // (Stage 5 addition) — e.g. "resume-service-agent/v1", for reproducibility (§11.5)
}

interface Session {
  id: string;
  candidateId: string; // references User.id where role === "student"
  role: string;
  jobDescription: string;
  jdFit: JdFit;
  state: SessionState; // see §3
  consent: { telemetry: boolean; clipboardMonitor: boolean; audioRecording: boolean; crossSessionMemory: boolean };
  questionBudget: number;      // total questions for the session, default 8
  topicPlan: TopicPlanEntry[]; // set once at CALIBRATION, read by Question Agent on every call
  createdAt: string;
}

interface TopicRelevance {
  topic: string;
  relevanceScore: number; // 0-1, how strongly the resume supports this topic
  evidence: string;       // must trace back to specific resume text
}

interface TopicPlanEntry {
  topic: string;
  maxQuestions: number;               // floor 1, ceiling 3 per topic
  source: "resume" | "role_requirement" | "jd_gap";
}

interface CandidateProfile {
  skills: string[];
  experience: { title: string; company: string; years: number }[];
  education: { degree: string; institution: string }[];
  seniorityEstimate: "junior" | "mid" | "senior" | "staff+";
  topicRelevance: TopicRelevance[];
}

interface Question {
  id: string;
  text: string;
  audioUrl?: string; // set by the Harness Agent via Speech Service Tool before reaching the frontend
  topic: string;
  type: "behavioral" | "technical" | "coding";
  difficulty: number; // 1-5
  quotaOverride?: boolean; // true if this question exceeded its topic's max_questions as a last resort
  promptVersion?: string; // (Stage 5 addition) — set only when LLM-generated; absent for question-bank fallback picks
  // NOTE: `referenceAnswer` is deliberately NOT a field here. It lives only in the Memory Agent's
  // session-scoped store (§4.7) and is passed directly to the Follow-up Question Agent — it must
  // never round-trip through the Question object the Harness Agent hands to the frontend.
}

interface FollowUpExchange {
  text: string;
  transcript: string;
  score?: {                                        // (Stage 5 addition)
    rubricId: string;
    value: number;
    rationale: string;
    evidenceSpans: { start: number; end: number }[]; // indexes into THIS follow-up's transcript, not the answer's
  };
}

interface Answer {
  questionId: string;
  transcript: string;       // from Speech Service Tool STT, or typed fallback
  transcriptConfidence?: number;
  submittedAt: string;
  followUps: FollowUpExchange[]; // (Stage 5: element shape extended, see above)
}

interface Evaluation {
  answerId: string;
  rubricId: string;
  score: number;
  rationale: string;
  evidenceSpans: { start: number; end: number }[];
  promptVersion?: string; // (Stage 5 addition) — set when the score came from an LLM-backed call path
}

interface Report {
  sessionId: string;
  candidateId: string; // lets the Admin dashboard list/query reports across candidates
  competencyScores: { competency: string; score: number; evidence: string[] }[];
  strengths: string[];
  focusAreas: string[];
  disclaimer: string; // required: "this is practice, not a hiring prediction" — see soul.md §3
}

// (Stage 5 addition) — one archive document per completed session, written to the Supabase
// Postgres archive store (§11.4), never to the primary application Postgres.
interface SessionArchive {
  sessionId: string;
  candidateId: string;
  candidateName: string;   // from User.fullName — archiving is refused if this is unset (§11.4)
  department?: string;
  programYear?: string;
  archivedAt: string;
  document: {
    session: Session;
    topicPlan: TopicPlanEntry[];
    questions: Question[];
    answers: Answer[];       // transcript reflects whatever the primary store held at archive time —
                              // i.e. already redacted per §8 unless the candidate opted into retention.
                              // Archiving NEVER un-redacts; it is compiled strictly after the Stage 4
                              // retention job runs (soul.md §5 Stage 5 guardrail).
    evaluations: Evaluation[];
    report: Report;
  };
}
```

---

## 7. API surface (frontend <-> gateway <-> harness)

**Auth (REST, no session required)**
- `POST /auth/login` — email + passcode, returns a role-scoped token (`admin` or `student`)
- `POST /auth/reset-passcode/request` — emails a single-use reset link/code
- `POST /auth/reset-passcode/confirm` — sets a new passcode using that link/code
- `POST /auth/register` — **(Stage 3 addition)** self-service signup; email + passcode, always creates a `student`-role account. Admin accounts remain operator-provisioned only (§3.2).

**REST**
- `GET /me/stats` — student's own past interview stats, for the Home page
- `GET /admin/reports` — admin-only, list all candidates' reports for the Home dashboard
- `GET /admin/reports/:sessionId` — admin-only, fetch one candidate's full report
- `POST /sessions` — create a session (role, job description), returns `session_id`
- `POST /sessions/:id/resume` — upload resume; triggers Resume Service Agent parsing + JD-fit check
- `DELETE /sessions/:id/resume` — delete the uploaded resume (hard-deletes the stored file, §8)
- `GET /sessions/:id/jd-fit` — fetch the JD-fit result for the Interview Config page
- `POST /sessions/:id/telemetry-check` — record device check results (mic, speaker) and consent flags; must pass before the session can move past `TELEMETRY_CHECK`
- `GET /sessions/:id/report` — fetch the final report once `COMPLETED`
- `GET /admin/archives/:sessionId` — **(Stage 5 addition)** admin-only; returns `SessionArchive` metadata (candidate name/department/year, archived-at) without the full `document` body, for a listing view.
- `GET /admin/archives/:sessionId/download` — **(Stage 5 addition)** admin-only; streams the full `SessionArchive.document` as a file attachment (JSON by default). Fetched server-side from the Supabase archive store using a service-role credential that never reaches the client (§8, §11.4); emits an audited `archive_downloaded` telemetry event on every call.

**WebSocket** — `/sessions/:id/live`
- Server -> client: `question` (includes `audio_url` from TTS), `follow_up` (same), `timer_tick`, `coding_problem`, `paste_detected`, `session_complete`
- Client -> server: `submit_answer_audio` (raw audio blob — transcribed via the Speech Service Tool before any agent sees it), `submit_answer_text` (typed fallback, e.g. when transcription confidence is low), `submit_code`, `pause`, `end_session`

---

## 8. Security and privacy

- **Authentication:** passcodes are stored as salted hashes, never plaintext. The reset-passcode flow uses a short-lived, single-use token sent to the account's registered email — the token itself is never accepted as a permanent credential.
- **Role-based access:** enforced at the Gateway on every request, not just in the frontend UI. A student can only ever read their own sessions and reports. The Admin role can read all candidates' `Report` records but gets no elevated access to raw resumes, audio, or transcripts beyond what a report already contains — see `soul.md`.
- **Consent gating:** clipboard monitoring, audio recording retention, and any transcript-level (as opposed to metadata-level) telemetry require an explicit per-session consent flag, captured on the Telemetry Check page and checked both in the UI and enforced at the tool level (§5.5, §5.6).
- **Data minimization:** telemetry payloads carry event types, IDs, and timings — never raw resume text, answer transcripts, raw audio, or clipboard content.
- **Retention:** raw resume files, raw audio recordings, and full transcripts are retained only as long as needed to generate the report, then deleted, unless the candidate opts into longer retention for their own review.
- **Deletion:** a `DELETE /sessions/:id/resume` request (or any explicit "delete resume" action on the Interview Config page) hard-deletes the stored file — it is never just unlinked or hidden.
- **Encryption:** all data in transit over TLS; resume files, audio, and transcripts encrypted at rest.
- **No third-party sharing** of candidate data by default.
- **(Stage 5 addition) LLM provider exception:** text sent to the LLM Provider Tool (§5.7) — resume content, job description, transcripts, for the Resume Service/Question/Follow-up agents' generation calls — is the one documented, named exception to "no third-party sharing." Every provider in use (Bedrock, OpenRouter, Groq) must have its data-use/retention terms documented in `.env.example`; this is a requirement, not a suggestion, and applies independently of which provider is the active default. If LangSmith tracing is enabled, it is a *second* such exception (it receives the same prompt/response content for observability) and must be documented and gated the same way — off by default outside local development.
- **(Stage 5 addition) Archive access boundary:** the Supabase archive store (§11.4) is reached only from server-side code via a service-role credential; it is never queried from a browser client, and Supabase's own auth/RLS is not the access-control boundary for it — this system's existing Gateway RBAC (admin-only) is, so there is exactly one place that decides who can read candidate data, matching the rest of this section. Every read is audited (`archive_downloaded`, §7).

---

## 9. Non-functional requirements

- **Latency budgets:** question generation < 2s, follow-up generation < 3s, per-answer eval < 4s, sandboxed code execution < 5s, text-to-speech synthesis < 1.5s before a question is spoken, speech-to-text transcription < 2s after the candidate stops talking. The Harness Agent should show a "thinking"/"listening" state to the frontend past these thresholds rather than let the UI hang silently. **(Stage 5 addition)** the cheap-path grounding check (§11.3, substring-match against source documents) adds < 100ms and is included inside the generation budgets above; the expensive-path grounding check (a second LLM call) is only invoked when the cheap path is inconclusive and is budgeted an additional < 1.5s — if it would push a call past budget, the agent returns `insufficient_signal` rather than block the session waiting on a second LLM round-trip.
- **Scalability:** agents are stateless where possible; all session state lives in Redis/Postgres so any agent instance can serve any session, enabling horizontal scaling per agent (the Coding Agent, being the most expensive, is the one most likely to need independent scaling).
- **Observability:** every MCP call auto-emits `tool_called`/`agent_called` telemetry with latency and status via the gateway; domain events (`question_asked`, `segment_expired`, etc.) are emitted explicitly by the owning agent.

---

## 10. Assumptions and open questions

- Assumed Claude (via the Anthropic API) was the model behind every agent through Stage 4. **(Stage 5 addition, resolved):** this was already flagged as swappable per-agent, and Stage 5 exercises exactly that — the Resume Service, Question, and Follow-up Question Agents now generate through `packages/llm-client` / the LLM Provider Tool (§5.7, §11.5) against Groq (`openai/gpt-oss-120b`) by default, with Bedrock and OpenRouter available via the same seam. The Harness Agent, Coding Agent, Time Tracking Agent, Memory Agent, and Report Agent are unchanged by this and keep whatever model/approach they were already using — Stage 5 doesn't force every agent onto one provider.
- Voice is first-class, not optional: questions are delivered via text-to-speech and candidate answers are captured via speech-to-text (§5.6), with typed text as an explicit fallback when transcription confidence is low. A code editor is also available for the coding round regardless of voice talk-through.
- Live video/webcam proctoring is out of scope for this spec and would need its own agent + tool if added later — the Clipboard Monitor and Speech Service cover the monitoring surface described so far.
- Assumes a single target role and job description per session; multi-role comparison sessions would need a change to the state machine in §3.
- Open question: whether the Coding Agent's sandbox is self-hosted or a third-party code-execution API — pick based on the team's security/compliance requirements before implementation.
- ~~Open question: which TTS/STT provider the Speech Service Tool wraps (cloud API vs self-hosted)~~ — resolved as a Stage 3 addition: `sherpa-onnx`, self-hosted and in-process (§5.6). **Revised in Stage 11:** self-hosted still holds, but it is now two engines rather than one — sherpa-onnx for TTS, `faster-whisper` for STT.
- Open question: exact rubric definitions for the Eval Tool (what "evidence_spans" precision looks like) — should be drafted with input from whoever owns hiring/interview subject-matter expertise, not invented solely by engineering.

---

## 11. Stage 5 — LLM-backed agents, structured tool calling, and session archival

Scope: makes the Resume Service, Question, and Follow-up Question Agents genuinely LLM-backed (they were rule-based through Stage 4, per `TRACKING.md` "The model seam"), formalizes the stateless-agent assumption that was already implicit, adds a scoring step to follow-ups, and ships a per-session archive to a separate Supabase Postgres instance for Admin export. Read `soul.md`'s Stage 5 additions before implementing any part of this — the ethical constraints there are not optional extensions of what's written here.

### 11.1 Stateless reducer contract

Every agent — not just the three going LLM-backed — is specified as a pure function of the context it's given, not a process with memory:

```typescript
type Reducer<TInput, TContext, TOutput> = (input: TInput, context: TContext) => Promise<TOutput>;
```

- `TContext` is assembled by the Harness Agent on *every* call, sourced from the Memory Agent, Redis, and Postgres — never cached in the agent process between calls.
- An agent instance may be killed and replaced with a fresh one between any two calls in the same session with no observable difference in output, given the same input and context. This is what makes horizontal scaling per agent (`INSTRUCTIONS.md §9`, `CLAUDE.md §3`) actually safe, not just theoretically possible.
- Practically: no module-level mutable state in `/agents/**`, no in-memory cache keyed by `session_id` inside an agent, no "remember the last N calls" shortcut — if it needs remembering, it goes through the Memory Agent (§4.7) where it's inspectable and scoped.
- This was already true by construction for the Stage 1–4 rule-based agents; Stage 5 makes it an explicit, testable contract because LLM-backed calls are the first place a well-intentioned optimization (client-side prompt caching keyed by session, a warm conversation object per session) would quietly violate it.

### 11.2 Follow-up scoring addition

Summarized in full at §4.4; the shape in one place:

1. Follow-up Question Agent receives `{ question, answer_transcript, reference_answer }`.
2. It calls the Eval Tool to score `answer_transcript` against `reference_answer` — this `Evaluation` is persisted immediately, not deferred to `REPORT_GENERATION`.
3. It then decides `should_follow_up`, optionally informed by that score, per the follow-up-quality rule already in §4.4 and `soul.md`.
4. If a follow-up is asked and answered, the *next* call scores that follow-up transcript the same way and writes the result onto `answers.follow_ups[i]` (§6 `FollowUpExchange`) — not a new top-level `Evaluation`, since a follow-up is a sub-unit of its answer.

### 11.3 Grounding checks

A grounding check runs inside `packages/llm-client`, in-process, right after a structured LLM call and before its output is returned to the calling agent. It is **not** a new MCP tool or server — it doesn't need its own auth/telemetry hop because it's app logic validating an agent's own generation, not a cross-agent or cross-tool interaction (`CLAUDE.md §5` "golden rule" governs agent/tool *calls*, not in-process validation).

```typescript
// packages/llm-client/src/grounding.ts
export interface GroundableField {
  value: string;
  evidence: string; // the substring the model claims supports `value`
}

export async function groundingCheck(
  fields: Record<string, GroundableField>,
  sourceDocuments: string[],
): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  const normalized = sourceDocuments.map(normalizeWhitespace);

  for (const [key, field] of Object.entries(fields)) {
    // cheap path: does the cited evidence actually appear in a source document?
    const cheapPass = normalized.some(doc => doc.includes(normalizeWhitespace(field.evidence)));
    if (cheapPass) { result[key] = true; continue; }

    // expensive path only on an inconclusive cheap-path result — one additional structured call,
    // same provider, logged to LangSmith under a "grounding-check" run name so a failed check is
    // itself auditable (soul.md §"Grounding is checked, not assumed").
    result[key] = await llmGroundingFallback(field, sourceDocuments);
  }
  return result;
}
```

- A field that fails both passes is dropped from the agent's output and replaced with `insufficient_signal: true` on that field — never silently omitted (the caller must be able to tell "no signal" apart from "signal, but it happened to be empty").
- The whole response is only rejected if a *required* field fails (e.g. `Question.text` itself); an optional enrichment field (like `jd_fit.rationale`) failing doesn't block the rest of the response.

### 11.4 Session archive → Supabase

At `COMPLETED`, strictly *after* the existing Stage 4 retention/redaction job runs (`soul.md §5` Stage 5 guardrail), the Harness Agent triggers a compile-and-ship step — not a new agent, just a job, since there's no decision-making here, only assembly:

1. Read the (already-redacted) `Session`, `TopicPlanEntry[]`, `Question[]`, `Answer[]`, `Evaluation[]`, and `Report` for the session from the primary Postgres.
2. Refuse to proceed if `User.fullName` is unset for the candidate — archiving requires the profile fields (§6 `User`); this is a hard stop, not a "archive with blanks."
3. Assemble one `SessionArchive` document (§6) and upsert it into the **Supabase-hosted** Postgres `session_archives` table (§11.6) — a physically separate database from the primary application Postgres, reached only with a server-side service-role credential (§8).
4. Nothing about this step touches the primary Postgres record — the archive is a copy for admin export, not a second source of truth. If archiving fails, the session still completes normally for the candidate; archiving is retried as a background job, never blocks `REPORT_GENERATION` → `COMPLETED`.

Admin access is exclusively through `GET /admin/archives/:sessionId` and `GET /admin/archives/:sessionId/download` (§7) — Supabase itself is never exposed to any client, and every read is audited (§8).

### 11.5 `packages/llm-client` — structured tool calling

Single source of truth for (a) which schema an LLM call must return, (b) which prompt version produced it, and (c) which provider served it — so the MCP contract in `/packages/mcp-schemas` and the LLM's function-calling schema are literally the same object, not two hand-synced copies.

```typescript
// packages/llm-client/src/types.ts
import { z } from "zod";

export interface ToolDefinition<TSchema extends z.ZodTypeAny> {
  name: string;                 // matches the MCP method name it backs
  description: string;
  schema: TSchema;              // also the schema registered in /packages/mcp-schemas
  promptVersion: string;        // "{agent}/v{n}" — see PromptRegistry below
}

// packages/llm-client/src/provider.ts
export type ProviderName = "bedrock" | "openrouter" | "groq";

export function createChatModel(provider: ProviderName) {
  switch (provider) {
    case "groq":
      // OpenAI-compatible endpoint; model is the open-weight GPT-OSS-120B served on Groq's LPU inference.
      return new ChatGroq({ apiKey: requireEnv("GROQ_API_KEY"), model: "openai/gpt-oss-120b", temperature: 0.3 });
    case "bedrock":
      return new ChatBedrockConverse({ model: requireEnv("BEDROCK_MODEL_ID"), region: requireEnv("AWS_REGION") });
    case "openrouter":
      return new ChatOpenAI({ apiKey: requireEnv("OPENROUTER_API_KEY"), configuration: { baseURL: "https://openrouter.ai/api/v1" } });
  }
}

// packages/llm-client/src/promptRegistry.ts
export class PromptRegistry {
  // prompts live as versioned files: packages/llm-client/prompts/{agent}/v{n}.ts
  // the ACTIVE version per agent is pinned in one config object, never inferred from "latest file" —
  // bumping a prompt without bumping its version string is a CI failure (§ Stage gate test 3, TRACKING.md).
  static get(promptVersion: string): PromptTemplate { /* ... */ }
}

// packages/llm-client/src/structuredCall.ts
export async function structuredCall<TSchema extends z.ZodTypeAny>(
  tool: ToolDefinition<TSchema>,
  input: unknown,
  opts: { provider: ProviderName; sourceDocuments?: string[]; retries?: number },
): Promise<{ output: z.infer<TSchema> | null; grounded: boolean; promptVersion: string; provider: ProviderName }> {
  const model = createChatModel(opts.provider).withStructuredOutput(tool.schema);
  const prompt = PromptRegistry.get(tool.promptVersion);
  let lastError: unknown;

  for (let attempt = 0; attempt <= (opts.retries ?? 1); attempt++) {
    try {
      const raw = await model.invoke(prompt.render(input), {
        runName: tool.name,
        tags: [tool.promptVersion, opts.provider], // LangSmith run metadata — off outside dev by default, see §8
      });
      const parsed = tool.schema.parse(raw); // re-validate against the SAME schema as the MCP contract
      if (opts.sourceDocuments) {
        const groundedFields = await groundingCheck(extractGroundableFields(parsed), opts.sourceDocuments);
        if (Object.values(groundedFields).some(g => !g)) {
          return applyInsufficientSignal(parsed, groundedFields, tool.promptVersion, opts.provider);
        }
      }
      return { output: parsed, grounded: true, promptVersion: tool.promptVersion, provider: opts.provider };
    } catch (err) {
      lastError = err; // retry once with a corrective system message on schema-validation failure only
    }
  }
  throw new StructuredCallError(tool.name, lastError); // caller falls back to the deterministic Stage-2 path
}
```

Every specialized agent that's LLM-backed calls `structuredCall`, never the raw provider SDK directly — this is what keeps the Bedrock/OpenRouter/Groq choice a deployment concern instead of something baked into agent code.

### 11.6 Schema/migration deltas (illustrative SQL, primary app Postgres unless noted)

```sql
-- User profile fields for archiving (§6 User, §11.4)
ALTER TABLE users ADD COLUMN full_name TEXT;
ALTER TABLE users ADD COLUMN department TEXT;
ALTER TABLE users ADD COLUMN program_year TEXT;

-- sessions.jd_fit is already JSONB (Stage 1) — the `rationale` / `topic_relevance` / `prompt_version`
-- fields (§6 JdFit) are a shape change validated by /packages/mcp-schemas, not a column migration.

-- answers.follow_ups is already JSONB (Stage 1) — the per-follow-up `score`/`rationale`/`evidence_spans`
-- (§6 FollowUpExchange) is likewise a shape change, not a column migration.

-- evaluations gains one nullable column so a follow-up-linked score is queryable without a second table:
ALTER TABLE evaluations ADD COLUMN prompt_version TEXT;

-- NEW — on the Supabase-hosted Postgres instance, not the primary app database (§11.4, §8):
CREATE TABLE session_archives (
  session_id     UUID PRIMARY KEY,
  candidate_id   UUID NOT NULL,
  candidate_name TEXT NOT NULL,
  department     TEXT,
  program_year   TEXT,
  document       JSONB NOT NULL,
  archived_at    TIMESTAMPTZ DEFAULT now()
);
-- No Supabase RLS policy is relied on for access control — see §8 "Archive access boundary."
-- If RLS is enabled anyway as defense-in-depth, it should default-deny and be a no-op given that
-- only the server-side service-role credential ever connects.
```

### 11.7 Modifications flagged during this stage's design (read before implementing)

- **Archive vs. redaction ordering was the one real conflict in the original ask.** "Ship the entire document of all the data" and the existing Stage 4 retention policy (redact transcripts after report generation, hard-delete resumes) pull in opposite directions if taken literally at the same time. Resolved by ordering: redaction runs first, archive compiles second, so the archive can never be *more* permissive than the primary record — see §11.4 and the new `soul.md` guardrail. If the product actually wants un-redacted transcripts preserved in the archive, that needs to be a new, explicit consent flag (parallel to `consent.crossSessionMemory`), not a side effect of adding archiving.
- **New `User` profile fields** (`fullName`, `department`, `programYear`) didn't exist before this stage and have no collection UI yet — needs a signup/profile-completion form addition; archiving refuses (§11.4 step 2) rather than silently archiving with blanks, so this has to land before archiving can work end-to-end, not after.
- **LangSmith is a distinct third-party data flow**, not a detail of picking Groq — it needed its own callout in `soul.md`/§8 rather than being bundled into the Bedrock/OpenRouter/Groq provider note, since a team could enable Groq without LangSmith or vice versa.

---

## 12. Stage 6 — Tiered concept-escalation model (`systemBlueprint`)

Reshapes the flat `difficulty: 1-5` + `expectedSignals[]` question model (§4.3, §6) into an explicit three-tier `extractionMatrix`, and formalizes the Follow-up Question Agent's existing deterministic gap detector into a named `nextActionGenerator` directive. Additive throughout — see `TRACKING.md` Stage 6 for exactly what changed and the stage-gate tests. Nothing here replaces §4.3/§4.4/§4.7/§5.2 above; it extends them, and every field below is optional on the wire.

### 12.1 `systemBlueprint` — a role's static evaluation plan

Built once per role by `@mia/interview-domain`'s `buildSystemBlueprint(role)`, not per session:

```typescript
interface SystemBlueprint {
  roleProfileId: string;   // e.g. "backend-engineer" — RoleProfile.id (§4.3's requiredTopicsFor)
  domainFocus: string;     // RoleProfile.label, e.g. "Backend Engineer"
  evaluationTopics: EvaluationTopicBlueprint[];  // one per bank topic (packages/interview-domain/topics.ts)
}

interface EvaluationTopicBlueprint {
  topicId: string;  // == the existing `topic` string everywhere else in this doc
  dynamicFraming: {
    // The RULE for picking a resume anchor — a template, not a resolved
    // value. Resolution (which is per-candidate) stays the Question Agent's
    // job at generation time, same as today's `candidate_profile_lines` (§4.3).
    resumeContextIntegrationRule: string;
  };
  extractionMatrix: {
    tier_1_baseline: TierSpec;
    tier_2_intermediate: TierSpec;
    tier_3_advanced: TierSpec;
  };
}

interface TierSpec {
  tier: 1 | 2 | 3;
  targetConceptIds: string[];             // derived from BankQuestion.expectedSignals via conceptId()
  escalationTriggerCondition: string | null;  // null at tier 3 — nothing above "advanced"
}
```

A topic's three tiers are exactly its three existing bank questions (difficulty 2/3/4), which already formed a tier ladder in every way but name (soul.md §4: "opens below the target and works up"). `tierOf(difficulty)` makes that explicit rather than introducing a second numbering.

### 12.2 §4.3 addition — per-topic tier selection

`get_next_question` gains two optional inputs: `topic_tier: Record<topic, 1|2|3>` (the tier of the last question asked in each topic — from the Memory Agent, §12.3) and `topic_scores: Record<topic, number[]>` (that topic's own score history, distinct from the session-wide `recent_scores` §4.3 already has). When a topic has a recorded tier, escalation runs **per topic**, off that topic's own recent scores only — soul.md §"Balanced coverage" applies to depth now, not just count: a strong run of answers in "databases" must never escalate "system design" too. A topic with no recorded tier yet falls back to the pre-Stage-6 global difficulty curve, unchanged.

The response's `question` object gains optional `tier` (1-3) and `target_concept_ids` (that tier's `targetConceptIds`, from `EvaluationTopicBlueprint`). `difficulty` is untouched — it still means what §6 always said, and is kept in lockstep as `tier + 1` for report/UI continuity. `target_concept_ids` is never sent to the candidate, same rule as `expected_signals` and `reference_answer`.

### 12.3 §4.7 addition — `topic_tier` in session context

`get_session_context`'s response gains `topic_tier: Record<topic, 1|2|3>`, derived from persisted `Question.tier` the exact same way `topic_counts` is derived from persisted questions (§4.7: "counts are derived... rather than kept in a separate counter") — no new store, no new write path.

### 12.4 §4.4 addition — anti-patterns and the next-action directive

`consider_follow_up` gains optional inputs `tier` and `target_concept_ids` (the triggering question's own, §12.2) and its response gains three fields:

- **`anti_patterns_detected: string[]`** — the deterministic gap detector's *full* hit list (§4.4's existing `GAPS` table: `no_personal_action`, `team_without_self`, `no_outcome`, `unquantified_claim`, `no_reasoning`, `hedged_claim`), not just the one gap it chose to probe. The probe itself is unchanged — still exactly one, still targeting the first/most-severe gap.
- **`verified_concept_ids` / `unverified_concept_ids`** — from the Eval Tool's new `verify_concepts` (§12.5), called against the triggering question's `target_concept_ids`. An enrichment: if the caller supplied no `target_concept_ids`, or the Eval Tool call fails, these are simply absent — the score and the follow-up decision are unaffected.
- **`next_action`** — the deterministic decision, computed the same way `should_follow_up` always was (never by the LLM call, which still only phrases the probe):

```typescript
interface NextActionGenerator {
  systemDirective: "escalate" | "pivot" | "drill_down";  // never "conclude" — see below
  targetConceptIdForNextPrompt: string | null;
  synthesizedFramingStrategy: string;   // a short instruction for the next generation call
  generatedFollowUpPrompt: string | null;  // mirrors follow_up_text under the blueprint's name
}
```

Decision rule: a detected gap always means `drill_down` (soul.md §"Growth-oriented follow-ups" still applies — probing, not trapping). Absent a gap, full coverage of the current tier's target concepts at tier < 3 means `escalate`; anything else means `pivot`. **`conclude` is never returned by this agent** — it has no view of the session's question budget (§4.1 is still exclusively the Harness Agent's to decide "the loop is over").

### 12.5 §5.2 addition — Eval Tool `verify_concepts`

```json
// Follow-up Agent -> Eval Tool
{
  "method": "verify_concepts",
  "params": {
    "answer_transcript": "...",
    "concepts": [{ "id": "databases.t1.reason-for-the-split", "label": "reason for the split" }]
  }
}
```

Same evidence-first discipline as `evaluate_answer`'s rubric signals (§5.2, soul.md §"No fabrication") — a concept is "verified" only because specific words from its label appear in the transcript (`termCoverage`, reused from the existing reference-answer scoring path), never an LLM's unsupported judgement call. Concept ids carry no label of their own on the wire; callers without one reconstruct a best-effort label via `labelFromConceptId` (the inverse of `conceptId`'s slugging).

### 12.6 `liveSessionState` — a composed snapshot, not a new stored shape

The illustrative `liveSessionState` object (`sessionId`, `candidateId`, `activeTopicId`, `sessionMetrics`, `contextEngine`, `extractionProcessor`, `nextActionGenerator`) is not a new place session state lives. Every field in it already has exactly one owner — `Session` (harness), `Question` (Question Agent, §12.2), `Answer.extraction`/`Answer.nextAction` (Follow-up Agent, §12.4), the Time Tracking Tool (§5.3) — and Stage 5's stateless-reducer rule (§11.1) is exactly the rule that says a second, aggregate home for the same facts is the wrong default.

`agents/harness-agent`'s `composeLiveSessionState` assembles the shape as a **read-only projection**, computed fresh on every `submitAnswer` call from that call's own inputs, never persisted:

```typescript
interface LiveSessionState {
  sessionId: string;
  candidateId: string;
  activeTopicId: string;             // the just-answered question's topic
  sessionMetrics: {
    elapsedTimeSeconds: number;      // from the Time Tracking Tool's stop_segment result
    topicCompetencyScore: number;    // THIS TURN's score / 5, not a running average — see the type's doc comment
    currentDemonstratedTier: number; // the just-answered question's tier
  };
  contextEngine: {
    activeResumeAnchor: string;      // dynamicFraming.resumeContextIntegrationRule (§12.1), resolved for this candidate
    lastDeliveredPrompt: string;     // the just-answered question's text
  };
  extractionProcessor: ExtractionProcessorResult;  // §12.4 — transcribedInputChunk included here ONLY, never persisted (§12.7)
  nextActionGenerator: NextActionGenerator;        // §12.4
}
```

Exposed as `live_session_state` in `POST /sessions/:id/answers`'s response, present under the same condition as `extraction`/`next_action` (§12.4: the Follow-up Agent had a tool client to reach the Eval Tool with). `contextEngine.activeResumeAnchor` is the one field here that isn't just a rename of something already returned elsewhere — it resolves the topic's `resumeContextIntegrationRule` against this candidate's actual `CandidateProfile.topicRelevance`, same evidence-only rule as `soul.md §"No fabrication"`: a real resume line when one exists for the topic, an honest "no resume evidence on file for `<topic>`" when it doesn't, never an invented one.

### 12.7 A redaction hazard this stage found, and how it's closed

`Answer.extraction.transcribedInputChunk` (the transcript the concept-verification pass ran against) is **never persisted** — it exists only on the same-request wire response. `AnswerStore.redact()` (§8) only knows to blank `transcript` and `followUps[].transcript`; a second durable copy of the candidate's words in a new column would silently survive redaction and leak into the post-redaction archive (soul.md §5, §11.4's "never more permissive than the primary record"). This was caught live by the Stage 5 archive-ordering gate test the first time the field was (wrongly) persisted — `AnswerStore.recordExtraction` strips it before every write, and the type is documented accordingly rather than trusted to future callers' memory.
- **Grounding checks are library code, not a new MCP tool** — an earlier read of "structured tool calling design" could have turned this into an eighth tool server with its own auth/telemetry hop, which would add a network round-trip and an audit-log entry for something that's really "did my own output pass my own check." Kept in-process in `packages/llm-client` instead (§11.3).
- **Follow-up scores live inline in `answers.follow_ups`, not in a new table.** A separate `follow_up_evaluations` table was considered (parallel to `evaluations`) but rejected: a follow-up is a sub-exchange of an answer, always read together with it, and `evaluations.evidence_spans` already assumes indices into `answers.transcript` specifically — reusing it for follow-up transcripts would silently break that assumption for every existing consumer of the table.
---

## 13. Interview continuity and the grading scale

Two additions on top of Stage 6, both filling gaps the earlier stages left open rather than changing any contract they defined. Every Stage 1-6 wire shape, DB column and test still holds; each new field below is optional, and an absent one reproduces the pre-addition behaviour exactly.

### 13.1 §4.3 addition — the directive reaches the question that acts on it

Stage 6 gave the Follow-up Agent a `next_action` directive (§12.4) and gave the Question Agent per-topic tier escalation (§12.2). It never connected them. `next_action` was computed on every answer, persisted to `answers.next_action`, and surfaced in `live_session_state` — and then nothing read it. The next question came from `topic_counts`/`topic_tier` alone, and `_pick_from`'s least-covered-topic-first ordering moved the interview off the just-discussed topic on the very next turn. So `escalate` — "this topic's tier is covered, go deeper" — could not in practice produce an escalation.

`get_next_question` gains two optional inputs, both assembled by the **Harness Agent** from its own stores and passed down. Neither agent reads the other; the hop is a harness routing decision, exactly as CLAUDE.md §5 requires:

- **`next_action`** — the `NextActionGenerator` (§12.4) persisted on the most recently answered question in this session.
- **`recent_exchanges`** — a short trailing window (3) of `{ topic, question, answer_excerpt }`, oldest first, excerpted to ~60 words. Data minimisation (§8) applies to what leaves for a provider as much as to what is logged: re-sending the whole transcript every turn is not required to write one question that follows from the last one.

**What the directive may and may not do.** It reorders the plan and nothing else:

| Directive | Effect on selection |
|---|---|
| `escalate`, `drill_down` | The topic of the most recent exchange is tried FIRST, before the least-covered ordering. |
| `pivot`, `conclude`, absent | No effect — the pre-existing ordering stands unchanged. |

The topic's cap still binds (a capped topic is released to the normal ordering despite an `escalate`), an already-asked bank question is still excluded, and the tier still comes from `next_tier_for` — so an `escalate` on a topic whose scores do not support escalation does *not* get a harder question just because a directive asked for one. When the directive actually changed the pick, the response carries `followed_directive` and the harness emits a `directive_followed` telemetry span; when it changed nothing, neither appears. "Why did it stay on databases?" is then a recorded fact rather than an inference from the question sequence.

**Generation (`question-agent/v4`).** The prompt now receives `RECENT EXCHANGES` and `DIRECTIVE` blocks, and `transition_style` (§12.4) selects the opening: `same_topic` refers back to something specific the candidate said and moves forward from it, `topic_shift` closes the last thread and opens a new one cleanly, `none` opens on the question's own terms. The trailing window is added to `source_documents` for the grounding check (§11.3) — a question that transitions from the previous answer has to be able to cite that answer, and the candidate's own words were already an admissible source for the Follow-up Agent's probes (§4.4). Two rules are new and load-bearing:

- **The model must never say whether the previous answer was right.** It writes this question before that answer has been scored and is not told the score; praise or correction here would be a verdict it does not have (`soul.md §"No fabrication"`). It may refer to *what* the candidate said, never to how good it was.
- **Escalating means going a level deeper, not rephrasing.** The prompt is required to name, in `reasoning`, the ground the recent exchanges already covered, so it does not ask for it again.

Topic *selection* is still not the prompt's job — the same boundary v1 drew. The directive reaches the model as an explanation of the slot it was given, never as permission to choose a different one.

### 13.2 §5.2 addition — Eval Tool `grade_scores`

Grade bands live in the Eval Tool (`backend/app/tools/eval/grading.py`) for the same reason rubrics do (CLAUDE.md §8): a grade is an *interpretation* of a rubric score, and an interpretation that two services each own is one that will eventually disagree with itself.

```json
// Report Agent -> Eval Tool
{
  "method": "grade_scores",
  "params": { "subjects": [{ "id": "databases", "score": 4.6 }, { "id": "system design", "score": 2.9 }] }
}
// ->
{
  "graded": [
    { "id": "databases", "score": 4.6, "grade": { "letter": "A", "label": "Excellent", "score": 4.6, "descriptor": "...", "is_strength": true, "scale_version": "grade-scale/v1" } },
    { "id": "system design", "score": 2.9, "grade": { "letter": "C", "label": "Competent", "score": 2.9, "descriptor": "...", "is_strength": false, "scale_version": "grade-scale/v1" } }
  ],
  "overall_grade": { "letter": "B", "label": "Strong", "score": 3.8, "descriptor": "...", "is_strength": true, "scale_version": "grade-scale/v1" },
  "scale_version": "grade-scale/v1"
}
```

The scale is `A` Excellent (≥4.3), `B` Strong (≥3.5), `C` Competent (≥2.5), `D` Developing (≥1.5), `E` Early (≥0), versioned like a rubric — a stored grade means nothing later unless the version that produced it still identifies the same thresholds, so moving a boundary means bumping `GRADE_SCALE_VERSION`, never editing a number in place. `evaluate_answer` additionally returns the band for the score it just produced, so a live answer and the final report show the same judgement rather than two that happen to agree.

Four rules, all from `soul.md`:

- **No score, no grade.** An unscored subject grades to `null`, never the bottom band, and `overall_grade` is *omitted* when nothing scoreable was supplied. A candidate who was never assessed has not failed — the same rule `formatScore` already enforces by rendering `—` rather than `0`.
- **There is no "F".** Every band's `descriptor` says what the next band up would take, because §4 asks even a weak performance to be framed constructively. No band is named after the candidate rather than the answer.
- **A grade is derived, never asserted.** `grade_scores` scores nothing: every value handed in came from an `evaluate_answer` call that had to cite a transcript span first, so the grade inherits that provenance. The session-level band is the *unweighted* mean of the topics that were scored — weighting by question count would let a quota decision made at CALIBRATION become a scoring decision made afterwards, and the candidate chose neither.
- **`is_strength` travels on the grade.** The Report Agent partitions strengths from focus areas on that flag and holds no copy of the boundary, so a competency badged "B" can never also be filed under "worth strengthening".

`Report` gains `overall_grade` (nullable `reports.overall_grade JSONB`, migration `008_grading.sql`) and each `CompetencyScore` gains an optional `grade`. Both are nullable for the same reason as everything above: a report written before this addition was not graded, and NULL must read back as "not graded" rather than as the bottom band.

## 14. Stage 13 — dynamic question synthesis and adaptive routing

Two changes that between them remove the last two places where a live interview followed a list written before the candidate arrived: the *text* of a question came out of a static bank, and the *order* of the questions came out of a plan that could not react to what the candidate had just demonstrated.

Everything here is additive at the wire. Every Stage 1–12 request shape, response shape, DB column and test still holds; each new field below is optional, and an absent one reproduces the pre-Stage-13 behaviour exactly. The two suites that exercise the old paths (`smoke_stage3_question_loop`, `smoke_stage_human_flow`) pass unmodified, which is the check that matters.

### 14.1 §4.3 addition — selection produces a slot, generation writes the scenario

Before this stage, `select_next_question` returned a `BankQuestion` and the LLM was handed its text with instructions to "modify and sharpen" it (`question-agent/v1`–`v5`). Two consequences followed from that and neither was fixable inside the prompt:

- A bank entry is written for every candidate who will ever be asked it, so the best available outcome was a generic question with the candidate's stack name dropped into it.
- A topic and tier the bank did not cover could not be asked at all. `_pick_from` skipped any topic with no unasked entry, and a plan whose topics were all spent raised `no_questions_available`.

Selection now returns a **`QuestionSlot`** — `{ topic, tier, type, difficulty, expected_signals[], concept_ids[], bank_question? }`. The deterministic rules are untouched: the per-topic cap, the least-covered-first ordering, `next_tier_for`'s escalation curve, and the `quota_override` last resort all run exactly as they did and still decide which slot comes next. What changed is what the slot is *made of*: the bank is now consulted for the signal list and for a fallback text, not for the question.

The text is then decided in this order, and none of it is a judgement the Question Agent makes:

| Order | Path | Prompt | Result |
|---|---|---|---|
| 1 | `_synthesize_question` | `question-agent/v6` | scenario written from scratch; `question_source: "synthesized"` |
| 2 | `_generate_question` | `question-agent/v5` | bank entry sharpened — the pre-Stage-13 path, unchanged; `question_source: "bank_rewrite"` |
| 3 | — | — | the bank entry as written; no `question_source` |
| 4 | — | — | a bank-less slot nothing could write: `no_questions_available`, exactly as an exhausted bank already raised |

**Synthesis is off unless a real provider is resolved** (`QuestionAgentDeps.synthesis_enabled`, set once in `gateway.py` from `resolve_provider`). With no API key the fixture model stands in, and a fixture cannot write a scenario — it can only assemble one from the signal list, which is strictly worse than the reviewed bank question the same slot already has. "Running with no API key behaves like Stage 2, not like a worse interviewer than Stage 2" is the rule `fixture_model.py` was built around and this stage does not get to break it. An injected `llm_model` counts as a real provider, so a test that substitutes a model exercises the path it meant to.

**`question-agent/v6`** takes one JSON payload and no baseline:

```json
{
  "constraints": { "topic": "databases", "tier": 2, "type": "technical", "difficulty": 3,
                   "expected_signals": ["names a concrete schema change", "explains the trade-off"] },
  "candidate":   { "role": "backend engineer",
                   "profile_lines": ["Owned the Postgres schema design for the billing service."],
                   "topic_plan": [{ "topic": "databases", "source": "resume" }] },
  "recent_exchanges": [], "session_callbacks": [], "used_transitions": [],
  "directive": { "system_directive": "pivot", "transition_style": "topic_shift", "routing_rationale": "..." }
}
```

There is nowhere in that payload to put a baseline question, which is how the removal is enforced rather than merely requested. The signals are the specification: the prompt's instruction is to write a question the candidate *cannot answer well without demonstrating them*. Everything else v4/v5 established is carried forward in substance — the trailing window, the long-range callbacks, the spent-cue list, and all four transition styles including `supportive_reframe`. A stage that made questions more specific and simultaneously made the interview read as a cold list would not be an improvement.

**Grounding is unchanged and applies identically to both paths.** `_source_documents` is shared, so a synthesized scenario is checked against the same topic plan, profile lines, trailing window and callback facts a rewritten bank question is. `grounding_rationale` is a required grounded path — a scenario we cannot tie back to the plan or the profile is a question with no provenance at all, and it falls back rather than being asked.

**`target_concept_ids` follow the written question.** When synthesis returns `expected_signals`, the concept ids are minted from those (`concept_id(topic, tier, label)`) rather than from the slot's originals, so the Follow-up Agent's `verify_concepts` pass runs against what the question actually asked.

### 14.2 New LLM schema — `llm:question-agent/dynamic_question@v1`

```python
class DynamicQuestionResponse(BaseModel):
    reasoning: str                       # chain-of-thought, never returned past the agent
    topic: str                           # echo of the slot's topic
    tier: int                            # echo of the slot's tier
    question_text: str                   # ready to speak; at most one question mark
    expected_signals: list[str]          # 1-6; the grading rubric's signal list
    reference_answer: str                # for the Eval Tool; never shown or spoken
    grounding_rationale: GroundableClaim # { value, evidence } — required grounded path
```

`topic` and `tier` are echoed rather than assumed because they are the two constraints a from-scratch generation can silently drift off, and echoing them is what makes drift something Pydantic can *catch*. The constraints arrive as **validation context** (`model_validate(raw, context={"question_constraints": {...}})`), not as fields baked into the schema: the JSON Schema handed to the provider is one fixed document, and encoding "topic must be databases" into it would mean a different registered schema per call. `StructuredCallOptions.validation_context` and the `validation_context` / `retries` params on `tool-llm-provider.generate_structured` are the plumbing for that.

A violation therefore surfaces as an ordinary schema-validation failure, which puts `structured_call` into the retry-with-correction loop §11.5 already defines — the corrective message is the validator's own sentence ("topic must be exactly 'databases' … you returned 'machine learning'"). The synthesis call budgets **two** retries rather than the default one, because a malformed response and a constraint violation are different failures and one retry can only cover whichever happens first. A generation that never complies raises `StructuredCallError`, the agent falls back to the bank, and the candidate never sees any of it.

`grounding_rationale` is a `GroundableClaim` rather than a bare string for the reason every other claim in `schemas.py` is: a plain sentence cannot be grounding-checked, and `soul.md §"Grounding is checked, not assumed"` has no exception for the field that explains the grounding. Its `value` is the rationale a caller renders; `evidence` is what makes it checkable.

### 14.3 §4.4 addition — next-node routing

`next_action` could say `pivot` but never *where to*, so "move on" meant nothing more than "let the plan's default ordering decide". A candidate who had just demonstrated real depth in one area and visible weakness in another got the next question from the same fixed order either way.

**`interview_domain/routing.py`** holds the arithmetic — beside `topics.py` and `blueprint.py`, because three agents read the same thresholds and two copies of a threshold become two different thresholds the first time one is tuned.

- **`InterviewSession`** — `{ session_id, current_topic, current_tier, exhausted_topics[], rolling_score, last_score, answers_scored, topic_scores{}, topic_tier{} }`.
- **`record_score`** — an exponential moving average, `alpha = 0.4`. A plain mean over a session is a lagging indicator: a candidate who opens badly and then finds their feet keeps a depressed average for the rest of the interview, and the interview keeps treating them as struggling. `rolling_score` is `null` until the first scored answer — an unscored session has not scored zero.
- **`determine_next_node`** — the traffic cop:

| Last score | Tier | Topic | Directive |
|---|---|---|---|
| `> 4.0` | `+1` (max 3) | least-covered unexhausted | `escalate` if it stayed, `pivot` if it moved |
| `< 2.5`, first time on this topic | `-1` (min 1) | unchanged | `support` |
| `< 2.5`, second consecutive on this topic | `-1` (min 1) | nearest *lateral* topic | `pivot`, `lateral_pivot: true` |
| otherwise | unchanged | current, or least-covered | none — routing has no opinion |

"Lateral" is same-kind first, then shared topic vocabulary, then coverage — a stuck candidate moved from a system-design question straight to "tell me about a conflict" reads as the interview giving up on them. It is a preference order *over the session's own `topic_plan`*, never a jump outside it: a topic off the plan has no cap, no relevance evidence and no place in the report.

**The Follow-up Agent computes it** (it is the agent that sees a score the moment it exists) from a `routing_context` the Harness Agent supplies — the same arrangement `struggle_context` and `topic_counts` already use, since no agent reads the stores or another agent directly (§4.7, CLAUDE.md §5). `next_action` gains `next_topic`, `next_tier` and `routing_rationale`; the request gains `routing_context`. All are optional and an absent `routing_context` produces a `next_action` byte-identical to the pre-Stage-13 one.

Two rules govern how the proposal interacts with the directive the detectors already computed:

- **Routing always annotates.** The three fields are added whatever the directive says, because the Question Agent consults `next_topic` only where the directive leaves the choice open — an annotation cannot cancel a probe.
- **Routing changes the directive in exactly one case.** A candidate who has not recovered on a topic across two answers gets `support` turned into `pivot` with the lateral topic, because a third question on a topic they have no way into is not support. `should_follow_up` and `follow_up_text` are untouched, so they still get their reframe *now*; only where the interview goes *next* changes.

**Selection honours it exactly as far as it honours a directive** (`_route_to_topic`). The preference order is: a stay directive's own topic first (`escalate`/`drill_down`/`support` came from a detector that read the answer, which knows something a score band does not), then `next_topic`. The cap still binds, an already-asked question is still excluded, and the tier still comes from `next_tier_for` — so a routed topic that is capped simply falls through to the normal ordering, and `next_tier` can never produce a harder question than the topic's own scores support. When routing alone changed the pick, `followed_directive` is `"route"`.

The harness emits a **`routing_decision`** span carrying the from-topic, the proposed topic and tier, the directive and the rationale. It is a sibling of `directive_followed`, not a replacement: that one records what *selection* did, this one records what *routing asked for*, and both are needed to answer "why this topic?" on the turns where they legitimately disagree.

### 14.4 The in-memory session tracker

`app/http/session_tracker.py` holds `active_sessions: dict[str, InterviewSession]` — a plain dict, read on every turn between the candidate finishing an answer and the next question being spoken.

It lives in the gateway layer and not in an agent, and that is not a filing decision. CLAUDE.md §10 forbids an agent holding module-level mutable state or an in-memory per-session cache, and that rule is not bent here: everything in this dict is *derived* from persisted rows — `topic_counts` from the Memory Agent, `topic_scores` from the Evaluation store, the caps from `Session.topic_plan` — and `rebuilt_from` reconstructs any entry exactly, replaying the EMA through the same function rather than averaging it. A restart, a second worker, or a session resumed on another process therefore produces the same routing decision as the one that was lost. `snapshot()` reconciles the cached entry against the persisted counts and caps on every turn and carries forward only the EMA, which is the one genuinely running value.

If something ever needs to go in this dict that cannot be rebuilt from the stores, it has become real state and belongs in the Memory Agent (§4.7).
