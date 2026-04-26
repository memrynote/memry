# M5 Phase O - Final Verification + Ledger

Fresh session prompt. This phase closes M5 with full verification, manual dogfood, and
carry-forward bookkeeping.

---

## PROMPT START

You are implementing **Phase O of Milestone M5**. This phase executes plan Tasks
72-74 from `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5`
**Branch:** `m5/notes-crud-blocknote-crdt`
**Plan:** `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`
**Previous phase:** `prompts/m5/m5-phase-n-runtime-e2e.md`

All implementation phases should be complete. Phase O adds no planned feature work; it
verifies, fixes only real verification issues, and records the carry-forward ledger.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
git status --short
test -f apps/desktop-tauri/e2e/runtime/run-runtime-e2e.ts
pnpm --filter @memry/desktop-tauri command:parity
```

If implementation is incomplete, STOP and return to the missing phase.

### Your Scope

Execute Tasks 72-74 in order:

- **Task 72:** Run full local verification: Rust fmt/check/clippy/test, renderer lint/
  typecheck/test, bindings, capabilities, parity, mock e2e, runtime e2e.
- **Task 73:** Run manual dogfood against a fresh real vault with `VITE_MOCK_IPC=false`.
- **Task 74:** Update PR body or milestone ledger with M5 carry-forward details.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:verification-before-completion`.
2. Use `superpowers:systematic-debugging` for any failing command whose cause is not
   obvious.
3. Do not add new feature scope in this phase.
4. If fixes are required, make the smallest patch, rerun the failing check, then rerun
   the relevant full gate.
5. Commit fixes with narrow messages. Commit ledger/doc changes only if source docs
   actually changed.

### Automated Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5

pnpm --filter @memry/desktop-tauri cargo:fmt -- --check
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
pnpm --filter @memry/desktop-tauri cargo:test

pnpm --filter @memry/desktop-tauri lint
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri command:parity

pnpm --filter @memry/desktop-tauri test:e2e
pnpm --filter @memry/desktop-tauri test:e2e:runtime
```

Expected: all pass before M5 is considered complete.

### Manual Dogfood Checklist

Run against a fresh vault with `VITE_MOCK_IPC=false`:

- create note, type 500+ chars, restart, content remains
- rename note, move folder, reorder within folder
- delete note, verify it disappears and vault/trash behavior matches Task 27
- wiki-link resolve and hover preview work
- file note metadata opens and reveal-in-Finder works
- local-only toggle and count update
- property create/update/options/status flows work in folder view
- attachment upload/list/delete shows M6 deferred error shape without data loss
- export/import/version commands show M8 deferred shape and are production-ledgered

### Ledger Content

Record the Task 74 carry-forward ledger in the PR body or milestone ledger:

```markdown
## M5 Carry-Forward Ledger

- M4 baseline command audit: `/tmp/m4-parity-baseline.txt`
- M5 final command audit: output from `pnpm --filter @memry/desktop-tauri command:parity`
- Real in M5: notes CRUD, folders, properties, positions, local-only, wiki-link helpers,
  note file open/reveal, CRDT open/apply/snapshot/state-vector/sync-step/chunk helpers
- Deferred M6: attachment upload/list/delete if not fully local metadata-backed; cloud
  blob upload/download
- Deferred M7: FTS-backed wiki-link/search ranking
- Deferred M8: import/export/pdf/html/version history and remaining editor chrome
- Retired aliases: `sync_crdt_*` -> `crdt_*`
- Production mock guard: enabled and tested
- Runtime e2e evidence: typing p95, persistence, slash, undo/redo, concurrent edit,
  state coverage
- Known warnings carried forward: exact warning, owner milestone, non-blocking reason
```

### When Done

Report:

```text
Phase O complete.
Tasks covered: 72, 73, 74
Commits: <count> (<first hash>..<last hash>)
Automated verification: <all commands and result>
Manual verification: <dogfood result>
Carry-forward ledger: <recorded | not changed, reason>
Blockers: <none | list>
```

## PROMPT END
