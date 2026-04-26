# M5 Phase L - Registration, Devtools, Capabilities, Bindings

Fresh session prompt. This phase makes all M5 commands reachable, adds debug-only
runtime helpers, and aligns bindings/capabilities/events/parity.

---

## PROMPT START

You are implementing **Phase L of Milestone M5**. This phase executes plan Tasks
53-56 from `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5`
**Branch:** `m5/notes-crud-blocknote-crdt`
**Plan:** `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`
**Previous phase:** `prompts/m5/m5-phase-k-md-to-yjs-seed.md`

Command modules exist, but M5 is not complete until registrations, generated bindings,
capabilities, parity audit, and event names agree.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
test -f apps/desktop-tauri/src-tauri/src/commands/notes.rs
test -f apps/desktop-tauri/src-tauri/src/commands/folders.rs
test -f apps/desktop-tauri/src-tauri/src/commands/properties.rs
test -f apps/desktop-tauri/src-tauri/src/commands/crdt.rs
pnpm --filter @memry/desktop-tauri cargo:check
```

If this fails, STOP and finish implementation phases first.

### Your Scope

Execute Tasks 53-56 in order:

- **Task 53:** Add debug/test-only `commands/devtools.rs`, `capabilities/dev.json`,
  tests, and cfg-gated registration.
- **Task 54:** Register every M5 command in `generate_handler![]`, Specta/bindings
  generation, and `examples/generate_bindings.rs`.
- **Task 55:** Add default capability grants, command parity `REQUIRED_REAL` and
  `RETIRED` aliases, plus production mock guard in `src/lib/ipc/invoke.ts`.
- **Task 56:** Add event-name parity tests for Rust emissions and renderer
  subscriptions.

### Methodology

1. Invoke `superpowers:using-superpowers`, `superpowers:test-driven-development`, and
   `superpowers:verification-before-completion`.
2. Read plan Tasks 53-56 fully before editing.
3. `devtools_*` must compile only under debug/test-helper gates and must not appear in
   production `default.json`.
4. Register every real M5 command exactly once.
5. `sync_crdt_*` aliases are retired. The audit must fail if literals remain.
6. Commit once per task.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5

test -f apps/desktop-tauri/src-tauri/src/commands/devtools.rs
test -f apps/desktop-tauri/src-tauri/capabilities/dev.json
test -f apps/desktop-tauri/src-tauri/tests/commands_devtools_test.rs

pnpm --filter @memry/desktop-tauri cargo:test -- --test commands_devtools_test
pnpm --filter @memry/desktop-tauri bindings:generate
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri command:parity
pnpm --filter @memry/desktop-tauri test -- scripts/command-parity-audit.test.ts
pnpm --filter @memry/desktop-tauri test -- src/services/notes-service.test.ts
```

Expected: generated `Commands` includes all real M5 commands and no production
`devtools_*` commands.

### When Done

Report:

```text
Phase L complete.
Tasks covered: 53, 54, 55, 56
Commits: <count> (<first hash>..<last hash>)
Verification: devtools test + bindings/capability/parity + event tests
Next: Phase M - prompts/m5/m5-phase-m-renderer-legacy-contract-cleanup.md
Blockers: <none | list>
```

## PROMPT END
