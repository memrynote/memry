# M1 Phase F — Renderer Components Port

Temiz session prompt. Phase E tamamlandıktan sonra başlat.

---

## PROMPT START

You are implementing **Phase F of Milestone M1** for Memry's Electron→Tauri migration. This phase bulk-copies the `components/` directory verbatim.

### Context

**Repo:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk`
**Branch:** `spike/tauri-risk-discovery`
**Plan:** `docs/superpowers/plans/2026-04-24-m1-tauri-skeleton-and-renderer-port.md`

### Prerequisite

**Phase E complete.** Verify:

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk
test -f apps/desktop-tauri/src/main.tsx
test -d apps/desktop-tauri/src/lib
test -d apps/desktop-tauri/src/hooks
test -d apps/desktop-tauri/src/contexts
```

If any fails, STOP.

### Your scope

Execute **Task 13** from the plan. Bulk-copy `apps/desktop/src/renderer/src/components/` → `apps/desktop-tauri/src/components/` using rsync.

Per the earlier recon, this directory contains subfolders: `journal/`, `tabs/`, `sidebar/`, `ui/`, `note/`, `settings/`, `hint-overlay/`, `tasks/`, `bulk/`, `calendar/`, `inbox/`, `day-panel/`, `folder-view/`, `reminder/`, `graph/`, `empty-state/`, `shared/`, `search/`, `hooks/`, `viewers/`.

### Methodology

1. **Invoke `superpowers:using-superpowers`** first.
2. **Read Task 13 fully** from the plan (it's short).
3. **Single rsync command** from step 13.1.
4. **Structural diff verification** step 13.2 — must return empty diff. If non-empty, investigate before committing.

### TDD notes

Pure file copy — no TDD. Use **verification-before-completion**:

- Step 13.2 diff must be empty
- `pnpm --filter @memry/desktop-tauri typecheck` will show MORE errors than after Phase E (because components reference window.api, contexts, etc.). This is expected.

### Constraints

- **One commit for this phase** — a single `m1(port): copy components/ verbatim` commit covering the entire directory.
- **Do NOT modify copied files.** Errors are expected. Phase H fixes them.
- **BlockNote-specific files** in `components/` (editor wrappers, slash menu customizations) get copied as-is. Their runtime behavior will be verified in Phase J smoke run, not here.

### Acceptance criteria (Phase F done when all pass)

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-risk

# Directory present
test -d apps/desktop-tauri/src/components

# Structural parity
diff <(cd apps/desktop/src/renderer/src/components && find . -type f | sort) \
     <(cd apps/desktop-tauri/src/components && find . -type f | sort)
# Expected: exit 0 (no diff)

# Spot check — a few representative files exist
test -f apps/desktop-tauri/src/components/ui/button.tsx
test -f apps/desktop-tauri/src/components/note/note-editor.tsx 2>/dev/null || echo "file may have different name; grep for note-editor"
test -d apps/desktop-tauri/src/components/sidebar
test -d apps/desktop-tauri/src/components/graph

# Commit landed
git log --oneline -1 | grep -q "m1(port)"
```

### When done

Report:

```
Phase F complete.
Tasks covered: 13
Commits: 1 (<hash>)
Components directory: <subfolder count> subfolders, <total file count> files
Verification:
  - Structural diff vs Electron: empty
  - Spot-check files present

Next: Phase G — prompts/m1-phase-g-renderer-features.md
Blockers: <none | list>
```

### Ready

1. Invoke `superpowers:using-superpowers`.
2. Read plan Task 13.
3. Verify prerequisites.
4. Run rsync, verify diff, commit.

## PROMPT END
