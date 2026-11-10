# Admin: User Directory, Profile Drill-down, Report Download, Interview Scheduling

The feature spec this stage was built from. Kept in the repo so the delivered
work can be read against what was asked for — see the "Reconciliation" section
at the end for every place the existing codebase required a deviation.

Build status and stage-gate tests: `TRACKING.md` Stage 7.

---

## Context — read first, in this order

1. `CLAUDE.md` — architecture (Harness Agent + specialized agents + MCP tools),
   repo layout, roles (Student/Admin), page flow.
2. `INSTRUCTIONS.md` — MCP tool schemas, `§4.8` (Report Agent output),
   `§11.4`/`§11.6` (session archive schema in the separate Supabase Postgres),
   `§3` (session state machine).
3. `soul.md` — **"No fabrication"**, **"Grounding is checked, not assumed"**, and
   the constraint that **Admins get read access only to what a candidate's
   `Report` already contains** — never raw resumes, audio, or full transcripts.
   Hard boundary for everything here.
4. `TRACKING.md` — what is actually built vs. stubbed.
5. Inspect the current code before designing: `apps/web` for admin routes and
   the UI stack, `apps/gateway` for auth/role middleware and session token
   shape, `packages/shared-types` and the migrations for existing
   `User`/`Session`/`Report` fields. **Do not invent field names or endpoints
   that might already exist under different names — grep first.**

## Goal

Three parts on top of the existing admin dashboard (`CLAUDE.md §11`):

1. **User directory** — every student account with aggregate stats.
2. **User profile drill-down** — full interview history, open/download any report.
3. **Interview scheduling** — assign a mock interview to a user or a batch.

## Part 1 — User Directory page

Columns: name, email, avatar (from `oauth_profiles` if Google, else initials),
department, total interviews completed, average overall score, last interview
date, account created date, status badge (`active` / `interview scheduled` /
`no activity`).

Controls: search by name/email; filter by department, score range, date range,
status; sort by any column; server-side pagination — aggregate stats come from a
summary query, **not** N+1 report fetches.

## Part 2 — User Profile page

Route `app/admin/users/[userId]`.

- **Header**: identity, department, join date, aggregate stats (total
  interviews, avg score, score trend sparkline, most recent interview date).
- **Interview history**: every session — date, role/JD title, duration, overall
  score, status (`completed`/`abandoned`/`in progress`). Clicking opens that
  session's report using the **existing** report view component in an
  admin-permissioned read-only mode.
- **Download report**: per-row download plus "download all".
- **Data boundary**: may show everything inside that user's `Report` objects,
  and **must not** expose raw resume text, raw audio, or unredacted transcripts.
  If the report schema carries something more sensitive than intended, flag it
  rather than quietly building UI for it.

## Part 3 — Interview Scheduling

Confirm by grep that nothing like schedule/invite/assign exists first.

| Field | Type | Notes |
|---|---|---|
| `targetUserIds` | string[] | one or many students |
| `department` | enum/string | targeting a batch, and tagging the session |
| `role` | string | feeds the Question Agent's topic plan |
| `jobDescription` | text (optional) | pre-fills JD-fit as self-serve config does |
| `interviewType` | enum | `behavioral` \| `technical` \| `behavioral+technical` \| `coding` \| `full` |
| `difficulty` | enum | `junior` \| `mid` \| `senior` \| `staff+` |
| `durationMinutes` | number | enforced by the Time Tracking Agent, not the UI |
| `scheduledFor` | datetime | when the interview window opens |
| `deadline` | datetime (optional) | after which it is `missed` |
| `recurring` | enum (optional) | `none` \| `weekly` \| `biweekly` \| `monthly` |
| `codingRoundEnabled` | boolean | gates the Coding Agent round |
| `consentDefaults` | object | **decide explicitly** — admins cannot consent on a student's behalf per `soul.md` |
| `notes` | text (optional) | internal to admins, never shown to the student |
| `notifyVia` | enum/multi | use an existing notification channel or surface a TODO |
| `status` | enum | `pending` \| `sent` \| `started` \| `completed` \| `missed` \| `cancelled` |
| `createdBy` / `createdAt` | audit trail |

### Flow

- Schedule from the directory (bulk, by rows or department) or a single profile.
- A "Scheduled Interviews" admin view with cancel/reschedule.
- When the window opens the student sees it on their home page as a
  pre-configured start, which **pre-fills** Interview Config rather than
  skipping it — resume upload and the JD-fit check still have to happen.
- Must not introduce a new agent-to-agent path: scheduling data is session-seed
  data the Harness Agent reads, nothing more.

## Design bar

Match the existing design system — no second UI kit. Dense scannable table,
sticky header, skeleton and empty states, sortable columns. Profile page should
feel like a dashboard (score trend chart). Scheduling form grouped
Who → What → When → Notify, inline validation, explicit confirmation before it
fires. Responsive to tablet width. Theme-consistent.

## Explicit boundaries / non-goals

- No bypassing consent capture, resume upload, or the JD-fit check.
- No second database duplicating `session_archives`.
- No scoring/rubric logic in admin code — the Eval Tool stays the only source.
- No second report renderer.
- New gateway/agent pieces stay stateless per `CLAUDE.md §10`.

## Deliverables

1. Data model changes for `department` on users and a `scheduled_interviews`
   table, in `packages/shared-types` and the migrations.
2. Gateway endpoints: list users + stats, user profile + history, report
   download, scheduled-interview create/list/cancel — admin-gated.
3. `apps/web` pages: directory, profile, scheduled list, scheduling form, plus
   the student home change.
4. `TRACKING.md` stage-gate tests in the existing format.
5. Unit tests for the new handlers, plus a contract test if new MCP-adjacent
   schemas appear.

---

## Reconciliation — where the delivered work deviates, and why

Everything below was found by inspecting the code (step 5) and takes precedence
over the spec above, which was written without that detail.

1. **`department` already exists on `users`.** Added by
   `apps/gateway/migrations/003_stage5_llm_and_archive.sql` and carried on
   `User`/`UserProfile`/`PublicUser` since Stage 5, where the session archive is
   keyed on it. No new column was added; the directory filters the existing one.

2. **There is no Tailwind, no shadcn/ui, and no chart library.** `apps/web`
   depends on exactly `next`, `react`, `react-dom`. The design system is
   hand-rolled CSS custom properties in `app/globals.css` (`.card`, `.row`,
   `.tag`, `.notice`, `.evidence`, `.meter`, light/dark via
   `prefers-color-scheme`). Per "don't introduce a second UI kit", the new
   pages extend that stylesheet, and the score-trend sparkline is inline SVG
   rather than a new dependency.

3. **No notification or email service exists.** The only mailer is
   `MemoryResetMailer`, explicitly dev/test-only. `notifyVia` is therefore
   recorded on the schedule as intent, and delivery is a documented TODO —
   the in-app channel (the student's home page) is the one that actually works.

4. **`consentDefaults` is deliberately not implemented.** `soul.md`
   §"Consent-first monitoring" makes consent the candidate's to give, and an
   admin pre-answering it is exactly the thing that rule forbids. The schedule
   carries what the interview *will ask for* (`codingRoundEnabled`), the invite
   says so, and the Telemetry Check page remains the sole place consent is
   captured. This is the explicit decision the spec asked for.

5. **There was no reusable report renderer** — the report lived inline in
   `app/interview/[id]/report/page.tsx`. It was extracted to
   `app/components/report-view.tsx` and both the candidate page and the admin
   drill-down now render that one component, per "don't build a second one".

6. **No PDF exporter exists.** The Report Agent emits a structured `Report`, and
   the established download precedent in this repo is
   `GET /admin/archives/:id/download`, which serves JSON with a
   `content-disposition` attachment header. Report download follows that rather
   than adding a PDF toolchain.

7. **Session duration is not yet enforced per-session.** The Time Tracking Tool
   takes a budget, but `durationMinutes` is stored on the schedule and carried
   onto the seeded session; wiring it through to override the Time Tracking
   Agent's default segment budget is called out in `TRACKING.md` as not done.
