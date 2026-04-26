# M5 Phase A - CRDT Foundation

Fresh session prompt. This phase lands the Rust `yrs` CRDT core before any command
exposes it.

---

## PROMPT START

You are implementing **Phase A of Milestone M5** for Memry's Electron to Tauri
migration. This phase executes plan Tasks 1-9 from
`docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5`
**Branch:** `m5/notes-crud-blocknote-crdt`
**Plan:** `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
**Prompts README:** `prompts/m5/README.md`

M5 replaces mock notes/CRDT behavior with a Rust-owned authoritative Y.Doc runtime.
Phase A only builds the Rust CRDT core. It does not add DB persistence, commands,
renderer wiring, or runtime e2e.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
git rev-parse --abbrev-ref HEAD                  # expect: m5/notes-crud-blocknote-crdt
git log --oneline main | head -10                # expect M4 merged
test -f apps/desktop-tauri/src-tauri/Cargo.toml
test -f apps/desktop-tauri/src-tauri/src/error.rs
test -f apps/desktop-tauri/src-tauri/src/app_state.rs
test -f apps/desktop-tauri/src-tauri/src/lib.rs
grep -q '^yrs = "0.21"' apps/desktop-tauri/src-tauri/Cargo.toml
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:test
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri command:parity
```

If any command fails, STOP and report. Do not start M5 on an unverified M4 base.

### Your Scope

Execute Tasks 1-9 in order:

- **Task 1:** Add `lru` and `once_cell` dependencies.
- **Task 2:** Add `AppError::Crdt` and `From<yrs>` decode/apply error impls.
- **Task 3:** Add `crdt/mod.rs`, `CrdtRuntime`, origin tag, and `AppState` wiring.
- **Task 4:** Implement `DocStore`, `DocHandle`, `get_or_init`, `get`, `drop_doc`.
- **Task 5:** Implement `crdt/apply.rs` with `apply_update_v1`.
- **Task 6:** Implement `crdt/snapshot.rs` with snapshot and diff encoders.
- **Task 7:** Implement `crdt/state_vector.rs`.
- **Task 8:** Implement `crdt/compaction.rs` and threshold constants.
- **Task 9:** Implement `crdt/wire.rs` with `CRDT_UPDATE_EVENT` and payload types.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 1-9 fully before editing. Use the code snippets there as the
   implementation baseline, but adapt to the exact repo APIs.
3. Keep the outer `DocStore` map lock short. Do not hold it across Yjs transactions.
4. Stamp updates with a stable non-zero origin tag.
5. Commit once per task when source changed.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5

test -f apps/desktop-tauri/src-tauri/src/crdt/mod.rs
test -f apps/desktop-tauri/src-tauri/src/crdt/docstore.rs
test -f apps/desktop-tauri/src-tauri/src/crdt/apply.rs
test -f apps/desktop-tauri/src-tauri/src/crdt/snapshot.rs
test -f apps/desktop-tauri/src-tauri/src/crdt/state_vector.rs
test -f apps/desktop-tauri/src-tauri/src/crdt/compaction.rs
test -f apps/desktop-tauri/src-tauri/src/crdt/wire.rs

cd apps/desktop-tauri/src-tauri
cargo test --test error_crdt_test
cargo test --test crdt_runtime_test
cargo test --test crdt_docstore_test
cargo test --test crdt_apply_test
cargo test --test crdt_snapshot_test
cargo test --test crdt_state_vector_test
cargo test --test crdt_compaction_test
cargo test --test crdt_wire_test

cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
pnpm --filter @memry/desktop-tauri cargo:test -- --test 'crdt_*'
```

### When Done

Report:

```text
Phase A complete.
Tasks covered: 1, 2, 3, 4, 5, 6, 7, 8, 9
Commits: <count> (<first hash>..<last hash>)
Verification: crdt/error tests + cargo check/clippy/test
Next: Phase B - prompts/m5/m5-phase-b-db-schema-notes.md
Blockers: <none | list>
```

## PROMPT END
