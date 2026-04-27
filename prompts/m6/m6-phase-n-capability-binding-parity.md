# M6 Phase N - Capability, Binding + Parity Closure

Fresh session prompt. This phase closes generated bindings, capability coverage, and
command parity after all M6 commands have real implementations.

---

## PROMPT START

You are implementing **Phase N of Milestone M6**. This phase executes Chunk 14 from
`docs/superpowers/plans/2026-04-27-m6-sync-engine.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6`
**Branch:** `m6/sync-engine`
**Plan:** `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
**Previous phase:** `prompts/m6/m6-phase-m-runtime-e2e-staging.md`

Phase N adds no feature scope. It fixes only generated artifact, capability, parity, or
formatting issues caused by earlier M6 work.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6
git status --short --branch
pnpm --filter @memry/desktop-tauri cargo:test -- --test commands_sync_ops_test --test sync_attachments_test
pnpm --filter @memry/desktop-tauri test -- src/contexts/sync-context.test.tsx
```

If implementation tests fail, STOP and return to the owning phase.

### Your Scope

Execute Chunk 14 in order:

- **Step 1:** Regenerate bindings.
- **Step 2:** Run binding check.
- **Step 3:** Close capability coverage.
- **Step 4:** Close command parity.
- **Step 5:** Run formatting.

### Required Reads

Read these before editing:

- `AGENTS.md`
- `CLAUDE.md`
- `apps/desktop-tauri/scripts/command-parity-audit.ts`
- `apps/desktop-tauri/src/generated/bindings.ts`
- `apps/desktop-tauri/src-tauri/capabilities/default.json`
- `apps/desktop-tauri/src-tauri/build.rs`
- `apps/desktop-tauri/src/lib/ipc/invoke.ts`
- `apps/desktop-tauri/src/lib/ipc/mocks/sync.ts`
- `docs/superpowers/plans/2026-04-27-m6-sync-engine.md` Chunk 14

### Methodology

1. Invoke `superpowers:using-superpowers` and
   `superpowers:verification-before-completion`.
2. Regenerate generated artifacts with the repo script. Do not hand-edit generated
   bindings unless the generator is broken and you have stopped to document that.
3. Capability check must prove every registered M6 command has an allow grant.
4. Command parity expected state:
   - `notes_upload_attachment`, `notes_list_attachments`, and `notes_delete_attachment`
     are real.
   - all `sync_ops_*` are real.
   - quarantine list/retry/delete is real or explicitly UI-deferred with no live call
     site.
   - no unclassified `sync:*`, `sync-ops:*`, `devices:*`, `attachments:*`, or sync
     event channels remain.
   - M7/M8/M9 deferrals are explicit.
5. Run formatting and fix only formatting or generated-artifact drift in this phase.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6

pnpm --filter @memry/desktop-tauri bindings:generate
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri command:parity
pnpm --filter @memry/desktop-tauri cargo:fmt
pnpm exec prettier --check apps/desktop-tauri/src apps/desktop-tauri/e2e/runtime
```

Expected: PASS.

### When Done

Report:

```text
Phase N complete.
Plan chunk: 14
Commits: <count> (<first hash>..<last hash>)
Verification: bindings + capability + command parity + formatting
Next: Phase O - prompts/m6/m6-phase-o-final-verification-gate.md
Blockers: <none | list>
```

## PROMPT END
