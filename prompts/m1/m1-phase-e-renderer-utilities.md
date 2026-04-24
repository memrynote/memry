# M1 Phase E — Renderer Utility Modules Port

Temiz session prompt. Phase D tamamlandıktan sonra başlat.

---

## PROMPT START

You are implementing **Phase E of Milestone M1** for Memry's Electron→Tauri migration. This phase ports renderer utility modules (entry points, lib, hooks, contexts, types) from Electron to Tauri.

### Context

**Repo:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk`
**Branch:** `spike/tauri-risk-discovery`
**Plan:** `docs/superpowers/plans/2026-04-24-m1-tauri-skeleton-and-renderer-port.md`

### Prerequisite

**Phase D complete.** Verify:

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
test -f apps/desktop-tauri/src/lib/ipc/invoke.ts
test $(ls apps/desktop-tauri/src/lib/ipc/mocks/*.ts | wc -l) -ge 21
pnpm --filter @memry/desktop-tauri test 2>&1 | tail -3 | grep -q 'passed'
```

If any fails, STOP.

### Your scope

Execute **Task 12** from the plan. This ports:

- Entry points: `main.tsx`, `App.tsx`
- Utility modules: `lib/` (excluding `ipc/` which was authored in Phase D), `hooks/`, `contexts/`, `data/` (if exists), `types/`

### Methodology

1. **Invoke `superpowers:using-superpowers`** first.
2. **Read Task 12 fully** from the plan.
3. **Mechanical port.** Use the exact rsync commands from Task 12.2. Do not selectively copy — bulk-copy directories and let typecheck reveal what needs attention.
4. **Do NOT fix typecheck errors in this phase.** Task 12.4 explicitly expects `window.api` + `ipcRenderer` type errors. Phase H (window.api rewrite) is where those are fixed. Your job here is: mechanical copy, note the errors, commit, stop.

### TDD notes

This phase is 100% mechanical file copy. TDD does not apply. Instead use **verification-before-completion**:

- After Task 12.1: `diff apps/desktop/src/renderer/src/main.tsx apps/desktop-tauri/src/main.tsx` shows the files are identical
- After Task 12.2: `diff <(cd apps/desktop/src/renderer/src/lib && find . -type f | grep -v '^\./ipc/' | sort) <(cd apps/desktop-tauri/src/lib && find . -type f | grep -v '^\./ipc/' | sort)` is empty
- Same pattern for hooks, contexts, types
- After Task 12.3: `ls apps/desktop-tauri/src/lib/ipc/` shows only `invoke.ts`, `events.ts`, `mocks/` (nothing ported into that folder)

### Constraints

- **Exclude `lib/ipc/`:** The `rsync --exclude='ipc/'` flag in step 12.2 is critical. If you skip the exclude, you'll overwrite Phase D work. Double-check the command before running.
- **Do not modify copied files.** They'll be broken (referencing `window.api`) — that's Task 15's problem.
- **Preserve directory structure exactly.** If Electron has `contexts/tabs/context.tsx` + `contexts/tabs/provider.tsx`, Tauri should have the same.
- **Do NOT run typecheck expecting clean.** It will have dozens of errors — acknowledge in commit message and move on.

### Acceptance criteria (Phase E done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk

# Entry points ported
test -f apps/desktop-tauri/src/main.tsx
test -f apps/desktop-tauri/src/App.tsx

# Utility dirs ported (structure matches Electron)
test -d apps/desktop-tauri/src/lib
test -d apps/desktop-tauri/src/hooks
test -d apps/desktop-tauri/src/contexts
test -d apps/desktop-tauri/src/types

# lib/ipc/ still Phase D content only
test -f apps/desktop-tauri/src/lib/ipc/invoke.ts
test -f apps/desktop-tauri/src/lib/ipc/events.ts
test -d apps/desktop-tauri/src/lib/ipc/mocks
ls apps/desktop-tauri/src/lib/ipc/ | wc -l   # should be 3 (invoke.ts, events.ts, mocks/)

# File counts approximately match (Electron lib/ count vs Tauri lib/ count minus ipc/)
electron_count=$(find apps/desktop/src/renderer/src/lib -type f \( -name '*.ts' -o -name '*.tsx' \) | wc -l)
tauri_count=$(find apps/desktop-tauri/src/lib -type f \( -name '*.ts' -o -name '*.tsx' \) -not -path '*/ipc/*' | wc -l)
# tauri_count should equal electron_count (or be off by at most 1 for ipc-error.ts delta)

# Typecheck INTENTIONALLY fails (Phase H fixes)
pnpm --filter @memry/desktop-tauri typecheck 2>&1 | grep -c 'error TS' | awk '$1 > 10 {exit 0} {exit 1}'

# Commit landed
git log --oneline | grep -c "m1(port)"   # expect ≥ 1 for Task 12
```

### When done

Report:

```
Phase E complete.
Tasks covered: 12
Commits: 1 (<hash>)
Files ported:
  - main.tsx, App.tsx
  - lib/ (<count> files, ipc/ preserved from Phase D)
  - hooks/ (<count>)
  - contexts/ (<count>)
  - types/ (<count>)
Typecheck: <count> errors (expected — fixed in Phase H)

Next: Phase F — prompts/m1-phase-f-renderer-components.md
Blockers: <none | list>
```

### Ready

1. Invoke `superpowers:using-superpowers`.
2. Read plan Task 12.
3. Verify prerequisites.
4. Start Task 12.1 with Task 12.3 sanity check before committing.

## PROMPT END
