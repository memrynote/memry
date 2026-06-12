# Plan 002: Flush pending CRDT markdown write-backs on shutdown instead of discarding them

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 86ee0cd1..HEAD -- apps/desktop/src/main/sync/crdt-writeback.ts apps/desktop/src/main/sync/crdt-provider.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `86ee0cd1`, 2026-06-12
- **Issue**: https://github.com/memrynote/memry/issues/543

## Why this matters

When a note or journal entry changes, the CRDT layer schedules a **debounced** (500 ms) write-back that projects the in-memory `Y.Doc` to the on-disk markdown file and updates the search index. On shutdown, `CrdtProvider.destroy()` calls `cancelPendingWritebacks()`, which **clears the debounce timers without running them** — so any edit made within ~500 ms before quit never reaches the `.md` file or the search index. The CRDT state itself is persisted (so the edit isn't permanently lost), but the on-disk file silently lags the true content, and it does **not** self-heal: opening a note later does not re-trigger a write-back, only a _new_ edit does. For a product whose core promise is "files on disk, not a database you can't migrate out of," a file that disagrees with what the app shows — and that propagates stale via folder-level sync (Dropbox/git) and stale search results — is a real correctness gap. The fix is to **flush** pending write-backs on shutdown rather than cancel them.

## Current state

Files:

- `apps/desktop/src/main/sync/crdt-writeback.ts` — owns the debounced write-back machinery (`scheduleWriteback`, `cancelPendingWritebacks`, `performWriteback`).
- `apps/desktop/src/main/sync/crdt-provider.ts` — owns `Y.Doc` lifecycle; its `destroy()` is the shutdown path and currently _cancels_ write-backs.

Current `crdt-writeback.ts` (key excerpts):

```ts
// apps/desktop/src/main/sync/crdt-writeback.ts:36
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
```

```ts
// apps/desktop/src/main/sync/crdt-writeback.ts:113
export function scheduleWriteback(noteId: string, doc: Y.Doc): void {
  const existing = pendingTimers.get(noteId)
  if (existing) clearTimeout(existing)
  updateDebugState(noteId, {
    pending: true,
    scheduledCount: (debugState.get(noteId)?.scheduledCount ?? 0) + 1,
    lastError: null
  })

  const timer = setTimeout(() => {
    pendingTimers.delete(noteId)
    performWriteback(noteId, doc).catch((err) => {
      updateDebugState(noteId, {
        pending: false,
        lastError: err instanceof Error ? err.message : String(err)
      })
      log.error('Write-back failed', { noteId, error: err })
      emitToRenderer('sync:write-back-failed', { noteId })
    })
  }, WRITEBACK_DEBOUNCE_MS)

  pendingTimers.set(noteId, timer)
}

// apps/desktop/src/main/sync/crdt-writeback.ts:137
export function cancelPendingWritebacks(): void {
  for (const timer of pendingTimers.values()) {
    clearTimeout(timer)
  }
  pendingTimers.clear()
}

// apps/desktop/src/main/sync/crdt-writeback.ts:144
async function performWriteback(noteId: string, doc: Y.Doc): Promise<void> {
  /* ... writes the file ... */
}
```

The problem: `pendingTimers` stores only the timer handle, not the `doc`. To _flush_, we need the `doc` for each pending note. The `setTimeout` callback captures `doc`, but a separate flush function can't reach it.

Current shutdown path in `crdt-provider.ts`:

```ts
// apps/desktop/src/main/sync/crdt-provider.ts:11
import { scheduleWriteback, cancelPendingWritebacks, recordNetworkUpdate } from './crdt-writeback'

// apps/desktop/src/main/sync/crdt-provider.ts:296
async destroy(): Promise<void> {
  cancelPendingWritebacks()
  this.networkBatcher.flushAll()

  for (const [noteId] of this.docs) {
    try {
      await this.flushDoc(noteId)          // flushes CRDT persistence, NOT the markdown file
    } catch (err) { /* ... */ }
  }
  for (const [, entry] of this.docs) {
    entry.doc.destroy()                    // doc is gone after this — must flush write-backs BEFORE
  }
  this.docs.clear()
  // ...
}
```

`destroy()` is awaited from `stopSyncRuntime()` (`apps/desktop/src/main/sync/runtime.ts:593`), which is awaited from the Electron `before-quit` handler (`apps/desktop/src/main/index.ts:1194`), so an async flush on shutdown is safe and will be awaited.

Conventions: logging via `createLogger('CrdtWriteback')` (already in the file as `log`); no `console.*`. Tests use Vitest with `vi.hoisted` mocks — see the existing `apps/desktop/src/main/sync/crdt-writeback.test.ts` as the pattern.

## Commands you will need

| Purpose                  | Command                                                                             | Expected on success |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------------- |
| Typecheck (node side)    | `pnpm --filter @memry/desktop typecheck:node`                                       | exit 0, no errors   |
| Run the write-back tests | `pnpm --filter @memry/desktop exec vitest run src/main/sync/crdt-writeback.test.ts` | all pass            |
| Lint                     | `pnpm lint`                                                                         | exit 0              |

(Note: `pnpm typecheck` surfaces a few pre-existing test-file errors documented in `CLAUDE.md` — e.g. `websocket.test.ts`, `folders.test.ts`. Those are not yours; judge success on `typecheck:node` for the in-scope files being clean.)

## Scope

**In scope** (modify):

- `apps/desktop/src/main/sync/crdt-writeback.ts` — track the `doc` per pending write-back and add a `flushPendingWritebacks()` export.
- `apps/desktop/src/main/sync/crdt-provider.ts` — call `await flushPendingWritebacks()` in `destroy()` instead of `cancelPendingWritebacks()`.
- `apps/desktop/src/main/sync/crdt-writeback.test.ts` — add tests for the flush behavior.

**Out of scope** (do NOT touch):

- `performWriteback` internals and the file-write logic — unchanged.
- The 500 ms debounce constant.
- `runtime.ts` / `index.ts` shutdown ordering — already awaits `destroy()`.
- Keep `cancelPendingWritebacks()` exported (other code or tests may use it); just stop calling it from `destroy()`. If `grep -rn "cancelPendingWritebacks" apps/desktop/src` shows it is now unused everywhere, you may remove it — but only if it is genuinely orphaned by your change.

## Git workflow

- Branch: `fix/flush-writebacks-on-shutdown` (from `origin/main`).
- Commit message: `fix(sync): flush pending CRDT write-backs on shutdown instead of dropping them`.
- Do NOT push or open a PR unless instructed. No `Co-Authored-By` trailers.

## Steps

### Step 1: Track the `doc` alongside each pending timer

In `crdt-writeback.ts`, change `pendingTimers` so a flush can reach the `doc`. Replace the `Map<string, timeout>` with a richer entry:

```ts
interface PendingWriteback {
  timer: ReturnType<typeof setTimeout>
  doc: Y.Doc
}
const pendingTimers = new Map<string, PendingWriteback>()
```

Update `scheduleWriteback` to store `{ timer, doc }`, and update `cancelPendingWritebacks` to read `.timer`:

```ts
export function scheduleWriteback(noteId: string, doc: Y.Doc): void {
  const existing = pendingTimers.get(noteId)
  if (existing) clearTimeout(existing.timer)
  // ...updateDebugState unchanged...
  const timer = setTimeout(() => {
    pendingTimers.delete(noteId)
    performWriteback(noteId, doc).catch((err) => {
      /* unchanged */
    })
  }, WRITEBACK_DEBOUNCE_MS)
  pendingTimers.set(noteId, { timer, doc })
}

export function cancelPendingWritebacks(): void {
  for (const { timer } of pendingTimers.values()) clearTimeout(timer)
  pendingTimers.clear()
}
```

**Verify**: `pnpm --filter @memry/desktop typecheck:node` → exit 0.

### Step 2: Add `flushPendingWritebacks()`

Add an exported async function that runs every pending write-back immediately (clearing its timer first) and awaits them all. It must drain notes that may be re-added during the flush is not a concern here (shutdown is single-shot), so a snapshot-then-run is fine:

```ts
export async function flushPendingWritebacks(): Promise<void> {
  const pending = Array.from(pendingTimers.entries())
  pendingTimers.clear()
  for (const [, { timer }] of pending) clearTimeout(timer)
  await Promise.all(
    pending.map(([noteId, { doc }]) =>
      performWriteback(noteId, doc).catch((err) => {
        log.error('Write-back failed during shutdown flush', { noteId, error: err })
      })
    )
  )
}
```

**Verify**: `pnpm --filter @memry/desktop typecheck:node` → exit 0.

### Step 3: Call the flush from `CrdtProvider.destroy()` before docs are destroyed

In `crdt-provider.ts`:

1. Update the import on line 11 to bring in `flushPendingWritebacks`:
   ```ts
   import { scheduleWriteback, flushPendingWritebacks, recordNetworkUpdate } from './crdt-writeback'
   ```
   (Drop `cancelPendingWritebacks` from this import if it is no longer referenced in the file.)
2. In `destroy()` (line ~296), replace `cancelPendingWritebacks()` with `await flushPendingWritebacks()`. It must run **before** the `entry.doc.destroy()` loop (the flush reads from the docs). Keep the rest of `destroy()` unchanged:
   ```ts
   async destroy(): Promise<void> {
     await flushPendingWritebacks()
     this.networkBatcher.flushAll()
     for (const [noteId] of this.docs) { /* flushDoc — unchanged */ }
     for (const [, entry] of this.docs) entry.doc.destroy()
     this.docs.clear()
     // ...unchanged...
   }
   ```

**Verify**: `pnpm --filter @memry/desktop typecheck:node` → exit 0, and `grep -n "cancelPendingWritebacks" apps/desktop/src/main/sync/crdt-provider.ts` → no matches.

### Step 4: Add tests (see Test plan) and run them

**Verify**: `pnpm --filter @memry/desktop exec vitest run src/main/sync/crdt-writeback.test.ts` → all pass, including the new tests.

## Test plan

Add to `apps/desktop/src/main/sync/crdt-writeback.test.ts` (model the mock setup after the existing file — it already mocks `electron`, `yDocToMarkdown`, `atomicWrite`, etc. via `vi.hoisted`). New cases:

1. **flush runs a scheduled write-back**: call `scheduleWriteback(noteId, doc)`, then `await flushPendingWritebacks()`, and assert `performWriteback`'s side effect ran — i.e. the mocked `atomicWrite` (or `syncNoteToCache`) was called. Use fake timers so the debounce does not fire on its own: `vi.useFakeTimers()` in `beforeEach`, and do NOT advance them, so the only way the write happens is the flush.
2. **flush clears pending state**: after `await flushPendingWritebacks()`, scheduling nothing more, advancing timers (`vi.advanceTimersByTime(1000)`) does not trigger a second `atomicWrite` (the timer was cleared).
3. **flush with nothing pending is a no-op**: `await flushPendingWritebacks()` resolves without calling `atomicWrite`.
4. **a rejected write-back during flush does not reject the flush**: make `yDocToMarkdown` (or `atomicWrite`) throw once; `await expect(flushPendingWritebacks()).resolves.toBeUndefined()` and the error is logged, not thrown.

**Verify**: `pnpm --filter @memry/desktop exec vitest run src/main/sync/crdt-writeback.test.ts` → all pass, 4 new tests included.

## Done criteria

ALL must hold:

- [ ] `flushPendingWritebacks` is exported from `crdt-writeback.ts` and awaited in `CrdtProvider.destroy()` before docs are destroyed.
- [ ] `grep -n "cancelPendingWritebacks()" apps/desktop/src/main/sync/crdt-provider.ts` returns no matches.
- [ ] `pnpm --filter @memry/desktop typecheck:node` exits 0.
- [ ] `pnpm --filter @memry/desktop exec vitest run src/main/sync/crdt-writeback.test.ts` passes with the 4 new tests.
- [ ] `pnpm lint` exits 0.
- [ ] `git status` shows only the three in-scope files modified.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- `destroy()` no longer calls `cancelPendingWritebacks()` (someone already changed this) — the finding may be fixed; verify and mark REJECTED if so.
- `pendingTimers` already stores the `doc` or a flush function — the structure drifted from the excerpt; re-read before changing.
- Adding the flush makes an existing `crdt-writeback.test.ts` or `crdt-provider.test.ts` test fail in a way that suggests flush-on-destroy changes intended behavior (e.g. a test asserts files are NOT written on destroy) — stop and report; the intent may be deliberate and needs the maintainer's call.

## Maintenance notes

- If the debounce window is ever made longer, the shutdown flush becomes more important (more in-flight edits to lose), not less.
- A reviewer should confirm the flush runs _before_ `entry.doc.destroy()` — flushing after the docs are destroyed would read a destroyed `Y.Doc`.
- Deferred: the same drop-on-quit shape may exist for other debounced projections (e.g. `flushProjectionEvents`); this plan covers only the markdown write-back. If a future audit finds another, file it separately.
