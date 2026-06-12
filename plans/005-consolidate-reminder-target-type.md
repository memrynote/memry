# Plan 005: Make `app-core`'s `ReminderTargetType` derive from the canonical contracts definition (fix the existing `'task'` drift)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 86ee0cd1..HEAD -- packages/app-core/src/reminders.ts packages/contracts/src/reminder-types.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `86ee0cd1`, 2026-06-12
- **Issue**: https://github.com/memrynote/memry/issues/546

## Why this matters

`ReminderTargetType` is defined as a string-literal union in **four independent places**. One of them has **already drifted**: `packages/app-core/src/reminders.ts:6` is `'note' | 'journal' | 'highlight'` and is **missing `'task'`**, even though task reminders are a shipped feature (canonical type, contracts schema, db-schema, the preload type, and `domain-inbox` all include `'task'`). `app-core` is the domain layer the **CLI** runs on (`apps/cli`), so the CLI's reminder handling is typed against a stale union — any task-reminder value flowing through `app-core` is silently outside its declared type. The canonical definition already exists at `packages/contracts/src/reminder-types.ts`, and `app-core` already depends on `@memry/contracts`. The fix is to make `app-core` re-export the canonical type instead of hand-maintaining its own copy, which both fixes the current drift and removes one of the four divergent sources.

## Current state

The **canonical** definition (do NOT change — it is correct and already includes `task`):

```ts
// packages/contracts/src/reminder-types.ts
export const reminderTargetType = {
  NOTE: 'note',
  JOURNAL: 'journal',
  HIGHLIGHT: 'highlight',
  TASK: 'task'
} as const
export type ReminderTargetType = (typeof reminderTargetType)[keyof typeof reminderTargetType]

export const reminderStatus = {
  PENDING: 'pending',
  TRIGGERED: 'triggered',
  DISMISSED: 'dismissed',
  SNOOZED: 'snoozed'
} as const
export type ReminderStatus = (typeof reminderStatus)[keyof typeof reminderStatus]
```

The **drifted** copy (to fix):

```ts
// packages/app-core/src/reminders.ts:1
import { asc, eq } from 'drizzle-orm'
import { reminders } from '@memry/db-schema/data-schema'
import type { DataDb } from './database.ts'
import { createId } from './ids.ts'

// packages/app-core/src/reminders.ts:6
export type ReminderTargetType = 'note' | 'journal' | 'highlight' // <-- missing 'task'
export type ReminderStatus = 'pending' | 'triggered' | 'dismissed' | 'snoozed'
```

`app-core` already imports from contracts elsewhere (e.g. `packages/app-core/src/calendar.ts:9` imports `@memry/contracts/calendar-api`), and `packages/app-core/package.json` lists `"@memry/contracts": "workspace:*"`. So importing `@memry/contracts/reminder-types` here is consistent with the package's existing dependencies — no new dependency is added.

The other three copies are **already correct** (they include `'task'`) and are **out of scope** for this plan:

- `packages/contracts/src/reminders-api.ts:29` — `z.enum(['note', 'journal', 'highlight', 'task'])` (a Zod schema, intentionally a separate literal).
- `packages/domain-inbox/src/types.ts:98` — inline union; `domain-inbox` has **no** `@memry/contracts` dependency, so converting it would require adding one (deliberately deferred).
- `apps/desktop/src/preload/index.d.ts:931` — a hand-written ambient `.d.ts` union.

## Commands you will need

| Purpose                                   | Command                   | Expected on success |
| ----------------------------------------- | ------------------------- | ------------------- | --------------------------------------------- | ---------------------------- |
| Typecheck packages (incl. app-core + cli) | `pnpm typecheck:packages` | exit 0              |
| Test app-core + cli                       | `pnpm test:cli`           | all pass            |
| List all copies                           | `grep -rn "'note'         | 'journal'           | 'highlight'" packages apps --include="\*.ts"` | shows the remaining literals |

(`pnpm typecheck:packages` runs `repair:links` first per the root scripts — that is expected, not an error.)

## Scope

**In scope** (modify):

- `packages/app-core/src/reminders.ts` — replace the local `ReminderTargetType` (and optionally `ReminderStatus`) with a re-export of the canonical contracts type.
- `packages/app-core/src/reminders.test.ts` (create if absent, or add to an existing app-core reminders test) — a guard test that pins the value set.

**Out of scope** (do NOT touch):

- `packages/contracts/src/reminder-types.ts` — canonical, correct.
- `packages/contracts/src/reminders-api.ts` Zod enum — leave as-is.
- `packages/domain-inbox/src/types.ts` and `apps/desktop/src/preload/index.d.ts` — already include `'task'`; converting them needs a dependency/ambient-type change that this plan deliberately defers (see Maintenance notes).

## Git workflow

- Branch: `refactor/consolidate-reminder-target-type` (from `origin/main`).
- Commit message: `refactor(app-core): derive ReminderTargetType from canonical contracts type`.
- Do NOT push or open a PR unless instructed. No `Co-Authored-By` trailers.

## Steps

### Step 1: Re-export the canonical types in `app-core/reminders.ts`

Replace lines 6–7:

```ts
export type ReminderTargetType = 'note' | 'journal' | 'highlight'
export type ReminderStatus = 'pending' | 'triggered' | 'dismissed' | 'snoozed'
```

with a re-export of the canonical definitions:

```ts
export type { ReminderTargetType, ReminderStatus } from '@memry/contracts/reminder-types'
```

Keep this near the top with the other imports. All existing uses of `ReminderTargetType` / `ReminderStatus` within `reminders.ts` (lines 11, 28, 46, 66, 83) keep working because the names are unchanged — they now resolve to the canonical (4-value) type.

**Verify**: `pnpm typecheck:packages` → exit 0.

### Step 2: Handle any newly-surfaced exhaustiveness gaps

Adding `'task'` to the union may make the TypeScript compiler flag a `switch`/branch in `app-core` (or its `cli` consumers) that doesn't handle `'task'`. If `pnpm typecheck:packages` now reports a "not all code paths" / missing-case error:

- If the missing case is a clear pass-through (the code already handles arbitrary target types), add the `'task'` branch minimally, mirroring the `'note'` branch.
- If handling `'task'` requires real new behavior (not a trivial mirror), **STOP and report** — that is a feature gap, not a type cleanup.

**Verify**: `pnpm typecheck:packages` → exit 0.

### Step 3: Add a guard test pinning the value set

Add a small Vitest test in `packages/app-core/src/reminders.test.ts` (or the nearest existing app-core test file) that fails if the canonical set ever changes silently:

```ts
import { describe, it, expect } from 'vitest'
import { reminderTargetType } from '@memry/contracts/reminder-types'

describe('reminder target types', () => {
  it('canonical set is exactly the four supported targets', () => {
    expect(Object.values(reminderTargetType).sort()).toEqual([
      'highlight',
      'journal',
      'note',
      'task'
    ])
  })
})
```

**Verify**: `pnpm test:cli` → all pass, including this test.

## Test plan

- New test: the guard above, asserting the canonical target set is `note/journal/highlight/task`. This makes any future addition/removal a deliberate, test-breaking change.
- Model after any existing test in `packages/app-core/src/*.test.ts` for import style and Vitest setup.
- **Verify**: `pnpm test:cli` → all pass.

## Done criteria

ALL must hold:

- [ ] `packages/app-core/src/reminders.ts` no longer defines a local `ReminderTargetType` literal; it re-exports from `@memry/contracts/reminder-types`.
- [ ] `grep -n "'note' | 'journal' | 'highlight'" packages/app-core/src/reminders.ts` returns no matches.
- [ ] `pnpm typecheck:packages` exits 0.
- [ ] `pnpm test:cli` passes, including the new guard test.
- [ ] `git status` shows only `packages/app-core/src/reminders.ts` and its test file (plus `plans/README.md`) modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- `app-core/reminders.ts` already imports `ReminderTargetType` from contracts (fixed independently) — mark REJECTED.
- Step 2 reveals a `'task'` branch that needs real new logic in `app-core`/`cli` — that is a behavior gap beyond this cleanup.
- Importing `@memry/contracts/reminder-types` fails to resolve in `app-core` (the subpath export isn't exposed) — report it; do not work around it by copying the type again.

## Maintenance notes

- Two literal copies remain by design: `domain-inbox/src/types.ts:98` (no contracts dep) and `preload/index.d.ts:931` (ambient hand-written types). A future follow-up could add a `@memry/contracts` dependency to `domain-inbox` and generate the preload types, collapsing all copies to one. Out of scope here to keep risk LOW.
- A reviewer should confirm the guard test's expected array matches the canonical `reminderTargetType` values, and that no exhaustiveness error was silenced with a cast.
