# M5 Phase G - Property Commands

Fresh session prompt. This phase ships the property-definition command surface.

---

## PROMPT START

You are implementing **Phase G of Milestone M5**. This phase executes plan Tasks
36-37 from `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5`
**Branch:** `m5/notes-crud-blocknote-crdt`
**Plan:** `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`
**Previous phase:** `prompts/m5/m5-phase-f-folder-commands.md`

The property DB module exists. Phase G exposes it through Tauri commands.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
test -f apps/desktop-tauri/src-tauri/src/db/property_definitions.rs
pnpm --filter @memry/desktop-tauri cargo:test -- --test db_property_definitions_test
```

If this fails, STOP and finish Phase C.

### Your Scope

Execute Tasks 36-37 in order:

- **Task 36:** Create `commands/properties.rs`; implement
  `notes_get_property_definitions`, `notes_create_property_definition`,
  `notes_update_property_definition`, and `notes_ensure_property_definition`.
- **Task 37:** Implement `notes_add_property_option`, `notes_add_status_option`,
  `notes_remove_property_option`, `notes_rename_property_option`,
  `notes_update_option_color`, and `notes_delete_property_definition`.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 36-37 fully before editing.
3. Commands should be thin wrappers over `db::property_definitions`.
4. Accept permissive JSON payloads where the current renderer contract is loose.
5. Emit/subscribe to `folder-config-updated` only where the current renderer expects it.
6. Commit once per task.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5

test -f apps/desktop-tauri/src-tauri/src/commands/properties.rs
test -f apps/desktop-tauri/src-tauri/tests/commands_properties_test.rs
rg -n "notes_add_property_option|notes_delete_property_definition" apps/desktop-tauri/src-tauri/src

cd apps/desktop-tauri/src-tauri
cargo test --test commands_properties_test

cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

### When Done

Report:

```text
Phase G complete.
Tasks covered: 36, 37
Commits: <count> (<first hash>..<last hash>)
Verification: commands_properties_test + bindings check + clippy
Next: Phase H - prompts/m5/m5-phase-h-deferred-stubs-parity.md
Blockers: <none | list>
```

## PROMPT END
