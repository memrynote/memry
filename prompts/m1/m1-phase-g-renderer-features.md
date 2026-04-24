# M1 Phase G — Renderer Features + Pages + Services Port

Temiz session prompt. Phase F tamamlandıktan sonra başlat.

---

## PROMPT START

You are implementing **Phase G of Milestone M1** for Memry's Electron→Tauri migration. This phase ports the remaining renderer directories: `features/`, `pages/`, `services/`, `sync/`.

### Context

**Repo:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk`
**Branch:** `spike/tauri-risk-discovery`
**Plan:** `docs/superpowers/plans/2026-04-24-m1-tauri-skeleton-and-renderer-port.md`

### Prerequisite

**Phase F complete.** Verify:

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
test -d apps/desktop-tauri/src/components
diff <(cd apps/desktop/src/renderer/src/components && find . -type f | sort) \
     <(cd apps/desktop-tauri/src/components && find . -type f | sort) > /dev/null
```

If diff returns non-empty, STOP (Phase F incomplete).

### Your scope

Execute **Task 14** from the plan. Port:

- `apps/desktop/src/renderer/src/features/` → `apps/desktop-tauri/src/features/` (contains `inbox/`, `tasks/` subfolders per earlier recon)
- `apps/desktop/src/renderer/src/pages/` → `apps/desktop-tauri/src/pages/` (calendar, file, folder-view, inbox, journal, note, settings, tasks, template-editor, templates)
- `apps/desktop/src/renderer/src/services/` → `apps/desktop-tauri/src/services/` (notes-service, tasks-service, vault-service, etc. — 15+ files)
- `apps/desktop/src/renderer/src/sync/` → `apps/desktop-tauri/src/sync/` (yjs-ipc-provider and related — if exists)

### Methodology

1. **Invoke `superpowers:using-superpowers`** first.
2. **Read Task 14 fully** from the plan.
3. **Mechanical bulk copy.** Four rsync commands in step 14.1.
4. **File count sanity check** step 14.2 — Tauri total should match Electron total within a few files.

### TDD notes

Mechanical copy — no TDD. Verification-before-completion:

- After step 14.1: all four directories exist in `apps/desktop-tauri/src/`
- After step 14.2: file counts match. If Tauri is missing ≥ 5 files, investigate which rsync failed.

### Constraints

- **Sync directory may not exist** on Electron side — the `rsync ... sync/ ... 2>/dev/null || true` in step 14.1 is defensive. If the directory doesn't exist, no-op is fine; continue.
- **Services reference `@memry/rpc/*`** — don't touch those imports. Package aliases resolve via `vite.config.ts` and `tsconfig.json` from Phase A.
- **Test files in services/ (e.g. `notes-service.test.ts`)** get copied too. They may fail in Tauri context until Phase H. Do not delete them — they're the spec for Phase H's correctness check.
- **One commit** for this phase.

### Acceptance criteria (Phase G done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk

# Directories present
test -d apps/desktop-tauri/src/features
test -d apps/desktop-tauri/src/pages
test -d apps/desktop-tauri/src/services

# File count parity
electron_count=$(find apps/desktop/src/renderer/src -type f \( -name '*.ts' -o -name '*.tsx' \) | wc -l)
tauri_count=$(find apps/desktop-tauri/src -type f \( -name '*.ts' -o -name '*.tsx' \) -not -path '*/generated/*' | wc -l)
diff=$((electron_count - tauri_count))
# diff should be ≤ 5 (accounting for authored IPC files, deleted preload shims, etc.)
# If diff > 20, investigate missing rsync

# Spot-check specific files
test -f apps/desktop-tauri/src/services/notes-service.ts
test -f apps/desktop-tauri/src/services/tasks-service.ts
test -f apps/desktop-tauri/src/pages/calendar.tsx
test -f apps/desktop-tauri/src/pages/settings/tasks-section.tsx 2>/dev/null || echo "check page naming"

# Commit landed
git log --oneline -1 | grep -q "m1(port)"
```

### When done

Report:

```
Phase G complete.
Tasks covered: 14
Commits: 1 (<hash>)
Directories ported: features/, pages/, services/, sync/(if present)
File counts:
  - Electron renderer total: <N>
  - Tauri total: <M>
  - Delta: <N-M> (expected ≤ 5)

Typecheck errors: <count> (expected — Phase H fixes)
Next: Phase H — prompts/m1-phase-h-window-api-rewrite.md
Blockers: <none | list>
```

### Ready

1. Invoke `superpowers:using-superpowers`.
2. Read plan Task 14.
3. Verify prerequisites.
4. Run rsync commands, verify counts, commit.

## PROMPT END
