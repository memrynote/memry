# M6 Phase A - Contract Extraction + Ledger Lock

Fresh session prompt. This phase freezes the sync-server protocol source of truth,
adds shared fixtures, and tightens the command parity ledger before Rust sync commands
exist.

---

## PROMPT START

You are implementing **Phase A of Milestone M6** for Memry's Electron to Tauri
migration. This phase executes Chunk 1 from
`docs/superpowers/plans/2026-04-27-m6-sync-engine.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6`
**Branch:** `m6/sync-engine`
**Plan:** `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
**Prompts README:** `prompts/m6/README.md`

M6 replaces the remaining mock sync and attachment surface with a real Rust sync
engine. Phase A does not implement Rust commands. It locks the protocol and ledger so
later phases cannot accidentally ship renderer-only sync behavior.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6
git rev-parse --abbrev-ref HEAD                  # expect: m6/sync-engine
git log --oneline --decorate -12                 # expect M5 merged
git status --short --branch
test -f AGENTS.md
test -f CLAUDE.md
test -f docs/superpowers/plans/2026-04-27-m6-sync-engine.md
test -f docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri command:parity
pnpm --filter @memry/sync-server test -- src/routes/sync.test.ts src/routes/blob.test.ts src/services/crdt.test.ts
pnpm --filter @memry/contracts typecheck
```

If any command fails, STOP and report. Do not start M6 on an unverified M5 base.

### Your Scope

Execute Chunk 1 in order:

- **Step 1:** Freeze the sync-server contract source of truth.
- **Step 2:** Add canonical protocol parity fixtures.
- **Step 3:** Run sync-server and contract checks.
- **Step 4:** Add failing M6 ledger assertions.
- **Step 5:** Run `command:parity` and confirm the expected failure.
- **Step 6:** Do not add `realCommands` entries until Rust handlers land later.
- **Step 7:** Keep deferred entries with TODO markers until each command graduates.
- **Step 8:** Stage ledger changes only if needed; do not commit a ledger-only known
  failing state.

### Required Reads

Read these before editing:

- `AGENTS.md`
- `CLAUDE.md`
- `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
- `packages/contracts/src/sync-api.ts`
- `packages/contracts/src/blob-api.ts`
- `apps/sync-server/src/routes/sync.ts`
- `apps/sync-server/src/routes/blob.ts`
- `apps/sync-server/src/services/crdt.ts`
- `apps/desktop-tauri/scripts/command-parity-audit.ts`
- `apps/desktop-tauri/src/lib/ipc/invoke.ts`
- `apps/desktop-tauri/src/lib/ipc/mocks/sync.ts`

### Methodology

1. Invoke `superpowers:using-superpowers`, `superpowers:test-driven-development`, and
   `superpowers:verification-before-completion`.
2. Confirm both route families still resolve in sync-server tests:
   `/sync/{status,manifest,changes,push,pull,items}` and
   `/sync/records/{status,manifest,changes,push,pull,items}`.
3. Keep legacy aliases live through M6 unless tests prove they are already gone.
4. Create or reuse canonical JSON fixtures for record changes, pull, push, CRDT
   update/batch/snapshot, blob upload, and storage breakdown.
5. Rehome contract modules into `apps/sync-server/src/contracts/*` only if Rust-client
   work proves the shared package dependency is awkward. Prefer no movement.
6. Add all M6 commands to the parity ledger as required-real or deferred with a clear
   TODO marker, but do not route the renderer to non-existent Rust commands.
7. Do not modify Electron `apps/desktop/**` except read-only inspection.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6

pnpm --filter @memry/sync-server test -- src/routes/sync.test.ts src/routes/blob.test.ts src/services/crdt.test.ts
pnpm --filter @memry/contracts typecheck
pnpm --filter @memry/desktop-tauri test -- src/lib/ipc/mocks/sync.test.ts
pnpm --filter @memry/desktop-tauri command:parity
```

Expected: sync-server/contracts/mock tests pass. `command:parity` may FAIL with missing
generated handler/binding errors for M6 sync and attachment commands. That failure is
expected only in this phase and must be recorded exactly.

### Commit Rule

Do not commit a ledger-only state if `command:parity` is knowingly failing. Leave the
changes staged or unstaged and document them in the handoff. The first later commit
that graduates a real sync command should include this ledger work.

### When Done

Report:

```text
Phase A complete.
Plan chunk: 1
Protocol decision: <shared package kept | contracts rehomed, why>
Route aliases: <legacy kept | changed, why>
Ledger state: <staged | unstaged | committed with first command | none>
Verification: sync-server/contracts/mock tests + command:parity expected result
Next: Phase B - prompts/m6/m6-phase-b-http-session-pinning.md
Blockers: <none | list>
```

## PROMPT END
