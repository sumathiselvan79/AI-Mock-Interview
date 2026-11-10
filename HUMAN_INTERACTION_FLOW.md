# Making the interview feel like a human interaction

Design notes for the next round of orchestration work. Read `CLAUDE.md` §1-5,
`soul.md`, and `INSTRUCTIONS.md` §4.3/§4.4 first — everything below extends
those, it doesn't replace anything in them.

## The principle

The follow-up agent (`backend/app/agents/followup/server.py`) already proves
the pattern to reuse: a deterministic detector (the `_GAPS` regex table)
decides **whether** something needs to happen, and an LLM call only phrases
**how** it's said. The model never decides interview logic on its own.

Making the interview feel human is not "give the model more freedom to
improvise." It's adding more small, deterministic detectors like `_GAPS`, each
producing a structured directive (the same shape as the existing
`next_action`/`transition_style` machinery in `interview.py` and
`question_agent_v4`), and letting the LLM phrase an increasingly narrow slice
of language for each one. That keeps every one of soul.md's grounding/no
fabrication guarantees intact while the surface gets warmer. Every method
below follows this shape: **detector → directive → narrow phrasing**.

Build order suggestion, roughly cheapest-and-most-noticeable first:
1. Thinking gap / acknowledgment beat
2. Struggle detection
3. Meta-utterance detection (repeat/clarify)
4. Phrasing variety tracking
5. Extended memory / callbacks
6. TTS pacing
7. Session-level arc / personalized wrap-up

§8 was added after those seven shipped, from the same list of remaining
silences rather than a new idea: 8. Conversational continuers.

## Status — all seven built

Shipped as **Stage 10**. Build record and stage-gate results: `TRACKING.md`
Stage 10. The rules from it that are easy to break later: `CLAUDE.md §17`.
Each section below ends with a **Built** line naming where it landed and what
changed from the design above.

Two things held across all seven, and both are worth checking against before
adding an eighth:

- **No interview logic moved into a model.** Every decision is a deterministic
  rule; the model phrases. That is why `tests/smoke_stage_human_flow.py` runs
  end to end with no provider configured — a provider outage changes what the
  interview *sounds like* and nothing about what it *does*.
- **Two prompt bumps, no in-place edits** — `question-agent/v5` and
  `followup-agent/v2`. v1–v4 are untouched and still resolvable for stored
  `prompt_version` stamps (`CLAUDE.md §16`).

---

## 1. Fill the "thinking" gap instead of instant replies

**Problem.** `InterviewOrchestrator.submit_answer` (`backend/app/agents/harness/interview.py`)
computes a score, a follow-up decision, and speaks the result in one
continuous async chain. The moment a candidate stops talking, a fully-formed
response fires instantly. Real interviewers pause, or say something like
"mm, okay" before responding — instant, fully-formed replies are what read as
a chatbot.

**What to build.** A two-stage response instead of one:
- A deterministic, no-LLM-call micro-acknowledgment ("Mm-hm.", "Okay.", "Got
  it.") spoken immediately via the existing `speak()` bridge, before the
  score/follow-up pipeline even starts.
- The real follow-up or next question follows once it's actually computed.

**Where it lives.** Harness-level change in `submit_answer` /
`InterviewOrchestrator`. Add a transient `THINKING`/`ACK` beat between the
transcript landing and the next spoken turn. No prompt changes needed — pick
the ack line from a small fixed pool (rotate to avoid repetition, see §4).
The frontend room (already handles paced/streamed reveal per Stage 9) needs a
lightweight "interviewer is thinking" indicator for the gap between the ack
and the real response.

**Tradeoff to watch.** Don't ack a low-confidence or too-short transcript the
same way as a substantive one — that already reads as canned. Consider two
ack pools, or skip the ack entirely below `MIN_CONFIDENCE` (mirrors the
existing threshold in `followup/server.py`).

**Built.** `interview_domain/acknowledgments.py` (two pools, silence below the
confidence floor, least-recently-used rotation — the tradeoff above taken
*both* ways). `submit_answer` gained an `on_acknowledgment` hook fired before
the scoring pipeline starts; the live channel pushes it as its own
`acknowledgment` frame, REST callers read `AnswerResult.acknowledgment` at the
end. Room page: `speakAside` + the `ThinkingBeat` indicator.

One constraint the design above did not state but the pools are built around:
this fires *before* the Eval Tool has scored anything, so no phrase may read as
a verdict — "Great." and "Interesting." are absent deliberately.

---

## 2. Detect struggle, not just gaps

**Problem.** `followup/server.py`'s `_GAPS` table (no outcome, no metric,
hedged claim, no reasoning, etc.) is built entirely around *probing a
capable candidate deeper*. There's no equivalent for "this candidate is
stuck" — a near-empty answer today falls into the generic `too_short_to_probe`
branch, which offers a way in but doesn't distinguish "vague but confident"
from "genuinely struggling." A human interviewer shifts tone here — supportive
reframe, easier angle — instead of mechanically pivoting or re-probing.

**What to build.** A sibling detector to `_GAPS`, run alongside it in
`consider_follow_up`:
- Signals: repeated hedge words across turns (not just this answer — track a
  running hedge count via the Memory Agent), explicit "I don't know" /
  "I'm not sure" patterns, a second consecutive too-short answer, a visible
  drop in `topic_competency_score` (already computed in `_compose_live_session_state`).
- New `next_action.system_directive` value: `support`, alongside the existing
  `escalate` / `pivot` / `drill_down`. `question-agent/v4`'s `transition_style`
  switch already has the shape to add a fourth case — a supportive reframe
  opener instead of "Staying with that..." or "Let's move to something
  different."
- Keep this deterministic-first, same as `_GAPS`: the detector decides *that*
  support is warranted; the LLM only phrases the reframe, anchored in
  soul.md's rule that a good follow-up "gives a struggling candidate a fair
  chance to recover" — never lower the bar or fabricate encouragement about
  content that wasn't demonstrated.

**Built.** `detect_struggle` in `followup/server.py`, with all four signals.
`support` + `supportive_reframe` threaded through `shared_types`,
`transitions.py`, the MCP schemas and `_STAY_DIRECTIVES`. The cross-turn half
(`struggle_context`) is assembled by the harness and passed in — the Follow-up
Agent still never queries the Memory Agent or the stores itself (§4.7), the
same routing rule `topic_counts` follows. `followup-agent/v2` carries a second
`support` job beside v1's `probe` job. `struggle_detected` telemetry names the
signal.

Three decisions the design above left open:

- **A struggle outranks a detected gap.** When both fire, the directive is
  `support`. Probing a stuck candidate harder is what soul.md §3 rules out.
- **A struggling candidate always gets a follow-up**, including when the gap
  detector found nothing to probe — "no gap" on an "I don't know" means there
  was no claim in the answer, not that the answer was complete. The model may
  reword the reframe but may not withdraw it.
- **`support` stays on the topic**, and that is safe for the same reason
  `escalate` is: the cap still binds and `next_tier_for` steps the tier *down*
  at exactly the score floor this detector fires at. Gentler framing and an
  easier tier — never an extra turn, never an easier bar.

---

## 3. Detect meta-utterances — don't score everything

**Problem.** "Can you repeat that?" or "Sorry, what do you mean by that?" has
nowhere to go today except straight into `submit_answer` and get scored as a
real (terrible) answer. A human interviewer recognizes a clarification
request and just answers it.

**What to build.** A cheap classification pass *before* a transcript commits
to `answers.append()` — mirrors the deterministic-first pattern already used
for gap detection: a short keyword/regex pass ("repeat", "say that again",
"what do you mean", "can you clarify", "sorry?") checked first, falling back
to the real scoring path when nothing matches. On a match, the harness
branches to a small "repeat/clarify" response (re-speak the question text
verbatim, or a one-line clarification) instead of writing an `Answer` at all.

**Where it lives.** New pre-step in `submit_answer`, likely as its own
function beside `_reference_answer` in `interview.py`. This is a genuine new
branch in the QUESTION_LOOP flow, not just a prompt tweak — needs a matching
frontend affordance (so a repeat request doesn't count as a "turn" against
time tracking).

**Careful with false positives.** A real answer that happens to start with
"sorry, um" shouldn't get swallowed. Keep the match narrow (whole-utterance
patterns, very short transcripts only) and log every match to telemetry so
false positives are visible instead of silently eating a real answer.

**Built.** `agents/harness/meta_utterance.py` — anchored whole-utterance
patterns, a 12-word cap, leading filler stripped before matching, and
`meta_utterance_detected` on every match. Five adversarial cases are pinned in
`smoke_stage_human_flow.py`, including the "sorry, um" opener above. It runs
before an `Answer` is written and before `stop_segment`, so the per-question
clock keeps running — asking to hear a question again is not a turn, exactly as
the design asked.

Its own return type (`MetaUtteranceResult`) rather than an `AnswerResult` with
empty fields, so no caller can advance an interview that has not moved: the
socket sends `clarification`, both REST answer routes send `answered: false`,
and neither issues an `answer_id`. The frontend affordance is a distinct
"Asked again" turn in the thread.

One thing the design left open: a `clarify` request restates the question
**verbatim** rather than explaining it. There is no rubric on this path, so any
explanation would be an invented reading of the question — and the candidate
would then be scored against the real one.

---

## 4. Avoid repeating the same conversational patterns

**Problem.** `question_agent_v4`'s liveliness cues ("Staying with that...",
"Let's move to something different.", "Building on what you just
described...") are the actual variety this system's been given — but nothing
tracks which ones were already used this session. A long interview can reuse
the same two or three transitions over and over, which itself starts to read
as scripted.

**What to build.** A `used_transitions` set threaded the same way
`asked_question_ids` already is — persisted per session (Memory Agent is the
natural home, same as `topic_counts`), passed into `get_next_question`, and
listed in the prompt with an instruction not to reuse a phrase already used
this session. Cheap, no new detector needed — this is pure plumbing on top of
what v4 already writes.

**Built.** `CUE_CATALOGUE` + `cues_used_in` in `interview_domain/transitions.py`;
Memory Agent `remember_used_phrase` / `get_used_phrases`, kind-namespaced so the
acknowledgment pool and the transition pool cannot exhaust each other;
`used_transitions` passed into `get_next_question` and forbidden in
`question-agent/v5`.

The one thing that turned out not to be pure plumbing: v4 writes free text, so
which cue it *chose* has to be observed from the generated question rather than
assumed from the directive. A `same_topic` directive does not guarantee a cue
was used at all, and recording one that was not would forbid a phrase the
interview has never said. Hence a closed catalogue and a detector — matching
loosely would be worse than not tracking.

---

## 5. Extend memory beyond the 3-turn window for real callbacks

**Problem.** `_CONTINUITY_WINDOW = 3` in `interview.py` is deliberately short
for token economy (§8 data-minimisation), so the interview can't say "earlier
you mentioned the Kafka migration — does that connect to this?" once that's
rolled off the trailing window. A human interviewer remembers standout
moments from 20 minutes ago, not just the last exchange.

**What to build.** Distinct from the trailing window — a small, durable set
of high-signal "callback facts," picked once per notable answer (e.g. any
answer that scored ≥4, or any answer whose evidence span names a specific
metric/project), capped at maybe 3-5 for the whole session. The Memory Agent
(`backend/app/agents/memory/server.py`) already owns session-scoped state
(`topic_counts`, reference answers) — extend it with a
`remember_callback_fact` / `get_callback_facts` pair. Feed these into
`_profile_lines()` or a new `session_callbacks` prompt block in v4 (a fifth
prompt section, same treatment as `RECENT EXCHANGES`), separately from the
resume-derived lines — these are things the *candidate said*, not resume
content, so they need their own grounding-evidence citation the same way
`recent_exchanges` does today (§11.3).

**Careful.** This is the one method most likely to blow the token/data-
minimisation budget if done carelessly — keep the cap small and the entries
short (one sentence each), same discipline as `_truncate_words` already
applies to the trailing window.

**Built.** `agents/harness/callbacks.py` picks the fact (scored ≥4, or naming a
concrete measure — preferring the sentence that carries the measure over the
first one); Memory Agent `remember_callback_fact` / `get_callback_facts` holds
at most 5 at 30 words each, and drops them with the rest of session memory at
`forget_session`. `session_callbacks` rides alongside `recent_exchanges` in
`_continuity`, de-duplicated against the window, and `question-agent/v5`
renders it as its own `EARLIER IN THIS SESSION` block — kept separate from the
resume-derived profile lines, because what a candidate *said* and what their
resume *claims* are not equally strong evidence and a reader of the prompt
should be able to tell which is which.

The grounding requirement the design flagged is what makes the "verbatim, never
paraphrased" rule load-bearing rather than stylistic: the facts are added to
`source_documents`, so a summarised fact would be both an ungrounded claim and
a generation the check silently discards on every turn that cites one.

---

## 6. Pace the actual audio, not just the text

**Problem.** Stage 9 already syncs word-by-word question reveal to TTS
boundaries — the text side is solved. What's missing is pacing *within* the
audio: a conversational cue like "Staying with that..." currently gets
spoken at the same clip as the rest of the question, so it doesn't read as a
pause-then-continue the way a human would deliver it.

**What to build.** A short deliberate pause (silence, not filler audio)
inserted between a conversational-cue prefix and the actual question — either
via SSML-style breaks if the TTS engine (`sherpa-onnx`, wrapped in
`backend/app/tools/speech_service/`) supports them, or by synthesizing the
cue and the question as two clips with a fixed gap between them and
stitching client-side. This is a Speech Service Tool change, not a prompt or
orchestration change — `question_agent_v4` already marks these cues clearly
enough (they're the leading clause before the actual question) to split on.

**Built.** The second option, because sherpa-onnx takes plain text and has no
SSML support at all. `split_leading_cue` in `transitions.py` (the *same* closed
catalogue §4 tracks, so a cue that is tracked is exactly a cue that gets the
pause) + `tools/speech_service/pacing.py`, which synthesises the two halves and
joins them with 350ms of real silence.

Stitched **server-side**, not client-side as the design suggested: that keeps
`audio_url` a single ref, so the frontend's playback path, the Stage 9 reveal
timing that hangs off it, the §8 audio-retention rules and the `/audio/{ref}`
route all stay exactly as they are — a paced line is just a longer clip. A
second ref would have needed all four to learn about pairs.

The split is narrow on purpose and returns nothing unless the leading segment
contains a catalogue cue, is short, and is not itself a question. Every failure
path — no cue, a rate mismatch, a provider error on either half — falls back to
the single unpaced clip. A pause in the middle of a question is worse than no
pause.

---

## 7. Give the interview a session-level arc

**Problem.** Each question is chosen from topic/tier/quota/score state, but
nothing carries forward "impression so far" into a form the model can
reference. The `wrap_up()` message in `harness.py` is a fixed script today —
the same closing line regardless of how the session actually went.

**What to build.** A short, deterministically-built rolling summary (NOT an
LLM re-summarization each turn — compute it from the same competency/topic
coverage data the Report Agent already aggregates) fed into the wrap-up
message and, optionally, into a "let's push into X now" framing line
mid-interview once a topic's coverage crosses a threshold. Keep this
additive to the Report Agent's real evidence-based scoring (soul.md "No
fabrication") — this is a *tone* layer over data that's already computed and
persisted, never a second, competing judgment.

**Built.** `agents/harness/session_arc.py`; `wrap_up()` now names the topics
covered and the number of answers given, both derived from persisted rows, with
the introduction opener excluded and the pre-arc script kept as the fallback for
a session with nothing answered.

Deliberately narrower than the design allowed, in two ways:

- **No strongest/weakest topic, and no figure of any kind.** "Impression so far"
  was the tempting reading, and it is the one that turns a tone layer into the
  second, competing judgment this section warns against. Coverage is enough to
  make the ending about *this* session; the Report Agent aggregates the
  evidenced scores minutes later and holds all the evidence.
- **No mid-interview "let's push into X now" line.** The design marked it
  optional, and `topic_shift` already owns the language for moving to a new
  topic — a second framing layer would compete with the transition cue for the
  same sentence.

---

## 8. Say something in the places the interview still says nothing

*Added after the first seven. Shipped as **Stage 12** — build record and
stage-gate results: `TRACKING.md` Stage 12; the rules from it worth keeping:
`CLAUDE.md §19`.*

**Problem.** §1 fixed the instant a candidate stops talking. It did not fix
what happens next, and it made that gap more conspicuous rather than less:
the acknowledgment costs no round trip, and everything after it costs two —
the Follow-up Agent scores the answer, then the Question Agent writes the next
question. On a slow provider the candidate hears "Okay." and then nothing at
all for tens of seconds. Being acknowledged and then abandoned reads worse
than the silence §1 removed.

Two smaller silences sit either side of it:

- **A follow-up answer gets no receipt.** §1's ack fires in `submit_answer`
  only. A probing session is half follow-ups, so in the sessions where the
  interview is working hardest, most of what the candidate says lands in
  nothing.
- **The interview opens cold.** The session's first spoken words are "Tell me
  about yourself." There is no hello.

**What to build.** A fourth phrase family beside §1's acknowledgments, §2's
supportive reframes and §4's transition cues — *continuers*: lines whose only
job is to say the interviewer is still there. Four kinds, one detector each:

- `opening` — the session's hello, spoken once before the introduction opener.
- `holding` — the wait while an answer is being scored, if it runs long.
- `selection` — the wait while the next question is being written, same.
- `follow_up_receipt` — §1's beat applied to the other half of a probing turn.

The detector for the middle two is a clock, and that is the whole of the
decision: a wait that exceeds `HOLDING_LINE_AFTER_MS` gets one line, a wait
that does not gets nothing. There is no model call in this method at all —
not even the narrow phrasing slice the other seven allow, because a continuer
makes no claim there would be anything to phrase.

**Where it lives.** `interview_domain/continuers.py` for the vocabulary,
`InterviewOrchestrator._continuer_window` for the clock, and a new `continuer`
frame on the live channel.

**Careful with talking over yourself.** This is the one method that speaks
*while the reply it is covering for is still being computed*, and everything
that can go wrong with it is an ordering problem — a line that arrives after
the reply, a line that delays the reply, a client that treats it as the reply.

**Built.** All four kinds. `_continuer_window` is an async context manager
around the silence: it speaks at most one line once the threshold passes, and
cancels the continuer when the window closes, so a slow synthesis can never add
latency to the very turn it was meant to make feel faster.

It is a *window* and not a wrapper around one call because running the app
proved the difference. The first version wrapped only `consider_follow_up`, and
on the introduction turn the topic-plan fusion — a provider round trip of its
own — runs before it: the candidate heard "Mm-hm." and then **34 seconds of
nothing** before the holding line. What the clock has to measure is the gap the
candidate is sitting in, not one hop inside it. Widened, the same turn speaks at
8.9s. `submit_follow_up_answer` gained
the receipt beat; `HarnessAgent.opening_line` speaks the greeting after
`begin_interview` has genuinely reached `QUESTION_LOOP`. The room renders an
`opening` as a labelled "Welcome" turn in the thread and the other three in
the existing `ThinkingBeat` indicator.

`continuer_spoken` carries the kind, the real total wait, and whether the line
reached the candidate or lost the race to the reply. It is emitted at the end
of the wait rather than at the threshold, because `waited_ms` would otherwise
always report the threshold and say nothing. That span earns its place twice: it answers "why did it say 'one
moment' there?", and because this method's detector *is* a clock, a run of
them is the plainest signal available that a provider round trip has gone
long — measured where the candidate experiences it rather than inside the MCP
client.

Five decisions the design above left open:

- **A continuer is push-only.** A REST caller that receives "one moment"
  alongside the thing it was waiting for has not been reassured, it has been
  handed a log line. So `on_continuer` being absent short-circuits to a plain
  await, and the REST answer route is byte-for-byte what it was — unlike §1's
  acknowledgment, which is genuinely worth showing after the fact and rides on
  `AnswerResult`.
- **One line per wait, then silence.** A second "bear with me" is not
  reassurance, it is an interview visibly stuck. One line and then quiet is the
  honest signal, and the candidate still has the timer and the thinking
  indicator.
- **`holding` and `selection` are separate pools.** The two waits are about
  different things — one is the interviewer thinking about what was just said,
  the other is choosing where to go next — and one pool would say "let me sit
  with that" while picking an unrelated topic.
- **A selection line names no topic.** It runs *before* the Question Agent has
  returned one. Naming one would be announcing a question the interview then
  does not ask; the stage gate checks every line against the real topic
  vocabulary rather than a hand-written word list.
- **The opening line is one fixed string, not a pool.** It is said once per
  session, so a rotating pool would be vocabulary that never reaches index 1 —
  dead words that read as variety. What it may *say* is the constrained part:
  "take your time" and "no rush" are both false, because there is a budget and
  a clock on screen.

---

## Cross-cutting notes

- **Every new directive/detector should telemetry-emit when it fires**, same
  as `directive_followed` and the new `resume_llm_parse_fallback` span — that's
  what makes "why did the interview react that way" answerable after the
  fact instead of a mystery.
- **Every new LLM-phrased slice needs a fixed rubric-neutral boundary**, same
  as the existing rule that a question-generation cue "must never assert the
  previous answer was right or wrong" — struggle support and repeat/clarify
  responses especially must not imply a verdict the system hasn't scored yet.
- **Nothing here should bypass the harness's "no peer-to-peer agent calls"
  rule** (CLAUDE.md §5, §8) — every new detector still lives inside the agent
  that already owns the relevant state (follow-up agent for struggle/gaps,
  memory agent for callbacks/phrasing history), and every new directive
  still routes through the harness the same way `next_action` does today.

**All three held.** Two new telemetry spans (`meta_utterance_detected`,
`struggle_detected`) alongside the existing `directive_followed`; the
rubric-neutral boundary is written into `followup-agent/v2` and
`question-agent/v5` as explicit rules rather than left to the phrasing; and no
new agent-to-agent edge was added — the harness assembles `struggle_context`,
`used_transitions` and `session_callbacks` from the Memory Agent and its own
stores and passes them onward, exactly as it already does for `topic_counts`.

Two notes for whoever adds the ninth method (both were written for the eighth,
and §8 held to them — it emits `continuer_spoken` when its detector fires, and
it reuses `least_recently_used` from §1 rather than copying it):

- **The `meta_utterance_detected` span is not optional instrumentation.** It is
  the only trace a false positive leaves — a swallowed answer has no `Answer`
  row to notice is missing.
- **`SHORT_ANSWER_WORDS`, `HEDGE_RE` and `METRIC_RE` now live in
  `interview_domain/signals.py`**, not in the Follow-up Agent that first defined
  them. They are one judgement read on two time horizons: within one answer by
  the agent, across turns by the harness. If a ninth method needs a third
  reading of the same signal, extend that file rather than copying the pattern —
  two copies of a regex become two different regexes the first time one is
  tuned.
