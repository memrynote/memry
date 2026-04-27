# M6 - Sync Engine / Phase Prompts

Fresh-session prompts for M6. Run one phase per clean session. Do not start the
next phase until the previous phase is either verified or explicitly stopped with a
handoff note.

## Worktree

M6 should run after M5 is merged to `main`.

```bash
cd /Users/h4yfans/sideproject/memry
git fetch origin
git checkout main
git pull --ff-only origin main
git worktree add ../memry-worktrees/spike-tauri-m6 -b m6/sync-engine main
cd ../memry-worktrees/spike-tauri-m6
```

If the branch name is random, rename it before pushing:

```bash
git branch -m m6/sync-engine
```

All prompts assume this root:

```text
/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6
```

## Execution Order

| Phase | Prompt | Task | Plan Chunk | Status |
|-------|--------|------|------------|--------|
| A | `m6-phase-a-contract-ledger.md` | Contract source of truth, fixtures, command ledger lock | Chunk 1 | TODO |
| B | `m6-phase-b-http-session-pinning.md` | Sync HTTP client, token refresh/session expiry, cert pinning | Chunk 2 | TODO |
| C | `m6-phase-c-queue-retry-state-history.md` | Durable queue, retry/backoff, sync state, history | Chunk 3 | TODO |
| D | `m6-phase-d-vector-clocks-field-merge.md` | Vector clocks and field-level merge semantics | Chunk 4 | TODO |
| E | `m6-phase-e-crypto-batch-device-keys.md` | Batch encryption/signature verification and device key lookup | Chunk 5 | TODO |
| F | `m6-phase-f-handler-registry.md` | 13 sync record handlers and registry coverage | Chunk 6 | TODO |
| G | `m6-phase-g-local-mutation-enqueue.md` | Enqueue live M5 local writes into durable sync queue | Chunk 7 | TODO |
| H | `m6-phase-h-engine-runtime.md` | Sync runtime plus pull, apply, push, full-sync coordinators | Chunk 8 | TODO |
| I | `m6-phase-i-websocket-listener.md` | WebSocket listener, close-code policy, reconnect behavior | Chunk 9 | TODO |
| J | `m6-phase-j-crdt-network-sync.md` | Network CRDT updates, per-note cursors, snapshot push/pull | Chunk 10 | TODO |
| K | `m6-phase-k-attachments-blob-sync.md` | Attachment upload/download/delete and blob sync commands | Chunk 11 | TODO |
| L | `m6-phase-l-sync-ops-renderer-wiring.md` | Sync ops commands, renderer DTO wiring, mock retirement | Chunk 12 | TODO |
| M | `m6-phase-m-runtime-e2e-staging.md` | Two-device, offline restart, attachment runtime/staging smoke | Chunk 13 | TODO |
| N | `m6-phase-n-capability-binding-parity.md` | Generated bindings, capabilities, command parity closure | Chunk 14 | TODO |
| O | `m6-phase-o-final-verification-gate.md` | Full verification gate and PR ledger | Chunk 15 | TODO |

## Global Rules

1. Worktree root: `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6`
2. Branch: `m6/sync-engine`
3. Source of truth: `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
4. Parent spec: `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
5. Predecessor: M5 must be merged before M6 starts.
6. Read `AGENTS.md` and `CLAUDE.md` before editing in every fresh session.
7. New product work goes to `apps/desktop-tauri/` unless a prompt explicitly names
   `apps/sync-server/` or `packages/contracts/`.
8. `apps/desktop/**` is read-only reference material. Do not change Electron during M6.
9. No `rusqlite::Connection` guard may cross `.await`.
10. Rust targets `/sync/records/*` as canonical. Keep legacy `/sync/*` server aliases
    live through M6 unless tests prove otherwise.
11. Access and refresh tokens stay in M4 keychain entries under `SERVICE_VAULT`.
12. Runtime event names stay kebab-case: no Electron colon event names in Tauri.
13. Implement exactly the 13 `RECORD_SYNC_ITEM_TYPES` handlers. Do not add
    bookmarks/templates/reminders unless the contracts prove they exist.
14. M6 does not implement M7 search, M8 import/export/version/native shell, M9 updater,
    Google OAuth provider polling, or broad Electron cleanup.
15. Commit format: `m6(<scope>): <description>`.
16. No branding in branch names, commit bodies, PR descriptions, or generated docs.

## Required Method

Each implementation phase starts by invoking:

- `superpowers:using-superpowers`
- `superpowers:test-driven-development` for phases that write code
- `superpowers:systematic-debugging` for failures with non-obvious cause
- `superpowers:verification-before-completion` before reporting complete

Use RED-GREEN for every task with a test file in the plan. Confirm the RED failure
before implementation, then confirm GREEN before committing.

## Cross-Phase Logic

- Phase A intentionally makes the command parity ledger stricter before all commands
  exist. It may end with staged or unstaged ledger work and a known failing
  `command:parity`. Do not commit a ledger-only failing state.
- Phase L is the first phase expected to graduate the full `sync_ops_*` command
  surface. Include any Phase A ledger work in the first commit that makes parity green.
- Attachments graduate in Phase K. Sync ops and mock retirement close in Phase L.
- Final command, binding, and capability closure happens in Phase N. Do not treat
  earlier partial gates as final M6 acceptance.

## Phase Handoff

At the end of every phase, run the smallest full-phase gate listed in that prompt,
then report:

```text
Phase <X> complete.
Plan chunk: <number>
Commits: <count> (<first hash>..<last hash>) or <none, reason>
Verification: <commands and result>
Next: Phase <Y> - <prompt filename>
Blockers: <none | list>
```

## Emergency Stop

Stop and report if:

- M5 is not merged or baseline checks are red.
- cert pinning cannot be implemented without a broad networking rewrite.
- sync-server schemas differ from `packages/contracts` and require server changes
  larger than parity fixtures.
- M5 CRDT storage lacks enough metadata for safe exactly-once CRDT push and requires a
  schema decision.
- runtime e2e proves data loss, duplicate queue drain, or signature bypass.
- any fix requires touching Electron `apps/desktop` implementation beyond read-only
  parity reference.

Do not guess. Identify root cause, state the smallest fix, and wait if the fix changes
scope.
