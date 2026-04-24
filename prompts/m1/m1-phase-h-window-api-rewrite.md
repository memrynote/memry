# M1 Phase H — window.api → invoke Mechanical Rewrite (TDD)

Temiz session prompt. **Bu phase'in ortasında TDD gereklidir** (port-audit script'i test-first yazılır). Rewrite kendisi mekaniktir ama verification test'lerle yapılır.

---

## PROMPT START

You are implementing **Phase H of Milestone M1** for Memry's Electron→Tauri migration. This phase rewrites all ~366 `window.api.*` call sites in the ported renderer to use the typed `invoke()` wrapper from Phase D. This is the largest single task in M1.

### Context

**Repo:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk`
**Branch:** `spike/tauri-risk-discovery`
**Plan:** `docs/superpowers/plans/2026-04-24-m1-tauri-skeleton-and-renderer-port.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`

### Prerequisite

**Phase G complete.** Verify:

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
test -d apps/desktop-tauri/src/features
test -d apps/desktop-tauri/src/pages
test -d apps/desktop-tauri/src/services
test -f apps/desktop-tauri/src/lib/ipc/invoke.ts
```

If any fails, STOP.

### Your scope

Execute **Task 15** from the plan. Steps 15.1-15.9:

1. Write `scripts/port-audit.ts` (TDD — test-first)
2. Run audit to discover all hit sites (~366 hits)
3. Rewrite each service file (mechanical)
4. Rewrite hooks and contexts
5. Rewrite pages, features, components
6. Delete pure Electron preload shims
7. Replace `lib/ipc-error.ts` with the simplified Tauri version
8. Typecheck clean
9. Commit

### Methodology — TDD for port-audit script, mechanical for rewrites

**Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`** first.

**Step 1: Write port-audit with TDD** (Task 15.1):
- RED: `apps/desktop-tauri/scripts/port-audit.test.ts`:
  - Given a fixture file containing `const x = window.api.notes.create(input)`, audit reports 1 hit of kind `window.api` at line 1
  - Given `import { ipcRenderer } from 'electron'`, audit reports 1 hit of kind `ipcRenderer`
  - Given `@electron-toolkit/utils`, audit reports 1 hit of kind `electron-toolkit`
  - Given `window.electron.something()`, audit reports 1 hit of kind `window.electron`
  - Given 5 identical lines, audit reports 5 hits (not deduplicated by line text)
  - Given clean code (no Electron refs), audit reports 0 hits
- Run tests → FAIL
- GREEN: implement `port-audit.ts` per plan step 15.1. Refactor so core scanning logic is exported + testable independently from file system walk.
- Run tests → PASS
- Commit `m1(port): add tdd port-audit script`

**Step 2: Run audit on current state** (Task 15.2):
- `pnpm port:audit`
- Save output hit counts. Expected ~366 hits.

**Step 3-5: Mechanical rewrites** (Tasks 15.3, 15.4, 15.5):

For each hit, apply the mapping:
```
window.api.<domain>.<method>(args)   →   invoke('<domain>_<method>', args)
window.api.<domain>.<method>(a, b)   →   invoke('<domain>_<method>', {a: valueA, b: valueB})
window.api.<domain>.on<Event>(cb)    →   listen('<domain>-<event-kebab>', cb)
```

camelCase → snake_case conversion rule: insert underscore before each uppercase letter, lowercase the whole thing. `listByFolder` → `list_by_folder`.

**Rewrite order** (minimizes breakage):
1. `services/*.ts` first — these are thin wrappers; easiest to find/replace
2. `hooks/` — often call services but some call window.api directly
3. `contexts/` — auth-context, sync-context reach into window.api for boot
4. `features/**`, `pages/**`, `components/**` — UI layer

After each file rewrite: run `pnpm port:audit` and verify hit count decreases. Run `pnpm typecheck` after each group (services done, hooks done, etc.) to catch regressions early.

**Step 6: Delete Electron shims** (Task 15.6):

```bash
grep -rln 'contextBridge\|electronAPI\b' apps/desktop-tauri/src/ 2>/dev/null
```

Any file returned is an Electron-only shim. Delete with `git rm`. Common suspects:
- Any file importing `@electron-toolkit/preload`
- Any file with `contextBridge.exposeInMainWorld`

Also delete files like `generated-rpc.ts` or anything tied to Electron's preload pattern — they're dead in Tauri.

**Step 7: Replace `lib/ipc-error.ts`** (Task 15.6 part 2):

Overwrite with the simplified version from the plan:

```typescript
export function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message || fallback
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message) || fallback
  }
  return fallback
}
```

Unit test it:
- `extractErrorMessage(new Error('x'), 'fallback')` returns `'x'`
- `extractErrorMessage(new Error(''), 'fallback')` returns `'fallback'`
- `extractErrorMessage('raw', 'fallback')` returns `'raw'`
- `extractErrorMessage({message: 'y'}, 'fallback')` returns `'y'`
- `extractErrorMessage(null, 'fallback')` returns `'fallback'`
- `extractErrorMessage(undefined, 'fallback')` returns `'fallback'`

RED first, then GREEN, then commit.

**Step 8: Typecheck clean** (Task 15.8):

```bash
pnpm --filter @memry/desktop-tauri typecheck 2>&1 | tee /tmp/m1-h-typecheck.log | head -60
```

For each remaining error:
- Missing mock command → add it in `apps/desktop-tauri/src/lib/ipc/mocks/<domain>.ts`
- Type mismatch between invoke mock and service → widen mock type or tighten service. Prefer widening mock — real Rust types land in M2+.
- Lingering `window.api` import → rewrite.

Iterate until `pnpm typecheck` exits 0.

**Step 9: Final audit + commit** (Task 15.9):

```bash
pnpm --filter @memry/desktop-tauri port:audit
# expect "Total hits: 0"
pnpm --filter @memry/desktop-tauri typecheck
# expect clean
```

Commit per plan step 15.9.

### Constraints

- **Budget pacing.** This phase is big. Commit incrementally (one commit per major group: services done, hooks done, etc.). Do NOT try to ship it all in one giant commit — too hard to bisect later.
- **No shortcuts.** Do NOT add `@ts-ignore` to skip rewrites. Every call site gets a real rewrite or deletion. If a file looks like pure dead code and nothing imports it, consider deletion — but confirm with grep first (search for imports of the file).
- **Preserve service function signatures.** External callers of `NotesService.create(input)` should not change. Only the INSIDE of the service function changes.
- **Mock command completeness matters.** Each time a mock is missing, the dev run will throw at runtime. Safer to over-define mocks than under-define.

### Acceptance criteria (Phase H done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk

# Port audit clean
pnpm --filter @memry/desktop-tauri port:audit 2>&1 | grep -q 'Total hits: 0'

# Typecheck clean
pnpm --filter @memry/desktop-tauri typecheck

# Tests still pass (Phase D tests shouldn't have regressed; new port-audit tests added)
pnpm --filter @memry/desktop-tauri test

# preload/ directory was never created under Tauri
test ! -d apps/desktop-tauri/src/preload

# No contextBridge leftovers
! grep -rln 'contextBridge\|electronAPI\|@electron-toolkit' apps/desktop-tauri/src/ 2>/dev/null

# Commits landed (expect several — one per major group + one final)
git log --oneline | grep -c "m1(port)"   # expect ≥ 5 across Phases E-H combined
```

### When done

Report:

```
Phase H complete.
Tasks covered: 15
Commits: <N> (<first_hash>..<last_hash>)
Rewrites:
  - window.api call sites rewritten: <count>
  - ipcRenderer listeners rewritten: <count>
  - Files deleted (Electron shims): <count>
  - lib/ipc-error.ts replaced + tested
  - port-audit.ts added with <N> unit tests
Mock commands added during typecheck loop: <list or "none">
Verification:
  - pnpm port:audit: 0 hits
  - pnpm typecheck: clean
  - pnpm test: all pass
  - No contextBridge/electronAPI leftover in src/

Next: Phase I — prompts/m1-phase-i-rust-commands-bindings.md
Blockers: <none | list>
```

### Emergency

If typecheck cannot reach clean within a reasonable budget (e.g., 3-4 hours of work remaining after initial rewrite sweep), STOP and report:
- Remaining error count + categories (missing mocks / type mismatches / dead code references)
- Recommended path forward
- Wait for user input before continuing.

### Ready

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Task 15 fully (it's long).
3. Verify prerequisites.
4. Write port-audit tests FIRST (RED).

## PROMPT END
