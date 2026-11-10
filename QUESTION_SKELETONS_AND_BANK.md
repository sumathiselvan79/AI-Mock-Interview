# Mock-Interview AI: Question Skeletons & Question Bank Specification

> **Comprehensive Technical Specification & Question Bank Catalog**
> This document details the question generation pipeline architecture, the question skeletons (baseline slots, tier progression, dynamic framing rules, and extraction matrices), prompt schemas (Chain-of-Thought reasoning and multi-shot examples), and all 175 questions processed for dynamic question generation across 5 engineering domains and 58 topic areas.

---

## Table of Contents
1. [System Architecture & Question Generation Lifecycle](#1-system-architecture--question-generation-lifecycle)
   - [Separation of Concerns: Deterministic Calibration vs. LLM Sharpening](#separation-of-concerns)
   - [Difficulty Calibration & Progressive Tier Matrix](#difficulty-calibration--progressive-tier-matrix)
   - [Dynamic Framing & Grounding Contracts](#dynamic-framing--grounding-contracts)
   - [Conversational Continuity & Follow-Up Directives](#conversational-continuity--follow-up-directives)
2. [Question Generation Prompt Skeletons & Schemas](#2-question-generation-prompt-skeletons--schemas)
   - [Slot & Context Input Specification](#slot--context-input-specification)
   - [Chain-of-Thought Reasoning Protocol](#chain-of-thought-reasoning-protocol)
   - [Generation Output Schema (`QuestionGeneration`)](#generation-output-schema)
   - [Multi-Shot Worked Examples](#multi-shot-worked-examples)
3. [Complete Question Bank & Extraction Matrices](#3-complete-question-bank--extraction-matrices)
   - [Domain: Fixed Introduction Opener (1 Question)](#domain-fixed-introduction-opener)
   - [Domain: Software Engineering (18 Topics, 54 Questions)](#domain-software-engineering)
   - [Domain: Hardware Engineering (10 Topics, 30 Questions)](#domain-hardware-engineering)
   - [Domain: Electrical Engineering (12 Topics, 36 Questions)](#domain-electrical-engineering)
   - [Domain: Mechanical Engineering (13 Topics, 39 Questions)](#domain-mechanical-engineering)
   - [Domain: Behavioral & Leadership (5 Topics, 15 Questions)](#domain-behavioral--leadership)
4. [Role Profiles & Curriculum Topic Blueprints](#4-role-profiles--curriculum-topic-blueprints)

---

## 1. System Architecture & Question Generation Lifecycle

### Separation of Concerns
In the Mock-Interview AI platform, question generation is architected around a strict separation between deterministic calibration and generative language models:

1. **Deterministic Agent / Harness (Stage 2 / Stage 6):**
   - Owns calibration: synthesizes the candidate's topic plan from Resume relevance scores, Job Description gaps, and Role defaults.
   - Enforces per-topic question quotas and progression rules.
   - Selects an exact **Question Skeleton** from the curated static question bank matching the candidate's current tier and performance.
2. **LLM Question Agent (Stage 5 / Prompts `question-agent/v1` through `v5`):**
   - Receives the chosen Question Skeleton (baseline text, difficulty, tier, topic, type, expected signals) along with candidate profile lines, JD gap notes, trailing dialogue exchanges, and follow-up directives.
   - **Sharpens and anchors** the question to the candidate's concrete background without modifying the topic, type, difficulty, or tier.
   - Generates an authoritative **reference answer** (scoring rubric comparison aid) and a **verbatim grounding claim**.

```mermaid
flowchart TD
    A[Candidate Resume & JD] --> B[Resume Service Agent / Parser]
    B --> C[Topic Relevance & Evidence Extraction]
    C --> D[Question Agent: Topic Plan Synthesis]
    D --> E[Topic Quotas & Role Profile Matrix]
    E --> F[Deterministic Slot & Skeleton Selector]
    G[Candidate Recent Answers & Follow-up Directives] --> F
    F --> H[Selected Question Skeleton (Baseline Slot)]
    H --> I[LLM Question Agent Prompts v1-v5]
    I --> J[Chain-of-Thought Reasoning Protocol]
    J --> K[Sharpened Tailored Question]
    J --> L[Reference Answer for Eval Tool]
    J --> M[Verbatim Grounding Claim]
```

### Difficulty Calibration & Progressive Tier Matrix
The platform defines 3 progressive evaluation tiers spanning difficulty ratings 1 through 5:

| Tier | Difficulty | Scope & Cognitive Focus | Escalation Trigger Condition |
| :--- | :---: | :--- | :--- |
| **Tier 1: Baseline** | 1 – 2 | Core fundamentals, system components, direct past experience, basic mechanics. | Average score across topic questions at this tier >= 4.0 / 5.0 |
| **Tier 2: Intermediate** | 3 | Real-world tradeoffs, diagnosis/troubleshooting, edge cases, design decisions, failure handling. | Average score across topic questions at this tier >= 4.0 / 5.0 |
| **Tier 3: Advanced** | 4 – 5 | High scale, zero downtime, complex failure modes, edge constraints, architecture bottlenecks. | Ceiling tier (maximum depth) |

### Dynamic Framing & Grounding Contracts
Every topic blueprint establishes deterministic rules for anchoring questions to candidate evidence:
- **Resume Context Integration Rule:** *"Prefer the candidate profile topic_relevance evidence line for the topic with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms. If nothing matches, frame the question generically against the role rather than inventing an anchor."*
- **JD Anchor Requirement:** *"Use the session's jd_fit.topic_relevance entry for the topic, if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, fall back to the role's own default framing rather than fabricating a requirement the job description never stated."*
- **Grounding Verification:** Every generated question must supply a `grounding.evidence` field containing a **verbatim quote** from the candidate profile, topic plan, or session history. Hallucination or fabrication of background is forbidden.

### Conversational Continuity & Follow-Up Directives
When moving between questions during an active interview session, the Harness passes directives from the Follow-up Agent:
- `same_topic` (Escalate / Drill Down): Continues the current topic to a higher tier or deeper aspect. Refers back to candidate statements neutrally without praise or premature verdict.
- `topic_shift` (Pivot): Closes the current thread briefly and transitions cleanly to a fresh topic from the plan.
- `supportive_reframe` (Support): When a candidate is stuck, provides a smaller, more accessible entry point while maintaining the slot difficulty and tier bar.

---

## 2. Question Generation Prompt Skeletons & Schemas

### Slot & Context Input Specification
The prompt template renders structured context blocks into the LLM context:

```text
TARGET ROLE: <Role Title>

TOPIC PLAN:
- <topic> (max <N>, from <source: jd_gap | resume | role_default>)

CANDIDATE PROFILE:
<Extracted verbatim candidate profile lines or "(no resume was uploaded for this session)">

RECENT EXCHANGES (oldest first):
- [<topic>] asked: <question text>
  answered: <candidate answer excerpt>

DIRECTIVE FROM THE LAST ANSWER:
- system_directive: <escalate | drill_down | pivot | support>
- transition_style: <same_topic | topic_shift | supportive_reframe | none>
- framing strategy: <framing guideline string>

EARLIER IN THIS SESSION (the candidate's own words, from further back than recent exchanges):
- [<topic>] <high-signal callback fact quoted from candidate>

CUES ALREADY USED THIS SESSION (do not reuse any of these):
- <spent conversational transition cues>

SLOT TO FILL:
- topic: <topic_name>
- type: <technical | behavioral>
- difficulty: <1-5>
- tier: <1=baseline, 2=intermediate, 3=advanced>
- baseline question: <baseline_question_text>
- expected signals: [<expected signal 1>, <expected signal 2>, ...]
```

### Chain-of-Thought Reasoning Protocol
The model executes a 6-step reasoning sequence prior to outputting the final question object:
1. **Profile Evidence Inspection:** Quote verbatim lines from the candidate profile matching this topic. If absent, explicitly state no resume evidence exists.
2. **Session Ground Inspection:** Inspect recent exchanges and session callbacks. Detail what ground has already been covered to avoid asking for it again.
3. **Baseline Slot Fit Assessment:** Assess whether the baseline question skeleton already satisfies the slot, or if candidate-specific anchoring is needed.
4. **Sharpening Strategy:** Sharpen the question phrasing to reference the candidate's history without altering topic, type, difficulty, or tier. If no sharpening is needed, retain the baseline as-is.
5. **Transition & Conversational Cue:** Select a transition style (`same_topic`, `topic_shift`, `supportive_reframe`), ensuring no previously used cues are repeated.
6. **Single Question Constraint Verification:** Ensure the final output remains exactly one concise question without multi-part clauses or preambles.

### Generation Output Schema
The generated JSON structure is defined by the `QuestionGeneration` schema:

```json
{
  "reasoning": "Chain-of-thought scratchpad text (min 20 characters)...",
  "question": {
    "text": "Sharpened question text (or unchanged baseline)...",
    "topic": "databases",
    "type": "technical",
    "difficulty": 2,
    "tier": 1,
    "expected_signals": ["see reference_answer"]
  },
  "reference_answer": "Comprehensive scoring guide detailing what a strong candidate response must cover...",
  "grounding": {
    "value": "databases is on this session's topic plan, so a question about it is in scope.",
    "evidence": "Verbatim quote from candidate profile, topic plan, or recent exchanges"
  }
}
```

### Multi-Shot Worked Examples

#### Example 1: Anchoring into Candidate Resume Profile (Databases — Tier 1)
- **Target Role:** Senior Backend Engineer
- **Candidate Profile:** `"Owned the Postgres schema behind route planning; added partial indexes that took a nightly report from 4 minutes to 8 seconds."`
- **Slot Skeleton:** Topic: `databases`, Type: `technical`, Difficulty: `2`, Tier: `1`, Baseline: `"Tell me about a time you improved database performance."`
- **Reasoning Trace:** `"The profile has a concrete database-performance story: partial indexes, a nightly report going from 4 minutes to 8 seconds. That is squarely on-topic for a tier-1/difficulty-2 databases slot. The baseline question is generic enough that it could be asked of any candidate — it doesn't invite them to use what's already in their own history, and a tier-1 question should be easy to anchor concretely. Sharpening it to reference the resume's own language (without inventing detail beyond what's stated) keeps it at the same difficulty while making it easier for the candidate to give a specific answer instead of a generic one."`
- **Sharpened Question Output:** `"You mentioned adding partial indexes that cut a nightly report from 4 minutes to 8 seconds — walk me through how you found which query needed the index."`
- **Reference Answer:** `"A strong answer names the diagnostic step (EXPLAIN ANALYZE, slow query log, or similar), identifies which column(s) the index targeted and why a partial index specifically (vs. a full index) was the right shape, and states the measured before/after. A candidate who reaches the same result via a different diagnostic tool answers this just as well — this is a comparison aid, not the one correct answer."`
- **Grounding Evidence:** `"added partial indexes that took a nightly report from 4 minutes to 8 seconds"`

#### Example 2: No Profile Context Available (APIs and Services — Tier 2)
- **Target Role:** Backend Engineer
- **Candidate Profile:** `(no resume was uploaded for this session)`
- **Slot Skeleton:** Topic: `apis and services`, Type: `technical`, Difficulty: `3`, Tier: `2`, Baseline: `"How do you version a public API without breaking existing clients?"`
- **Reasoning Trace:** `"No resume was uploaded, so there is no candidate-specific detail to anchor to — the grounding evidence has to come from the topic plan itself, not an invented profile fact. The baseline question is already a clean, single-part, tier-2/difficulty-3 question that doesn't assume anything about this candidate's background. Rewriting it for the sake of rewriting it risks introducing an assumption the profile can't support, which the rules explicitly forbid. The right move here is to keep it as-is."`
- **Question Output:** `"How do you version a public API without breaking existing clients?"` *(Kept as-is)*
- **Reference Answer:** `"A strong answer names a concrete versioning strategy (URL path, header, or content-negotiation versioning), explains how it avoids breaking existing clients specifically, and raises at least one tradeoff (e.g. maintenance burden of running multiple versions, or the discipline required for additive-only changes)."`
- **Grounding Evidence:** `"apis and services (max 3, from role_default)"`

#### Example 3: Escalation and Conversational Continuity (Databases — Tier 2)
- **Target Role:** Senior Backend Engineer
- **Recent Exchange:** Candidate answered how they pulled slow query logs, found sequential scan on trips table, and added partial index on status column.
- **Directive:** `system_directive: escalate`, `transition_style: same_topic`
- **Slot Skeleton:** Topic: `databases`, Type: `technical`, Difficulty: `3`, Tier: `2`, Baseline: `"How do you decide when an index will hurt more than it helps?"`
- **Reasoning Trace:** `"The directive is escalate/same_topic, and the last answer covered the tier-1 ground properly: the diagnostic step (slow query log), the specific problem (sequential scan), and why a partial index specifically (five percent selectivity). So this question continues databases rather than pivoting, and it should not re-ask any of that. The baseline is a good tier-2 question. The natural opening refers back to the selectivity point the candidate actually made, because that is the hinge between the two questions. Neutral referring-back cue does the transition without claiming anything."`
- **Sharpened Question Output:** `"You picked that partial index because only a small share of rows matched — staying with that, how do you decide when an index will cost you more than it saves?"`
- **Reference Answer:** `"A strong answer names at least one concrete cost of an index — write amplification on insert/update, storage, planner churn, or maintenance during bulk loads — and ties the decision to a property of the workload (write-heavy vs read-heavy, selectivity, how often the query actually runs)."`
- **Grounding Evidence:** `"added partial indexes that took a nightly report from 4 minutes to 8 seconds"`

---

## 3. Complete Question Bank & Extraction Matrices

This section catalogs all **175 questions** in the Mock-Interview AI system across 5 engineering domains, complete with baseline texts, difficulty ratings, progressive tiers, expected evaluation signals, stable concept IDs, and dynamic framing rules.

### Domain: Fixed Introduction Opener (1 Question)

The introduction question is the fixed opener asked first in every interview session outside the question budget.

| Field | Specification |
| :--- | :--- |
| **Bank ID** | `introduction.opener` |
| **Topic** | `introduction` |
| **Type** | `behavioral` |
| **Difficulty / Tier** | Difficulty: `1` / Tier: `1` (Session Opener) |
| **Question Text** | *"Tell me about yourself — walk me through your background and what's brought you here today."* |
| **Expected Signals** | `communication clarity`, `career trajectory coherence`, `role motivation`, `conciseness` |
| **Concept IDs** | `introduction.t1.communication-clarity`<br/>`introduction.t1.career-trajectory-coherence`<br/>`introduction.t1.role-motivation`<br/>`introduction.t1.conciseness` |
| **Processing Rule** | Fixed deterministic opener. Answer transcript is processed via prompt `self-intro/v1` to extract candidate topic relevance and evidence. |

### Domain: Software Engineering (18 Topics, 54 Questions)

#### Topic: `Distributed Systems` (Technical)

- **Topic ID:** `distributed systems`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `distributed`, `microservice`, `microservices`, `sharding`, `sharded`, `replication`, `consensus`, `raft`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "distributed systems" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. distributed, microservice, microservices, sharding, sharded). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "distributed systems", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `ds-1` | `2` | `technical` | Walk me through a system you've worked on where components ran on more than one machine. What talked to what, and why was it split that way? | **Signals:**<br/>• component boundaries<br/>• reason for the split<br/>• communication mechanism<br/><br/>**Concept IDs:**<br/>`distributed-systems.t1.component-boundaries`<br/>`distributed-systems.t1.reason-for-the-split`<br/>`distributed-systems.t1.communication-mechanism` |
| **Tier 2 (Intermediate)** | `ds-2` | `3` | `technical` | You have a service that publishes events to a queue and a consumer that occasionally processes the same event twice. How would you find out why, and what would you change? | **Signals:**<br/>• at-least-once delivery<br/>• idempotency<br/>• diagnosis before fix<br/><br/>**Concept IDs:**<br/>`distributed-systems.t2.at-least-once-delivery`<br/>`distributed-systems.t2.idempotency`<br/>`distributed-systems.t2.diagnosis-before-fix` |
| **Tier 3 (Advanced)** | `ds-3` | `4` | `technical` | Two services need to stay in agreement about a piece of state, but the network between them is unreliable. Talk me through the tradeoffs you'd weigh. | **Signals:**<br/>• consistency vs availability<br/>• partition behaviour<br/>• concrete tradeoff, not just CAP recital<br/><br/>**Concept IDs:**<br/>`distributed-systems.t3.consistency-vs-availability`<br/>`distributed-systems.t3.partition-behaviour`<br/>`distributed-systems.t3.concrete-tradeoff-not-just-cap-recital` |

#### Topic: `System Design` (Technical)

- **Topic ID:** `system design`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `system design`, `architecture`, `architected`, `scalability`, `scalable`, `load balancer`, `caching`, `cache`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "system design" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. system design, architecture, architected, scalability, scalable). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "system design", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `sd-1` | `2` | `technical` | Design a URL shortener. Start wherever you'd naturally start, and tell me what you'd want to know before writing any code. | **Signals:**<br/>• clarifying questions<br/>• data model<br/>• read/write ratio<br/><br/>**Concept IDs:**<br/>`system-design.t1.clarifying-questions`<br/>`system-design.t1.data-model`<br/>`system-design.t1.read-write-ratio` |
| **Tier 2 (Intermediate)** | `sd-2` | `3` | `technical` | A read-heavy endpoint is slow under load. Take me through how you'd decide between caching, an index, and a schema change. | **Signals:**<br/>• measurement first<br/>• tradeoffs of each option<br/>• invalidation cost<br/><br/>**Concept IDs:**<br/>`system-design.t2.measurement-first`<br/>`system-design.t2.tradeoffs-of-each-option`<br/>`system-design.t2.invalidation-cost` |
| **Tier 3 (Advanced)** | `sd-3` | `4` | `technical` | Design the write path for a system that has to accept 50,000 events a second and lose none of them. Where does it break first? | **Signals:**<br/>• buffering/backpressure<br/>• durability guarantees<br/>• identifies own bottleneck<br/><br/>**Concept IDs:**<br/>`system-design.t3.buffering-backpressure`<br/>`system-design.t3.durability-guarantees`<br/>`system-design.t3.identifies-own-bottleneck` |

#### Topic: `Databases` (Technical)

- **Topic ID:** `databases`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `postgres`, `postgresql`, `mysql`, `sql`, `nosql`, `mongodb`, `dynamodb`, `redis`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "databases" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. postgres, postgresql, mysql, sql, nosql). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "databases", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `db-1` | `2` | `technical` | Tell me about a schema you designed. What did you get right, and what would you change now? | **Signals:**<br/>• concrete schema<br/>• normalisation choice<br/>• hindsight with a reason<br/><br/>**Concept IDs:**<br/>`databases.t1.concrete-schema`<br/>`databases.t1.normalisation-choice`<br/>`databases.t1.hindsight-with-a-reason` |
| **Tier 2 (Intermediate)** | `db-2` | `3` | `technical` | A query that used to take 20ms now takes 4 seconds and nothing about the query changed. How do you work out what happened? | **Signals:**<br/>• query plan<br/>• data growth/statistics<br/>• index selectivity<br/><br/>**Concept IDs:**<br/>`databases.t2.query-plan`<br/>`databases.t2.data-growth-statistics`<br/>`databases.t2.index-selectivity` |
| **Tier 3 (Advanced)** | `db-3` | `4` | `technical` | You need to add a NOT NULL column to a table with 500 million rows, with no downtime. How do you do it? | **Signals:**<br/>• backfill in batches<br/>• lock behaviour<br/>• rollout ordering with the app<br/><br/>**Concept IDs:**<br/>`databases.t3.backfill-in-batches`<br/>`databases.t3.lock-behaviour`<br/>`databases.t3.rollout-ordering-with-the-app` |

#### Topic: `Apis And Services` (Technical)

- **Topic ID:** `apis and services`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `rest`, `restful`, `graphql`, `grpc`, `api`, `apis`, `endpoint`, `openapi`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "apis and services" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. rest, restful, graphql, grpc, api). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "apis and services", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `api-1` | `2` | `technical` | Take an API you've built and walk me through one endpoint: its inputs, outputs, and what happens when it fails. | **Signals:**<br/>• contract clarity<br/>• error semantics<br/>• status codes or equivalent<br/><br/>**Concept IDs:**<br/>`apis-and-services.t1.contract-clarity`<br/>`apis-and-services.t1.error-semantics`<br/>`apis-and-services.t1.status-codes-or-equivalent` |
| **Tier 2 (Intermediate)** | `api-2` | `3` | `technical` | You need to change the shape of a response field that other teams already depend on. How do you ship that? | **Signals:**<br/>• versioning or additive change<br/>• consumer migration<br/>• deprecation window<br/><br/>**Concept IDs:**<br/>`apis-and-services.t2.versioning-or-additive-change`<br/>`apis-and-services.t2.consumer-migration`<br/>`apis-and-services.t2.deprecation-window` |
| **Tier 3 (Advanced)** | `api-3` | `4` | `technical` | A client retries on timeout, and your endpoint isn't idempotent. Walk me through what goes wrong and how you'd fix it properly. | **Signals:**<br/>• duplicate side effects<br/>• idempotency keys<br/>• server-side deduplication<br/><br/>**Concept IDs:**<br/>`apis-and-services.t3.duplicate-side-effects`<br/>`apis-and-services.t3.idempotency-keys`<br/>`apis-and-services.t3.server-side-deduplication` |

#### Topic: `Cloud And Infrastructure` (Technical)

- **Topic ID:** `cloud and infrastructure`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `aws`, `gcp`, `azure`, `kubernetes`, `k8s`, `docker`, `terraform`, `serverless`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "cloud and infrastructure" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. aws, gcp, azure, kubernetes, k8s). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "cloud and infrastructure", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `cloud-1` | `2` | `technical` | Describe how something you built got from your laptop to production. What ran that pipeline? | **Signals:**<br/>• build/deploy stages<br/>• environments<br/>• who or what triggers it<br/><br/>**Concept IDs:**<br/>`cloud-and-infrastructure.t1.build-deploy-stages`<br/>`cloud-and-infrastructure.t1.environments`<br/>`cloud-and-infrastructure.t1.who-or-what-triggers-it` |
| **Tier 2 (Intermediate)** | `cloud-2` | `3` | `technical` | How would you roll out a risky change to a service with a lot of traffic, so that a mistake costs as little as possible? | **Signals:**<br/>• staged rollout<br/>• rollback plan<br/>• signal that triggers rollback<br/><br/>**Concept IDs:**<br/>`cloud-and-infrastructure.t2.staged-rollout`<br/>`cloud-and-infrastructure.t2.rollback-plan`<br/>`cloud-and-infrastructure.t2.signal-that-triggers-rollback` |
| **Tier 3 (Advanced)** | `cloud-3` | `4` | `technical` | Your infrastructure is defined in code, but production has drifted from it. How do you find the drift and get back to a state you trust? | **Signals:**<br/>• drift detection<br/>• reconciliation risk<br/>• prevention, not just cleanup<br/><br/>**Concept IDs:**<br/>`cloud-and-infrastructure.t3.drift-detection`<br/>`cloud-and-infrastructure.t3.reconciliation-risk`<br/>`cloud-and-infrastructure.t3.prevention-not-just-cleanup` |

#### Topic: `Reliability And Operations` (Technical)

- **Topic ID:** `reliability and operations`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `reliability`, `sre`, `uptime`, `sla`, `slo`, `on-call`, `oncall`, `incident`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "reliability and operations" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. reliability, sre, uptime, sla, slo). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "reliability and operations", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `rel-1` | `2` | `technical` | What did you watch to know whether your service was healthy, and why those signals? | **Signals:**<br/>• specific metrics<br/>• user-facing vs machine-facing<br/>• reasoning behind the choice<br/><br/>**Concept IDs:**<br/>`reliability-and-operations.t1.specific-metrics`<br/>`reliability-and-operations.t1.user-facing-vs-machine-facing`<br/>`reliability-and-operations.t1.reasoning-behind-the-choice` |
| **Tier 2 (Intermediate)** | `rel-2` | `3` | `technical` | You're paged at 3am for a service you didn't write. Walk me through your first ten minutes. | **Signals:**<br/>• stabilise before diagnose<br/>• where they look first<br/>• communication<br/><br/>**Concept IDs:**<br/>`reliability-and-operations.t2.stabilise-before-diagnose`<br/>`reliability-and-operations.t2.where-they-look-first`<br/>`reliability-and-operations.t2.communication` |
| **Tier 3 (Advanced)** | `rel-3` | `4` | `technical` | How would you set an SLO for a service, and what would you actually do differently once you had one? | **Signals:**<br/>• ties to user impact<br/>• error budget consequence<br/>• avoids vanity targets<br/><br/>**Concept IDs:**<br/>`reliability-and-operations.t3.ties-to-user-impact`<br/>`reliability-and-operations.t3.error-budget-consequence`<br/>`reliability-and-operations.t3.avoids-vanity-targets` |

#### Topic: `Testing And Quality` (Technical)

- **Topic ID:** `testing and quality`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `testing`, `unit test`, `integration test`, `test coverage`, `tdd`, `qa`, `regression`, `end-to-end`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "testing and quality" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. testing, unit test, integration test, test coverage, tdd). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "testing and quality", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `test-1` | `2` | `technical` | For something you've built recently — what did you test, and what did you deliberately not test? | **Signals:**<br/>• explicit tradeoff<br/>• risk-based reasoning<br/>• concrete examples<br/><br/>**Concept IDs:**<br/>`testing-and-quality.t1.explicit-tradeoff`<br/>`testing-and-quality.t1.risk-based-reasoning`<br/>`testing-and-quality.t1.concrete-examples` |
| **Tier 2 (Intermediate)** | `test-2` | `3` | `technical` | A test in CI fails about one run in twenty and nobody can reproduce it locally. What do you do? | **Signals:**<br/>• treats flakiness as a real defect<br/>• isolation strategy<br/>• doesn't just retry<br/><br/>**Concept IDs:**<br/>`testing-and-quality.t2.treats-flakiness-as-a-real-defect`<br/>`testing-and-quality.t2.isolation-strategy`<br/>`testing-and-quality.t2.doesn-t-just-retry` |
| **Tier 3 (Advanced)** | `test-3` | `4` | `technical` | You inherit a service with no tests and a weekly release. Where do you add tests first, and how do you justify the time? | **Signals:**<br/>• prioritises by risk<br/>• characterisation tests<br/>• makes the case in business terms<br/><br/>**Concept IDs:**<br/>`testing-and-quality.t3.prioritises-by-risk`<br/>`testing-and-quality.t3.characterisation-tests`<br/>`testing-and-quality.t3.makes-the-case-in-business-terms` |

#### Topic: `Security` (Technical)

- **Topic ID:** `security`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `security`, `authentication`, `authorization`, `oauth`, `encryption`, `vulnerability`, `penetration`, `compliance`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "security" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. security, authentication, authorization, oauth, encryption). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "security", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `sec-1` | `2` | `technical` | How did users authenticate in a system you worked on, and what was stored on your side? | **Signals:**<br/>• credential handling<br/>• hashing vs encryption<br/>• session/token lifetime<br/><br/>**Concept IDs:**<br/>`security.t1.credential-handling`<br/>`security.t1.hashing-vs-encryption`<br/>`security.t1.session-token-lifetime` |
| **Tier 2 (Intermediate)** | `sec-2` | `3` | `technical` | How would you decide what a given service is allowed to access, and where would you enforce it? | **Signals:**<br/>• least privilege<br/>• enforcement point<br/>• auditability<br/><br/>**Concept IDs:**<br/>`security.t2.least-privilege`<br/>`security.t2.enforcement-point`<br/>`security.t2.auditability` |
| **Tier 3 (Advanced)** | `sec-3` | `4` | `technical` | You find a credential committed to a repository eighteen months ago. Walk me through what happens next. | **Signals:**<br/>• rotate first<br/>• assess exposure<br/>• prevention going forward<br/><br/>**Concept IDs:**<br/>`security.t3.rotate-first`<br/>`security.t3.assess-exposure`<br/>`security.t3.prevention-going-forward` |

#### Topic: `Data Engineering` (Technical)

- **Topic ID:** `data engineering`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `etl`, `data pipeline`, `airflow`, `spark`, `hadoop`, `warehouse`, `snowflake`, `batch processing`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "data engineering" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. etl, data pipeline, airflow, spark, hadoop). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "data engineering", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `de-1` | `2` | `technical` | Describe a data pipeline you've worked on end to end — where the data came from and what consumed it. | **Signals:**<br/>• source to sink<br/>• scheduling<br/>• consumers and their needs<br/><br/>**Concept IDs:**<br/>`data-engineering.t1.source-to-sink`<br/>`data-engineering.t1.scheduling`<br/>`data-engineering.t1.consumers-and-their-needs` |
| **Tier 2 (Intermediate)** | `de-2` | `3` | `technical` | A nightly job half-completed and left partial data behind. How do you make that situation not hurt? | **Signals:**<br/>• idempotent reruns<br/>• atomic swap or staging<br/>• detection<br/><br/>**Concept IDs:**<br/>`data-engineering.t2.idempotent-reruns`<br/>`data-engineering.t2.atomic-swap-or-staging`<br/>`data-engineering.t2.detection` |
| **Tier 3 (Advanced)** | `de-3` | `4` | `technical` | Downstream users say a dashboard number is wrong. How do you trace it back, and how would you stop it recurring? | **Signals:**<br/>• lineage<br/>• data quality checks<br/>• contract with producers<br/><br/>**Concept IDs:**<br/>`data-engineering.t3.lineage`<br/>`data-engineering.t3.data-quality-checks`<br/>`data-engineering.t3.contract-with-producers` |

#### Topic: `Machine Learning` (Technical)

- **Topic ID:** `machine learning`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `machine learning`, `ml`, `model training`, `pytorch`, `tensorflow`, `nlp`, `inference`, `embedding`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "machine learning" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. machine learning, ml, model training, pytorch, tensorflow). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "machine learning", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `ml-1` | `2` | `technical` | Tell me about a model you worked with. What was it predicting, and how did you know whether it was any good? | **Signals:**<br/>• problem framing<br/>• metric choice<br/>• baseline comparison<br/><br/>**Concept IDs:**<br/>`machine-learning.t1.problem-framing`<br/>`machine-learning.t1.metric-choice`<br/>`machine-learning.t1.baseline-comparison` |
| **Tier 2 (Intermediate)** | `ml-2` | `3` | `technical` | Your model scores well offline and disappoints in production. What are the likely reasons, and how do you check? | **Signals:**<br/>• train/serve skew<br/>• distribution shift<br/>• evaluation design<br/><br/>**Concept IDs:**<br/>`machine-learning.t2.train-serve-skew`<br/>`machine-learning.t2.distribution-shift`<br/>`machine-learning.t2.evaluation-design` |
| **Tier 3 (Advanced)** | `ml-3` | `4` | `technical` | How would you design the serving path for a model that has to answer in under 100ms at high volume? | **Signals:**<br/>• batching/caching<br/>• model size tradeoffs<br/>• fallback behaviour<br/><br/>**Concept IDs:**<br/>`machine-learning.t3.batching-caching`<br/>`machine-learning.t3.model-size-tradeoffs`<br/>`machine-learning.t3.fallback-behaviour` |

#### Topic: `Frontend Engineering` (Technical)

- **Topic ID:** `frontend engineering`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `react`, `next.js`, `nextjs`, `vue`, `angular`, `typescript`, `css`, `tailwind`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "frontend engineering" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. react, next.js, nextjs, vue, angular). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "frontend engineering", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `fe-1` | `2` | `technical` | Take a screen you've built and walk me through how state flowed through it. | **Signals:**<br/>• state ownership<br/>• data fetching<br/>• why that structure<br/><br/>**Concept IDs:**<br/>`frontend-engineering.t1.state-ownership`<br/>`frontend-engineering.t1.data-fetching`<br/>`frontend-engineering.t1.why-that-structure` |
| **Tier 2 (Intermediate)** | `fe-2` | `3` | `technical` | A page feels slow on a mid-range phone but fine on your laptop. How do you find out why? | **Signals:**<br/>• measures before optimising<br/>• bundle/render/network split<br/>• real device conditions<br/><br/>**Concept IDs:**<br/>`frontend-engineering.t2.measures-before-optimising`<br/>`frontend-engineering.t2.bundle-render-network-split`<br/>`frontend-engineering.t2.real-device-conditions` |
| **Tier 3 (Advanced)** | `fe-3` | `4` | `technical` | How would you make a complex interactive component usable with a keyboard and a screen reader, and how would you verify it? | **Signals:**<br/>• focus management<br/>• semantics over ARIA patches<br/>• actual verification method<br/><br/>**Concept IDs:**<br/>`frontend-engineering.t3.focus-management`<br/>`frontend-engineering.t3.semantics-over-aria-patches`<br/>`frontend-engineering.t3.actual-verification-method` |

#### Topic: `Mobile Engineering` (Technical)

- **Topic ID:** `mobile engineering`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `ios`, `android`, `swift`, `kotlin`, `react native`, `flutter`, `mobile app`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "mobile engineering" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. ios, android, swift, kotlin, react native). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "mobile engineering", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `mob-1` | `2` | `technical` | How did your app behave when the network dropped mid-action? | **Signals:**<br/>• offline handling<br/>• user feedback<br/>• retry/queue<br/><br/>**Concept IDs:**<br/>`mobile-engineering.t1.offline-handling`<br/>`mobile-engineering.t1.user-feedback`<br/>`mobile-engineering.t1.retry-queue` |
| **Tier 2 (Intermediate)** | `mob-2` | `3` | `technical` | You need to ship a fix to users today, but the app store review takes days. What are your options? | **Signals:**<br/>• server-side toggles<br/>• remote config<br/>• release planning<br/><br/>**Concept IDs:**<br/>`mobile-engineering.t2.server-side-toggles`<br/>`mobile-engineering.t2.remote-config`<br/>`mobile-engineering.t2.release-planning` |
| **Tier 3 (Advanced)** | `mob-3` | `4` | `technical` | How would you diagnose a battery drain complaint you can't reproduce? | **Signals:**<br/>• instrumentation<br/>• background work audit<br/>• narrowing by cohort<br/><br/>**Concept IDs:**<br/>`mobile-engineering.t3.instrumentation`<br/>`mobile-engineering.t3.background-work-audit`<br/>`mobile-engineering.t3.narrowing-by-cohort` |

#### Topic: `Data Structures And Algorithms` (Technical)

- **Topic ID:** `data structures and algorithms`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `algorithm`, `data structure`, `tree`, `graph`, `hash map`, `linked list`, `sorting`, `dynamic programming`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "data structures and algorithms" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. algorithm, data structure, tree, graph, hash map). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "data structures and algorithms", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `dsa-1` | `2` | `technical` | You need to look up items by key with very fast reads. Walk me through which data structure you'd choose and why. | **Signals:**<br/>• hash map understanding<br/>• collision handling<br/>• time complexity reasoning<br/><br/>**Concept IDs:**<br/>`data-structures-and-algorithms.t1.hash-map-understanding`<br/>`data-structures-and-algorithms.t1.collision-handling`<br/>`data-structures-and-algorithms.t1.time-complexity-reasoning` |
| **Tier 2 (Intermediate)** | `dsa-2` | `3` | `technical` | You have a sorted list of a million items and need to find one. What approach do you take, and what's the cost? | **Signals:**<br/>• binary search<br/>• logarithmic complexity<br/>• edge cases<br/><br/>**Concept IDs:**<br/>`data-structures-and-algorithms.t2.binary-search`<br/>`data-structures-and-algorithms.t2.logarithmic-complexity`<br/>`data-structures-and-algorithms.t2.edge-cases` |
| **Tier 3 (Advanced)** | `dsa-3` | `4` | `technical` | Describe a problem you solved using dynamic programming. How did you identify the substructure? | **Signals:**<br/>• overlapping subproblems<br/>• memoization vs tabulation<br/>• state definition<br/><br/>**Concept IDs:**<br/>`data-structures-and-algorithms.t3.overlapping-subproblems`<br/>`data-structures-and-algorithms.t3.memoization-vs-tabulation`<br/>`data-structures-and-algorithms.t3.state-definition` |

#### Topic: `Concurrency And Parallelism` (Technical)

- **Topic ID:** `concurrency and parallelism`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `concurrency`, `parallel`, `thread`, `mutex`, `lock`, `deadlock`, `race condition`, `async`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "concurrency and parallelism" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. concurrency, parallel, thread, mutex, lock). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "concurrency and parallelism", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `conc-1` | `2` | `technical` | Describe a situation where two threads or processes needed to access the same resource. How did you handle it? | **Signals:**<br/>• mutual exclusion concept<br/>• lock or equivalent<br/>• awareness of contention<br/><br/>**Concept IDs:**<br/>`concurrency-and-parallelism.t1.mutual-exclusion-concept`<br/>`concurrency-and-parallelism.t1.lock-or-equivalent`<br/>`concurrency-and-parallelism.t1.awareness-of-contention` |
| **Tier 2 (Intermediate)** | `conc-2` | `3` | `technical` | A multithreaded application occasionally produces wrong results but works fine under a debugger. What's your diagnosis approach? | **Signals:**<br/>• race condition suspicion<br/>• reproducibility challenges<br/>• systematic narrowing<br/><br/>**Concept IDs:**<br/>`concurrency-and-parallelism.t2.race-condition-suspicion`<br/>`concurrency-and-parallelism.t2.reproducibility-challenges`<br/>`concurrency-and-parallelism.t2.systematic-narrowing` |
| **Tier 3 (Advanced)** | `conc-3` | `4` | `technical` | How would you design a work-stealing scheduler for a thread pool? What are the tradeoffs? | **Signals:**<br/>• load balancing<br/>• lock-free queues<br/>• cache locality considerations<br/><br/>**Concept IDs:**<br/>`concurrency-and-parallelism.t3.load-balancing`<br/>`concurrency-and-parallelism.t3.lock-free-queues`<br/>`concurrency-and-parallelism.t3.cache-locality-considerations` |

#### Topic: `Networking Fundamentals` (Technical)

- **Topic ID:** `networking fundamentals`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `tcp`, `udp`, `http`, `https`, `tls`, `ssl`, `dns`, `cdn`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "networking fundamentals" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. tcp, udp, http, https, tls). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "networking fundamentals", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `net-1` | `2` | `technical` | Walk me through what happens from when you type a URL into a browser to when you see the page. | **Signals:**<br/>• dns resolution<br/>• tcp handshake<br/>• http request/response<br/><br/>**Concept IDs:**<br/>`networking-fundamentals.t1.dns-resolution`<br/>`networking-fundamentals.t1.tcp-handshake`<br/>`networking-fundamentals.t1.http-request-response` |
| **Tier 2 (Intermediate)** | `net-2` | `3` | `technical` | A service can reach the internet but not another service on the same network. How do you debug this? | **Signals:**<br/>• layer-by-layer diagnosis<br/>• firewall/security groups<br/>• dns vs routing<br/><br/>**Concept IDs:**<br/>`networking-fundamentals.t2.layer-by-layer-diagnosis`<br/>`networking-fundamentals.t2.firewall-security-groups`<br/>`networking-fundamentals.t2.dns-vs-routing` |
| **Tier 3 (Advanced)** | `net-3` | `4` | `technical` | How would you design a system to handle 100k concurrent WebSocket connections on a single host? | **Signals:**<br/>• event-driven architecture<br/>• connection pooling limits<br/>• memory per connection<br/><br/>**Concept IDs:**<br/>`networking-fundamentals.t3.event-driven-architecture`<br/>`networking-fundamentals.t3.connection-pooling-limits`<br/>`networking-fundamentals.t3.memory-per-connection` |

#### Topic: `Operating Systems` (Technical)

- **Topic ID:** `operating systems`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `operating system`, `kernel`, `process`, `virtual memory`, `paging`, `file system`, `syscall`, `scheduler`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "operating systems" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. operating system, kernel, process, virtual memory, paging). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "operating systems", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `os-1` | `2` | `technical` | What's the difference between a process and a thread? When would you pick one over the other? | **Signals:**<br/>• isolation vs shared memory<br/>• context switch cost<br/>• use-case reasoning<br/><br/>**Concept IDs:**<br/>`operating-systems.t1.isolation-vs-shared-memory`<br/>`operating-systems.t1.context-switch-cost`<br/>`operating-systems.t1.use-case-reasoning` |
| **Tier 2 (Intermediate)** | `os-2` | `3` | `technical` | A process is using far more memory than you expect. How do you investigate? | **Signals:**<br/>• virtual vs resident memory<br/>• tooling (top/pmap/etc)<br/>• leak vs expected growth<br/><br/>**Concept IDs:**<br/>`operating-systems.t2.virtual-vs-resident-memory`<br/>`operating-systems.t2.tooling-top-pmap-etc`<br/>`operating-systems.t2.leak-vs-expected-growth` |
| **Tier 3 (Advanced)** | `os-3` | `4` | `technical` | Explain how virtual memory works and what happens when a page fault occurs during a critical path. | **Signals:**<br/>• page table mechanics<br/>• major vs minor faults<br/>• performance implications<br/><br/>**Concept IDs:**<br/>`operating-systems.t3.page-table-mechanics`<br/>`operating-systems.t3.major-vs-minor-faults`<br/>`operating-systems.t3.performance-implications` |

#### Topic: `Devops And Ci/Cd` (Technical)

- **Topic ID:** `devops and ci/cd`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `devops`, `continuous integration`, `continuous deployment`, `pipeline`, `build automation`, `artifact registry`, `canary deployment`, `blue-green`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "devops and ci/cd" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. devops, continuous integration, continuous deployment, pipeline, build automation). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "devops and ci/cd", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `devops-1` | `2` | `technical` | Describe your team's deployment pipeline. What steps ran automatically vs. required a human? | **Signals:**<br/>• pipeline stages<br/>• automated vs manual gates<br/>• artifact management<br/><br/>**Concept IDs:**<br/>`devops-and-ci-cd.t1.pipeline-stages`<br/>`devops-and-ci-cd.t1.automated-vs-manual-gates`<br/>`devops-and-ci-cd.t1.artifact-management` |
| **Tier 2 (Intermediate)** | `devops-2` | `3` | `technical` | A deployment went out and metrics degraded. How do you decide whether to roll back or roll forward? | **Signals:**<br/>• severity assessment<br/>• rollback cost vs fix time<br/>• blast radius<br/><br/>**Concept IDs:**<br/>`devops-and-ci-cd.t2.severity-assessment`<br/>`devops-and-ci-cd.t2.rollback-cost-vs-fix-time`<br/>`devops-and-ci-cd.t2.blast-radius` |
| **Tier 3 (Advanced)** | `devops-3` | `4` | `technical` | How would you implement canary deployments for a stateful service with database migrations? | **Signals:**<br/>• backward-compatible migrations<br/>• traffic splitting<br/>• rollback of schema changes<br/><br/>**Concept IDs:**<br/>`devops-and-ci-cd.t3.backward-compatible-migrations`<br/>`devops-and-ci-cd.t3.traffic-splitting`<br/>`devops-and-ci-cd.t3.rollback-of-schema-changes` |

#### Topic: `Version Control And Collaboration` (Technical)

- **Topic ID:** `version control and collaboration`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `git`, `branching`, `merge`, `pull request`, `code review`, `trunk-based`, `monorepo`, `git workflow`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "version control and collaboration" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. git, branching, merge, pull request, code review). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "version control and collaboration", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `vc-1` | `2` | `technical` | How does your team use branches? Walk me through a feature from start to merge. | **Signals:**<br/>• branching strategy<br/>• review process<br/>• merge vs rebase reasoning<br/><br/>**Concept IDs:**<br/>`version-control-and-collaboration.t1.branching-strategy`<br/>`version-control-and-collaboration.t1.review-process`<br/>`version-control-and-collaboration.t1.merge-vs-rebase-reasoning` |
| **Tier 2 (Intermediate)** | `vc-2` | `3` | `technical` | Two developers made conflicting changes to the same module. How do you resolve it without losing work? | **Signals:**<br/>• conflict resolution strategy<br/>• communication<br/>• testing after merge<br/><br/>**Concept IDs:**<br/>`version-control-and-collaboration.t2.conflict-resolution-strategy`<br/>`version-control-and-collaboration.t2.communication`<br/>`version-control-and-collaboration.t2.testing-after-merge` |
| **Tier 3 (Advanced)** | `vc-3` | `4` | `technical` | Your monorepo has 500 contributors and CI takes 45 minutes. How do you keep velocity up? | **Signals:**<br/>• affected-path detection<br/>• caching strategies<br/>• trunk-based development tradeoffs<br/><br/>**Concept IDs:**<br/>`version-control-and-collaboration.t3.affected-path-detection`<br/>`version-control-and-collaboration.t3.caching-strategies`<br/>`version-control-and-collaboration.t3.trunk-based-development-tradeoffs` |

### Domain: Hardware Engineering (10 Topics, 30 Questions)

#### Topic: `Digital Logic Design` (Technical)

- **Topic ID:** `digital logic design`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `digital logic`, `verilog`, `vhdl`, `fpga`, `asic`, `rtl`, `synthesis`, `gate`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "digital logic design" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. digital logic, verilog, vhdl, fpga, asic). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "digital logic design", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `dld-1` | `2` | `technical` | Explain the difference between combinational and sequential logic. Give an example of each you've designed. | **Signals:**<br/>• stateless vs stateful distinction<br/>• concrete examples<br/>• clock dependency awareness<br/><br/>**Concept IDs:**<br/>`digital-logic-design.t1.stateless-vs-stateful-distinction`<br/>`digital-logic-design.t1.concrete-examples`<br/>`digital-logic-design.t1.clock-dependency-awareness` |
| **Tier 2 (Intermediate)** | `dld-2` | `3` | `technical` | You have a state machine with 16 states and glitchy outputs. How do you diagnose and fix it? | **Signals:**<br/>• state encoding choices<br/>• output registration<br/>• simulation-based debugging<br/><br/>**Concept IDs:**<br/>`digital-logic-design.t2.state-encoding-choices`<br/>`digital-logic-design.t2.output-registration`<br/>`digital-logic-design.t2.simulation-based-debugging` |
| **Tier 3 (Advanced)** | `dld-3` | `4` | `technical` | How would you design a pipelined datapath for a custom accelerator? Where do you insert pipeline stages? | **Signals:**<br/>• critical path analysis<br/>• throughput vs latency tradeoff<br/>• hazard handling<br/><br/>**Concept IDs:**<br/>`digital-logic-design.t3.critical-path-analysis`<br/>`digital-logic-design.t3.throughput-vs-latency-tradeoff`<br/>`digital-logic-design.t3.hazard-handling` |

#### Topic: `Computer Architecture` (Technical)

- **Topic ID:** `computer architecture`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `cpu`, `processor`, `pipeline`, `cache hierarchy`, `branch prediction`, `instruction set`, `isa`, `risc-v`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "computer architecture" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. cpu, processor, pipeline, cache hierarchy, branch prediction). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "computer architecture", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `arch-1` | `2` | `technical` | Walk me through what happens inside a CPU when it executes a single instruction. | **Signals:**<br/>• fetch-decode-execute cycle<br/>• register file access<br/>• ALU operation<br/><br/>**Concept IDs:**<br/>`computer-architecture.t1.fetch-decode-execute-cycle`<br/>`computer-architecture.t1.register-file-access`<br/>`computer-architecture.t1.alu-operation` |
| **Tier 2 (Intermediate)** | `arch-2` | `3` | `technical` | Why do modern CPUs have multiple levels of cache? How does data flow between them? | **Signals:**<br/>• locality of reference<br/>• inclusion vs exclusion policies<br/>• cache coherence basics<br/><br/>**Concept IDs:**<br/>`computer-architecture.t2.locality-of-reference`<br/>`computer-architecture.t2.inclusion-vs-exclusion-policies`<br/>`computer-architecture.t2.cache-coherence-basics` |
| **Tier 3 (Advanced)** | `arch-3` | `4` | `technical` | How does branch prediction work, and what happens to the pipeline when a prediction is wrong? | **Signals:**<br/>• speculative execution<br/>• pipeline flush cost<br/>• prediction strategies (static vs dynamic)<br/><br/>**Concept IDs:**<br/>`computer-architecture.t3.speculative-execution`<br/>`computer-architecture.t3.pipeline-flush-cost`<br/>`computer-architecture.t3.prediction-strategies-static-vs-dynamic` |

#### Topic: `Embedded Systems` (Technical)

- **Topic ID:** `embedded systems`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `embedded`, `microcontroller`, `mcu`, `firmware`, `rtos`, `bare-metal`, `bootloader`, `interrupt`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "embedded systems" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. embedded, microcontroller, mcu, firmware, rtos). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "embedded systems", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `emb-1` | `2` | `technical` | Describe a firmware project you worked on. What microcontroller did you use, and why that one? | **Signals:**<br/>• peripheral requirements<br/>• power/cost constraints<br/>• toolchain familiarity<br/><br/>**Concept IDs:**<br/>`embedded-systems.t1.peripheral-requirements`<br/>`embedded-systems.t1.power-cost-constraints`<br/>`embedded-systems.t1.toolchain-familiarity` |
| **Tier 2 (Intermediate)** | `emb-2` | `3` | `technical` | Your embedded device randomly resets in the field. Walk me through your investigation. | **Signals:**<br/>• watchdog timer analysis<br/>• power supply integrity<br/>• stack overflow checks<br/><br/>**Concept IDs:**<br/>`embedded-systems.t2.watchdog-timer-analysis`<br/>`embedded-systems.t2.power-supply-integrity`<br/>`embedded-systems.t2.stack-overflow-checks` |
| **Tier 3 (Advanced)** | `emb-3` | `4` | `technical` | How would you design firmware for an OTA-updatable device that must never brick itself? | **Signals:**<br/>• dual-bank/A-B partitioning<br/>• rollback on boot failure<br/>• integrity verification<br/><br/>**Concept IDs:**<br/>`embedded-systems.t3.dual-bank-a-b-partitioning`<br/>`embedded-systems.t3.rollback-on-boot-failure`<br/>`embedded-systems.t3.integrity-verification` |

#### Topic: `Pcb Design And Layout` (Technical)

- **Topic ID:** `pcb design and layout`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `pcb`, `printed circuit board`, `schematic`, `layout`, `trace`, `pcb via`, `impedance`, `stackup`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "pcb design and layout" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. pcb, printed circuit board, schematic, layout, trace). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "pcb design and layout", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `pcb-1` | `2` | `technical` | Walk me through your PCB design process from schematic capture to manufacturing files. | **Signals:**<br/>• schematic review<br/>• component placement rationale<br/>• DRC before tapeout<br/><br/>**Concept IDs:**<br/>`pcb-design-and-layout.t1.schematic-review`<br/>`pcb-design-and-layout.t1.component-placement-rationale`<br/>`pcb-design-and-layout.t1.drc-before-tapeout` |
| **Tier 2 (Intermediate)** | `pcb-2` | `3` | `technical` | You have a high-speed differential pair that isn't meeting signal integrity requirements. What do you check? | **Signals:**<br/>• impedance control<br/>• length matching<br/>• reference plane continuity<br/><br/>**Concept IDs:**<br/>`pcb-design-and-layout.t2.impedance-control`<br/>`pcb-design-and-layout.t2.length-matching`<br/>`pcb-design-and-layout.t2.reference-plane-continuity` |
| **Tier 3 (Advanced)** | `pcb-3` | `4` | `technical` | How would you design a 12-layer PCB stackup for a mixed-signal board with sensitive analog and noisy digital sections? | **Signals:**<br/>• ground plane isolation<br/>• return current paths<br/>• EMI containment strategy<br/><br/>**Concept IDs:**<br/>`pcb-design-and-layout.t3.ground-plane-isolation`<br/>`pcb-design-and-layout.t3.return-current-paths`<br/>`pcb-design-and-layout.t3.emi-containment-strategy` |

#### Topic: `Hardware Verification And Testing` (Technical)

- **Topic ID:** `hardware verification and testing`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `verification`, `validation`, `testbench`, `simulation`, `formal verification`, `coverage`, `uvm`, `systemverilog`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "hardware verification and testing" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. verification, validation, testbench, simulation, formal verification). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "hardware verification and testing", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `hv-1` | `2` | `technical` | How do you verify that a Verilog/VHDL module behaves correctly before it goes to silicon? | **Signals:**<br/>• testbench methodology<br/>• stimulus generation<br/>• checking against expected output<br/><br/>**Concept IDs:**<br/>`hardware-verification-and-testing.t1.testbench-methodology`<br/>`hardware-verification-and-testing.t1.stimulus-generation`<br/>`hardware-verification-and-testing.t1.checking-against-expected-output` |
| **Tier 2 (Intermediate)** | `hv-2` | `3` | `technical` | Your functional coverage is at 85% and the remaining holes are hard to hit. What's your strategy? | **Signals:**<br/>• constrained random with targeted seeds<br/>• corner case identification<br/>• coverage closure plan<br/><br/>**Concept IDs:**<br/>`hardware-verification-and-testing.t2.constrained-random-with-targeted-seeds`<br/>`hardware-verification-and-testing.t2.corner-case-identification`<br/>`hardware-verification-and-testing.t2.coverage-closure-plan` |
| **Tier 3 (Advanced)** | `hv-3` | `4` | `technical` | When would you use formal verification over simulation, and what are its limitations? | **Signals:**<br/>• exhaustive proof vs bounded<br/>• state space explosion<br/>• property specification<br/><br/>**Concept IDs:**<br/>`hardware-verification-and-testing.t3.exhaustive-proof-vs-bounded`<br/>`hardware-verification-and-testing.t3.state-space-explosion`<br/>`hardware-verification-and-testing.t3.property-specification` |

#### Topic: `Soc Design` (Technical)

- **Topic ID:** `soc design`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `system on chip`, `soc`, `interconnect`, `bus protocol`, `axi`, `apb`, `ahb`, `noc`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "soc design" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. system on chip, soc, interconnect, bus protocol, axi). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "soc design", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `soc-1` | `2` | `technical` | What components make up a typical SoC, and how do they communicate? | **Signals:**<br/>• CPU/memory/peripherals<br/>• bus interconnect<br/>• address mapping<br/><br/>**Concept IDs:**<br/>`soc-design.t1.cpu-memory-peripherals`<br/>`soc-design.t1.bus-interconnect`<br/>`soc-design.t1.address-mapping` |
| **Tier 2 (Intermediate)** | `soc-2` | `3` | `technical` | How do you handle the integration of a third-party IP core into your SoC? | **Signals:**<br/>• interface compliance verification<br/>• clock domain handling<br/>• documentation review<br/><br/>**Concept IDs:**<br/>`soc-design.t2.interface-compliance-verification`<br/>`soc-design.t2.clock-domain-handling`<br/>`soc-design.t2.documentation-review` |
| **Tier 3 (Advanced)** | `soc-3` | `4` | `technical` | Design the memory subsystem for an SoC that must serve a CPU, a GPU, and a DMA engine simultaneously. | **Signals:**<br/>• arbitration policy<br/>• QoS requirements<br/>• bandwidth partitioning<br/><br/>**Concept IDs:**<br/>`soc-design.t3.arbitration-policy`<br/>`soc-design.t3.qos-requirements`<br/>`soc-design.t3.bandwidth-partitioning` |

#### Topic: `Hardware-Software Interface` (Technical)

- **Topic ID:** `hardware-software interface`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `driver`, `device driver`, `hal`, `bsp`, `memory-mapped`, `register`, `mmio`, `dts`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "hardware-software interface" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. driver, device driver, hal, bsp, memory-mapped). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "hardware-software interface", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `hsi-1` | `2` | `technical` | How does a device driver communicate with hardware? Walk me through a register read. | **Signals:**<br/>• memory-mapped I/O<br/>• register address space<br/>• volatile access<br/><br/>**Concept IDs:**<br/>`hardware-software-interface.t1.memory-mapped-i-o`<br/>`hardware-software-interface.t1.register-address-space`<br/>`hardware-software-interface.t1.volatile-access` |
| **Tier 2 (Intermediate)** | `hsi-2` | `3` | `technical` | You wrote a driver, but the device behaves differently on two OS versions. How do you debug? | **Signals:**<br/>• HAL abstraction differences<br/>• kernel API changes<br/>• register-level validation<br/><br/>**Concept IDs:**<br/>`hardware-software-interface.t2.hal-abstraction-differences`<br/>`hardware-software-interface.t2.kernel-api-changes`<br/>`hardware-software-interface.t2.register-level-validation` |
| **Tier 3 (Advanced)** | `hsi-3` | `4` | `technical` | How would you design a DMA engine's programming interface to be both efficient and safe for user-space access? | **Signals:**<br/>• IOMMU protection<br/>• descriptor ring design<br/>• interrupt coalescing<br/><br/>**Concept IDs:**<br/>`hardware-software-interface.t3.iommu-protection`<br/>`hardware-software-interface.t3.descriptor-ring-design`<br/>`hardware-software-interface.t3.interrupt-coalescing` |

#### Topic: `Signal Integrity And Timing` (Technical)

- **Topic ID:** `signal integrity and timing`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `signal integrity`, `timing analysis`, `setup time`, `hold time`, `clock domain`, `metastability`, `jitter`, `eye diagram`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "signal integrity and timing" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. signal integrity, timing analysis, setup time, hold time, clock domain). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "signal integrity and timing", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `si-1` | `2` | `technical` | What is setup time and hold time? Why do they matter? | **Signals:**<br/>• data stability window<br/>• metastability risk<br/>• clock-to-q relationship<br/><br/>**Concept IDs:**<br/>`signal-integrity-and-timing.t1.data-stability-window`<br/>`signal-integrity-and-timing.t1.metastability-risk`<br/>`signal-integrity-and-timing.t1.clock-to-q-relationship` |
| **Tier 2 (Intermediate)** | `si-2` | `3` | `technical` | Your design has a timing violation on a path that crosses clock domains. How do you fix it? | **Signals:**<br/>• synchronizer insertion<br/>• CDC analysis<br/>• false path vs multi-cycle<br/><br/>**Concept IDs:**<br/>`signal-integrity-and-timing.t2.synchronizer-insertion`<br/>`signal-integrity-and-timing.t2.cdc-analysis`<br/>`signal-integrity-and-timing.t2.false-path-vs-multi-cycle` |
| **Tier 3 (Advanced)** | `si-3` | `4` | `technical` | How do you analyze and mitigate jitter in a high-speed serial link? | **Signals:**<br/>• deterministic vs random jitter<br/>• eye diagram analysis<br/>• equalization techniques<br/><br/>**Concept IDs:**<br/>`signal-integrity-and-timing.t3.deterministic-vs-random-jitter`<br/>`signal-integrity-and-timing.t3.eye-diagram-analysis`<br/>`signal-integrity-and-timing.t3.equalization-techniques` |

#### Topic: `Low Power Design` (Technical)

- **Topic ID:** `low power design`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `low power`, `power gating`, `clock gating`, `voltage scaling`, `dvfs`, `leakage`, `power domain`, `retention`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "low power design" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. low power, power gating, clock gating, voltage scaling, dvfs). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "low power design", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `lp-1` | `2` | `technical` | What are the main sources of power consumption in a digital chip? | **Signals:**<br/>• dynamic vs static power<br/>• switching activity<br/>• leakage current<br/><br/>**Concept IDs:**<br/>`low-power-design.t1.dynamic-vs-static-power`<br/>`low-power-design.t1.switching-activity`<br/>`low-power-design.t1.leakage-current` |
| **Tier 2 (Intermediate)** | `lp-2` | `3` | `technical` | How would you reduce power in a block that toggles frequently but is only used intermittently? | **Signals:**<br/>• clock gating<br/>• power gating with isolation<br/>• retention registers<br/><br/>**Concept IDs:**<br/>`low-power-design.t2.clock-gating`<br/>`low-power-design.t2.power-gating-with-isolation`<br/>`low-power-design.t2.retention-registers` |
| **Tier 3 (Advanced)** | `lp-3` | `4` | `technical` | Design a multi-voltage-domain strategy for an IoT SoC that must last years on a coin cell. | **Signals:**<br/>• always-on domain sizing<br/>• wake-up latency budget<br/>• level shifter placement<br/><br/>**Concept IDs:**<br/>`low-power-design.t3.always-on-domain-sizing`<br/>`low-power-design.t3.wake-up-latency-budget`<br/>`low-power-design.t3.level-shifter-placement` |

#### Topic: `Semiconductor Physics` (Technical)

- **Topic ID:** `semiconductor physics`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `mosfet`, `transistor`, `cmos`, `process node`, `fabrication`, `lithography`, `doping`, `threshold voltage`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "semiconductor physics" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. mosfet, transistor, cmos, process node, fabrication). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "semiconductor physics", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `semi-1` | `2` | `technical` | Explain how a MOSFET works as a switch. What controls whether it's on or off? | **Signals:**<br/>• gate voltage vs threshold<br/>• channel formation<br/>• n-type vs p-type<br/><br/>**Concept IDs:**<br/>`semiconductor-physics.t1.gate-voltage-vs-threshold`<br/>`semiconductor-physics.t1.channel-formation`<br/>`semiconductor-physics.t1.n-type-vs-p-type` |
| **Tier 2 (Intermediate)** | `semi-2` | `3` | `technical` | Why does shrinking the process node increase leakage current, and what do foundries do about it? | **Signals:**<br/>• short-channel effects<br/>• gate oxide tunneling<br/>• high-k metal gate<br/><br/>**Concept IDs:**<br/>`semiconductor-physics.t2.short-channel-effects`<br/>`semiconductor-physics.t2.gate-oxide-tunneling`<br/>`semiconductor-physics.t2.high-k-metal-gate` |
| **Tier 3 (Advanced)** | `semi-3` | `4` | `technical` | How do FinFETs differ from planar transistors, and what design implications does that have? | **Signals:**<br/>• 3D channel structure<br/>• quantized width<br/>• variability reduction<br/><br/>**Concept IDs:**<br/>`semiconductor-physics.t3.3d-channel-structure`<br/>`semiconductor-physics.t3.quantized-width`<br/>`semiconductor-physics.t3.variability-reduction` |

### Domain: Electrical Engineering (12 Topics, 36 Questions)

#### Topic: `Circuit Analysis` (Technical)

- **Topic ID:** `circuit analysis`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `circuit`, `kirchhoff`, `ohm's law`, `thevenin`, `norton`, `impedance`, `reactance`, `phasor`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "circuit analysis" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. circuit, kirchhoff, ohm's law, thevenin, norton). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "circuit analysis", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `ckt-1` | `2` | `technical` | You have a resistive network and need to find the current through one branch. What method do you use? | **Signals:**<br/>• KVL/KCL application<br/>• Thevenin or mesh/nodal choice<br/>• systematic approach<br/><br/>**Concept IDs:**<br/>`circuit-analysis.t1.kvl-kcl-application`<br/>`circuit-analysis.t1.thevenin-or-mesh-nodal-choice`<br/>`circuit-analysis.t1.systematic-approach` |
| **Tier 2 (Intermediate)** | `ckt-2` | `3` | `technical` | An RLC circuit is ringing longer than expected. How do you characterise the damping? | **Signals:**<br/>• damping ratio calculation<br/>• Q factor relationship<br/>• measurement approach<br/><br/>**Concept IDs:**<br/>`circuit-analysis.t2.damping-ratio-calculation`<br/>`circuit-analysis.t2.q-factor-relationship`<br/>`circuit-analysis.t2.measurement-approach` |
| **Tier 3 (Advanced)** | `ckt-3` | `4` | `technical` | How would you analyse a circuit with multiple coupled inductors and nonlinear elements? | **Signals:**<br/>• SPICE simulation setup<br/>• coupling coefficient modeling<br/>• convergence challenges<br/><br/>**Concept IDs:**<br/>`circuit-analysis.t3.spice-simulation-setup`<br/>`circuit-analysis.t3.coupling-coefficient-modeling`<br/>`circuit-analysis.t3.convergence-challenges` |

#### Topic: `Analog Electronics` (Technical)

- **Topic ID:** `analog electronics`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `op-amp`, `amplifier`, `transistor`, `bjt`, `mosfet`, `diode`, `rectifier`, `filter`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "analog electronics" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. op-amp, amplifier, transistor, bjt, mosfet). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "analog electronics", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `analog-1` | `2` | `technical` | Design a non-inverting amplifier with a gain of 10. What practical issues do you consider? | **Signals:**<br/>• resistor ratio<br/>• op-amp bandwidth/GBP<br/>• input/output range<br/><br/>**Concept IDs:**<br/>`analog-electronics.t1.resistor-ratio`<br/>`analog-electronics.t1.op-amp-bandwidth-gbp`<br/>`analog-electronics.t1.input-output-range` |
| **Tier 2 (Intermediate)** | `analog-2` | `3` | `technical` | Your ADC readings have noise that wasn't in the datasheet. How do you track down the source? | **Signals:**<br/>• grounding/layout review<br/>• power supply noise measurement<br/>• signal conditioning evaluation<br/><br/>**Concept IDs:**<br/>`analog-electronics.t2.grounding-layout-review`<br/>`analog-electronics.t2.power-supply-noise-measurement`<br/>`analog-electronics.t2.signal-conditioning-evaluation` |
| **Tier 3 (Advanced)** | `analog-3` | `4` | `technical` | How would you design a precision current sense circuit for a 0-50A range with 1% accuracy? | **Signals:**<br/>• shunt vs Hall effect tradeoff<br/>• thermal drift compensation<br/>• common-mode rejection<br/><br/>**Concept IDs:**<br/>`analog-electronics.t3.shunt-vs-hall-effect-tradeoff`<br/>`analog-electronics.t3.thermal-drift-compensation`<br/>`analog-electronics.t3.common-mode-rejection` |

#### Topic: `Power Electronics` (Technical)

- **Topic ID:** `power electronics`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `power electronics`, `converter`, `inverter`, `rectifier`, `buck`, `boost`, `switching regulator`, `pwm`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "power electronics" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. power electronics, converter, inverter, rectifier, buck). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "power electronics", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `pe-1` | `2` | `technical` | Explain the difference between a buck and a boost converter. When would you use each? | **Signals:**<br/>• voltage step-down vs step-up<br/>• duty cycle relationship<br/>• application examples<br/><br/>**Concept IDs:**<br/>`power-electronics.t1.voltage-step-down-vs-step-up`<br/>`power-electronics.t1.duty-cycle-relationship`<br/>`power-electronics.t1.application-examples` |
| **Tier 2 (Intermediate)** | `pe-2` | `3` | `technical` | Your switch-mode power supply has excessive output ripple. What are the likely causes? | **Signals:**<br/>• output capacitor ESR<br/>• inductor sizing<br/>• switching frequency considerations<br/><br/>**Concept IDs:**<br/>`power-electronics.t2.output-capacitor-esr`<br/>`power-electronics.t2.inductor-sizing`<br/>`power-electronics.t2.switching-frequency-considerations` |
| **Tier 3 (Advanced)** | `pe-3` | `4` | `technical` | How would you design a 3-phase inverter for a motor drive with regenerative braking? | **Signals:**<br/>• switching topology choice<br/>• deadtime insertion<br/>• DC bus energy management<br/><br/>**Concept IDs:**<br/>`power-electronics.t3.switching-topology-choice`<br/>`power-electronics.t3.deadtime-insertion`<br/>`power-electronics.t3.dc-bus-energy-management` |

#### Topic: `Power Systems` (Technical)

- **Topic ID:** `power systems`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `power grid`, `transmission`, `distribution`, `power transformer`, `generator`, `load flow`, `short circuit`, `protection`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "power systems" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. power grid, transmission, distribution, power transformer, generator). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "power systems", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `ps-1` | `2` | `technical` | What is the purpose of a transformer in power distribution? Walk me through the sizing considerations. | **Signals:**<br/>• voltage transformation<br/>• kVA rating vs load<br/>• impedance and losses<br/><br/>**Concept IDs:**<br/>`power-systems.t1.voltage-transformation`<br/>`power-systems.t1.kva-rating-vs-load`<br/>`power-systems.t1.impedance-and-losses` |
| **Tier 2 (Intermediate)** | `ps-2` | `3` | `technical` | A feeder trips on overcurrent but the load hasn't changed. How do you investigate? | **Signals:**<br/>• fault current analysis<br/>• protection coordination review<br/>• insulation testing<br/><br/>**Concept IDs:**<br/>`power-systems.t2.fault-current-analysis`<br/>`power-systems.t2.protection-coordination-review`<br/>`power-systems.t2.insulation-testing` |
| **Tier 3 (Advanced)** | `ps-3` | `4` | `technical` | How would you integrate a 50MW solar farm into an existing distribution network? | **Signals:**<br/>• grid interconnection study<br/>• voltage regulation impact<br/>• protection scheme redesign<br/><br/>**Concept IDs:**<br/>`power-systems.t3.grid-interconnection-study`<br/>`power-systems.t3.voltage-regulation-impact`<br/>`power-systems.t3.protection-scheme-redesign` |

#### Topic: `Electromagnetic Theory` (Technical)

- **Topic ID:** `electromagnetic theory`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `electromagnetic`, `maxwell`, `antenna`, `rf`, `microwave`, `waveguide`, `radiation pattern`, `smith chart`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "electromagnetic theory" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. electromagnetic, maxwell, antenna, rf, microwave). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "electromagnetic theory", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `em-1` | `2` | `technical` | What is impedance matching and why does it matter in RF systems? | **Signals:**<br/>• maximum power transfer<br/>• reflection coefficient<br/>• Smith chart basics<br/><br/>**Concept IDs:**<br/>`electromagnetic-theory.t1.maximum-power-transfer`<br/>`electromagnetic-theory.t1.reflection-coefficient`<br/>`electromagnetic-theory.t1.smith-chart-basics` |
| **Tier 2 (Intermediate)** | `em-2` | `3` | `technical` | Your PCB antenna's radiation pattern doesn't match simulation. How do you debug? | **Signals:**<br/>• ground plane effects<br/>• nearby conductor coupling<br/>• measurement setup validation<br/><br/>**Concept IDs:**<br/>`electromagnetic-theory.t2.ground-plane-effects`<br/>`electromagnetic-theory.t2.nearby-conductor-coupling`<br/>`electromagnetic-theory.t2.measurement-setup-validation` |
| **Tier 3 (Advanced)** | `em-3` | `4` | `technical` | How would you design an antenna array for beam steering in a 5G base station? | **Signals:**<br/>• element spacing for grating lobe avoidance<br/>• phase shift control<br/>• mutual coupling compensation<br/><br/>**Concept IDs:**<br/>`electromagnetic-theory.t3.element-spacing-for-grating-lobe-avoidance`<br/>`electromagnetic-theory.t3.phase-shift-control`<br/>`electromagnetic-theory.t3.mutual-coupling-compensation` |

#### Topic: `Signal Processing` (Technical)

- **Topic ID:** `signal processing`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `dsp`, `signal processing`, `fourier transform`, `fft`, `filter design`, `signal sampling`, `nyquist`, `aliasing`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "signal processing" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. dsp, signal processing, fourier transform, fft, filter design). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "signal processing", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `sp-1` | `2` | `technical` | What is the Nyquist theorem, and what happens if you violate it? | **Signals:**<br/>• sampling rate requirement<br/>• aliasing explanation<br/>• anti-aliasing filter<br/><br/>**Concept IDs:**<br/>`signal-processing.t1.sampling-rate-requirement`<br/>`signal-processing.t1.aliasing-explanation`<br/>`signal-processing.t1.anti-aliasing-filter` |
| **Tier 2 (Intermediate)** | `sp-2` | `3` | `technical` | Design a digital filter to remove 50Hz mains noise from a biomedical signal. | **Signals:**<br/>• notch filter design<br/>• IIR vs FIR tradeoff<br/>• phase distortion consideration<br/><br/>**Concept IDs:**<br/>`signal-processing.t2.notch-filter-design`<br/>`signal-processing.t2.iir-vs-fir-tradeoff`<br/>`signal-processing.t2.phase-distortion-consideration` |
| **Tier 3 (Advanced)** | `sp-3` | `4` | `technical` | How would you implement real-time spectral analysis on an FPGA for a wideband receiver? | **Signals:**<br/>• FFT architecture choice<br/>• windowing strategy<br/>• throughput vs resource tradeoff<br/><br/>**Concept IDs:**<br/>`signal-processing.t3.fft-architecture-choice`<br/>`signal-processing.t3.windowing-strategy`<br/>`signal-processing.t3.throughput-vs-resource-tradeoff` |

#### Topic: `Communication Systems` (Technical)

- **Topic ID:** `communication systems`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `communication`, `modulation`, `demodulation`, `ofdm`, `mimo`, `5g`, `lte`, `wireless`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "communication systems" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. communication, modulation, demodulation, ofdm, mimo). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "communication systems", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `comm-1` | `2` | `technical` | Explain the difference between AM, FM, and digital modulation. When is each appropriate? | **Signals:**<br/>• bandwidth efficiency<br/>• noise resilience<br/>• application context<br/><br/>**Concept IDs:**<br/>`communication-systems.t1.bandwidth-efficiency`<br/>`communication-systems.t1.noise-resilience`<br/>`communication-systems.t1.application-context` |
| **Tier 2 (Intermediate)** | `comm-2` | `3` | `technical` | A wireless link has high bit error rate at range. What factors do you investigate? | **Signals:**<br/>• link budget analysis<br/>• multipath effects<br/>• modulation/coding scheme<br/><br/>**Concept IDs:**<br/>`communication-systems.t2.link-budget-analysis`<br/>`communication-systems.t2.multipath-effects`<br/>`communication-systems.t2.modulation-coding-scheme` |
| **Tier 3 (Advanced)** | `comm-3` | `4` | `technical` | How does OFDM handle frequency-selective fading, and what are its weaknesses? | **Signals:**<br/>• subcarrier orthogonality<br/>• cyclic prefix purpose<br/>• PAPR problem<br/><br/>**Concept IDs:**<br/>`communication-systems.t3.subcarrier-orthogonality`<br/>`communication-systems.t3.cyclic-prefix-purpose`<br/>`communication-systems.t3.papr-problem` |

#### Topic: `Electric Machines And Drives` (Technical)

- **Topic ID:** `electric machines and drives`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `motor`, `generator`, `induction motor`, `synchronous motor`, `dc motor`, `vfd`, `variable frequency drive`, `torque`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "electric machines and drives" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. motor, generator, induction motor, synchronous motor, dc motor). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "electric machines and drives", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `emd-1` | `2` | `technical` | Explain the operating principle of a 3-phase induction motor. How is speed controlled? | **Signals:**<br/>• rotating magnetic field<br/>• slip concept<br/>• VFD application<br/><br/>**Concept IDs:**<br/>`electric-machines-and-drives.t1.rotating-magnetic-field`<br/>`electric-machines-and-drives.t1.slip-concept`<br/>`electric-machines-and-drives.t1.vfd-application` |
| **Tier 2 (Intermediate)** | `emd-2` | `3` | `technical` | A motor runs hot at rated load. What are the possible causes? | **Signals:**<br/>• voltage imbalance check<br/>• ventilation/cooling review<br/>• load profile analysis<br/><br/>**Concept IDs:**<br/>`electric-machines-and-drives.t2.voltage-imbalance-check`<br/>`electric-machines-and-drives.t2.ventilation-cooling-review`<br/>`electric-machines-and-drives.t2.load-profile-analysis` |
| **Tier 3 (Advanced)** | `emd-3` | `4` | `technical` | How would you design the control algorithm for a PMSM drive with field weakening? | **Signals:**<br/>• d-q axis control<br/>• flux weakening region constraints<br/>• current limiting strategy<br/><br/>**Concept IDs:**<br/>`electric-machines-and-drives.t3.d-q-axis-control`<br/>`electric-machines-and-drives.t3.flux-weakening-region-constraints`<br/>`electric-machines-and-drives.t3.current-limiting-strategy` |

#### Topic: `Instrumentation And Measurement` (Technical)

- **Topic ID:** `instrumentation and measurement`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `instrumentation`, `measurement`, `oscilloscope`, `multimeter`, `spectrum analyzer`, `transducer`, `strain gauge`, `thermocouple`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "instrumentation and measurement" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. instrumentation, measurement, oscilloscope, multimeter, spectrum analyzer). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "instrumentation and measurement", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `inst-1` | `2` | `technical` | How do you select a sensor for measuring temperature in an industrial process? | **Signals:**<br/>• sensor type comparison<br/>• range and environment<br/>• signal conditioning needs<br/><br/>**Concept IDs:**<br/>`instrumentation-and-measurement.t1.sensor-type-comparison`<br/>`instrumentation-and-measurement.t1.range-and-environment`<br/>`instrumentation-and-measurement.t1.signal-conditioning-needs` |
| **Tier 2 (Intermediate)** | `inst-2` | `3` | `technical` | Your measurements drift over time despite a stable process. What's causing it? | **Signals:**<br/>• calibration verification<br/>• thermal effects on sensor<br/>• reference stability<br/><br/>**Concept IDs:**<br/>`instrumentation-and-measurement.t2.calibration-verification`<br/>`instrumentation-and-measurement.t2.thermal-effects-on-sensor`<br/>`instrumentation-and-measurement.t2.reference-stability` |
| **Tier 3 (Advanced)** | `inst-3` | `4` | `technical` | How would you design a data acquisition system that measures 64 channels at 100kHz each? | **Signals:**<br/>• multiplexing vs parallel ADC<br/>• channel-to-channel isolation<br/>• timing synchronisation<br/><br/>**Concept IDs:**<br/>`instrumentation-and-measurement.t3.multiplexing-vs-parallel-adc`<br/>`instrumentation-and-measurement.t3.channel-to-channel-isolation`<br/>`instrumentation-and-measurement.t3.timing-synchronisation` |

#### Topic: `Renewable Energy Systems` (Technical)

- **Topic ID:** `renewable energy systems`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `solar`, `photovoltaic`, `wind energy`, `battery`, `energy storage`, `inverter`, `mppt`, `grid-tied`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "renewable energy systems" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. solar, photovoltaic, wind energy, battery, energy storage). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "renewable energy systems", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `ren-1` | `2` | `technical` | How does a grid-tied solar inverter work? What happens when the grid goes down? | **Signals:**<br/>• DC-AC conversion<br/>• MPPT concept<br/>• anti-islanding protection<br/><br/>**Concept IDs:**<br/>`renewable-energy-systems.t1.dc-ac-conversion`<br/>`renewable-energy-systems.t1.mppt-concept`<br/>`renewable-energy-systems.t1.anti-islanding-protection` |
| **Tier 2 (Intermediate)** | `ren-2` | `3` | `technical` | A solar installation is producing 20% less than predicted. How do you diagnose? | **Signals:**<br/>• shading analysis<br/>• string voltage comparison<br/>• inverter efficiency check<br/><br/>**Concept IDs:**<br/>`renewable-energy-systems.t2.shading-analysis`<br/>`renewable-energy-systems.t2.string-voltage-comparison`<br/>`renewable-energy-systems.t2.inverter-efficiency-check` |
| **Tier 3 (Advanced)** | `ren-3` | `4` | `technical` | How would you design a microgrid with solar, battery storage, and a diesel backup? | **Signals:**<br/>• load profiling and sizing<br/>• dispatch strategy<br/>• battery cycling optimisation<br/><br/>**Concept IDs:**<br/>`renewable-energy-systems.t3.load-profiling-and-sizing`<br/>`renewable-energy-systems.t3.dispatch-strategy`<br/>`renewable-energy-systems.t3.battery-cycling-optimisation` |

#### Topic: `Electrical Safety And Standards` (Technical)

- **Topic ID:** `electrical safety and standards`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `nec`, `iec`, `grounding`, `bonding`, `arc flash`, `lockout tagout`, `loto`, `overcurrent protection`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "electrical safety and standards" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. nec, iec, grounding, bonding, arc flash). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "electrical safety and standards", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `esafe-1` | `2` | `technical` | What is the purpose of grounding in an electrical installation? | **Signals:**<br/>• fault current path<br/>• ground resistance testing<br/>• personnel safety<br/><br/>**Concept IDs:**<br/>`electrical-safety-and-standards.t1.fault-current-path`<br/>`electrical-safety-and-standards.t1.ground-resistance-testing`<br/>`electrical-safety-and-standards.t1.personnel-safety` |
| **Tier 2 (Intermediate)** | `esafe-2` | `3` | `technical` | How do you perform an arc flash hazard analysis for a switchgear installation? | **Signals:**<br/>• incident energy calculation<br/>• boundary determination<br/>• PPE selection<br/><br/>**Concept IDs:**<br/>`electrical-safety-and-standards.t2.incident-energy-calculation`<br/>`electrical-safety-and-standards.t2.boundary-determination`<br/>`electrical-safety-and-standards.t2.ppe-selection` |
| **Tier 3 (Advanced)** | `esafe-3` | `4` | `technical` | How would you design the protection coordination for a multi-level industrial distribution system? | **Signals:**<br/>• time-current curve coordination<br/>• selectivity between devices<br/>• short-circuit study<br/><br/>**Concept IDs:**<br/>`electrical-safety-and-standards.t3.time-current-curve-coordination`<br/>`electrical-safety-and-standards.t3.selectivity-between-devices`<br/>`electrical-safety-and-standards.t3.short-circuit-study` |

#### Topic: `Plc And Industrial Automation` (Technical)

- **Topic ID:** `plc and industrial automation`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `plc`, `programmable logic controller`, `scada`, `hmi`, `ladder logic`, `industrial automation`, `dcs`, `modbus`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "plc and industrial automation" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. plc, programmable logic controller, scada, hmi, ladder logic). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "plc and industrial automation", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `plc-1` | `2` | `technical` | How does a PLC control a process? Walk me through a simple conveyor example. | **Signals:**<br/>• scan cycle concept<br/>• input/output mapping<br/>• ladder logic basics<br/><br/>**Concept IDs:**<br/>`plc-and-industrial-automation.t1.scan-cycle-concept`<br/>`plc-and-industrial-automation.t1.input-output-mapping`<br/>`plc-and-industrial-automation.t1.ladder-logic-basics` |
| **Tier 2 (Intermediate)** | `plc-2` | `3` | `technical` | A PLC-controlled process occasionally produces defective parts. How do you use data to find the cause? | **Signals:**<br/>• data logging analysis<br/>• timing correlation<br/>• sensor validation<br/><br/>**Concept IDs:**<br/>`plc-and-industrial-automation.t2.data-logging-analysis`<br/>`plc-and-industrial-automation.t2.timing-correlation`<br/>`plc-and-industrial-automation.t2.sensor-validation` |
| **Tier 3 (Advanced)** | `plc-3` | `4` | `technical` | How would you architect a SCADA system for a water treatment plant with 2000 I/O points? | **Signals:**<br/>• network topology design<br/>• redundancy requirements<br/>• cybersecurity considerations<br/><br/>**Concept IDs:**<br/>`plc-and-industrial-automation.t3.network-topology-design`<br/>`plc-and-industrial-automation.t3.redundancy-requirements`<br/>`plc-and-industrial-automation.t3.cybersecurity-considerations` |

### Domain: Mechanical Engineering (13 Topics, 39 Questions)

#### Topic: `Mechanics Of Materials` (Technical)

- **Topic ID:** `mechanics of materials`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `stress`, `strain`, `tensile`, `compressive`, `shear`, `yield strength`, `ultimate strength`, `fatigue`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "mechanics of materials" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. stress, strain, tensile, compressive, shear). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "mechanics of materials", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `mom-1` | `2` | `technical` | A beam is loaded in the center. How do you determine where it will fail first? | **Signals:**<br/>• bending moment diagram<br/>• stress concentration<br/>• material yield point<br/><br/>**Concept IDs:**<br/>`mechanics-of-materials.t1.bending-moment-diagram`<br/>`mechanics-of-materials.t1.stress-concentration`<br/>`mechanics-of-materials.t1.material-yield-point` |
| **Tier 2 (Intermediate)** | `mom-2` | `3` | `technical` | A component failed in fatigue after six months. How do you investigate and redesign? | **Signals:**<br/>• S-N curve analysis<br/>• stress raiser identification<br/>• load cycle characterisation<br/><br/>**Concept IDs:**<br/>`mechanics-of-materials.t2.s-n-curve-analysis`<br/>`mechanics-of-materials.t2.stress-raiser-identification`<br/>`mechanics-of-materials.t2.load-cycle-characterisation` |
| **Tier 3 (Advanced)** | `mom-3` | `4` | `technical` | How would you design a pressure vessel to meet both static yield and fatigue life requirements? | **Signals:**<br/>• combined stress state<br/>• ASME code application<br/>• weld joint efficiency<br/><br/>**Concept IDs:**<br/>`mechanics-of-materials.t3.combined-stress-state`<br/>`mechanics-of-materials.t3.asme-code-application`<br/>`mechanics-of-materials.t3.weld-joint-efficiency` |

#### Topic: `Thermodynamics` (Technical)

- **Topic ID:** `thermodynamics`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `thermodynamics`, `entropy`, `enthalpy`, `carnot`, `heat transfer`, `conduction`, `convection`, `radiation`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "thermodynamics" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. thermodynamics, entropy, enthalpy, carnot, heat transfer). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "thermodynamics", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `thermo-1` | `2` | `technical` | Explain the first and second laws of thermodynamics with a real-world example from your work. | **Signals:**<br/>• energy conservation<br/>• entropy increase<br/>• practical application<br/><br/>**Concept IDs:**<br/>`thermodynamics.t1.energy-conservation`<br/>`thermodynamics.t1.entropy-increase`<br/>`thermodynamics.t1.practical-application` |
| **Tier 2 (Intermediate)** | `thermo-2` | `3` | `technical` | A heat exchanger is underperforming. What factors would you investigate? | **Signals:**<br/>• fouling assessment<br/>• flow rate verification<br/>• LMTD analysis<br/><br/>**Concept IDs:**<br/>`thermodynamics.t2.fouling-assessment`<br/>`thermodynamics.t2.flow-rate-verification`<br/>`thermodynamics.t2.lmtd-analysis` |
| **Tier 3 (Advanced)** | `thermo-3` | `4` | `technical` | How would you optimise the thermal efficiency of a combined cycle power plant? | **Signals:**<br/>• Brayton-Rankine interaction<br/>• waste heat recovery<br/>• pinch point analysis<br/><br/>**Concept IDs:**<br/>`thermodynamics.t3.brayton-rankine-interaction`<br/>`thermodynamics.t3.waste-heat-recovery`<br/>`thermodynamics.t3.pinch-point-analysis` |

#### Topic: `Fluid Mechanics` (Technical)

- **Topic ID:** `fluid mechanics`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `fluid mechanics`, `fluid dynamics`, `bernoulli`, `reynolds number`, `laminar`, `turbulent`, `viscosity`, `navier-stokes`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "fluid mechanics" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. fluid mechanics, fluid dynamics, bernoulli, reynolds number, laminar). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "fluid mechanics", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `fluid-1` | `2` | `technical` | Describe the difference between laminar and turbulent flow. How do you know which you have? | **Signals:**<br/>• Reynolds number<br/>• flow regime characteristics<br/>• practical identification<br/><br/>**Concept IDs:**<br/>`fluid-mechanics.t1.reynolds-number`<br/>`fluid-mechanics.t1.flow-regime-characteristics`<br/>`fluid-mechanics.t1.practical-identification` |
| **Tier 2 (Intermediate)** | `fluid-2` | `3` | `technical` | A piping system has excessive pressure drop. Walk me through your troubleshooting. | **Signals:**<br/>• friction factor calculation<br/>• minor loss identification<br/>• system curve analysis<br/><br/>**Concept IDs:**<br/>`fluid-mechanics.t2.friction-factor-calculation`<br/>`fluid-mechanics.t2.minor-loss-identification`<br/>`fluid-mechanics.t2.system-curve-analysis` |
| **Tier 3 (Advanced)** | `fluid-3` | `4` | `technical` | How would you design the cooling channels for an injection mold to ensure uniform temperature? | **Signals:**<br/>• CFD-guided layout<br/>• heat flux matching<br/>• flow balancing across channels<br/><br/>**Concept IDs:**<br/>`fluid-mechanics.t3.cfd-guided-layout`<br/>`fluid-mechanics.t3.heat-flux-matching`<br/>`fluid-mechanics.t3.flow-balancing-across-channels` |

#### Topic: `Machine Design` (Technical)

- **Topic ID:** `machine design`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `gear`, `bearing`, `shaft`, `coupling`, `belt drive`, `chain drive`, `cam`, `mechanism`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "machine design" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. gear, bearing, shaft, coupling, belt drive). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "machine design", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `mdes-1` | `2` | `technical` | How do you select a bearing for a rotating shaft? What information do you need? | **Signals:**<br/>• load type and magnitude<br/>• speed and life requirements<br/>• catalogue selection process<br/><br/>**Concept IDs:**<br/>`machine-design.t1.load-type-and-magnitude`<br/>`machine-design.t1.speed-and-life-requirements`<br/>`machine-design.t1.catalogue-selection-process` |
| **Tier 2 (Intermediate)** | `mdes-2` | `3` | `technical` | A gear train is generating excessive noise and wear. What's your diagnosis approach? | **Signals:**<br/>• contact pattern analysis<br/>• alignment verification<br/>• lubrication check<br/><br/>**Concept IDs:**<br/>`machine-design.t2.contact-pattern-analysis`<br/>`machine-design.t2.alignment-verification`<br/>`machine-design.t2.lubrication-check` |
| **Tier 3 (Advanced)** | `mdes-3` | `4` | `technical` | Design a power transmission system for a 50kW application with high shock loads. | **Signals:**<br/>• service factor application<br/>• component sizing rationale<br/>• redundancy considerations<br/><br/>**Concept IDs:**<br/>`machine-design.t3.service-factor-application`<br/>`machine-design.t3.component-sizing-rationale`<br/>`machine-design.t3.redundancy-considerations` |

#### Topic: `Cad And 3D Modeling` (Technical)

- **Topic ID:** `cad and 3d modeling`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `cad`, `solidworks`, `catia`, `creo`, `fusion 360`, `inventor`, `parametric`, `3d modeling`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "cad and 3d modeling" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. cad, solidworks, catia, creo, fusion 360). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "cad and 3d modeling", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `cad-1` | `2` | `technical` | Walk me through how you create a parametric model. Why parametric rather than direct? | **Signals:**<br/>• design intent capture<br/>• feature tree reasoning<br/>• revision flexibility<br/><br/>**Concept IDs:**<br/>`cad-and-3d-modeling.t1.design-intent-capture`<br/>`cad-and-3d-modeling.t1.feature-tree-reasoning`<br/>`cad-and-3d-modeling.t1.revision-flexibility` |
| **Tier 2 (Intermediate)** | `cad-2` | `3` | `technical` | An assembly of 500+ parts is slow to load and crashes often. How do you manage it? | **Signals:**<br/>• simplified representations<br/>• level of detail management<br/>• assembly strategy<br/><br/>**Concept IDs:**<br/>`cad-and-3d-modeling.t2.simplified-representations`<br/>`cad-and-3d-modeling.t2.level-of-detail-management`<br/>`cad-and-3d-modeling.t2.assembly-strategy` |
| **Tier 3 (Advanced)** | `cad-3` | `4` | `technical` | How do you ensure that your CAD model is manufacture-ready? What checks do you perform? | **Signals:**<br/>• DFM analysis<br/>• draft angles and undercuts<br/>• tolerance stack-up review<br/><br/>**Concept IDs:**<br/>`cad-and-3d-modeling.t3.dfm-analysis`<br/>`cad-and-3d-modeling.t3.draft-angles-and-undercuts`<br/>`cad-and-3d-modeling.t3.tolerance-stack-up-review` |

#### Topic: `Manufacturing Processes` (Technical)

- **Topic ID:** `manufacturing processes`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `machining`, `cnc`, `milling`, `turning`, `drilling`, `casting`, `forging`, `injection molding`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "manufacturing processes" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. machining, cnc, milling, turning, drilling). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "manufacturing processes", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `mfg-1` | `2` | `technical` | Compare CNC machining and 3D printing for producing a small batch of metal parts. | **Signals:**<br/>• volume economics<br/>• geometry complexity<br/>• material properties<br/><br/>**Concept IDs:**<br/>`manufacturing-processes.t1.volume-economics`<br/>`manufacturing-processes.t1.geometry-complexity`<br/>`manufacturing-processes.t1.material-properties` |
| **Tier 2 (Intermediate)** | `mfg-2` | `3` | `technical` | A CNC-machined part consistently fails dimensional inspection. How do you find the root cause? | **Signals:**<br/>• tool wear analysis<br/>• fixturing review<br/>• thermal expansion effects<br/><br/>**Concept IDs:**<br/>`manufacturing-processes.t2.tool-wear-analysis`<br/>`manufacturing-processes.t2.fixturing-review`<br/>`manufacturing-processes.t2.thermal-expansion-effects` |
| **Tier 3 (Advanced)** | `mfg-3` | `4` | `technical` | How would you transition a prototype from 3D-printed to injection-molded production at 100k units/year? | **Signals:**<br/>• design for injection molding<br/>• tooling cost amortisation<br/>• material substitution<br/><br/>**Concept IDs:**<br/>`manufacturing-processes.t3.design-for-injection-molding`<br/>`manufacturing-processes.t3.tooling-cost-amortisation`<br/>`manufacturing-processes.t3.material-substitution` |

#### Topic: `Finite Element Analysis` (Technical)

- **Topic ID:** `finite element analysis`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `fea`, `fem`, `finite element`, `ansys`, `abaqus`, `mesh`, `convergence`, `boundary condition`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "finite element analysis" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. fea, fem, finite element, ansys, abaqus). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "finite element analysis", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `fea-1` | `2` | `technical` | You need to run an FEA on a bracket. Walk me through your setup from geometry to results. | **Signals:**<br/>• mesh quality considerations<br/>• boundary condition application<br/>• results validation<br/><br/>**Concept IDs:**<br/>`finite-element-analysis.t1.mesh-quality-considerations`<br/>`finite-element-analysis.t1.boundary-condition-application`<br/>`finite-element-analysis.t1.results-validation` |
| **Tier 2 (Intermediate)** | `fea-2` | `3` | `technical` | Your FEA shows stress singularities at sharp corners. Are they real? How do you handle them? | **Signals:**<br/>• mesh convergence study<br/>• stress linearisation<br/>• engineering judgement<br/><br/>**Concept IDs:**<br/>`finite-element-analysis.t2.mesh-convergence-study`<br/>`finite-element-analysis.t2.stress-linearisation`<br/>`finite-element-analysis.t2.engineering-judgement` |
| **Tier 3 (Advanced)** | `fea-3` | `4` | `technical` | How would you set up a nonlinear contact analysis for a bolted joint under dynamic loading? | **Signals:**<br/>• contact formulation choice<br/>• preload modeling<br/>• convergence strategy<br/><br/>**Concept IDs:**<br/>`finite-element-analysis.t3.contact-formulation-choice`<br/>`finite-element-analysis.t3.preload-modeling`<br/>`finite-element-analysis.t3.convergence-strategy` |

#### Topic: `Materials Science` (Technical)

- **Topic ID:** `materials science`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `material selection`, `steel`, `aluminum`, `composite`, `polymer`, `ceramic`, `alloy`, `heat treatment`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "materials science" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. material selection, steel, aluminum, composite, polymer). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "materials science", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `mat-1` | `2` | `technical` | How do you select a material for a new part? What properties do you prioritise? | **Signals:**<br/>• load/environment requirements<br/>• cost and availability<br/>• Ashby chart or equivalent<br/><br/>**Concept IDs:**<br/>`materials-science.t1.load-environment-requirements`<br/>`materials-science.t1.cost-and-availability`<br/>`materials-science.t1.ashby-chart-or-equivalent` |
| **Tier 2 (Intermediate)** | `mat-2` | `3` | `technical` | A steel part is corroding in service. How do you determine the mechanism and choose a fix? | **Signals:**<br/>• corrosion type identification<br/>• environment analysis<br/>• protection strategy<br/><br/>**Concept IDs:**<br/>`materials-science.t2.corrosion-type-identification`<br/>`materials-science.t2.environment-analysis`<br/>`materials-science.t2.protection-strategy` |
| **Tier 3 (Advanced)** | `mat-3` | `4` | `technical` | How would you design a composite layup for a structural panel that must resist bending and impact? | **Signals:**<br/>• fiber orientation strategy<br/>• interlaminar shear consideration<br/>• testing protocol<br/><br/>**Concept IDs:**<br/>`materials-science.t3.fiber-orientation-strategy`<br/>`materials-science.t3.interlaminar-shear-consideration`<br/>`materials-science.t3.testing-protocol` |

#### Topic: `Vibrations And Dynamics` (Technical)

- **Topic ID:** `vibrations and dynamics`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `vibration`, `natural frequency`, `resonance`, `damping`, `modal analysis`, `harmonic`, `forced vibration`, `free vibration`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "vibrations and dynamics" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. vibration, natural frequency, resonance, damping, modal analysis). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "vibrations and dynamics", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `vib-1` | `2` | `technical` | What is resonance, and how have you dealt with it in a real project? | **Signals:**<br/>• natural frequency matching<br/>• consequences of resonance<br/>• practical mitigation<br/><br/>**Concept IDs:**<br/>`vibrations-and-dynamics.t1.natural-frequency-matching`<br/>`vibrations-and-dynamics.t1.consequences-of-resonance`<br/>`vibrations-and-dynamics.t1.practical-mitigation` |
| **Tier 2 (Intermediate)** | `vib-2` | `3` | `technical` | A rotating machine has unacceptable vibration levels. How do you diagnose the source? | **Signals:**<br/>• frequency spectrum analysis<br/>• 1x vs 2x signatures<br/>• phase measurement<br/><br/>**Concept IDs:**<br/>`vibrations-and-dynamics.t2.frequency-spectrum-analysis`<br/>`vibrations-and-dynamics.t2.1x-vs-2x-signatures`<br/>`vibrations-and-dynamics.t2.phase-measurement` |
| **Tier 3 (Advanced)** | `vib-3` | `4` | `technical` | How would you design a vibration isolation system for sensitive equipment on a factory floor? | **Signals:**<br/>• transmissibility analysis<br/>• isolator selection<br/>• source characterisation<br/><br/>**Concept IDs:**<br/>`vibrations-and-dynamics.t3.transmissibility-analysis`<br/>`vibrations-and-dynamics.t3.isolator-selection`<br/>`vibrations-and-dynamics.t3.source-characterisation` |

#### Topic: `Control Systems` (Technical)

- **Topic ID:** `control systems`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `pid`, `control system`, `feedback control`, `transfer function`, `bode plot`, `root locus`, `stability`, `controller`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "control systems" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. pid, control system, feedback control, transfer function, bode plot). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "control systems", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `ctrl-1` | `2` | `technical` | Explain how a PID controller works. How do you tune one in practice? | **Signals:**<br/>• proportional/integral/derivative roles<br/>• tuning method<br/>• stability awareness<br/><br/>**Concept IDs:**<br/>`control-systems.t1.proportional-integral-derivative-roles`<br/>`control-systems.t1.tuning-method`<br/>`control-systems.t1.stability-awareness` |
| **Tier 2 (Intermediate)** | `ctrl-2` | `3` | `technical` | A control loop is oscillating. How do you determine whether it's the gains, the sensor, or the plant? | **Signals:**<br/>• systematic isolation<br/>• frequency response analysis<br/>• sensor noise assessment<br/><br/>**Concept IDs:**<br/>`control-systems.t2.systematic-isolation`<br/>`control-systems.t2.frequency-response-analysis`<br/>`control-systems.t2.sensor-noise-assessment` |
| **Tier 3 (Advanced)** | `ctrl-3` | `4` | `technical` | How would you design a multi-axis motion controller for a CNC machine with sub-micron accuracy? | **Signals:**<br/>• feedforward compensation<br/>• servo bandwidth requirements<br/>• disturbance rejection<br/><br/>**Concept IDs:**<br/>`control-systems.t3.feedforward-compensation`<br/>`control-systems.t3.servo-bandwidth-requirements`<br/>`control-systems.t3.disturbance-rejection` |

#### Topic: `Hvac And Thermal Systems` (Technical)

- **Topic ID:** `hvac and thermal systems`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `hvac`, `refrigeration`, `compressor`, `condenser`, `evaporator`, `air handling`, `duct`, `thermal management`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "hvac and thermal systems" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. hvac, refrigeration, compressor, condenser, evaporator). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "hvac and thermal systems", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `hvac-1` | `2` | `technical` | Walk me through a basic refrigeration cycle. Where does energy enter and leave? | **Signals:**<br/>• four main components<br/>• phase change process<br/>• energy balance<br/><br/>**Concept IDs:**<br/>`hvac-and-thermal-systems.t1.four-main-components`<br/>`hvac-and-thermal-systems.t1.phase-change-process`<br/>`hvac-and-thermal-systems.t1.energy-balance` |
| **Tier 2 (Intermediate)** | `hvac-2` | `3` | `technical` | A building zone can't maintain temperature setpoint. What do you check? | **Signals:**<br/>• load calculation review<br/>• airflow measurement<br/>• equipment capacity match<br/><br/>**Concept IDs:**<br/>`hvac-and-thermal-systems.t2.load-calculation-review`<br/>`hvac-and-thermal-systems.t2.airflow-measurement`<br/>`hvac-and-thermal-systems.t2.equipment-capacity-match` |
| **Tier 3 (Advanced)** | `hvac-3` | `4` | `technical` | How would you design the thermal management system for a data centre with 10MW of IT load? | **Signals:**<br/>• PUE optimisation<br/>• free cooling strategy<br/>• redundancy architecture<br/><br/>**Concept IDs:**<br/>`hvac-and-thermal-systems.t3.pue-optimisation`<br/>`hvac-and-thermal-systems.t3.free-cooling-strategy`<br/>`hvac-and-thermal-systems.t3.redundancy-architecture` |

#### Topic: `Robotics And Mechatronics` (Technical)

- **Topic ID:** `robotics and mechatronics`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `robot`, `robotic`, `kinematics`, `dynamics`, `end effector`, `manipulator`, `inverse kinematics`, `trajectory planning`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "robotics and mechatronics" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. robot, robotic, kinematics, dynamics, end effector). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "robotics and mechatronics", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `robo-1` | `2` | `technical` | Describe a robot or automated system you've worked on. What were the key subsystems? | **Signals:**<br/>• mechanical/electrical/software breakdown<br/>• sensor selection<br/>• actuator choices<br/><br/>**Concept IDs:**<br/>`robotics-and-mechatronics.t1.mechanical-electrical-software-breakdown`<br/>`robotics-and-mechatronics.t1.sensor-selection`<br/>`robotics-and-mechatronics.t1.actuator-choices` |
| **Tier 2 (Intermediate)** | `robo-2` | `3` | `technical` | Your robot arm overshoots its target position. How do you improve its accuracy? | **Signals:**<br/>• controller tuning<br/>• mechanical compliance<br/>• encoder resolution<br/><br/>**Concept IDs:**<br/>`robotics-and-mechatronics.t2.controller-tuning`<br/>`robotics-and-mechatronics.t2.mechanical-compliance`<br/>`robotics-and-mechatronics.t2.encoder-resolution` |
| **Tier 3 (Advanced)** | `robo-3` | `4` | `technical` | How would you plan collision-free paths for a 6-DOF manipulator in a cluttered workspace? | **Signals:**<br/>• configuration space planning<br/>• real-time replanning<br/>• safety constraints<br/><br/>**Concept IDs:**<br/>`robotics-and-mechatronics.t3.configuration-space-planning`<br/>`robotics-and-mechatronics.t3.real-time-replanning`<br/>`robotics-and-mechatronics.t3.safety-constraints` |

#### Topic: `Quality And Metrology` (Technical)

- **Topic ID:** `quality and metrology`
- **Category:** `Technical`
- **Vocabulary Match Terms:** `quality control`, `metrology`, `inspection`, `cmm`, `tolerance stack`, `statistical process control`, `spc`, `six sigma`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "quality and metrology" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. quality control, metrology, inspection, cmm, tolerance stack). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "quality and metrology", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `qm-1` | `2` | `technical` | How do you verify that a machined part meets its dimensional tolerances? | **Signals:**<br/>• measurement instrument selection<br/>• datum reference<br/>• go/no-go criteria<br/><br/>**Concept IDs:**<br/>`quality-and-metrology.t1.measurement-instrument-selection`<br/>`quality-and-metrology.t1.datum-reference`<br/>`quality-and-metrology.t1.go-no-go-criteria` |
| **Tier 2 (Intermediate)** | `qm-2` | `3` | `technical` | Your production line's Cpk has dropped below target. How do you investigate? | **Signals:**<br/>• process variation sources<br/>• measurement system analysis<br/>• corrective action plan<br/><br/>**Concept IDs:**<br/>`quality-and-metrology.t2.process-variation-sources`<br/>`quality-and-metrology.t2.measurement-system-analysis`<br/>`quality-and-metrology.t2.corrective-action-plan` |
| **Tier 3 (Advanced)** | `qm-3` | `4` | `technical` | How would you set up a tolerance stack-up analysis for a multi-part assembly? | **Signals:**<br/>• worst-case vs statistical approach<br/>• contributor identification<br/>• sensitivity analysis<br/><br/>**Concept IDs:**<br/>`quality-and-metrology.t3.worst-case-vs-statistical-approach`<br/>`quality-and-metrology.t3.contributor-identification`<br/>`quality-and-metrology.t3.sensitivity-analysis` |

### Domain: Behavioral & Leadership (5 Topics, 15 Questions)

#### Topic: `Product Sense` (Behavioral)

- **Topic ID:** `product sense`
- **Category:** `Behavioral`
- **Vocabulary Match Terms:** `product`, `roadmap`, `user research`, `stakeholder`, `requirements`, `prioritization`, `customer`, `user feedback`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "product sense" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. product, roadmap, user research, stakeholder, requirements). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "product sense", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `prod-1` | `2` | `behavioral` | Tell me about a time you pushed back on a requirement. What did you propose instead? | **Signals:**<br/>• understood the underlying need<br/>• concrete alternative<br/>• outcome<br/><br/>**Concept IDs:**<br/>`product-sense.t1.understood-the-underlying-need`<br/>`product-sense.t1.concrete-alternative`<br/>`product-sense.t1.outcome` |
| **Tier 2 (Intermediate)** | `prod-2` | `3` | `behavioral` | You have three weeks and a feature that needs six. How do you decide what ships? | **Signals:**<br/>• cuts scope not quality<br/>• user-value reasoning<br/>• communicates the tradeoff<br/><br/>**Concept IDs:**<br/>`product-sense.t2.cuts-scope-not-quality`<br/>`product-sense.t2.user-value-reasoning`<br/>`product-sense.t2.communicates-the-tradeoff` |
| **Tier 3 (Advanced)** | `prod-3` | `4` | `behavioral` | Describe something you built that didn't get used. What did you learn, and what would you check earlier next time? | **Signals:**<br/>• honest post-hoc analysis<br/>• validation step they skipped<br/>• changed behaviour<br/><br/>**Concept IDs:**<br/>`product-sense.t3.honest-post-hoc-analysis`<br/>`product-sense.t3.validation-step-they-skipped`<br/>`product-sense.t3.changed-behaviour` |

#### Topic: `Behavioral: Leadership` (Behavioral)

- **Topic ID:** `behavioral: leadership`
- **Category:** `Behavioral`
- **Vocabulary Match Terms:** `led`, `leading`, `lead`, `mentor`, `mentored`, `mentoring`, `managed`, `manager`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "behavioral: leadership" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. led, leading, lead, mentor, mentored). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "behavioral: leadership", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `lead-1` | `2` | `behavioral` | Tell me about a time you helped someone on your team get better at something. What did you actually do? | **Signals:**<br/>• specific person and skill<br/>• their own actions<br/>• observable change<br/><br/>**Concept IDs:**<br/>`behavioral-leadership.t1.specific-person-and-skill`<br/>`behavioral-leadership.t1.their-own-actions`<br/>`behavioral-leadership.t1.observable-change` |
| **Tier 2 (Intermediate)** | `lead-2` | `3` | `behavioral` | Describe a technical decision you owned that other people disagreed with. How did you handle the disagreement? | **Signals:**<br/>• took the disagreement seriously<br/>• decision process<br/>• outcome and follow-through<br/><br/>**Concept IDs:**<br/>`behavioral-leadership.t2.took-the-disagreement-seriously`<br/>`behavioral-leadership.t2.decision-process`<br/>`behavioral-leadership.t2.outcome-and-follow-through` |
| **Tier 3 (Advanced)** | `lead-3` | `4` | `behavioral` | Tell me about a time you had to deliver something through people you didn't manage. How did you get it done? | **Signals:**<br/>• influence without authority<br/>• specific obstacles<br/>• result<br/><br/>**Concept IDs:**<br/>`behavioral-leadership.t3.influence-without-authority`<br/>`behavioral-leadership.t3.specific-obstacles`<br/>`behavioral-leadership.t3.result` |

#### Topic: `Behavioral: Collaboration` (Behavioral)

- **Topic ID:** `behavioral: collaboration`
- **Category:** `Behavioral`
- **Vocabulary Match Terms:** `collaborated`, `cross-functional`, `partnered`, `pairing`, `code review`, `design review`, `worked with`, `stakeholders`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "behavioral: collaboration" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. collaborated, cross-functional, partnered, pairing, code review). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "behavioral: collaboration", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `collab-1` | `2` | `behavioral` | Tell me about a time you worked closely with someone outside engineering. What made it work, or not? | **Signals:**<br/>• concrete collaboration<br/>• communication adaptation<br/>• outcome<br/><br/>**Concept IDs:**<br/>`behavioral-collaboration.t1.concrete-collaboration`<br/>`behavioral-collaboration.t1.communication-adaptation`<br/>`behavioral-collaboration.t1.outcome` |
| **Tier 2 (Intermediate)** | `collab-2` | `3` | `behavioral` | Describe a code review where you and the reviewer disagreed. How did it end? | **Signals:**<br/>• specific technical disagreement<br/>• how it resolved<br/>• what they took from it<br/><br/>**Concept IDs:**<br/>`behavioral-collaboration.t2.specific-technical-disagreement`<br/>`behavioral-collaboration.t2.how-it-resolved`<br/>`behavioral-collaboration.t2.what-they-took-from-it` |
| **Tier 3 (Advanced)** | `collab-3` | `4` | `behavioral` | Tell me about a time a project was blocked by another team. What did you do about it? | **Signals:**<br/>• escalation judgement<br/>• own actions vs waiting<br/>• result<br/><br/>**Concept IDs:**<br/>`behavioral-collaboration.t3.escalation-judgement`<br/>`behavioral-collaboration.t3.own-actions-vs-waiting`<br/>`behavioral-collaboration.t3.result` |

#### Topic: `Behavioral: Ownership` (Behavioral)

- **Topic ID:** `behavioral: ownership`
- **Category:** `Behavioral`
- **Vocabulary Match Terms:** `owned`, `ownership`, `drove`, `delivered`, `shipped`, `launched`, `end-to-end`, `initiated`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "behavioral: ownership" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. owned, ownership, drove, delivered, shipped). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "behavioral: ownership", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `own-1` | `2` | `behavioral` | Tell me about something you shipped end to end. What were you responsible for? | **Signals:**<br/>• clear scope of their contribution<br/>• decisions they made<br/>• delivered outcome<br/><br/>**Concept IDs:**<br/>`behavioral-ownership.t1.clear-scope-of-their-contribution`<br/>`behavioral-ownership.t1.decisions-they-made`<br/>`behavioral-ownership.t1.delivered-outcome` |
| **Tier 2 (Intermediate)** | `own-2` | `3` | `behavioral` | Describe a problem nobody asked you to fix that you fixed anyway. Why that one? | **Signals:**<br/>• judgement about what mattered<br/>• action taken<br/>• impact<br/><br/>**Concept IDs:**<br/>`behavioral-ownership.t2.judgement-about-what-mattered`<br/>`behavioral-ownership.t2.action-taken`<br/>`behavioral-ownership.t2.impact` |
| **Tier 3 (Advanced)** | `own-3` | `4` | `behavioral` | Tell me about a commitment you made that you couldn't keep. What did you do? | **Signals:**<br/>• early communication<br/>• concrete recovery<br/>• no blame-shifting<br/><br/>**Concept IDs:**<br/>`behavioral-ownership.t3.early-communication`<br/>`behavioral-ownership.t3.concrete-recovery`<br/>`behavioral-ownership.t3.no-blame-shifting` |

#### Topic: `Behavioral: Handling Failure` (Behavioral)

- **Topic ID:** `behavioral: handling failure`
- **Category:** `Behavioral`
- **Vocabulary Match Terms:** `outage`, `incident`, `rollback`, `regression`, `postmortem`, `root cause`, `bug`, `recovered`
- **Resume Framing Rule:** Prefer the candidate profile's topic_relevance evidence line for "behavioral: handling failure" with the highest relevance_score. If none exists, fall back to the most recent experience entry whose title or company text matches one of this topic's terms (e.g. outage, incident, rollback, regression, postmortem). If nothing matches, frame the question generically against the role rather than inventing an anchor.
- **JD Framing Rule:** Use the session's jd_fit.topic_relevance entry for "behavioral: handling failure", if the job description produced one — its evidence line is the requirement this question should anchor to. If the JD is silent on this topic, that silence is not a gap to invent: fall back to the role's own default framing rather than fabricating a requirement the job description never stated.

| Tier | ID | Diff | Type | Baseline Question Skeleton | Expected Signals & Concept IDs |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **Tier 1 (Baseline)** | `fail-1` | `2` | `behavioral` | Tell me about a bug you shipped. How did you find out, and what happened next? | **Signals:**<br/>• owns the mistake<br/>• detection path<br/>• fix and follow-up<br/><br/>**Concept IDs:**<br/>`behavioral-handling-failure.t1.owns-the-mistake`<br/>`behavioral-handling-failure.t1.detection-path`<br/>`behavioral-handling-failure.t1.fix-and-follow-up` |
| **Tier 2 (Intermediate)** | `fail-2` | `3` | `behavioral` | Walk me through an incident you were part of, from the first alert to the follow-up actions. | **Signals:**<br/>• timeline<br/>• their specific role<br/>• durable follow-up, not just a hotfix<br/><br/>**Concept IDs:**<br/>`behavioral-handling-failure.t2.timeline`<br/>`behavioral-handling-failure.t2.their-specific-role`<br/>`behavioral-handling-failure.t2.durable-follow-up-not-just-a-hotfix` |
| **Tier 3 (Advanced)** | `fail-3` | `4` | `behavioral` | Describe a failure whose root cause turned out to be a decision you'd made months earlier. How did you handle that? | **Signals:**<br/>• traces cause honestly<br/>• systemic rather than personal framing<br/>• what changed after<br/><br/>**Concept IDs:**<br/>`behavioral-handling-failure.t3.traces-cause-honestly`<br/>`behavioral-handling-failure.t3.systemic-rather-than-personal-framing`<br/>`behavioral-handling-failure.t3.what-changed-after` |

---

## 4. Role Profiles & Curriculum Topic Blueprints

The platform defines 24 standard role profiles that dictate domain calibration, required topics, and question quotas:

| Role Title | ID | Match Keywords | Required Technical Topics | Universal Behavioral Topics | Coding Round | Budget |
| :--- | :--- | :--- | :--- | :--- | :---: | :---: |
| **Backend Engineer** | `backend-engineer` | `backend`, `back-end`, `server-side`, `platform engineer` | `system design`, `databases`, `apis and services`, `reliability and operations` | `behavioral: ownership`, `behavioral: collaboration` | Yes | 8 |
| **Frontend Engineer** | `frontend-engineer` | `frontend`, `front-end`, `web engineer`, `ui engineer` | `frontend engineering`, `apis and services`, `testing and quality` | `behavioral: ownership`, `behavioral: collaboration` | Yes | 8 |
| **Full-Stack Engineer** | `fullstack-engineer` | `full stack`, `full-stack`, `fullstack` | `frontend engineering`, `apis and services`, `databases`, `system design` | `behavioral: ownership`, `behavioral: collaboration` | Yes | 8 |
| **Data Engineer** | `data-engineer` | `data engineer`, `analytics engineer` | `data engineering`, `databases`, `cloud and infrastructure` | `behavioral: ownership`, `behavioral: collaboration` | Yes | 8 |
| **Machine Learning Engineer** | `ml-engineer` | `machine learning`, `ml engineer`, `ai engineer`, `research engineer` | `machine learning`, `data engineering`, `system design` | `behavioral: ownership`, `behavioral: collaboration` | Yes | 8 |
| **Site Reliability Engineer** | `sre` | `sre`, `site reliability`, `devops`, `infrastructure engineer` | `reliability and operations`, `cloud and infrastructure`, `system design` | `behavioral: ownership`, `behavioral: collaboration` | Yes | 8 |
| **Mobile Engineer** | `mobile-engineer` | `mobile`, `ios engineer`, `android engineer` | `mobile engineering`, `apis and services`, `testing and quality` | `behavioral: ownership`, `behavioral: collaboration` | Yes | 8 |
| **Engineering Manager** | `engineering-manager` | `engineering manager`, `em `, `director of engineering`, `head of engineering` | `behavioral: leadership`, `system design`, `product sense` | `behavioral: ownership`, `behavioral: collaboration` | No | 8 |
| **Product Manager** | `product-manager` | `product manager`, `product owner`, `pm ` | `product sense`, `behavioral: leadership` | `behavioral: ownership`, `behavioral: collaboration` | No | 8 |
| **Hardware Engineer** | `hardware-engineer` | `hardware engineer`, `hw engineer`, `chip designer`, `asic engineer` | `digital logic design`, `computer architecture`, `hardware verification and testing`, `signal integrity and timing` | `behavioral: ownership`, `behavioral: collaboration` | No | 8 |
| **Embedded Systems Engineer** | `embedded-engineer` | `embedded`, `firmware engineer`, `firmware developer`, `embedded software` | `embedded systems`, `hardware-software interface`, `digital logic design` | `behavioral: ownership`, `behavioral: collaboration` | Yes | 8 |
| **FPGA Engineer** | `fpga-engineer` | `fpga`, `fpga engineer`, `fpga developer` | `digital logic design`, `hardware verification and testing`, `signal integrity and timing` | `behavioral: ownership`, `behavioral: collaboration` | No | 8 |
| **Verification Engineer** | `verification-engineer` | `verification engineer`, `dv engineer`, `design verification` | `hardware verification and testing`, `digital logic design`, `soc design` | `behavioral: ownership`, `behavioral: collaboration` | No | 8 |
| **Mechanical Engineer** | `mechanical-engineer` | `mechanical engineer`, `mech engineer`, `mechanical design` | `mechanics of materials`, `machine design`, `cad and 3d modeling`, `manufacturing processes` | `behavioral: ownership`, `behavioral: collaboration` | No | 8 |
| **Thermal Engineer** | `thermal-engineer` | `thermal engineer`, `heat transfer engineer`, `hvac engineer` | `thermodynamics`, `hvac and thermal systems`, `fluid mechanics` | `behavioral: ownership`, `behavioral: collaboration` | No | 8 |
| **Manufacturing Engineer** | `manufacturing-engineer` | `manufacturing engineer`, `process engineer`, `production engineer` | `manufacturing processes`, `quality and metrology`, `materials science` | `behavioral: ownership`, `behavioral: collaboration` | No | 8 |
| **Robotics Engineer** | `robotics-engineer` | `robotics engineer`, `automation engineer`, `mechatronics engineer` | `robotics and mechatronics`, `control systems`, `embedded systems` | `behavioral: ownership`, `behavioral: collaboration` | Yes | 8 |
| **CAE / Simulation Analyst** | `cae-analyst` | `cae`, `simulation engineer`, `fea analyst`, `stress analyst` | `finite element analysis`, `mechanics of materials`, `vibrations and dynamics` | `behavioral: ownership`, `behavioral: collaboration` | No | 8 |
| **Electrical Engineer** | `electrical-engineer` | `electrical engineer`, `ee `, `power engineer` | `circuit analysis`, `power systems`, `electrical safety and standards` | `behavioral: ownership`, `behavioral: collaboration` | No | 8 |
| **Analog Design Engineer** | `analog-design-engineer` | `analog engineer`, `analog design`, `mixed-signal` | `analog electronics`, `circuit analysis`, `signal processing` | `behavioral: ownership`, `behavioral: collaboration` | No | 8 |
| **Power Electronics Engineer** | `power-electronics-engineer` | `power electronics`, `power supply engineer`, `converter design` | `power electronics`, `circuit analysis`, `electric machines and drives` | `behavioral: ownership`, `behavioral: collaboration` | No | 8 |
| **RF / Communications Engineer** | `rf-engineer` | `rf engineer`, `radio frequency`, `antenna engineer`, `wireless engineer` | `electromagnetic theory`, `communication systems`, `signal processing` | `behavioral: ownership`, `behavioral: collaboration` | No | 8 |
| **Controls / Automation Engineer** | `controls-engineer` | `controls engineer`, `plc programmer`, `automation engineer`, `control systems` | `plc and industrial automation`, `control systems`, `instrumentation and measurement` | `behavioral: ownership`, `behavioral: collaboration` | No | 8 |
| **Renewable Energy Engineer** | `renewable-energy-engineer` | `renewable energy`, `solar engineer`, `wind engineer`, `energy engineer` | `renewable energy systems`, `power systems`, `power electronics` | `behavioral: ownership`, `behavioral: collaboration` | No | 8 |
