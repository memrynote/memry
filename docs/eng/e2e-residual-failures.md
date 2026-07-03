# E2E residual failures (post onboarding-overlay fix)

_Last updated: 2026-06-30 (commit chain `9d5e0798` → `dbe7630b` → current)._

## Background

`Electron E2E full` had been red on `main` for 20+ consecutive runs. The dominant
cause was the **first-run onboarding tour** (`use-first-run-tour.ts`, driver.js):
on a fresh launch its full-screen `.driver-overlay` SVG intercepted pointer
events, so `locator.click` timed out across ~40 e2e files. The e2e helper meant
to handle this, `dismissFirstRunOnboarding`, had been stubbed to a no-op.

Fixing that (Escape-dismiss + persist the seen flag, `electron-helpers.ts`)
recovered **8 shards**: e2e-full went from 5/16 → **13/16** passing, and
`Static checks`, `Unit`, `Electron E2E smoke`, and `Packaged runtime smoke` are
all green in CI.

> ⚠️ `e2e-full` is gated `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`
> — it never runs on PRs, only post-merge. That is why these regressions landed
> silently. Consider running it (or a smoke subset) on PRs that touch the renderer/main.

This document lists the **remaining** failures (shards 1, 2, 4 — all survived
retries, so they are consistent, not flaky), their root cause, and whether each
is a test-drift, a product question, or infra-dependent.

## Status summary

| #   | Test                                                                                                                  | Root cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Class                    | Status                                          |
| --- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------- |
| 1   | `calendar-comprehensive.e2e.ts:197` creates a timed event from the toolbar plus button                                | Test filled a non-existent **`Add location`** field                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | test-drift (+ product Q) | ✅ fixed                                        |
| 2   | `agent-chat-*` (helper `openDayPanel`) + `calendar.e2e.ts:119`                                                        | `getByRole('button',{name:'Day Panel'})` matched both `Resize Day Panel` and `Day Panel` (strict-mode violation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | test-drift               | ✅ fixed (selector) — see deeper blockers below |
| 3   | `critic-markup-review.e2e.ts` (composer lookup)                                                                       | Composer is in a floating flyout (`role="dialog"`), not the rail (`complementary`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | test-drift               | ✅ fixed (selector) — see rail blocker below    |
| 4   | `critic-markup-review.e2e.ts:33,105,139,175`                                                                          | The **Day Panel now defaults open** (#625), eating ~320px, so the review rail responsive-collapses at the e2e viewport → cards land in the badge flyout, not the `complementary` "Comments" rail. Widening to keep the rail open moves the composer _into_ the rail, breaking the flyout-scoped `commentComposer` + `expectComposerNearSelectedTop`: the draft composer is a near-selection flyout **only while the rail is hidden** (`review-badge-layer.tsx`). Test needs composer-in-flyout AND rail-visible at once — a genuine tension, needs a coordinated test+layout fix. | layout redesign          | ❌ remaining (root cause pinned 2026-07-03)     |
| 5   | `agent-chat-create-task.e2e.ts:67,100`, `agent-chat-codex-create-task.e2e.ts:60`, `agent-chat-text-editing.e2e.ts:45` | Day-panel-defaults-open (#625) made `openAgentChat` _close_ the panel; agent handlers registered after `startSyncRuntime`; `getOrInitializeLocalVaultKey` hung on keytar in e2e; AgentPane blocked on `backendStatuses`.                                                                                                                                                                                                                                                                                                                                                          | infra + test             | ✅ fixed (3302a8ad) — shard 1 green on CI       |
| 6   | `calendar.e2e.ts:119` shows the same projection in the global journal day panel                                       | Same day-panel-defaults-open toggle-close; also the section heading is the date ("Today"), not "Schedule".                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | test-drift               | ✅ fixed (3302a8ad)                             |
| 7   | `auth-state-machine.e2e.ts:138,203,221` setup / recovery-phrase / re-auth                                             | Not sync — the React Doctor a11y pass (#639) replaced `role="listitem"` with semantic `<li>`; the CSS attribute selector no longer matched.                                                                                                                                                                                                                                                                                                                                                                                                                                       | test-drift               | ✅ fixed (e59200e8)                             |

## Fixed (this pass)

### 1. Calendar — non-existent location field — `calendar-comprehensive.e2e.ts:197`

The event popover (`calendar-event-popover.tsx`) renders **title, all-day,
start/end, notes** — there is **no location input**, even though the dialog's
helper copy still says "Update title, location, date, time, and notes." The test
filled `getByPlaceholder('Add location')` → 30s timeout.

- **Fix applied:** dropped `location` from the test's `createEvent` call. Test now passes.
- **Open product question:** should the event editor support a location field
  (Google events have locations, and the dialog copy implies it)? If yes, add the
  input + re-add location coverage. If no, remove "location" from the dialog copy.

### 2. "Day Panel" selector ambiguity — `agent-chat-helpers.ts:6`, `calendar.e2e.ts:122`

`getByRole('button', { name: 'Day Panel' })` matched two buttons:
`aria-label="Resize Day Panel"` (resize handle) and `aria-label="Day Panel"`
(the toggle). Strict-mode violation → click failed.

- **Fix applied:** `{ name: 'Day Panel', exact: true }` in both spots. The
  strict-mode error is gone; the agent-chat and calendar:119 tests now progress
  past opening the panel (and then hit the deeper blockers in #5/#6).

### 3. CriticMarkup — composer lives in a flyout, not the rail — `critic-markup-review.e2e.ts`

The new-comment composer (`comment-composer.tsx`) is mounted in a floating draft
flyout (`.critic-review-flyout-draft`, `role="dialog"`, `review-badge-layer.tsx:328`)
positioned near the selection — **not** inside the review rail aside
(`complementary`). The helper looked for `.critic-comment-composer` inside
`reviewRail()` (a `complementary`), so it never matched. `expectComposerNearSelectedTop`
even asserts the composer is positioned near the selection, confirming the flyout
is the intended target.

- **Fix applied:** `commentComposer()` now targets `.critic-review-flyout-draft .critic-comment-composer`.
  This unblocks composer interaction; the tests then fail on the rail (#4).

## Remaining

### 4. CriticMarkup review rail is responsive-gated — `critic-markup-review.e2e.ts:33,105,139,175`

After submitting a comment, the card renders into the review **rail**, but the
rail is conditionally shown by `note-layout.tsx`:
`showGridRail = hasSideRail && fullWidth` (and the grid rail is `max-[920px]:hidden`),
`showCanvasRail = hasSideRail && !fullWidth && !railHidden`. At the e2e window
size / default note layout the rail is hidden (the card exists in a
`display:none` subtree → absent from the a11y snapshot), so `expect(rail).toContainText(...)`
and `[data-note-layout-rail]` visibility assertions fail.

- **Likely fix:** ensure the e2e window is wide enough / the note layout shows the
  rail (e.g. maximize the window in `electron-lifecycle.ts`, or have the test set
  `fullWidth` / force the rail open). Needs to confirm `railHidden`
  (`use-review-rail-shift.ts`) behavior under the e2e window bounds.

### 5. Agent chat never reaches ready state — `agent-chat-create-task.e2e.ts:67,100`, `agent-chat-codex-create-task.e2e.ts:60`, `agent-chat-text-editing.e2e.ts:45`

With the Day Panel selector fixed the panel opens, but `openAgentChat`
(`agent-chat-helpers.ts`) then polls for the Agent tab / `region "Agent chat"` /
"Enable Agent chat" button and times out. Agent chat isn't reaching a usable
state in the e2e environment.

- **Investigate:** does agent chat require a configured provider/backend to render
  the pane? The codex test needs the Codex CLI; the create-task test stands up a
  fake local OpenAI-compatible server; the text-editing test only needs the
  composer but still depends on the pane being available. Confirm the e2e agent
  setup (provider config / feature availability) is wired for these.

### 6. Calendar journal-day-panel projection — `calendar.e2e.ts:119`

Day Panel opens; then `scrollIntoViewIfNeeded` on the projection / `Schedule`
target in `[data-slot="day-panel-inner"]` times out — the seeded projection
isn't showing in the **global journal** day panel.

- **Investigate:** does the seeded calendar projection (`__memryTestHooks.seedCalendarProjection`)
  surface in the journal day panel, or only the calendar view? Possible real
  gap in journal-day-panel projection rendering, or a stale target selector.

### 7. Auth state machine — `auth-state-machine.e2e.ts:138,203,221`

`expect(received).toHaveLength(24)` fails (recovery-phrase word count). Covers
sync setup, wrong-recovery-words blocking, and re-auth. Not reproduced locally
(needs the sync-server / recovery flow).

- **Investigate:** recovery-phrase generation/length, and whether sync setup +
  recovery confirmation work against the e2e sync target. Could be a real
  recovery-flow change or an e2e sync-server availability issue.

## Notes for whoever picks this up

- Run a single file locally on macOS: `pnpm --filter @memry/desktop rebuild:electron`
  then `pnpm --filter @memry/desktop exec electron-vite build` then
  `cd apps/desktop && env -u CI pnpm exec playwright test --config config/playwright.config.ts tests/e2e/<file> --workers=1`.
- macOS e2e is resource-sensitive (see the comment in `electron-lifecycle.ts`); prefer `--workers=1`.
- The onboarding-overlay finding is captured in agent memory: `e2e-onboarding-tour-blocks-suite`.
