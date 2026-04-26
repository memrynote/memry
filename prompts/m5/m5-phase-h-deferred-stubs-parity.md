# M5 Phase H - Deferred Stubs + Parity Ledger

Fresh session prompt. This phase classifies editor-adjacent command surface: real file
metadata/open/reveal commands plus explicit deferred M6/M8 stubs.

---

## PROMPT START

You are implementing **Phase H of Milestone M5**. This phase executes plan Tasks
38-39 from `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5`
**Branch:** `m5/notes-crud-blocknote-crdt`
**Plan:** `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`
**Previous phase:** `prompts/m5/m5-phase-g-property-commands.md`

The core notes/folder/property commands exist. Phase H prevents command parity drift by
classifying everything editor-adjacent that M5 does not own yet.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri command:parity || true
```

The parity command may still show unclassified M5 routes at the start of this phase.

### Your Scope

Execute Tasks 38-39 in order:

- **Task 38:** Create `commands/stubs_m6_m7_m8.rs`; implement real M5
  `notes_get_file`, `notes_open_external`, and `notes_reveal_in_finder`.
- **Task 39:** Create renderer deferred mock route files for attachments/export/
  versions/import, wire them into the mock router, and update the command parity
  deferred ledger.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 38-39 fully before editing.
3. `notes_open_external` and `notes_reveal_in_finder` must delegate to existing shell
   helpers. Add `*_inner` helper seams only if needed for tests.
4. Deferred mocks must include clear `deferred:M6` or `deferred:M8` markers.
5. Do not register export/import/version/attachment commands as real M5 commands.
6. Commit once per task.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5

test -f apps/desktop-tauri/src-tauri/src/commands/stubs_m6_m7_m8.rs
test -f apps/desktop-tauri/src/lib/ipc/mocks/stubs/attachments.ts
test -f apps/desktop-tauri/src/lib/ipc/mocks/stubs/export.ts
test -f apps/desktop-tauri/src/lib/ipc/mocks/stubs/versions.ts
test -f apps/desktop-tauri/src/lib/ipc/mocks/stubs/import.ts
rg -n "deferred:M6|deferred:M8" apps/desktop-tauri/src/lib/ipc/mocks apps/desktop-tauri/scripts

pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri command:parity
pnpm --filter @memry/desktop-tauri test
```

Expected: zero unclassified notes/folder/property/editor-adjacent commands after the
ledger update.

### When Done

Report:

```text
Phase H complete.
Tasks covered: 38, 39
Commits: <count> (<first hash>..<last hash>)
Verification: cargo check + command parity + renderer tests
Next: Phase I - prompts/m5/m5-phase-i-crdt-commands.md
Blockers: <none | list>
```

## PROMPT END
