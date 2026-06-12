# Plan 006: Remove the duplicate, broken `onSearchIndex*` declarations from the preload API type

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 86ee0cd1..HEAD -- apps/desktop/src/preload/index.d.ts apps/desktop/src/renderer/src/services/search-service.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `86ee0cd1`, 2026-06-12
- **Issue**: https://github.com/memrynote/memry/issues/547

## Why this matters

The `window.api` type (`interface API`, starts at `apps/desktop/src/preload/index.d.ts:1705`) declares the four search-index-rebuild event subscriptions **twice**, in the same interface, with **conflicting** signatures. Worse, the **first** copy references two type names — `IndexRebuildProgressEvent` and `IndexRebuildCompletedEvent` — that are **defined nowhere in the repo** (they appear only at those two declaration sites). The duplication is a correctness/maintainability hazard: a reader can't tell which signature is real, and the next person editing search events might update the wrong copy. The renderer's only consumer (`search-service.ts`) expects a **no-argument** completed callback, which matches the _second_ copy; the first copy (with the undefined types) is stale. Removing the stale copy leaves one correct, self-consistent declaration.

## Current state

`interface API extends WindowAPI, GeneratedRpcApi` begins at `apps/desktop/src/preload/index.d.ts:1705`. It contains two `// Search event subscriptions` blocks:

**First block (STALE — to remove), around lines 1753–1761**, grouped after the Vault subscriptions:

```ts
  // Search event subscriptions
  onSearchIndexRebuildStarted: (callback: () => void) => () => void
  onSearchIndexRebuildProgress: (
    callback: (progress: IndexRebuildProgressEvent) => void   // IndexRebuildProgressEvent is undefined
  ) => () => void
  onSearchIndexRebuildCompleted: (
    callback: (result: IndexRebuildCompletedEvent) => void    // IndexRebuildCompletedEvent is undefined
  ) => () => void
  onSearchIndexCorrupt: (callback: () => void) => () => void
```

**Second block (CANONICAL — keep), around lines 1794–1800**, grouped after Folder View / before Sync subscriptions:

```ts
  // Search event subscriptions
  onSearchIndexRebuildStarted: (callback: () => void) => () => void
  onSearchIndexRebuildProgress: (
    callback: (progress: { phase: string; current: number; total: number; percent: number }) => void
  ) => () => void
  onSearchIndexRebuildCompleted: (callback: () => void) => () => void
  onSearchIndexCorrupt: (callback: () => void) => () => void
```

The renderer consumer that fixes the canonical shape:

```ts
// apps/desktop/src/renderer/src/services/search-service.ts:53
onIndexRebuildCompleted(cb: () => void): () => void {
  return window.api.onSearchIndexRebuildCompleted(cb)   // cb takes NO argument → second block
}
```

Note: `index.d.ts` is a hand-maintained ambient declaration of `window.api`; it is not part of the strict typecheck projects (which is why the undefined-type references and the duplicate haven't failed CI). Verification therefore leans on the renderer consumer's web typecheck, not on this file erroring.

## Commands you will need

| Purpose                      | Command                                                                                               | Expected on success |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------- |
| Count remaining declarations | `grep -c "onSearchIndexRebuildStarted" apps/desktop/src/preload/index.d.ts`                           | `1`                 |
| Confirm undefined types gone | `grep -n "IndexRebuildProgressEvent\|IndexRebuildCompletedEvent" apps/desktop/src/preload/index.d.ts` | no matches          |
| Renderer web typecheck       | `pnpm --filter @memry/desktop typecheck:web`                                                          | exit 0              |
| Search-service tests         | `pnpm --filter @memry/desktop exec vitest run src/renderer/src/services/search-service.test.ts`       | all pass            |

## Scope

**In scope** (modify):

- `apps/desktop/src/preload/index.d.ts` — delete the first (stale) `// Search event subscriptions` block only.

**Out of scope** (do NOT touch):

- The second (canonical) block.
- `search-service.ts` and any renderer code — they already target the canonical shape.
- Defining the missing `IndexRebuildProgressEvent`/`IndexRebuildCompletedEvent` types — they are unused after the deletion; do not create them.
- Any other duplicate you might notice in this large file — out of scope; note it for a follow-up.

## Git workflow

- Branch: `fix/dedupe-preload-search-events` (from `origin/main`).
- Commit message: `fix(preload): remove duplicate stale onSearchIndex* declarations`.
- Do NOT push or open a PR unless instructed. No `Co-Authored-By` trailers.

## Steps

### Step 1: Delete the first (stale) block

Remove the **first** `// Search event subscriptions` comment and its four declarations (the ones referencing `IndexRebuildProgressEvent` / `IndexRebuildCompletedEvent`), around lines 1753–1761. Leave the surrounding Vault and Saved Filters subscription lines intact. Keep the second block untouched.

**Verify**:

- `grep -c "onSearchIndexRebuildStarted" apps/desktop/src/preload/index.d.ts` → `1`
- `grep -n "IndexRebuildProgressEvent\|IndexRebuildCompletedEvent" apps/desktop/src/preload/index.d.ts` → no matches

### Step 2: Confirm the renderer still typechecks against the single declaration

**Verify**: `pnpm --filter @memry/desktop typecheck:web` → exit 0. (If this reports a _new_ error about `onSearchIndexRebuild*` not existing or mismatching, you deleted the wrong block — restore and delete the other one. See STOP conditions.)

### Step 3: Run the search-service tests

**Verify**: `pnpm --filter @memry/desktop exec vitest run src/renderer/src/services/search-service.test.ts` → all pass.

## Test plan

No new tests — this removes a duplicate type declaration. The existing `search-service.test.ts` exercises the consumer and is the regression guard. Verification = the grep counts + web typecheck + that test passing.

## Done criteria

ALL must hold:

- [ ] Exactly one declaration of each `onSearchIndexRebuildStarted/Progress/Completed/Corrupt` remains (`grep -c` returns `1` for each).
- [ ] No references to `IndexRebuildProgressEvent` / `IndexRebuildCompletedEvent` remain anywhere (`grep -rn` across the repo returns nothing).
- [ ] `pnpm --filter @memry/desktop typecheck:web` exits 0.
- [ ] `search-service.test.ts` passes.
- [ ] `git status` shows only `apps/desktop/src/preload/index.d.ts` (plus `plans/README.md`) modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report if:

- There is only one `// Search event subscriptions` block already (fixed independently) — mark REJECTED.
- After deleting the first block, `typecheck:web` errors that `onSearchIndexRebuildCompleted` is called with a callback whose signature no longer matches — that means the consumer actually depends on the first block's shape; restore, reassess, and report rather than guessing.
- `IndexRebuildProgressEvent`/`IndexRebuildCompletedEvent` turn out to be defined somewhere your earlier grep missed and are used by real code — stop; the "stale" judgment was wrong.

## Maintenance notes

- The clean long-term fix is to generate `window.api`'s type from the IPC contracts (the repo already runs `pnpm ipc:generate` / `pnpm ipc:check`) so this `.d.ts` can't drift or duplicate. That's a larger effort; this plan just removes the immediate duplicate.
- A reviewer should confirm only the stale block was removed and the canonical inline-typed block remains.
