# 006 Sync architecture: state file

Epic #2279. Goal: `specs/006-sync-architecture/goal.md`. This file is the only state. After a restart, re-read it and continue at the first unticked box.

Forge: GitHub, `gh` (repo `memrynote/memry`). `origin` CLI not installed. Base SHA of the stack: `3d3a6e6c7` (origin/main at start).
Worktree: `.worktrees/sync-arch`. Node 24 (`~/.nvm/versions/node/v24.16.0/bin`) for native rebuilds.

## Operating rules

- Work only in `.worktrees/sync-arch`. Stage explicit paths. No `reset --hard`, `checkout .`, `clean -fd`, `stash`, `add -A`, `--no-verify`. Force push only `--force-with-lease` after `ls-remote`.
- Never merge, never arm auto-merge, never deploy production, never touch production D1/R2 or `client_policies`. Staging only, logged below.
- Per issue: validate, design (architect/interrogate where the goal names it), failing test first, implement, gates, docs, live (for live units), commit, PR (ready, stacked base), swarm verdict.
- Review section of each issue wins over the original text.
- Compat plan in this file before any schema, contract, wire or format change.
- Regression tests carry the issue number in a comment.

## Validity log

Checked at `3d3a6e6c7`. Full evidence per issue in the validator reports (local, `/tmp/sa-valid/*.md`); load-bearing lines below.

| Issue      | Verdict         | Evidence                                                                                                                                                                         | Action                    |
| ---------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| #2282 P1.1 | valid           | `apps/sync-server/src/services/sync.ts:634` stage 7 `allocateCursorRange` (own `db.batch`, `services/cursor.ts:31`), stage 8 upsert `db.batch` at `:722`                         | implement (PR01)          |
| #2283 P1.2 | valid           | `apps/desktop/src/main/sync/engine/push-coordinator.ts:414-422` sets `LAST_CURSOR = lastMaxCursor` after push                                                                    | implement (PR01)          |
| #2382 P1.8 | valid           | `engine/full-sync-runner.ts:604-626` heals only server-only `(type,id)`; no one-time repair key in `SYNC_STATE_KEYS` (`engine/sync-context.ts:87`)                               | implement (PR01)          |
| #2284 P1.3 | valid           | `item-handlers/journal-handler.ts:73,117` unawaited `.then`; `property-definition-handler.ts:119` `void import().then`; journal delete `deleteJournalEntryFile(...).catch`       | implement (PR02)          |
| #2285 P1.4 | valid           | `apply-item.ts:95-110` schema parse failure returns `'skipped'`; `engine/pull-coordinator.ts:671-691` `pull_page_dropped` returns `stop: 'none'`                                 | implement (PR03)          |
| #2286 P1.5 | valid           | `dirty-recovery.ts` sweeps tasks/projects/note_metadata/inbox only                                                                                                               | implement (PR04)          |
| #2287 P1.6 | valid           | settings field clocks keyed by literal `'local'`                                                                                                                                 | implement (PR05)          |
| #2310 P1.7 | valid           | `manifest-check.ts` throttled path returns `noAction`, runner logs "manifest check complete"                                                                                     | implement (PR06)          |
| #2280 P0.1 | valid           | no `committedAtMs` / `sync_e2e_ms` anywhere                                                                                                                                      | implement (PR07)          |
| #2281 P0.2 | valid           | `docs/protocol/09-realtime.md:21-23` MUST close when backgrounded                                                                                                                | implement (PR07)          |
| #2288 P2.1 | valid           | `routes/sync.ts:222` `pushRateLimit` 60/min, no identifier (per user)                                                                                                            | implement (PR08)          |
| #2289 P2.2 | valid           | `PUSH_DEBOUNCE_MS = 2000` trailing, re-arm in `requestPush`                                                                                                                      | implement (PR09)          |
| #2290 P2.3 | valid           | `engine.ts handleWsMessage` ignores payload cursor, no pull coalescing                                                                                                           | implement (PR10)          |
| #2291 P2.4 | valid           | `websocket.ts` own `z.enum` frame parser                                                                                                                                         | implement (PR11)          |
| #2292 P2.5 | valid           | `routes/sync.ts:364` `handleRecordChanges` has no inline mode                                                                                                                    | implement (PR12)          |
| #2293 P2.6 | partial         | items 1-3 open; item 4 per Review: only the `break` in the per-item loop                                                                                                         | implement narrowed (PR13) |
| #2294 P2.7 | partial         | `packages/sync-client/src/item-handlers/types.ts:58-68` equal -> apply; cursor persisted outside slice tx `pull-coordinator.ts:327`; narrowed to equal clock + identical payload | implement narrowed (PR14) |
| #2295 P3.1 | valid           | `services/crdt.ts:140` per-note `sequence_num`, no `server_cursor` column                                                                                                        | implement (PR15)          |
| #2296 P3.2 | valid           | `services/crdt.ts:139-146` unconditional insert, no `update_hash`                                                                                                                | implement (PR16)          |
| #2297 P3.3 | valid (+Review) | `engine.ts:804` `crdt_updated`, sweep/drain/watermarks present; Review adds NULL-cursor legacy sweep                                                                             | implement (PR17, PR18)    |
| #2298 P3.4 | valid (+Review) | `crdt-queue.ts` in-memory; `SyncQueueManager.enqueue` coalesces and overwrites payload                                                                                           | implement (PR19)          |
| #2299 P3.5 | valid (+Review) | destructive snapshot routing; `coversThrough` must exclude tracked-unapplied                                                                                                     | implement (PR20)          |
| #2302 P4.3 | valid (+Review) | `services/cleanup.ts:188-204` hard-deletes expired tombstones, no marker; no client purge handling                                                                               | implement (PR21)          |
| #2303 P4.4 | partial         | `services/sync.ts:780` `checkQuota` pre-estimate; `rate_limits` stays (Review)                                                                                                   | implement narrowed (PR22) |
| #2383 P4.6 | valid           | settings `mergeRemote` not §6.9.0                                                                                                                                                | implement (PR23)          |
| #2304 P4.5 | partial         | Rust `push.rs` already never moves the cursor (P1.2 step done); P2.3/P2.5/P2.7/P3.3 parity open                                                                                  | implement narrowed (PR24) |
| #2301 P4.2 | valid           | three uncoordinated SQLite txns for row, clock, outbox                                                                                                                           | implement, gated (PR25)   |
| #2300 P4.1 | valid           | `changes_available` carries only a cursor hint                                                                                                                                   | implement, gated (PR26)   |

## PR units

Checkbox legend: validate, design, failing test, implement, gates, docs, live, commit, PR, verdict.

### PR01 `fix/sync-cursor-skip` (#2282, #2283, #2382) live

- [x] validate
- [x] design (interrogate on the P1.8 repair trigger: 2 reviewers, `/tmp/sa-interrogate/pr01-*.md`; redesigned to a three-state key)
- [x] failing test (each regression test failed first for the intended reason)
- [x] implement
- [x] gates (sync-server 1318/1318, desktop test:main 9179 pass, lint, typecheck, architecture, contracts, diff --check)
- [x] docs (`docs/protocol/05-record-sync.md` §5.5; `apps/docs/src/architecture/sync-protocol.md` Cursors; docs:impact strict green; docs:build green)
- [x] live (Playwright two-device E2E on Miniflare; main 1/7 tasks, head 7/7; `evidence/pr01-live-*.txt`)
- [x] commit
- [ ] PR
- [ ] verdict

### PR02 `fix/sync-journal-apply-tx` (#2284)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR03 `fix/sync-schema-invalid` (#2285)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR04 `fix/sync-dirty-recovery-all-types` (#2286)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR05 `fix/sync-settings-device-clock` (#2287)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR06 `fix/sync-manifest-throttle-log` (#2310)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR07 `feat/sync-e2e-trace` (#2280, #2281)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR08 `feat/sync-push-rate-limit-per-device` (#2288)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR09 `feat/sync-leading-edge-push` (#2289)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR10 `feat/sync-honor-wake-cursor` (#2290) live

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] live · [ ] commit · [ ] PR · [ ] verdict

### PR11 `fix/sync-ws-contract-parser` (#2291)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR12 `feat/sync-inline-changes` (#2292) live

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] live · [ ] commit · [ ] PR · [ ] verdict

### PR13 `fix/sync-push-self-heal` (#2293)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR14 `feat/sync-slice-cursor-tx` (#2294) live

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] live · [ ] commit · [ ] PR · [ ] verdict

### PR15 `feat/sync-crdt-server-cursor` (#2295) live

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] live · [ ] commit · [ ] PR · [ ] verdict

### PR16 `fix/sync-crdt-idempotent-store` (#2296)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR17 `feat/sync-note-body-feed` (#2297 part a) live

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] live · [ ] commit · [ ] PR · [ ] verdict

### PR18 `refactor/sync-delete-crdt-sweep` (#2297 part b)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR19 `feat/sync-crdt-outbox` (#2298)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR20 `feat/sync-snapshot-covers-through` (#2299)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR21 `feat/sync-tombstone-purge-marker` (#2302)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR22 `chore/sync-server-dead-code` (#2303)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR23 `fix/sync-settings-merge-spec` (#2383)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR24 `feat/sync-core-parity` (#2304)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR25 `feat/sync-transactional-outbox` (#2301)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

### PR26 `feat/sync-ws-fast-path` (#2300)

- [x] validate
- [ ] design · [ ] failing test · [ ] implement · [ ] gates · [ ] docs · [ ] commit · [ ] PR · [ ] verdict

## Acceptance map

One line per acceptance criterion: issue, criterion, test name or live result.

- #2282 two concurrent pushes, no reader sees the higher range before the lower: `push-batch-pipeline.test.ts` "never lets a reader page past a range that commits after a higher one" (real SQLite, held batch).
- #2282 existing sync.test.ts + cursor.test.ts green, `pushed` response unchanged: sync-server suite 1318/1318; `push-batch-pipeline.test.ts` old-client compat matrix.
- #2283 push with maxCursor 100 and LAST_CURSOR 40 leaves 40: `push-coordinator.test.ts` "#then it leaves the pull cursor where the last pull put it".
- #2283 peer item below own push cursor delivered on next pull: `engine-push.test.ts` "(accepted 1, cursor delta 7)"; live `sync-cursor-skip.e2e.ts` (main 1/7, head 7/7).
- #2283 server mirror: `routes/sync.test.ts` "should leave the device pull cursor alone when items are accepted".
- #2382 key absent + LAST_CURSOR 40 pulls from 0, done after a clean pull: `full-sync-runner.test.ts` "#then an install with a cursor re-pulls from 0 under the lock ...".
- #2382 refused pull mid-repair repeats the repair (as redesigned: resumes, never restarts): `full-sync-runner.test.ts` "#then an interrupted repair resumes from its persisted cursor ...", "#then a pull that throws leaves the repair pending".
- #2382 fresh install, no reset, key set: `full-sync-runner.test.ts` "#then an install with no cursor / cursor 0 records done without a reset".
- #2382 #2283-shape regression: `engine.test.ts` "#then the skipped update arrives and the repair is recorded".

## Decisions

Full trail in `decisions.tsv` (worktree root, uncommitted).

- PR01: live lane runs on the Playwright two-device harness (`tests/sync-harness` Miniflare Worker + two Electron profiles) rather than staging: same two-device shape, real Worker code, no deploy.
- PR01: #2382 key is `cursorSkipRepair` with states absent / `pending:<cursor>` / `done`. The issue asked for "flag only after a clean pull"; kept (done only after a delivered pull), but an interrupted repair resumes from the persisted cursor instead of resetting again. Reason: interrogate found a permanent re-pull loop on a breaker page.
- PR01: the reset runs under the sync lock; a busy lock defers the repair to the next full sync.
- PR01: fresh installs (no cursor or cursor 0) record `done` immediately.
- PR01: `/sync/push` no longer raises `device_sync_state.last_cursor_seen` (server mirror of #2283).
- PR01: rejected zeroing `maxCursor` for old clients: it changes a field's meaning, and P1.8 heals old installs on upgrade.
- PR02: journal file deletes stay un-journaled, matching note-handler; follow-up issue filed.

## Blockers

## Staging deploy log

## Rollout

- PR01: deploy the Worker first (cursor reservation in the commit batch, push no longer moves last_cursor_seen), then release the desktop build. The desktop repair (#2382) relies on the Worker fix: a repair pull racing a peer push on an old Worker can skip again and still record done. No D1 migration. No client_policies change.
