# Plan 012: Produce the task focus mode design spec — bucket-axis decision, focus feed interaction model, and daily review nudge

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 86ee0cd1..HEAD -- ideas/ideas.md apps/desktop/src/main/database/queries/tasks.ts packages/storage-data/src/tasks-repository.ts`
> If any of these changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M (spike + spec; the build it specifies is M and is NOT part of this plan)
- **Risk**: LOW (this plan produces a design document; no source code changes)
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `86ee0cd1`, 2026-06-13

## Why this matters

`ideas/ideas.md:354-418` records a researched product direction from real user feedback (Reddit, ADHD-adjacent capture-fast/organize-later workflow): priority buckets (do now / do soon / long term), a scheduled daily review nudge, and a hand-ranked one-task-at-a-time **focus feed** with a "Next task" peek. The follow-up analysis in the same file (`ideas.md:395-414`) confirms most substrate already shipped — the remaining work is "a thin view, not a data-model change." One blocker named there (task-level reminders) has since shipped (PR #538, merged 2026-06-12), so the workflow is now unblocked. One genuine design decision is explicitly open (`ideas.md:416-418`): how the three buckets map onto existing task fields. This plan resolves that decision and specifies the interaction model so a build plan can execute it.

## Current state

What `ideas/ideas.md:400-414` says exists, verified against the code:

- **Manual ranking**: tasks have a `position` field with a `reorderTasks` command — confirmed in `apps/desktop/src/main/database/queries/tasks.ts`, `apps/desktop/src/main/ipc/tasks-handlers.ts`, `packages/storage-data/src/tasks-repository.ts`, and even exposed to the agent via `apps/desktop/src/main/agent/mcp/tools/handles-adapter.ts`.
- **Subtasks**: parent/child modeled and rendered (per `ideas.md:405`).
- **Today view + overdue/upcoming queries**: exist (per `ideas.md:406`; locate concrete files during Step 1).
- **Task reminders**: `targetType: 'task'` now in the contracts layer (`packages/contracts/src/reminders-api.test.ts:48` exercises it; shipped in PR #538 together with an inbox upcoming/past reminders panel). Note: `packages/app-core/src/reminders.ts:6` still reads `'note' | 'journal' | 'highlight'` — the CLI/app-core layer lags the desktop; this drift is already owned by `plans/005-consolidate-reminder-target-type.md` (issue #546); the spec should reference it, not solve it.

The genuinely missing pieces (`ideas.md:408-414`):

1. A focus mode / single-task "do this now" feed — today there is only a task detail drawer, no focus view.
2. A persistent "Next task" peek.

The explicitly open decision (`ideas.md:416-418`, quote): "whether do now / do soon / long term map onto the existing numeric priority field, the per-project status columns, or a new dedicated axis. The hand-ranked short-term list is orthogonal to whichever bucketing is chosen."

Hard product constraints from `ideas.md:391-393` the spec must honor: "The focus feed must follow the user's manual rank order, never auto-sort by date or priority. A 'do now' task added today must not automatically outrank a 'do now' task carried over from yesterday; relative urgency is the user's call, set by dragging."

Design-spec convention: `docs/superpowers/specs/YYYY-MM-DD-<name>-design.md`; structural exemplar `docs/superpowers/specs/2026-06-12-task-reminder-drawer-ui-design.md`.

## Commands you will need

| Purpose                        | Command                                                                              | Expected on success                          |
| ------------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| Confirm reorder substrate      | `grep -rn "reorderTasks" apps/desktop/src/main/database/queries/tasks.ts \| head -3` | matches                                      |
| Confirm task reminders shipped | `grep -n "'task'" packages/contracts/src/reminders-api.test.ts \| head -2`           | match at ~line 48                            |
| Lint (unchanged)               | `pnpm lint`                                                                          | exit 0                                       |
| Working tree check             | `git status --porcelain`                                                             | only the new spec file + plans/README.md row |

## Scope

**In scope** (the only files you may create or modify):

- `docs/superpowers/specs/2026-06-13-task-focus-mode-design.md` (create)
- `plans/README.md` (status row update)

**Out of scope** (do NOT touch):

- Any file under `apps/desktop/src`, `packages/*/src` — spec-only spike.
- The app-core reminders parity gap (`packages/app-core/src/reminders.ts:6`) — already owned by `plans/005-consolidate-reminder-target-type.md`; reference it in the spec, do not fix.
- The inbox triage flow itself — focus mode consumes triaged tasks; it does not change triage.

## Git workflow

- Branch: `focus-mode-design-spec` (repo rule: code-context branch names, no agent branding).
- Commit style: conventional commits, e.g. `docs(specs): task focus mode design spec`. Do NOT add Co-Authored-By lines.
- Do NOT push or open a PR unless the operator instructed it. If pushing and the pre-push docs gate blocks, `MEMRY_DOCS_IMPACT_SKIP=1` is acceptable for this spec-only change.

## Steps

### Step 1: Map the existing task-view substrate

Read (do not modify) and record in the spec with file paths: the Today view component and the overdue/upcoming queries (`grep -rn "overdue" apps/desktop/src/renderer/src/components/tasks --include="*.tsx" -l | head`), the task detail drawer, the drag-reorder UI that writes `position`, and the tab/view registration pattern (how a new full view gets a tab — see how existing views register; the reopen-closed-tab work touched `use-tab-keyboard-shortcuts.ts`, a useful trailhead).

**Verify**: spec's "Substrate" section lists ≥5 concrete files with one-line roles.

### Step 2: Resolve the bucket-axis decision

Write a "Decision: bucket axis" section comparing the three options from `ideas.md:416-418` (numeric priority field / per-project status columns / new dedicated axis) against: sync impact (new field = contracts + db-schema + vector-clock field merge — note the repo's per-field clock model for tasks), agent/MCP exposure, filter/query reuse, and migration cost (pre-production: schema resets are allowed, per CLAUDE.md "No backward-compat constraints"). Pick one with rationale. Whichever is picked, restate the orthogonality constraint: hand-rank order is `position`, never derived from the bucket.

**Verify**: section exists and ends with a single recommendation paragraph beginning "Decision:".

### Step 3: Specify the focus feed interaction model

Cover, each as its own subsection: entry point ("Go" from where — Today view? bucket list?), the focus surface (full tab vs. dedicated window vs. right-sidebar — recommend one; note the right sidebar already hosts Day | Agent tabs), what the focused task shows (title, subtasks inline per `ideas.md:387`, notes link), advance semantics (complete → next; skip → where does it go; what happens at list end), the "Next task" peek (name-only, corner placement per `ideas.md:389-390`), and interruption behavior (app restart mid-focus, task edited elsewhere mid-focus — CRDT/field-merge means the focused task can change under you; define the refresh rule).

**Verify**: spec contains ≥6 named subsections under "Interaction model".

### Step 4: Specify the daily review nudge and telemetry

- Daily review: a settings key (e.g. `tasks.dailyReviewTime`), scheduling in the main process — investigate whether the now-generic reminders scheduler (post-PR #538 it handles `task` targets; see `apps/desktop/src/main` reminders scheduler) can host a recurring synthetic reminder vs. a separate timer; recommend one. Notification → "Open review" lands in inbox triage.
- Telemetry: name the PostHog events to add (desktop analytics shipped via PR #512; follow `docs/superpowers/specs/2026-06-10-desktop-posthog-analytics-design.md` conventions) — e.g. `focus_session_started`, `focus_task_completed`, `daily_review_opened`.
- i18n note: new renderer strings need `en/common.json` keys only (the i18n gate is English-only).
- Close with "Phases" (suggested build order: axis + queries → focus view → peek → nudge), "Open questions" (each with a recommended answer), and "Out of scope" (mobile, auto-prioritization, AI ranking — the constraint at `ideas.md:391-393` forbids auto-sort).

**Verify**: spec file contains sections: Problem, Substrate, Decision: bucket axis, Interaction model, Daily review nudge, Telemetry & i18n, Phases, Open questions, Out of scope.

## Test plan

No code tests — this plan ships a spec. The spec must define the build plan's test plan: queries unit tests (bucket filter + position order stability), focus-feed reducer tests (advance/skip/end-of-list), scheduler test for the daily nudge (fake timers), and a renderer test for the focus view (note the repo convention: mock `@/components/ui/picker` in jsdom).

## Done criteria

- [ ] `docs/superpowers/specs/2026-06-13-task-focus-mode-design.md` exists with all nine sections from Step 4's verify
- [ ] The bucket-axis decision is singular and justified
- [ ] The manual-rank constraint (`ideas.md:391-393`) is restated verbatim in the spec
- [ ] `git status --porcelain` shows only the spec file and `plans/README.md`
- [ ] `pnpm lint` exits 0
- [ ] `plans/README.md` status row for 012 updated

## STOP conditions

Stop and report back (do not improvise) if:

- A focus-mode view or bucket field already exists in the code (search `grep -rin "focus" apps/desktop/src/renderer/src/components/tasks | head` first) — reconcile with the existing direction.
- `ideas/ideas.md:354-418` has materially changed — the product direction is the spec's foundation.
- The reminders scheduler turns out not to support recurring/synthetic reminders AND a separate timer would duplicate >50 lines of its logic — surface the trade-off instead of picking silently.

## Maintenance notes

- If a new bucket axis field is chosen, it must be added to the task sync handler's field-merge list and the three duplicated type-definition sites the task-reminders work hit (contracts, domain layer, preload index.d.ts) — the build plan must name all three.
- Reviewer should scrutinize: whether the focus feed honors manual rank under concurrent edits from another device (field-merge can reorder), and whether the nudge respects quiet hours / OS focus modes.
- Explicitly deferred: app-core/CLI reminders `'task'` parity, AI-assisted ranking, mobile focus mode.
