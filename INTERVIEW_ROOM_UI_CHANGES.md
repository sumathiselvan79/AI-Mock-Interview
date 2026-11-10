# Interview room UI changes

Three changes to the interview room (`apps/web/app/interview/[id]/room/`),
grounded in the actual layout code so they're ready to implement directly.

## Status — all three built

Shipped. Each section below ends with a **Built** line naming where it landed
and what differs from the design above. Presentation-layer only: no API
contract, no `lib/api.ts` signature, no route, and no gateway or agent
behaviour changed, so `CLAUDE.md §15`'s framing for Stage 8 still holds.

The one decision the note asked for (§1, A or B) was taken as **B**, the option
the note itself recommends — see that section.

Verified: `npx tsc --noEmit` clean, `npm run build:web` clean, frontend suite
21/21 (10 of them new, pinning §2). §1 and §3's layout opt-in were checked
against the running app's server-rendered HTML on every route; §3's geometry was
computed from the classes actually emitted into the production CSS bundle rather
than eyeballed. What none of that covers is how it *looks* — see "Still to check
by eye" at the bottom.

## 1. Remove the header (brand + disclaimer + Log out + theme toggle) from the room

**Where it comes from.** The bar in the screenshot isn't part of the room
page — it's `SiteHeader` (`apps/web/app/components/site-header.tsx`),
mounted once, globally, in `apps/web/app/layout.tsx`, above `<main>`. Every
page in the app gets it, including the room.

**One thing to flag before touching this.** `site-header.tsx` carries a
comment that the "Practice, not a hiring decision" text is not decoration:

> soul.md §3 requires that the system never implies it is a human recruiter
> or a real hiring decision, and says so where a candidate will see it.

Removing the whole header from the room removes that line from the one
screen where the candidate is actively talking to "the interviewer" — the
moment it matters most. Two ways to do this, pick one:

- **A — remove it outright, as asked.** Hide the whole pill (brand link,
  disclaimer, Log out, theme toggle) only on the room route. Simplest, and
  matches "remove the header containing the logout bar" literally.
- **B — recommended.** Hide the same nav chrome (brand link, Log out, theme
  toggle) on the room route, but keep the disclaimer text alive by folding
  it into the room's own status strip (`StatusBar`, already on screen —
  the "Writing down what you said" bar), so the safety line the code
  comment protects doesn't just disappear along with the logout button.

Either way, the mechanism is the same:

```tsx
// site-header.tsx
import { usePathname } from "next/navigation";

export function SiteHeader() {
  const pathname = usePathname();
  if (/^\/interview\/[^/]+\/room$/.test(pathname ?? "")) return null;
  // ...unchanged
}
```

This only touches the room route (`/interview/[id]/room`) — the config,
telemetry-check, and report pages for the same session keep the header, so
"Log out" is still reachable everywhere except the live interview screen
itself.

**Decision needed before implementing:** A or B. B is a few extra lines
(threading one string into `StatusBar`'s props); A is a one-line early
return. Say which and it's a quick change either way.

**Built — option B.** `SiteHeader` returns `null` on `/interview/:id/room`
(matched with `usePathname`, since the bar is mounted in the root layout above
`<main>` and has no other way to know what is under it), and the room's own
`StatusBar` renders the disclaimer.

Three things the design above left open:

- **The string is exported, not retyped.** `SAFETY_DISCLAIMER` now lives in
  `site-header.tsx` and the room imports it. Two copies of a sentence `soul.md`
  mandates become two different sentences the first time one is edited, and the
  copy that drifts would be the one on the screen where the candidate is
  actively talking to "the interviewer".
- **It is not in the status strip's live region.** The left-hand side of
  `StatusBar` is `role="status" aria-live="polite"` and changes every phase; the
  disclaimer never changes, so announcing it on every transition would be noise.
  It sits on the right as plain standing text, and is hidden below `sm` only
  because that strip is already three-deep on a phone — the candidate passed
  through the telemetry-check page, which still carries the full bar, to get
  here.
- **`StatusBar` moved from `top-[4.5rem]` to `top-3`.** That offset existed
  solely to clear the sticky header pill. Left alone it would have held 4.5rem
  of dead space above a bar that now has nothing to clear.

## 2. Stop showing the previous answer's transcription once the next question starts

**Where it lives.** `page.tsx` keeps one flat, ordered array of the whole
conversation — `turns: Turn[]` (~line 149, state at ~line 236) — interviewer
and candidate turns interleaved. `TranscriptionPanel` (~line 1397) currently
does this:

```tsx
const candidateTurns = useMemo(
  () => turns.filter((t): t is Extract<Turn, { role: "candidate" }> => t.role === "candidate"),
  [turns],
);
```

That's *every* candidate turn in the session, oldest first — which is why
the previous answer is still sitting in the box when the next question
starts. It's actually the panel's documented intent today ("every answer
given so far"), so this change is a deliberate reversal of that, not a bug
fix — worth knowing in case anything downstream assumed the panel showed
history.

**The fix.** Only show candidate turns that came *after* the most recent
interviewer turn (a question, follow-up, clarification, or greeting). The
moment `pushInterviewerTurn` (~line 389) appends the next prompt, everything
before it drops out of view on its own — no extra clear/reset call needed:

```tsx
const lastInterviewerIndex = useMemo(
  () => turns.reduce((idx, t, i) => (t.role === "interviewer" ? i : idx), -1),
  [turns],
);
const candidateTurns = useMemo(
  () =>
    turns
      .slice(lastInterviewerIndex + 1)
      .filter((t): t is Extract<Turn, { role: "candidate" }> => t.role === "candidate"),
  [turns, lastInterviewerIndex],
);
```

When nothing has been said yet for the current prompt, `candidateTurns` is
empty and the existing empty state ("Your answer will appear here as you
speak or type.") shows, same as today.

**What doesn't change.** `turns` itself still holds full history — nothing
about scoring, the follow-up logic, or what's sent to the backend depends on
this panel's filter, so `attachGrade`, `settleCandidateTurn`, and the
`SpeechPanel` (interviewer side, which intentionally keeps its full history
— that's the "what did I already say about this" thread the file's header
comment describes, and is unaffected by this change) all keep working
exactly as they do now.

**Built**, as `answersForCurrentPrompt` in `apps/web/lib/room-turns.ts` rather
than inline in the component, with `tests/room-turns.test.ts` beside it.

That is the one deviation, and the reason is the failure mode: both ways of
getting this cut wrong are silent, and it is the candidate who pays. One
direction leaves the previous answer sitting in the box they type into, reading
as part of what they are about to send; the other makes the answer they are
still speaking vanish mid-sentence. Neither throws, and neither looks like a bug
in a screenshot taken at the wrong moment. Same treatment and same reasoning as
`lib/live-protocol.ts` — the piece of the page that is a rule rather than
presentation gets to be a pure function with a test.

Two cases the tests pin that the sketch above does not mention: the in-flight
live preview must stay visible (scoping it away would make dictation look
broken), and more than one candidate turn can belong to a single prompt (a
retry), so the filter keeps all of them rather than just the last.

## 3. Widen both boxes, keep a real gap between them, keep the ball visible

**The actual cause of the overlap.** It isn't the panels' own width — it's
the column they sit in. The room page's return (~line 959) is a plain
`<div className="relative space-y-5">`. It never opts into the wide layout
(`<WidePage>` / `data-layout="wide"`, `components/shell.tsx`), so it
inherits `.mia-main`'s default cap:

```css
/* globals.css */
.mia-main { @apply mx-auto w-full max-w-[46rem] px-6 pt-8 pb-16; }
.mia-main:has([data-layout="wide"]) { @apply max-w-[80rem]; }
```

46rem (736px) is the *reading-column* width — meant for prose pages, not a
two-panel stage. Both panels are `lg:w-[38%]` of that same box, pinned to
`left-0` / `right-0` (~line 998, ~1002):

```tsx
<div className="lg:absolute lg:left-0 lg:top-1/2 lg:z-0 lg:w-[38%] lg:-translate-y-1/2">   {/* Speech */}
<div className="lg:absolute lg:right-0 lg:top-1/2 lg:z-10 lg:w-[38%] lg:-translate-y-1/2"> {/* Transcription */}
```

38% + 38% of 736px leaves only ~176px in the middle for the backdrop ring —
that's the cramped, nearly-touching look in the screenshots, not a bad
percentage choice.

**The fix, in order:**

1. **Give the room its existing wide column** — wrap the page's return in
   `<WidePage>` (or add `data-layout="wide"` directly to that top-level
   `div`), the same mechanism the admin pages already use. This alone jumps
   the stage from 736px to 1280px, tripling the gap between the panels with
   no other change.
2. **Put a floor and a ceiling on each panel's width**, so the gap stays
   healthy at both ends of a `lg`-and-up viewport instead of just "38% of
   whatever's left": keep `lg:w-[38%]` but add `lg:max-w-[26rem]` so a panel
   can't keep growing on an ultrawide monitor and start crowding the ball
   again, and inset both from the true edge with `lg:inset-x-[2%]`-style
   margins (`lg:left-[2%]` / `lg:right-[2%]`) instead of `left-0`/`right-0`,
   so there's always a minimum gap even at the narrow end of `lg` (1024px).
3. **No change needed to `CelestialBackdrop`.** It's `fixed` and sized off
   the viewport, not the `.mia-main` column (see its own file header
   comment) — it's already centered on the screen regardless of how wide
   the stage is, so widening the stage just gives it more room to be seen
   between the two panels rather than requiring it to move.

**What doesn't change.** The below-`lg` stacked fallback (`flex flex-col
gap-5`, speech first) is untouched — this only affects the side-by-side
layout at `lg` and up, which is where the overlap was actually happening.

**Built**, with one correction to step 2 that the measurements forced.

`data-layout="wide"` went on the page's top-level `div` (and on the
`phase === "done"` branch's, so the page does not reflow from 80rem to 46rem at
the moment the interview ends). `CelestialBackdrop` needed nothing, as
predicted.

The correction: **the wide column alone does not fix the narrow end of `lg`.**
Measured as the gap left for the ring, with the design's `38%` + `2%` insets:

| viewport | before | `38%` everywhere | shipped |
|---|---|---|---|
| 1024px | 165px | **195px** | **273px** |
| 1152px | 165px | 253px | 309px |
| 1280px and up | 165px | 351px | 351px |

195px at 1024px is the same cramped look one breakpoint further out — and
1024px is a width this note's own verification step calls out. The insets are
part of why: they are measured from the column edge, so `2%` on each side spends
4% of the middle, which is exactly where the ring is.

So the percentage steps: `lg:w-[34%]` up to 1280px, `xl:w-[38%]` above it, with
`lg:max-w-[26rem]` as the ceiling the note asked for. `38%` was never wrong for
a wide viewport — it was wrong for the one case where two panels and the ring
have to share 976px. Both panels still end up wider than before at every width
(261px to 332px at 1024px, to 416px above 1280px), so nothing gave up room to
buy the gap; the reading column was simply that much too narrow.

## Implementation order

1 and 2 are independent, one file each (`site-header.tsx`, and one filter
in `page.tsx`) — either can go first. 3 is also independent but touches
both the page's top-level wrapper and the two panels' width classes in the
same file as #2, so doing 2 and 3 in the same pass over `page.tsx` avoids
touching that file twice.

## How to verify

- **#1:** load `/interview/<id>/room` — header gone (or nav-only gone under
  option B, disclaimer still visible in the status strip); load any other
  page (`/`, `/interview/<id>/report`, `/admin`) — header still there,
  logout still works.
- **#2:** answer a question, confirm it's in the transcription box; let the
  next question (or a follow-up) start; confirm the box goes back to "Your
  answer will appear here…" until you start answering the new prompt.
- **#3:** at a `lg`-and-up viewport, confirm the two panels no longer touch
  or clip text at either edge, and the animated ring is clearly visible in
  the gap between them, at both ~1024px and a much wider window.

## What was actually verified, and what wasn't

Done:

- **#1** against the running app's server-rendered HTML on six routes: the room
  serves no brand link and the disclaimer exactly once (from `StatusBar`); `/`,
  `/signup`, `/admin`, and the same session's `config` and `report` pages all
  still serve the full bar.
- **#2** by `tests/room-turns.test.ts`, 10 cases.
- **#3** by reading the emitted production CSS: the `lg` utilities land in
  `@media (min-width:64rem)` and `xl:w-[38%]` in `@media (min-width:80rem)`,
  with the geometry table above computed from those exact values.

### Still to check by eye

The browser extension was not connected, so **none of this was looked at**.
Three things the checks above cannot answer:

1. Whether 332px is genuinely comfortable for the answer panel's controls at
   1024px. The arithmetic says it is wider than the 261px that shipped before,
   which is an argument that it is no worse, not that it is good.
2. Whether the disclaimer reads as a standing caveat rather than a status field
   where it now sits, beside the exit badge and the clock.
3. Whether the room's top edge looks right with `StatusBar` docked at `top-3`
   and no header above it.
