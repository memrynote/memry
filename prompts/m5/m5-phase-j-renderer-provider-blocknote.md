# M5 Phase J - Renderer Provider + BlockNote Binding

Fresh session prompt. This phase wires the renderer Y.Doc shadow state to the Rust CRDT
commands and BlockNote editor.

---

## PROMPT START

You are implementing **Phase J of Milestone M5**. This phase executes plan Tasks
47-50 from `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5`
**Branch:** `m5/notes-crud-blocknote-crdt`
**Plan:** `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`
**Previous phase:** `prompts/m5/m5-phase-i-crdt-commands.md`

The Rust CRDT commands exist. Phase J adds the renderer provider, origin echo guard,
BlockNote binding, and graduated mock route removal for this slice.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
rg -n "crdt_get_or_init_doc|crdt_apply_update|crdt-update" apps/desktop-tauri/src-tauri/src
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
```

If this fails, STOP and finish Phase I.

### Your Scope

Execute Tasks 47-50 in order:

- **Task 47:** Create `src/lib/crdt/origin-tags.ts` and tests.
- **Task 48:** Create `src/lib/crdt/yjs-tauri-provider.ts` and tests.
- **Task 49:** Wire the current BlockNote `ContentArea`/collaboration hook to the
  Rust-backed Yjs provider.
- **Task 50:** Add real M5 commands to renderer IPC allowlist and delete graduated
  notes/folders/properties/CRDT mocks, leaving only deferred routes.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 47-50 fully before editing.
3. Keep one provider path. Do not leave a parallel unused provider implementation.
4. Fragment name is exactly `prosemirror`.
5. Echo prevention must drop events whose origin matches the renderer origin.
6. Do not hide real Rust command failures by falling back to mocks.
7. Commit once per task.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5

test -f apps/desktop-tauri/src/lib/crdt/origin-tags.ts
test -f apps/desktop-tauri/src/lib/crdt/yjs-tauri-provider.ts
rg -n "prosemirror|YjsTauriProvider|crdt_apply_update" apps/desktop-tauri/src

pnpm --filter @memry/desktop-tauri test -- src/lib/crdt/origin-tags.test.ts
pnpm --filter @memry/desktop-tauri test -- src/lib/crdt/yjs-tauri-provider.test.ts
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri command:parity
pnpm --filter @memry/desktop-tauri test:e2e -- --grep="@mock-lane"
```

If the mock lane is intentionally marked runtime-only for CRDT-backed editor behavior,
document the exact skipped tests and why.

### When Done

Report:

```text
Phase J complete.
Tasks covered: 47, 48, 49, 50
Commits: <count> (<first hash>..<last hash>)
Verification: crdt renderer tests + full test + command parity + mock lane result
Next: Phase K - prompts/m5/m5-phase-k-md-to-yjs-seed.md
Blockers: <none | list>
```

## PROMPT END
