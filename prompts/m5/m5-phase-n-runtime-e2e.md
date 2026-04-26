# M5 Phase N - Runtime E2E Lane

Fresh session prompt. This phase adds the first real Tauri runtime e2e lane.

---

## PROMPT START

You are implementing **Phase N of Milestone M5**. This phase executes plan Tasks
65-71 from `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5`
**Branch:** `m5/notes-crud-blocknote-crdt`
**Plan:** `docs/superpowers/plans/2026-04-26-m5-notes-crud-blocknote-crdt.md`
**Previous phase:** `prompts/m5/m5-phase-m-renderer-legacy-contract-cleanup.md`

M5 must prove real Tauri runtime behavior, not only mock-lane React tests. This phase
adds the additive `test:e2e:runtime` lane with tauri-driver/WebDriverIO.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri command:parity
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri test:e2e
```

If the mock lane is not green, STOP and fix earlier phases first.

### Your Scope

Execute Tasks 65-71 in order:

- **Task 65:** Add runtime e2e dependencies/scripts/config. Install or document
  `tauri-driver`.
- **Task 66:** Add runtime runner and helpers for driver, vault, and devtools.
- **Task 67:** Add typing p95 and restart persistence scenarios.
- **Task 68:** Add slash/table/code/link, undo/redo, and paste/manual coverage.
- **Task 69:** Add concurrent-edit convergence scenario using real `crdt_*` commands.
- **Task 70:** Add empty/loading/error/offline/capability-denied state coverage.
- **Task 71:** Run runtime lane and mock lane close-out.

### Methodology

1. Invoke `superpowers:using-superpowers`, `superpowers:test-driven-development`, and
   `superpowers:systematic-debugging` for flaky runtime failures.
2. Read plan Tasks 65-71 fully before editing.
3. Runtime lane is additive. Do not change `test:e2e` away from the fast mock lane.
4. Each runtime test uses a fresh temp vault under `$TMPDIR/memry-e2e-<uuid>`.
5. Use `MEMRY_DEVICE` and `MEMRY_ORIGIN_TAG` to make multi-device cases deterministic.
6. Do not fake CRDT convergence in JS. Drive the real runtime command path.
7. Commit once per task.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m5

test -f apps/desktop-tauri/e2e/runtime/run-runtime-e2e.ts
test -f apps/desktop-tauri/e2e/runtime/helpers/driver.ts
test -f apps/desktop-tauri/e2e/runtime/helpers/vault.ts
test -f apps/desktop-tauri/e2e/runtime/helpers/devtools.ts
test -f apps/desktop-tauri/e2e/runtime/specs/typing.spec.ts
test -f apps/desktop-tauri/e2e/runtime/specs/persistence.spec.ts
test -f apps/desktop-tauri/e2e/runtime/specs/concurrent-edit.spec.ts
test -f apps/desktop-tauri/e2e/runtime/specs/states.spec.ts

pnpm --filter @memry/desktop-tauri test:e2e:runtime
pnpm --filter @memry/desktop-tauri test:e2e
```

Document any paste skip only if WebDriver clipboard support is unavailable, and keep the
manual checklist under `e2e/runtime/manual/clipboard-paste.md`.

### When Done

Report:

```text
Phase N complete.
Tasks covered: 65, 66, 67, 68, 69, 70, 71
Commits: <count> (<first hash>..<last hash>)
Verification: runtime e2e + mock e2e
Next: Phase O - prompts/m5/m5-phase-o-final-verification-ledger.md
Blockers: <none | list>
```

## PROMPT END
