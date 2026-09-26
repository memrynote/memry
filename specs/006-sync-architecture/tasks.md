# 006 Sync architecture: state file

Epic #2279. Goal: `specs/006-sync-architecture/goal.md`. This file is the only state. After a restart, re-read it and continue at the first unticked box.

Forge: GitHub, `gh` (repo `memrynote/memry`). `origin` CLI not installed. Base SHA of the stack: `3d3a6e6c7` (origin/main at start); rebased onto `d71c6f87d` and then `ba6ce80d2` on 2026-09-26.
Worktree: `.worktrees/sync-arch`. Node 24 (`~/.nvm/versions/node/v24.16.0/bin`) for native rebuilds.

## Operating rules

- Work only in `.worktrees/sync-arch`. Stage explicit paths. No `reset --hard`, `checkout .`, `clean -fd`, `stash`, `add -A`, `--no-verify`. Force push only `--force-with-lease` after `ls-remote`.
- Never merge, never arm auto-merge, never deploy production, never touch production D1/R2 or `client_policies`. Staging only, logged below.
- Per issue: validate, design (architect/interrogate where the goal names it), failing test first, implement, gates, docs, live (for live units), commit, PR (ready, stacked base), swarm verdict.
- Review section of each issue wins over the original text.
- Compat plan in this file before any schema, contract, wire or format change.
- Regression tests carry the issue number in a comment.

## Validity log

Checked at `3d3a6e6c7` (mid-run issues at the SHA they were found on). No issue was invalid, so none was closed. Full evidence per issue in the validator reports (local, `/tmp/sa-valid/*.md`); load-bearing lines below.

| Issue      | Verdict         | Evidence                                                                                                                                                                         | Action                              |
| ---------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| #2282 P1.1 | valid           | `apps/sync-server/src/services/sync.ts:634` stage 7 `allocateCursorRange` (own `db.batch`, `services/cursor.ts:31`), stage 8 upsert `db.batch` at `:722`                         | implement (PR01)                    |
| #2283 P1.2 | valid           | `apps/desktop/src/main/sync/engine/push-coordinator.ts:414-422` sets `LAST_CURSOR = lastMaxCursor` after push                                                                    | implement (PR01)                    |
| #2382 P1.8 | valid           | `engine/full-sync-runner.ts:604-626` heals only server-only `(type,id)`; no one-time repair key in `SYNC_STATE_KEYS` (`engine/sync-context.ts:87`)                               | implement (PR01)                    |
| #2284 P1.3 | valid           | `item-handlers/journal-handler.ts:73,117` unawaited `.then`; `property-definition-handler.ts:119` `void import().then`; journal delete `deleteJournalEntryFile(...).catch`       | implement (PR02)                    |
| #2285 P1.4 | valid           | `apply-item.ts:95-110` schema parse failure returns `'skipped'`; `engine/pull-coordinator.ts:671-691` `pull_page_dropped` returns `stop: 'none'`                                 | implement (PR03)                    |
| #2286 P1.5 | valid           | `dirty-recovery.ts` sweeps tasks/projects/note_metadata/inbox only                                                                                                               | implement (PR04)                    |
| #2287 P1.6 | valid           | settings field clocks keyed by literal `'local'`                                                                                                                                 | implement (PR05)                    |
| #2310 P1.7 | valid           | `manifest-check.ts` throttled path returns `noAction`, runner logs "manifest check complete"                                                                                     | implement (PR06)                    |
| #2280 P0.1 | valid           | no `committedAtMs` / `sync_e2e_ms` anywhere                                                                                                                                      | implement (PR07)                    |
| #2281 P0.2 | valid           | `docs/protocol/09-realtime.md:21-23` MUST close when backgrounded                                                                                                                | implement (PR07)                    |
| #2288 P2.1 | valid           | `routes/sync.ts:222` `pushRateLimit` 60/min, no identifier (per user)                                                                                                            | implement (PR08)                    |
| #2289 P2.2 | valid           | `PUSH_DEBOUNCE_MS = 2000` trailing, re-arm in `requestPush`                                                                                                                      | implement (PR09)                    |
| #2290 P2.3 | valid           | `engine.ts handleWsMessage` ignores payload cursor, no pull coalescing                                                                                                           | implement (PR10)                    |
| #2291 P2.4 | valid           | `websocket.ts` own `z.enum` frame parser                                                                                                                                         | implement (PR11)                    |
| #2292 P2.5 | valid           | `routes/sync.ts:364` `handleRecordChanges` has no inline mode                                                                                                                    | implement (PR12)                    |
| #2293 P2.6 | partial         | items 1-3 open; item 4 per Review: only the `break` in the per-item loop                                                                                                         | implement narrowed (PR13)           |
| #2294 P2.7 | partial         | `packages/sync-client/src/item-handlers/types.ts:58-68` equal -> apply; cursor persisted outside slice tx `pull-coordinator.ts:327`; narrowed to equal clock + identical payload | implement narrowed (PR14)           |
| #2295 P3.1 | valid           | `services/crdt.ts:140` per-note `sequence_num`, no `server_cursor` column                                                                                                        | implement (PR15)                    |
| #2296 P3.2 | valid           | `services/crdt.ts:139-146` unconditional insert, no `update_hash`                                                                                                                | implement (PR16)                    |
| #2297 P3.3 | valid (+Review) | `engine.ts:804` `crdt_updated`, sweep/drain/watermarks present; Review adds NULL-cursor legacy sweep                                                                             | implement (PR17, PR18)              |
| #2298 P3.4 | valid (+Review) | `crdt-queue.ts` in-memory; `SyncQueueManager.enqueue` coalesces and overwrites payload                                                                                           | implement (PR19)                    |
| #2299 P3.5 | valid (+Review) | destructive snapshot routing; `coversThrough` must exclude tracked-unapplied                                                                                                     | implement (PR20)                    |
| #2302 P4.3 | valid (+Review) | `services/cleanup.ts:188-204` hard-deletes expired tombstones, no marker; no client purge handling                                                                               | implement (PR21)                    |
| #2303 P4.4 | partial         | `services/sync.ts:780` `checkQuota` pre-estimate; `rate_limits` stays (Review)                                                                                                   | implement narrowed (PR22)           |
| #2383 P4.6 | valid           | settings `mergeRemote` not §6.9.0                                                                                                                                                | implement (PR23)                    |
| #2304 P4.5 | partial         | Rust `push.rs` already never moves the cursor (P1.2 step done); P2.3/P2.5/P2.7/P3.3 parity open                                                                                  | implement narrowed (PR24)           |
| #2301 P4.2 | valid           | three uncoordinated SQLite txns for row, clock, outbox                                                                                                                           | implement, gated (PR25)             |
| #2300 P4.1 | valid           | `changes_available` carries only a cursor hint                                                                                                                                   | implement, gated (PR26)             |
| #2385      | valid           | `note-handler.ts`/`journal-handler.ts` `applyDelete` unlink the file after the row commits, outside the crash journal (found in PR02)                                            | implement (PR27)                    |
| #2399      | valid           | Rust `settings_merge.rs` removes local on an absent winner and never re-queues on a concurrent merge (found in PR23)                                                             | implement (PR24 part 1)             |
| #2408      | valid           | purged-tombstone entries carry no signature; a server can assert any delete (PR21 interrogate)                                                                                   | implement (PR29)                    |
| #2409      | valid           | a re-created deterministic id ticks from a fresh clock the tombstone dominates (PR21 interrogate)                                                                                | implement (PR30)                    |
| #2413      | valid           | `e2e-pr.yml` `--only-changed` selects all 662 specs when `@memry/contracts` changes; job hits 35 min (PR12 CI)                                                                   | implement (#2415, tooling)          |
| #2414      | valid           | `deleteRowsAndBlobs` binds up to 1000 ids and deletes R2 objects before an unguarded row delete (PR21 review)                                                                    | implement (PR31)                    |
| #2420      | valid, narrowed | CRDT commits broadcast `crdt_updated` with no cursor; issue comment narrows to an optional `cursor` field instead of a second frame                                              | implement (PR32)                    |
| #2421      | valid, gated    | old CRDT body machinery (sweeps, per-note `crdt_updated` pull) still the only path in some pre-gate states (#2297 Review)                                                        | implement, merge-gated (PR36, PR37) |
| #2423      | partial         | item 1 valid (+ tag_category); item 2 only for dirty-sweep types (bookmark, canvas_folder, note, journal)                                                                        | implement (PR33)                    |
| #2424      | partial         | reported trigger is harness-only (`bootstrapSyncDevice` skips `recordCrdtStoreRename`); real production gap on a failed store move                                               | narrowed, implement (PR34)          |
| #2429      | valid           | `PullCoordinator.processedIds` skips a later page's newer version by identity (PR26 round-2 review)                                                                              | implement (PR35)                    |

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
- [x] PR https://github.com/memrynote/memry/pull/2384
- [x] verdict: swarm PASS at e3c744797 (gates, red-first, receipts); patch-id unchanged after the restack onto PR00

### PR02 `fix/sync-journal-apply-tx` (#2284)

- [x] validate
- [x] design (sync `buildJournalEntryWrite`, deferred file via the crash journal; property-definition delete journals `properties.md`)
- [x] failing test (`page-apply-file-writes.test.ts`: 3 failed before the fix)
- [x] implement
- [x] gates (desktop test:main 9184, lint, typecheck, architecture, contracts)
- [x] docs (`apps/docs/src/architecture/sync-protocol.md` page-transaction paragraph)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2386
- [x] verdict: swarm PASS at 3e12b8a1a (gates, red-first, receipts)

### PR03 `fix/sync-schema-invalid` (#2285)

- [x] validate
- [x] design (interrogate + comment review: `/tmp/sa-interrogate/pr03-*.md`; ledger kinds, 100-id chunks, manifest exclusion, orphan guard, breaker count)
- [x] failing test (apply-item and pull-coordinator tests failed on the parent branch)
- [x] implement
- [x] gates (desktop test:main 9198, lint, typecheck)
- [x] docs (protocol 05 §5.14 non-envelope rule changed with reason; apps/docs sync-protocol + sync-handlers)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2388
- [x] verdict: swarm PASS at e3f9a970f (gates, red-first, receipts)

### PR00 `fix/eventkit-provider-test-platform` (tooling, not an epic issue)

Stack root: https://github.com/memrynote/memry/pull/2387. After the rebase onto main `d71c6f87d` it also carries the renderer-test fix first opened as #2438 (the root must be green on main by itself; GitHub marked #2438 merged into this branch when the branch fast-forwarded to it; nothing reached main). Swarm PASS for both commits (dc0a0b377 and 6e0b21131).

### Tooling units under PR01 (found mid-run, not epic issues except #2413)

- #2412 `fix/e2e-paste-menu-selector`: e2e paste specs still waited for `data-paste-link-menu` (renamed in #2364). Swarm PASS at 8d73bdcb5.
- #2415 `ci/e2e-pr-selection-cap` (closes #2413): above 100 selected tests, PR E2E runs only the PR's changed specs. Swarm PASS at 6ba2eb8fc.
- #2440 `fix/editor-web-asset-refresh`: main's editor-web asset was stale (Editor and crypto gates red on main). Regenerated; editor:check current.

- main's Unit & integration job fails on Linux since #2375 (two EventKit provider tests). Fixed in its own PR at the stack root: https://github.com/memrynote/memry/pull/2387

### PR04 `fix/sync-dirty-recovery-all-types` (#2286)

- [x] validate
- [x] design (DIRTY_RECOVERY registry keyed by RecordSyncItemType, sweep or stated exemption; recoverOfflineDocClock hook)
- [x] failing test (15 failed before)
- [x] implement
- [x] gates (stacked tip ed60ebb86: lint, typecheck, architecture, contracts, diff --check, contracts/sync-client/sync-harness/sync-server suites, desktop test:main 9259, docs:impact strict, docs:build)
- [x] docs (protocol 06 §6.6.1, apps/docs sync-handlers + how-sync-works)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2390
- [x] verdict: swarm PASS at 2c816befe (red-first, receipts; gates on the stacked tip)

### PR05 `fix/sync-settings-device-clock` (#2287)

- [x] validate
- [x] design (device-id key; re-queue on concurrent merge (§6.5.2 P3); legacy local entries kept)
- [x] failing test (divergence trace red before)
- [x] implement
- [x] gates (stacked tip ed60ebb86: lint, typecheck, architecture, contracts, diff --check, contracts/sync-client/sync-harness/sync-server suites, desktop test:main 9259, docs:impact strict, docs:build)
- [x] docs (protocol 06 §6.9, 13, conflict-health.md)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2391
- [x] verdict: swarm PASS at d10870542 (red-first, receipts; gates on the stacked tip)

### PR06 `fix/sync-manifest-throttle-log` (#2310)

- [x] validate
- [x] design (optional ManifestCheckResult.skipped {reason,nextEligibleAt})
- [x] failing test (4 failed before)
- [x] implement
- [x] gates (stacked tip ed60ebb86: lint, typecheck, architecture, contracts, diff --check, contracts/sync-client/sync-harness/sync-server suites, desktop test:main 9259, docs:impact strict, docs:build)
- [x] docs (apps/docs sync-protocol)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2392
- [x] verdict: swarm PASS at 5ab97ecaf (red-first, receipts; gates on the stacked tip)

### PR07 `feat/sync-e2e-trace` (#2280, #2281)

- [x] validate
- [x] design (cursor as trace key; migration 0010 committed_at_ms; optional serverCursor/committedAtMs/serverTimeMs; RTT-midpoint offset)
- [x] failing test (10 server + 4 desktop failed before)
- [x] implement
- [x] gates (stacked tip ed60ebb86: lint, typecheck, architecture, contracts, diff --check, contracts/sync-client/sync-harness/sync-server suites, desktop test:main 9259, docs:impact strict, docs:build; main-integration 17 on the owner branch)
- [x] docs (protocol 05 §5.11/§5.11.1, 09 §9.1, apps/docs sync-protocol)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2393
- [x] verdict: swarm PASS at d35d86e10 (red-first, receipts; gates on the stacked tip)

### PR08 `feat/sync-push-rate-limit-per-device` (#2288)

- [x] validate
- [x] design (sync_push 300/60s keyed by deviceIdentifier)
- [x] failing test (config and 301st-429 tests red before)
- [x] implement
- [x] gates (stacked tip ed60ebb86: lint, typecheck, architecture, contracts, diff --check, contracts/sync-client/sync-harness/sync-server suites, desktop test:main 9259, docs:impact strict, docs:build)
- [x] docs (apps/docs sync-protocol, protocol 10 §10.7)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2394
- [x] verdict: swarm PASS at 8db7a3060 (red-first, receipts; gates on the stacked tip)

### PR09 `feat/sync-leading-edge-push` (#2289)

- [x] validate
- [x] design (300 ms leading edge, chain on inFlightSync, idempotent onSyncCycleEnded for direct cycles, stop() latch; CRDT per-note leading edge)
- [x] failing test (7 push + 3 CRDT red before)
- [x] implement
- [x] gates (stacked tip 6f4f167c7: lint, typecheck, architecture, contracts, diff --check, sync-client, sync-server, desktop test:main, docs:impact strict)
- [x] docs (apps/docs sync-protocol "When a push starts", crdt.md)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2396
- [x] verdict: swarm PASS at 8a89f57e1 (red-first, receipts)

### PR10 `feat/sync-honor-wake-cursor` (#2290) live

- [x] validate
- [x] design (wake cursor <= LAST_CURSOR dropped as a skip filter only; one queued + one trailing wake pull; flag reset in recoverStaleSyncLock)
- [x] failing test (3 red before; 4th guards the flag, mutation-checked)
- [x] implement
- [x] gates (tip fdb8717c7: lint, typecheck, architecture, contracts, diff --check, sync-client, sync-server, desktop test:main 9278, docs:impact strict)
- [x] docs (protocol 09 §9.11 MAY-drop, 05 §5.11, apps/docs sync-protocol)
- [x] live (sync-wake-coalesce.e2e.ts: start SHA wakes=23 pulls=23 fail; restacked head wakes=23 pulls=5 pass; /tmp/sa-evidence/pr10-live-*.txt)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2398
- [x] verdict: swarm PASS after the CI fix (red-first at fdb8717c7; receipts' CI-only E2E failure root-caused to app version 0.0 under the harness floor, fixed, CI E2E green with live socket activity)

### PR11 `fix/sync-ws-contract-parser` (#2291)

- [x] validate
- [x] design (typed calendar/linking SyncSocketEvent variants (supervisor option A); desktop uses parseSyncSocketFrame)
- [x] failing test (contracts 2 + websocket 5 red before)
- [x] implement
- [x] gates (stacked tip ed60ebb86: lint, typecheck, architecture, contracts, diff --check, contracts/sync-client/sync-harness/sync-server suites, desktop test:main 9259, docs:impact strict, docs:build)
- [x] docs (protocol 09 §9.5.1-§9.5.2, apps/docs sync-protocol)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2395
- [x] verdict: swarm PASS (red-first at ed60ebb86; receipts' codecov/patch gap fixed by a targeted test)

### PR12 `feat/sync-inline-changes` (#2292) live

- [x] validate
- [x] design (runner A: top-level inline array of /sync/pull items, id-granular, first page of a non-full-sync run)
- [x] failing test (server 9 + desktop 13 red)
- [x] implement
- [x] gates (owner at ed60ebb86 + coordinator at e305f3cc0: lint, typecheck, architecture, contracts, diff --check, contracts, sync-client, sync-server, desktop test:main, docs:impact strict)
- [x] docs (protocol 05 §5.1/§5.10/§5.11.1/§5.11.2/§5.12, apps/docs)
- [x] live (sync-inline-changes.e2e.ts: start SHA POST /sync/pull=1 fail; branch POST /sync/pull=0 pass)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2402
- [x] verdict: swarm PASS at 2f6986c75 (red-first, receipts)

### PR13 `fix/sync-push-self-heal` (#2293)

- [x] validate
- [x] design (ceiling climbs back after 3 clean pushes; retry only at min batch size (§5.6 kept); quota rejection no longer drops the rest of the response; item 3 invalid)
- [x] failing test (4 red before)
- [x] implement
- [x] gates (stacked tip 6f4f167c7: lint, typecheck, architecture, contracts, diff --check, sync-client, sync-server, desktop test:main, docs:impact strict)
- [x] docs (protocol 05 §5.6, apps/docs sync-protocol)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2397
- [x] verdict: swarm PASS at 6f4f167c7 (red-first, receipts)

### PR14 `feat/sync-slice-cursor-tx` (#2294) live

- [x] validate
- [x] design (identical-payload equal skip via resolveUpsertClock; cursor in last slice tx only without post-commit work; emits after commit)
- [x] failing test (first pass 8 red; review round 14 red)
- [x] implement
- [x] gates (owner at 430ffd1f6 + coordinator restack to e5a2131b8: desktop test:main 9326, sync-client 203, lint, typecheck, architecture, contracts, line ceilings, docs:impact strict)
- [x] docs (protocol 05 §5.11, 06 §6.5.2 P4, apps/docs sync-protocol)
- [x] live (sync-equal-clock-echo.e2e.ts: start SHA echo re-applies 5 / identical 4, fail; branch 0 / 0 with the diverged row still applied, pass)
- [x] interrogate (2 reviewers: /tmp/sa-interrogate/pr14-{a,b}.md; 1 high, 6 medium fixed)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2410
- [x] verdict (swarm PASS at e5a2131b8: red + receipts)

### PR15 `feat/sync-crdt-server-cursor` (#2295) live

- [x] validate
- [x] design (runner B + rulings: note_body feed-only negotiable type, in-batch cursor reservation, one db.batch page, noteBodies sibling, 4 KiB inline threshold; composes with inline=1)
- [x] failing test (16 server + 3 contracts red)
- [x] implement
- [x] gates (owner at restacked tip: sync-server 1375, contracts 2268, sync-client, sync-harness, desktop test:main 9308, lint, typecheck, architecture, contracts, docs:impact strict)
- [x] docs (protocol 00/05/07, apps/docs)
- [x] live (sync-harness note-body-feed.test.ts on Miniflare: with note_body body@1 + task@2; without, task only)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2403
- [x] verdict: swarm PASS at a0789e9c0

### PR16 `fix/sync-crdt-idempotent-store` (#2296)

- [x] validate
- [x] design (update_hash + partial unique index (0012), INSERT OR IGNORE + same-batch SELECT, refund duplicate bytes)
- [x] failing test (7 server + 1 harness red)
- [x] implement
- [x] gates (sync-server 1384, contracts, sync-harness 34, desktop test:main, lint, typecheck, docs:impact strict)
- [x] docs (protocol 07 §7.4.1/§7.17, apps/docs)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2404
- [x] verdict: swarm PASS at 5548da6f1 with one finding (quota on retry), fixed in 429569236 with a red-first test

### PR17 `feat/sync-note-body-feed` (#2297 part a) live

- [x] validate
- [x] design (declare note_body; per-entry parse; fetch/decrypt before the slice tx; land after flushFiles; landing is post-commit work so LAST_CURSOR waits; three-state legacy sweep; old crdt_updated machinery kept for PR18)
- [x] failing test (19 red + missing module)
- [x] implement (0ed5ea452 on PR14 e5a2131b8)
- [x] gates (desktop test:main 9354, contracts 2268, lint, typecheck, architecture, contracts, docs:impact strict, docs:build)
- [x] docs (protocol 07 §7.17.3/§7.17.4, 05 §5.11; apps/docs crdt, sync-protocol)
- [x] live (body-crdt-feed-delivery.e2e.ts with B's CRDT pulls disabled: base fails, branch passes; existing body-crdt specs 35/36, V6 fails on base too)
- [x] interrogate (/tmp/sa-interrogate/pr17-{a,b}.md: 1 high each, 7 medium each; all fixed: body journal removed, landing failures refused (ledger + owed) before the cursor, store-confirmed sink, heal cannot resurrect, per-entry fetch failures with bounded concurrency, pruned/missing entries owed, key guard holds the cursor, worker decrypt, own snapshot echoes skipped, sweep done only after a delivered pull and reset on rollback, Yjs decoded before any store; rowless/empty-doc bodies not stored)
- [x] commit (f693561c0, 3c340b113 on e5a2131b8; test:main 9369; live feed spec passes; body-crdt suite 34/36 with V6 pre-existing and outbox-restart passing alone)
- [x] restack (onto PR24b a5ece4144: 9494d5d69, fadd2549f; conflicts with PR21/PR25 resolved keeping both; desktop section renumbered §7.17.5; restack exposed a C4 regression (snapshot watermark recorded for an unmerged snapshot), fixed test-first; test:main 9484; live 5/5)
- [x] PR https://github.com/memrynote/memry/pull/2419
- [x] swarm (red PASS; receipts ISSUES non-blocking: process claims unverifiable, CI pending at audit)
- [x] round-2 review (/tmp/sa-interrogate/pr17r2-{a,b}.md: 1 high each (rowless ids still owed through pendingPulls), 3+2 medium (bootstrap cost, transport failures as ledger refusals, snapshot dedup), lows; all fixed at 1988c97c7/0d8186199, test:main 9498, live 5/5 twice, pushed)
- [x] verdict (swarm PASS at 0d8186199: red + receipts; CI green)

### PR18 `feat/sync-crdt-body-debts` (#2297 part b; branch renamed from refactor/sync-delete-crdt-sweep, nothing is deleted)

Scope narrowed by the #2297 Review: durable per-note body debts (`crdt_body_debts`, desktop data 0060) replacing the vault-wide latch; no body path deleted (deletions in #2421, gated on minWriteVersion). Owner run on d458c0ac8 (worktree sa-sync-crdt-body-debts).

- [x] validate
- [x] design (runner a, /tmp/sa-arch/p18-a.md, with the Decisions-log rulings) · [x] failing test (4 red: crash-after-unpaid-batch restart, record debt before cursor, feed debts with lowest cursor, missing base/failed landing) · [x] implement (0060 when 1787658819433) · [x] gates (desktop 9549, sync-client 203, contracts 2279, lint, typecheck, architecture, contracts, ceilings) · [x] docs (07 §7.7.1/§7.13.2/§7.17.5, apps/docs crdt, local-storage) · [x] live (body-crdt-debt-restart.e2e.ts: base red (file stale after restart, debts null), branch green (debt record paid after restart, table empty); feed-delivery now asserts no /sync/crdt/updates GET; create-propagation read polled) · [x] commit (8fba93c5b, ddb3eb84d, 1bcd8eac9 on d458c0ac8) · [x] restack onto PR20 round-2 tip (807848171, 5506a2782 on PR32 203968963; option (B) flags session-only; compaction owes durably; test:main 9575; live debt-restart red base/green branch, feed 1/1, create-propagation 12/12) · [x] interrogate (/tmp/sa-interrogate/pr18-{a,b}.md: 3 high (migration skip if 0061 shipped first plus a throw inside the local-only toggle; bodies skipped for an on-page record that never applies get no debt; probe-settle on a watermark ahead of the doc), 4 medium (backoff keyed on updated_at starves notes and blocks legacy done; wall-clock settle guard), lows) · [x] review fixes round 1 (b39b2f91a, 4eed182c6: missing-table guard; generation counter per db; backoff from last_failed_at, deferred set, timer; skipped-for-record owes; watermark drop; failed pulls insert only on counted failures; test:main 9590; live red base/green branch)
- [x] interrogate round 2 (/tmp/sa-interrogate/pr18r2-{a,b}.md: 0 critical/high, 5 medium: counted failures stuck in pendingPulls, unclamped wall-clock backoff, outages counted via DeadLetterError, multi-slice skipped-for-record owe after the walk, doc closed mid-batch settles; lows)
- [x] review fixes round 2 (666cce67d, a354b8561 on 203968963; needs_walk column; counted failures deferred at once; clock clamp; DeadLetter/network/abort/chunk-level not counted; per-slice skipped-for-record owes; closing-doc drops owe and drop the watermark; old-shape heal; test:main 9611; live red base/green branch)
- [x] PR https://github.com/memrynote/memry/pull/2430 · [x] verdict (swarm PASS at a354b8561: red + receipts)

Finding filed: #2424 (first restart after linking opens an empty CRDT store).

### PR34 `fix/sync-adoption-store-rename` (#2424, mid-run discovery from PR18)

- [x] validate (partial, /tmp/sa-valid/2424.md: the reported trigger is harness-only, because bootstrapSyncDevice skips recordCrdtStoreRename; real production gap on a failed store move, where an empty store is opened at the adopted path and the old history is never reopened) · [x] design (open the pre-adoption store in place when the move fails, retry next launch; hook uses adoptVaultLocally) · [x] failing test (unit red: adopted path opened after a failed move; e2e sync-adoption-store-restart red with the old hook) · [x] implement · [x] gates (desktop 9550, lint, typecheck, architecture, contracts, ceilings, docs) · [x] docs (apps/docs crdt) · [x] live (lanes using the hook: pack-bootstrap, fresh-device, download-manager, vault-deletion, debt-restart, feed-delivery, adoption-store-restart green; sync-seeding-push failed at base and head, stale since #2295 shared the cursor sequence, fixed by 27e820324 and green) · [x] commit (995a280d9, 6d580e3a5, 27e820324 on 1bcd8eac9; restacked onto PR33 bd8d68f7a, tip df7cde63f; re-restacked ab51d8b4a) · [x] gates at the stack tip ab51d8b4a (desktop 9763, server 1513, contracts 2320, sync-client 206, harness 36, cargo 993, lint, typecheck, typecheck:test, architecture, contracts, ceilings, diff-check, docs:impact; live adoption-store-restart and debt-restart pass) · [x] PR https://github.com/memrynote/memry/pull/2434 · [x] verdict (swarm PASS at ab51d8b4a: red + receipts; after the main rebase and the test-file merge with PR10's hook tests, PASS again at e1d87062e)

### PR32 `feat/sync-crdt-wake-cursor` (#2420, mid-run discovery from the PR18 design)

- [x] validate · [x] design (crdt_updated gains optional cursor, the highest server_cursor the write reserved; parsers already tolerant; no client behaviour change; #2421 turns it into a wake) · [x] failing test (server 4/7, DO, contracts, desktop, Rust red) · [x] implement · [x] gates (sync-server 1484, contracts 2282, desktop 9526, sync-client 203, cargo 978, lint, typecheck, architecture, contracts, ceilings) · [x] docs (09 §9.5/§9.11, 07 §7.17) · [x] commit (203968963 on PR20 56e5dbb47; coordinator fixup: a malformed cursor is dropped, never the frame; restack test: stale own encode now refused and not broadcast) · [x] PR https://github.com/memrynote/memry/pull/2426 · [x] verdict (swarm PASS at 203968963: red + receipts; CI green)

### PR35 `fix/sync-pull-run-newer-version` (#2429, mid-run discovery from the PR26 review)

- [x] validate (reviewer trace: processedIds filters by identity only) · [x] design (per id, the highest listed cursor applied this run; listed cursor = ref serverCursor, else the page's nextCursor; clock cannot be the key, §6.5.2 P4; applies to refs, inline items and purged tombstones) · [x] failing test (run-applied-cursors.test.ts 4 red) · [x] implement (run-applied-cursors.ts, pull-run-state.ts; pull-coordinator.ts under the cap) · [x] gates · [x] docs (apps/docs sync-protocol) · [x] commit · [x] PR https://github.com/memrynote/memry/pull/2436 · [x] verdict (swarm PASS at 318284950: red + receipts)

### PR19 `feat/sync-crdt-outbox` (#2298)

- [x] validate
- [x] design (append-only note_body rows in sync_queue (Review shape a), NoteBodyOutbox keeps the per-note leading edge and global 429 gate, legacy pending file imported once)
- [x] failing test (4 red)
- [x] implement
- [x] gates (stack tip 436514888: lint, typecheck, architecture, contracts, diff --check, contracts, sync-client, sync-server, desktop test:main, cargo test, docs:impact strict)
- [x] docs (protocol 07 §7.10.1, apps/docs crdt + sync-protocol)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2406
- [x] verdict: swarm PASS at 0321ead39

### PR20 `feat/sync-snapshot-covers-through` (#2299)

- [x] validate (routing deletion narrowed: owed pulls are session-only and old servers ignore the field)
- [x] design (see Decisions 2026-09-25 PR20)
- [x] failing test (server 10/16 red, desktop 3 mutation runs, Rust 3 red)
- [x] implement (ac447cdc4 server, 9894233e0 Rust, 3a850f86a desktop on PR17 fadd2549f)
- [x] gates (sync-server 1469, contracts 2278, desktop test:main 9499, cargo test 973, clippy, fmt, lint, typecheck, architecture, contracts, line ceilings, docs:impact strict, docs:build)
- [x] docs (1623a6201: protocol 07 new §7.7.1 plus §7.4.1/§7.6/§7.7/§7.13.2/§7.17.2/§7.17.4/§7.17.5; apps/docs crdt, sync-protocol)
- [x] interrogate (/tmp/sa-interrogate/pr20-{a,b}.md: 1 critical, 4+2 high: moving the watermark makes every blind blob overwrite lossy: stale own retry via the own-signer exemption, check-then-act guard across the R2 put, pushes without C, local-only toggle, Rust body_pull gap; redesign in progress)
- [x] redesign (compare-and-swap; 7a8b29c4b, 63ff646d8, 52faaeb13, 9667af057 on fadd2549f: D1 0014 covers_through; per-write blob keys in blob_key; guard in the upsert WHERE with the prune conditioned on it in one batch; older same-device encode 200 no-op; unclaimed push onto a claimed row 409; baseRevision CAS; refusals name the blocking cursor; desktop routes refused notes to updates until the feed passes it; local-only exit owes a pull; unmarked CRDT store resets the sweep key and raises the debt; sweep ids from the data DB too; encodeForPush sole producer; Rust baseline on unknown revision, per-document claim, refs pass re-arms; server 1476, desktop 9510, cargo 977, contracts 2279, sync-client 203)
- [x] rebase onto PR17 final (862ada6ad, 508653f71, 3305c8fa7, d458c0ac8 on 0d8186199; only 07 §7.17.5 conflicted; fixup: an undeclared (from-zero) page resets the legacy sweep key so no claim covers bodies the run skipped; server 1476, desktop 9525, cargo 977; live body-crdt-feed-delivery 1/1, create-propagation C3/C4 line-96 flake reproduced on base 1/8)
- [x] interrogate round 2 (/tmp/sa-interrogate/pr20r2-{a,b}.md: 2 high (equal-C own overwrite after a base-arm write; released desktops loop on the new 409), 4-5 medium each (ambiguous batch failure deletes a committed object, readers racing the old-object delete, 200 no-op recorded as held, in-memory/reconcile-failure/seeded docs still claim, landing during compaction), lows)
- [x] round-2 fixes (92ff8ca0a, 9b8e5f630, 4620b36da, 56e5dbb47 on 0d8186199; server 1490, cargo 1012, sync-client 205, desktop 9549; full-state notes flagged at start without a pull (option B); ruling /tmp/sa-owner/pr20-r2-ruling.md: same-signer arm and no-op removed; claims dormant until CRDT_CLAIM_MIN_DESKTOP_VERSION is set and the desktop min_write_version reaches it; re-read on batch failure; 503 not null on a raced read; claims withheld for in-memory, failed reconcile, seeded/created docs, rowless drops; epoch id mirrored in the data DB; compaction landings owed) · [x] PR https://github.com/memrynote/memry/pull/2425 · [x] verdict (swarm PASS at 56e5dbb47: red + receipts)

### PR21 `feat/sync-tombstone-purge-marker` (#2302)

- [x] validate
- [x] design (architect runner A: never hard-delete; marker rows served as typed purgedTombstones/blobMissing siblings behind the feed-only `purged_tombstones` token, never from cursor 0; RECREATABLE_AFTER_PURGE_ITEM_TYPES for create-over-marker)
- [x] failing test (server 15 red, desktop 24 red; review round server 7, desktop 4, orphan 1, manifest 2 red)
- [x] implement (migration 0013 additive; shed 200 rows/20 users per tick with bulk R2 delete; audit cron dropped; desktop local refusals, manifest re-upload gated on delivered pull, orphan repair only on positive gone)
- [x] gates (at 5bfc54ed3 base: sync-server 1444, desktop test:main 9376, contracts 2275, harness 4/4, lint, typecheck, line ceilings, architecture, contracts, docs:impact strict, docs:build)
- [x] docs (protocol 05 §5.8, §5.11.1, §5.12.3, §5.12.4, §5.14; apps/docs sync-protocol, sync-handlers)
- [x] interrogate (/tmp/sa-interrogate/pr21-{a,b}.md: 2 high + 1 high from each reviewer, all ruled; residuals filed as #2408, #2409)
- [x] commit (restacked on PR14 e5a2131b8: bb34744bf, 2421dd9af, 309534651; desktop test:main 9387, sync-server 1449)
- [x] PR https://github.com/memrynote/memry/pull/2411
- [x] verdict (swarm PASS at 309534651: red + receipts; follow-up #2414 orphan chunk cleanup bind limit)

### PR22 `chore/sync-server-dead-code` (#2303)

- [x] validate
- [x] design (remove the push-path checkQuota pre-estimate (Review); keep checkQuota, rate_limits and splitIntoWaves (load-bearing for duplicate ids))
- [x] failing test (2 red before)
- [x] implement
- [x] gates (tip 744bbae43: lint, typecheck, architecture, contracts, diff --check, contracts, sync-client, sync-server, desktop test:main, cargo settings_merge, docs:impact strict)
- [x] docs (protocol-consistent; apps/docs sync-protocol)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2400
- [x] verdict: swarm PASS at c3d25d215 (red-first, receipts); later heads differ only by restack and a docstring fix

### PR23 `fix/sync-settings-merge-spec` (#2383)

- [x] validate
- [x] design (mergeSettingsPayloads via shared mergeFields; absent winner keeps local (removal deferred, 06 §6.9.0 amended); shared vectors in TS and Rust)
- [x] failing test (4 red before)
- [x] implement
- [x] gates (tip 744bbae43: lint, typecheck, architecture, contracts, diff --check, contracts, sync-client, sync-server, desktop test:main, cargo settings_merge, docs:impact strict)
- [x] docs (protocol 06 §6.9.0-§6.9.1, 13; apps/docs sync-handlers)
- [x] commit
- [x] PR https://github.com/memrynote/memry/pull/2401
- [x] verdict: swarm PASS at 744bbae43 (red-first, receipts); later heads differ only by restack and a docstring fix

### PR24 `feat/sync-core-parity` (#2304)

- [x] validate
- [x] done in two parts (below): part 1 #2407, part 2 #2418, both swarm PASS

Split. Part 1 (P2.3 wake skip+coalesce, P2.5 inline, §5.14 non-envelope hold, #2399 settings, P1.8 check): https://github.com/memrynote/memry/pull/2407, cargo test 934, swarm PASS at 430ffd1f6 plus a line-ceiling split (2481410eb). Part 2 (P2.7, P3.3 note_body, one-time Rust re-pull for the pre-P1.1 race) after PR14 and PR17.

Part 2 `feat/sync-core-parity-2` (on PR25 cec7f9745):

- [x] design (identical-payload equal skip via document_gate; durable per-doc body debt; three-state cursor-skip repair; note_body feed with per-entry owed failures, bodies + debts + cursor in one transaction, legacy pull over held docs (option B))
- [x] failing test (item 1: 4 red; item 2: 3 red; item 3: 7 red)
- [x] implement (2a1f5daa2, 9fd9ed282, a14698fd1)
- [x] gates (cargo test 956, clippy, fmt, check --workspace, memry-cli 34, line ceilings, vectors:check, docs:impact)
- [x] docs (05 §5.3/§5.5/§5.11, 06 §6.5.2 P4, 07 §7.17.4 Rust notes)
- [x] interrogate (/tmp/sa-interrogate/pr24b-{a,b}.md: 1 critical, 3 high, 5+3 medium; all fixed: body step never blocks push, legacy sweep converted to debts, 200-request budget per pass, tombstones settle debts, held-cursor skip before fetch, stop after 429, no feed bodies for documents without body state, settle only at head, per-doc backoff, snapshot refusal for resident docs behind their log)
- [x] commit (8181b886e, 90db4fa8b, 2abbf6ad1 on cec7f9745; cargo test 968)
- [x] PR https://github.com/memrynote/memry/pull/2418
- [x] verdict (swarm PASS at 2abbf6ad1: red + receipts; journal feed test added per receipts note, head a5ece4144)

### PR27 `fix/sync-journal-remote-deletes` (#2385, mid-run discovery)

- [x] validate
- [x] design (delete entry kind in the bulk-apply crash journal with per-entry deferredAt; replay unlinks only if mtime <= deferredAt; one op per path; old readers drop the entry)
- [x] failing test (9 red)
- [x] implement
- [x] gates (tip 5bfc54ed3: lint, typecheck, architecture, contracts, diff --check, sync-client, sync-server, desktop test:main, docs:impact strict) · [x] docs · [x] commit · [x] PR https://github.com/memrynote/memry/pull/2405 · [x] verdict: swarm PASS at 5bfc54ed3

### PR28 `fix/sync-core-settings-merge` (#2399, mid-run discovery): folded into PR24 part 1

### PR29 `fix/sync-signed-delete-attestation` (#2408, mid-run discovery from PR21 interrogate)

- [x] validate (filed from reviewer evidence) · [x] design (runner A, /tmp/sa-arch/p29-a.md: Ed25519 device signature over canonical CBOR {purpose,id,type,deletedAt,clock}; D1 0015 delete_attestation kept by the shed; served on purgedTombstones; desktop refuses unattested/unknown/invalid; Rust producer + verifier + shared vectors, consumer not ported) · [x] failing test (desktop matrix 58 red, server 10 red, vectors, Rust vectors) · [x] implement · [x] gates (desktop 9567, server 1465, contracts 2301, sync-client 204, cargo 976, harness 34, lint, typecheck, architecture, contracts, ceilings, ipc) · [x] docs (04 §4.8.4, 05 §5.12.3, apps/docs) · [x] commit (8b5864e72, d01205dfc on 0d8186199; review fixes: a missing token or unreadable device list holds the page; local_newer compares ms deletedAt in seconds) · [x] restack after PR18 (0c56eff1c, aa00e7250 on 5506a2782, clean; desktop 9644, server 1510, contracts 2308, cargo 986; re-restacked onto a354b8561: ca44cd03e) · [x] PR https://github.com/memrynote/memry/pull/2431 · [x] verdict (swarm PASS at ca44cd03e: red + receipts)

### PR30 `fix/sync-recreate-clock-seed` (#2409, mid-run discovery from PR21 interrogate)

- [x] validate (filed from reviewer evidence) · [x] design (runner A, /tmp/sa-arch/p30-a.md: sync_tombstone_clocks, desktop data 0061; recorded on local and remote deletes; every first-clock mint of a recreatable type ticks from merge(T); core tombstone_clock column 0004, write_over_tombstone; shared recreate-clock vectors; server allowance kept; core uses a new sync_tombstone_clocks table (0004) instead of ALTER, for crash-window idempotency) · [x] failing test (fixture table 34 red, apply-item, migration, harness, Rust folder/journal/apply) · [x] implement · [x] gates (desktop 9555, server 1456, contracts 2287, sync-client 203, harness 36, cargo 976, lint, typecheck, architecture, contracts, ceilings; pull.rs 597/600) · [x] docs (05 §5.8/§5.12.3, 06 §6.1.1, apps/docs) · [x] commit (75a9e92e1, 166db5587, b7753e924 on 0d8186199; 0061 when = 0059 + 2 days, PR18's 0060 must sit between) · [x] restack after PR29 (ec2bece43, 08f6b73d4, f8a255ba8 on aa00e7250; journal 0060+0061 both kept in order, 05 §5.12.3 residuals merged, vector README row; desktop 9701, server 1513, contracts 2320, harness 36, cargo 993; re-restacked ed8b40f76) · [x] PR https://github.com/memrynote/memry/pull/2432 · [x] verdict (swarm PASS at ed8b40f76: red + receipts)

Follow-up filed: #2423 (no-snapshot delete fallbacks, start-up flush folding a re-create into a stale delete).

### PR33 `fix/sync-recreate-pending-delete-fold` (#2423, mid-run discovery from PR30)

- [x] validate (item 2 partial: only the dirty-sweep types (bookmark, canvas_folder, note, journal) are deleted everywhere; seeded types get a spurious delete then a re-create; item 1 valid, plus tag_category) · [x] design (start-up flush retires a pending delete whose recreatable id has a live local row, per-type liveness map; no-snapshot deletes derive from the clocked local row or push nothing) · [x] failing test (18 red of 26) · [x] implement · [x] gates (desktop 9580, sync-client 203, contracts 2287, lint, typecheck, architecture, contracts, ceilings) · [x] docs (apps/docs; protocol unchanged) · [x] commit (9e4077a19, bbb3adaf9 on b7753e924; restacked 01df98fd2, bd8d68f7a on f8a255ba8, desktop 9726; re-restacked 929f34d2b) · [x] PR https://github.com/memrynote/memry/pull/2433 · [x] verdict (swarm PASS at 929f34d2b: red + receipts)

### PR25 `feat/sync-transactional-outbox` (#2301)

Merge-gated: P1.5 sweep reports residual rows (instrument shipped here: `dirty_recovery_residual`, `sync_intents_replayed`).

- [x] validate
- [x] design (runner B: `sync_intents` journal, data-DB migration 0059 additive; T1 row + intent (+ delete tombstone), T2 clock + queue + intent delete; TasksUnitOfWork; tasks and projects first)
- [x] failing test (first pass 7 red + 2 absent modules; review round 26 red)
- [x] implement (a8a762f8f on PR21 309534651)
- [x] gates (desktop test:main 9434, test:shared 3510, sync-client 203, lint, typecheck, architecture, contracts, line ceilings, docs:impact strict, docs:build)
- [x] docs (apps/docs sync-handlers "Sync intents", local-storage migrations; no protocol change)
- [x] interrogate round 1 (/tmp/sa-interrogate/pr25-{a,b}.md: 1 high, 5 medium, all fixed)
- [x] interrogate round 2 (/tmp/sa-interrogate/pr25r2-{a,b}.md: 2 medium each; attempts counted at start-up only, never given up (stays pending and guarding), unreadable rows untouched, pending_intent ledger instead of the deferred-retry drop, precise retag/status fields)
- [x] commit (restacked on PR31 9b360ccd3: bd2b6e6c6, cec7f9745; patch-id unchanged)
- [x] PR https://github.com/memrynote/memry/pull/2417
- [x] verdict (swarm PASS at cec7f9745: red + receipts)

### PR26 `feat/sync-ws-fast-path` (#2300)

Merge-gated: sync_e2e_ms p50 after phase 2 still above ~0.7-1 s.

- [x] validate
- [x] design (runner B: opt-in socket items via X-Memry-Socket-Items + X-Memry-Sync-Types, <=64 KiB all-or-nothing, byte-identical to /sync/pull; desktop applies at bulk-apply quiescence, never writes LAST_CURSOR, records no failure state; the pull still runs)
- [x] failing test (engine, socket-apply, bulk-apply quiescence, DO frames, service committed items, route, contracts, websocket)
- [x] implement (bb11de3f2 on PR14 e5a2131b8)
- [x] gates (contracts 2272, sync-server 1416, desktop test:main 9348, lint, typecheck, architecture, contracts, docs:impact strict, docs:build)
- [x] docs (protocol 09 §9.2, §9.5, §9.11, new §9.13; 05 §5.11; apps/docs sync-protocol)
- [x] live (sync-socket-items.e2e.ts: every B HTTP pull severed, A's edit still lands on B from the frame; itemsSent=1)
- [x] interrogate (/tmp/sa-interrogate/pr26-{a,b}.md: 1 high, 5 medium; all 11 ruling items fixed: owned-through mark, serialized frames, synchronous quiescence, replay reconciles unlandedOps, push-in-flight gate, budget from payload sizes, expired tokens hint-only, 50-item cap, latency cap, applyDecryptedItem helper, docs)
- [x] commit (7436b7b8f, accece6f1 on e5a2131b8; contracts 2272, sync-server 1420, desktop test:main 9367, live 2/2)
- [x] restack onto the chain tip (7088a1c67, dcdcacb04 on df7cde63f; six conflicts resolved preserving purged-tombstone, attestation, sync-intent, ledger, tombstone-clock and claim rules; new: a note record applied from a frame owes its whole body with a durable record debt; desktop 9772, server 1544, contracts 2325, sync-client 206; live socket-items and inline-changes pass; conflict commit ran without hooks, mitigated by secret scan, prettier and ipc:check over the diff)
- [x] interrogate round 2 (/tmp/sa-interrogate/pr26r2-{a,b}.md: every round-1 fix still closed; A: 1 high (frame file ops unjournaled, #2385 class on the live path), 4 low; B: 4 low (post-apply writes outside the item try, zombie push pins the gate, frames dropped during a push, per-frame gate sample); pre-existing processedIds drop filed #2429)
- [x] round-2 fixes (c1c989a49, 441a31f0d on df7cde63f; desktop 9779, server 1544, contracts 2325; live socket-items and inline-changes pass; ruling /tmp/sa-owner/pr26-r2-ruling.md: frame runs in a page session with journaled file ops and synchronous landing; conflict, owe and apply commit together; owe only on applied/conflict; owned-through mark kept until LAST_CURSOR reaches it; push-generation gate with bounded wait; per-item latency samples) · [x] final restack onto the chain tip (PR35 318284950: 97ba683de, 7b744755b; stack-tip gates: desktop 9823, server 1544, contracts 2325, sync-client 206, harness 36, cargo 993; live socket-items, debt-restart, inline-changes, cursor-skip, feed-delivery pass) · [x] PR https://github.com/memrynote/memry/pull/2437 · [x] verdict (swarm PASS at 7b744755b: red + receipts)

### PR36 `refactor/sync-delete-crdt-sweep` (#2421 part b, merge-gated)

Gates: `minWriteVersion` past #2419/#2430, no Worker rollback past #2295, #2420 cursor deployed.

- [x] validate (every old path still the only delivery path in some pre-gate state; valid once the gates hold)
- [x] design (p18-a PR18b row; `crdt_updated` becomes a wake only with the key `done` and a cursor; sweeps deleted, legacy sweep, probe and watermark kept; record narrowing only where the feed demonstrably served the body)
- [x] failing test (10 red)
- [x] implement
- [x] gates
- [x] docs (07 §7.7.1/§7.12/§7.17.3/§7.17.5, 09 §9.11, apps/docs)
- [x] live
- [x] interrogate round 1 (/tmp/sa-interrogate/pr36-{a,b}.md: 1 high (lost unmerged flag), mediums; ruling pr36-ruling.md, 8 items fixed, 18 red)
- [x] interrogate round 2 (/tmp/sa-interrogate/pr36r2-{a,b}.md: 0 high; ruling pr36-ruling-r2.md, 7 items fixed, 14 red; `crdt_body_withheld`, desktop data migration 0062)
- [x] commit (on the stack tip after main `ba6ce80d2`: 7266542dc, 1ebcb868b)
- [x] PR https://github.com/memrynote/memry/pull/2444
- [x] verdict (swarm PASS at 1ebcb868b: red + receipts; receipts' test failures were contamination from the concurrent red-lane revert, a clean checkout at head runs test:main green, 9902)

### PR37 `refactor/sync-delete-crdt-legacy-sweep` (#2421 part c, narrowed, merge-gated)

- [x] validate
- [x] design (ruling: the legacy sweep stays, because it is the only writer of `done`, which licenses #2299 claims; only the `crdtUnmergedDebt` mirror writes go, the reader stays)
- [x] failing test (5 red)
- [x] implement
- [x] gates
- [x] docs
- [x] commit (8c651aa5b, e8c94b3ca)
- [x] PR https://github.com/memrynote/memry/pull/2445
- [x] verdict (swarm PASS at e8c94b3ca: red + receipts; body test counts corrected)

### PR31 `fix/sync-orphan-chunk-cleanup` (#2414)

Found in PR21 review. Stacked on PR21 (#2411) for now; final restack linearizes it.

- [x] validate (`deleteRowsAndBlobs` bound up to 1000 ids; objects deleted before an unguarded row delete, so a re-referenced chunk lost its bytes)
- [x] design (row first with `ref_count <= 0` guard and RETURNING, re-check keys a fresh row claimed, one bulk R2 delete per 90-id batch, 300 per tick)
- [x] failing test (orphan-chunk-cleanup.test.ts: bind ceiling, re-reference race, re-create race)
- [x] implement (20028a439)
- [x] gates (sync-server 1453, contracts 2275, lint, typecheck, architecture, contracts, line ceilings, docs:impact strict, docs:build)
- [x] docs (protocol 14 §14.8; apps/docs sync-protocol Note Attachments; 9b360ccd3)
- [x] PR https://github.com/memrynote/memry/pull/2416
- [x] verdict (swarm PASS at 9b360ccd3: red + receipts)

## Acceptance map

One line per acceptance criterion: issue, criterion, test name or live result, or the stated narrowing. Compiled 2026-09-25, updated 2026-09-26 after the rebase onto main `d71c6f87d` (every unit PR-linked).

- #2284 row exists before commit returns, file written by flushFiles: `page-apply-file-writes.test.ts` "commits the row with the page and writes the file on flush".
- #2284 crash between commit and flush, replay writes the file: `page-apply-file-writes.test.ts` "replays the file write after a crash between commit and flush"; property delete: "journals the properties.md rewrite so a crash cannot bring the definition back".
- #2284 no `.then(` in item-handler apply paths: grep returns nothing (PR02 body).
- #2285 schema failure returns schema_invalid, recorded, re-fetched and re-applied after an app update: `apply-item.test.ts` "#then returns schema_invalid ...", `pull-coordinator.test.ts` "#then the item is re-fetched by id and applied, though the cursor moved past it", `item-recovery.test.ts`, `schema-invalid-ledger.test.ts`.
- #2285 malformed pull response: cursor not advanced, pull_page_dropped still emitted: `pull-coordinator.test.ts` "#then logs pull_page_dropped ...".
- #2282 two concurrent pushes, no reader sees the higher range before the lower: `push-batch-pipeline.test.ts` "never lets a reader page past a range that commits after a higher one" (real SQLite, held batch).
- #2282 existing sync.test.ts + cursor.test.ts green, `pushed` response unchanged: sync-server suite 1318/1318; `push-batch-pipeline.test.ts` old-client compat matrix.
- #2283 push with maxCursor 100 and LAST_CURSOR 40 leaves 40: `push-coordinator.test.ts` "#then it leaves the pull cursor where the last pull put it".
- #2283 peer item below own push cursor delivered on next pull: `engine-push.test.ts` "(accepted 1, cursor delta 7)"; live `sync-cursor-skip.e2e.ts` (main 1/7, head 7/7).
- #2283 server mirror: `routes/sync.test.ts` "should leave the device pull cursor alone when items are accepted".
- #2382 key absent + LAST_CURSOR 40 pulls from 0, done after a clean pull: `full-sync-runner.test.ts` "#then an install with a cursor re-pulls from 0 under the lock ...".
- #2382 refused pull mid-repair repeats the repair (as redesigned: resumes, never restarts): `full-sync-runner.test.ts` "#then an interrupted repair resumes from its persisted cursor ...", "#then a pull that throws leaves the repair pending".
- #2382 fresh install, no reset, key set: `full-sync-runner.test.ts` "#then an install with no cursor / cursor 0 records done without a reset".
- #2382 #2283-shape regression: `engine.test.ts` "#then the skipped update arrives and the repair is recorded".

## PR04 (#2286 P1.5)

Review 2026-09-24 wins: descriptor list must be per sync item type (`RECORD_SYNC_ITEM_TYPES`, 25 members), not per `syncedAt` table; guard test enumerates the union and requires a sweep or a stated exemption.

- #2286 per-type (not per-table) descriptor list covering the full `RecordSyncItemType` union: TypeScript `Record<RecordSyncItemType, ...>` shape (compile-time) plus `dirty-recovery.test.ts` "covers every record sync item type with a sweep or a stated exemption (#2286)".
- #2286 never-synced row enqueued as create, no `_offline` key on the wire: `dirty-recovery.test.ts` "pushes a clocked never-synced row as a create with no _offline key on the wire (#2286)".
- #2286 modified-since-sync row enqueued as recovered update at stored clock: `dirty-recovery.test.ts` "re-pushes a row modified after its last sync at its stored clock (#2286)".
- #2286 `_offline` clock rebind path: `dirty-recovery.test.ts` "rebinds an offline tick instead of putting _offline on the wire (#2286)".
- #2286 comment references the issue: multiple `(#2286)` comments in `dirty-recovery.ts` and every new test title.
- #2286 compat (client-only): no non-desktop/sync-client files touched (per pr2390-receipts.md diff-stat check).
- #2286 12 types exempted rather than swept: disclosed narrowing per the review's own allowance ("either add a dirty marker... or record that the type relies on P4.2 (#2301)"); each exemption is schema-verified in the PR body.

## PR05 (#2287 P1.6)

Review 2026-09-24 adds: tick-sum/removal-of-absent-path carved out to #2383; test the round trip, not a single merge call.

- #2287 device A and B edit the same setting concurrently, both clocks compare `concurrent`, merge branch runs, round trip converges to one value: `settings-sync.device-clock.test.ts` "#given two devices edit the same setting #then their clocks compare concurrent", "#given both devices push before either pulls #then a round trip leaves both on one value", "#given one device pulls the other before pushing #then a round trip leaves both on one value".
- #2287 old-client clock `{local: 3}` merges against a new one `{dev-a: 1}` without throwing: `settings-sync.device-clock.test.ts` "#given an old-client clock {local: 3} and a new clock {dev-a: 1} #then both directions merge without throwing".
- #2287 `grep -rn "'local'"` over the three named files returns nothing clock-related: independently re-verified against the committed blobs at PR05's head (`d108705...`); zero matches (pr2391-receipts.md §3).
- #2287 comment references this issue: `// #2287` / `(#2287)` present in `settings-sync.ts` and the new test file.
- #2287 tick-max-vs-tick-sum and absent-path removal: disclosed, correctly-scoped narrowing to #2383 (PR05 body states "Winner rule (tick-max, keep local on tie) unchanged; that is #2383").

## PR06 (#2310 P1.7)

- #2310 throttled path and performed path produce distinguishable log lines: `full-sync-runner.test.ts` "#then a throttled check logs a skip with its reason and next eligible time, not a clean result", "#then a performed check logs complete with its diff result".
- #2310 skipped path never emits a `serverOnlyCount: 0` that reads as clean: same test, asserts `'serverOnlyCount' in payload` is false for every `fullSync: manifest check*` log call.
- #2310 additional `performed:false` causes (no-token, error) named in the issue's own Problem section: `manifest-check.test.ts` "#then reports the skip as no-token, eligible one window from now", "#then reports the skip as error", "#then the throttled result says so and when the next check is due".
- #2310 Review 2026-09-24 (reconfirms only, no new criteria): no additional mapping needed.

## PR07 (#2280 P0.1, #2281 P0.2)

- #2280 one PostHog query joins push accept -> broadcast -> apply on `(userId, cursor)`: `sync-telemetry.test.ts` "logs the vault, the accepted cursor range and its item count, and no item ids"; `user-sync-state.test.ts` "logs the vault, the cursor and how many sockets it reached, and nothing else"; `pull-coordinator.test.ts` / `sync-latency-telemetry.test.ts` (apply event carries `value = serverCursor`).
- #2280 no plaintext, no note ids in server logs beyond today: same two tests, explicit negative assertions (no item ids / nothing else logged).
- #2280 `sync_e2e_ms` dashboard exists before P2.x lands: disclosed narrowing, not code-testable — PR07 body's Rollout section defers this to a manual PostHog dashboard step before any Phase 2 client ships.
- #2280 Review addition, `sync_push_lag_ms` origin-side metric, product number is their sum: `sync-latency-telemetry.test.ts` `describe('PushLagTrace')` "reports accept time minus enqueue time per accepted row, keyed by maxCursor", "skips an offline backlog older than the live window", "caps a push run at ... events across responses".
- #2280 Review addition, clock skew via RTT-midpoint offset: `sync-latency-telemetry.test.ts` `describe('PullLatencyTrace')` "corrects the apply time by the clock offset from the RTT midpoint", "keeps the offset from the lowest-RTT sample".
- #2281 no normative sentence in chapter 09 contradicts shipped desktop behavior: docs-only change to `docs/protocol/09-realtime.md`; every code citation independently re-verified against the tree (pr2393-receipts.md §4); no test file expected for a doc-only concern.
- #2281 `pnpm docs:impact` clean: not independently re-run in this map; CI "Static checks" job passed on PR07 (`/tmp/sa-swarm/pr2393-receipts.md`).

## PR08 (#2288 P2.1)

- #2288 server test for the new 300/min-per-device limit: `sync.test.ts` `describe('record push rate limit')` (config test: 300/60s keyed by `deviceIdentifier`, no elevation; 300 ok/301st 429; second device gets its own bucket).
- #2288 ship before P2.2, watch `sync_push` 429 telemetry for 48h: not diff-testable — PR08 body's Rollout section restates this operational step verbatim; disclosed, not dropped.

## PR09 (#2289 P2.2)

- #2289 a lone enqueue starts a push within one tick: `push-coordinator.test.ts` "#then a lone request starts a push within one tick".
- #2289 five enqueues in 100 ms produce one push: `push-coordinator.test.ts` "#then five requests inside one window produce one push".
- #2289 an enqueue during an in-flight cycle produces exactly one push after the cycle, no timer re-arm: `push-coordinator.test.ts` "#then a request during an in-flight cycle pushes exactly once after it, with no timer"; extended to cycles with no `inFlightSync`: "#then a request during a directly started cycle pushes once when the engine signals its end", `engine-push.test.ts` (two matching tests).
- #2289 nothing pushes after `stop()`: `push-coordinator.test.ts` "#then nothing requested before stop() pushes after it" (harder than the issue's literal text, present as a superset).
- #2289 `sync_e2e_ms` p50 drops by >= 1.5s: disclosed narrowing, not unit-testable — PR09 body states this is measured post-release via the #2280 trace.

## PR10 (#2290 P2.3) live

- #2290 10 frames in 50 ms -> at most 2 pulls: `engine.test.ts` "#then ten wakes within 50 ms cost at most two pulls".
- #2290 a frame with cursor <= LAST_CURSOR -> 0 pulls: `engine.test.ts` "#then a wake whose cursor is at or below LAST_CURSOR pulls nothing" (also covers cursor-above and no-cursor cases; LAST_CURSOR itself is asserted untouched, honoring §9.11 "MUST NOT use the broadcast cursor as its own").
- #2290 a frame during a pull -> exactly one follow-up pull: `engine.test.ts` "#then wakes during a running pull queue exactly one follow-up pull".
- #2290 `recoverStaleSyncLock` clears the queued-wake flag (extra regression, disclosed in the body): `engine.test.ts` "#then a wake after the stale-lock watchdog fires schedules a pull again".
- #2290 comment references this issue: `#2290` on all four new tests and the `wakePullQueued`/`scheduleWakePull` code.
- #2290 live: `sync-wake-coalesce.e2e.ts`, restacked head wakes=23 pulls=5 pass (start SHA wakes=23 pulls=23 fail). Note: pr2398-receipts.md flags one CI run of the identical head SHA that showed wakes=0/pulls=0 (A's socket never connected in that run); tasks.md records this was root-caused (app version 0.0 under the harness's MIN_APP_VERSION floor) and fixed in its own commit on PR10, after which CI showed wakes=23 pulls=5 live activity.

## PR11 (#2291 P2.4)

- #2291 a frame `{ type: 'future_type', payload: {} }` is ignored without emitting `error`; known frames still dispatch: `websocket.test.ts` "#then ignores an unknown frame type without an error event", "#then dispatches known frames after ignoring an unknown one".
- #2291 `grep -rn "z.enum(SYNC_SOCKET_MESSAGE_TYPES)" apps/desktop` returns nothing: independently re-verified against the committed tree at PR11's head (pr2395-receipts.md §3).

## PR12 (#2292 P2.5) live

- #2292 server: inline page byte-identical to `/sync/pull` for the same ids: `inline-changes.test.ts` "inlines each small item byte-identical to what /sync/pull returns for it".
- #2292 server: refs > 64 KB have no inline fields: `inline-changes.test.ts` "keeps the ref of a row over 64 KiB but leaves it out of inline".
- #2292 server: page cap enforced: `inline-changes.test.ts` "clamps an inline page to 100 refs and reports hasMore".
- #2292 desktop: all-inline page makes zero `/sync/pull` calls: `pull-coordinator-inline.test.ts` "asks for inline on the first page and applies a fully inline page with no /sync/pull".
- #2292 desktop: mixed page makes one `/sync/pull` call for the large ids: `pull-coordinator-inline.test.ts` "pulls only the ids the page did not inline, and applies both sources in rank order".
- #2292 `sync_e2e_ms` p50 drops ~150-200ms: production measurement, deferred to the #2280 trace after release; stated in the PR #2402 body. Live evidence shows the request drop (POST /sync/pull 1 -> 0).
- #2292 live: `sync-inline-changes.e2e.ts`, start SHA POST /sync/pull=1 fail; branch POST /sync/pull=0 pass.

## PR13 (#2293 P2.6)

Review 2026-09-24 wins: item 4's description corrected (the `break` exits only the per-item loop, not the outer 50-iteration loop).

- #2293 item 1, ceiling only ever lowered, never restored: `push-coordinator.test.ts` "#then the lowered ceiling climbs back once full batches land cleanly again".
- #2293 item 2, `retryOn5xx: false` unconditionally: `push-coordinator.test.ts` "#then it is retried with backoff instead of resent at once, and lands" (narrowed: retry-with-backoff applies to min-size batches that cannot be split further; halving stays the first answer for splittable batches — disclosed in the PR body).
- #2293 item 3, global `rateLimitedUntil` in `crdt-queue.ts` gates every note on one note's 429: **narrowed, not fixed.** Disclosed: single per-device rate-limit bucket shared by all CRDT push routes; a per-note gate would multiply wasted 429s (issue comment cited in the PR body; pr2397-receipts.md §3). No code change, no new test — the pre-existing `crdt-queue.test.ts` assertion was cited as already covering the invariant (crdt-queue.ts itself was later deleted whole-cloth by PR19/#2298).
- #2293 item 4, quota-rejected item does not stall the rest of the response (corrected description): `push-coordinator.test.ts` "#then the rest of the same response is still acked and recorded", "#then later batches keep going out, so a delete that frees space is not blocked".

## PR14 (#2294 P2.7) live

Review 2026-09-24 wins: narrows "equal clock -> skip" from blanket to equal-clock-and-identical-payload only (protocol §6.5.2 P4 requires equal-clock-with-different-payload to still apply).

- #2294 crash between slice 3 and 4 of a 5-slice page -> restart re-applies only slices 4-5: `pull-coordinator-cursor-tx.test.ts` "a crash between slice 3 and 4 holds the cursor, and the re-pull re-applies only slices 4-5".
- #2294 a slice whose commit throws emits nothing to windows (buffered emit, flush after commit): `pull-coordinator-cursor-tx.test.ts` "a last slice whose commit throws keeps the cursor and emits nothing for its items"; `bulk-apply.test.ts` "a page whose data COMMIT throws drops them".
- #2294 equal clock + identical payload -> skip, no row write, no emit (narrowed per Review to content-equal only): `types.test.ts` "skips an equal clock whose payload is identical to the local one" (plus task/note/canvas/settings handler tests).
- #2294 equal clock + different payload -> still applies (§6.5.2 P4, not in the original issue text, added by the Review): `types.test.ts` "applies an equal clock whose payload differs from the local one"; E2E part (b) of `sync-equal-clock-echo.e2e.ts` reproduces the diverged-row-under-the-same-clock scenario.
- #2294 live: `sync-equal-clock-echo.e2e.ts`, start SHA echo re-applies 5 / identical 4 fail; branch 0 / 0 with the diverged row still applied, pass.
- #2294 comment references this issue: per tasks.md PR14 gates/commit entries.

## PR15 (#2295 P3.1) live

- #2295 migration applies on a populated dev D1 without touching existing rows: `crdt-server-cursor-migration.test.ts` "applies on a populated database without touching existing CRDT rows".
- #2295 client without `note_body` sees no CRDT rows; with it, sees them in cursor order interleaved with records; old NULL-cursor rows never appear: `note-body-feed.test.ts` "serves no CRDT row and no noteBodies key to a client that did not declare note_body", "interleaves records, updates and snapshots in cursor order when note_body is declared", "never serves a pre-migration row with a NULL cursor"; live harness `tests/sync-harness/note-body-feed.test.ts` on Miniflare reproduces the same (with note_body: body@1 + task@2; without: task only).
- #2295 concurrent record push + CRDT update push produce strictly increasing cursors across both tables: `push-batch-pipeline.test.ts` "hands concurrent record, update and snapshot writes disjoint cursors in commit order".
- #2295 disclosed narrowing: `note_body` added to `FEED_ONLY_SYNC_TYPES`/`NEGOTIABLE_SYNC_TYPES`, not `RECORD_SYNC_ITEM_TYPES` as the issue's Fix section literally said — a fix-design change, not an acceptance-criterion change, justified in the PR body (pr2403-receipts.md).

## PR16 (#2296 P3.2)

- #2296 the same update posted twice yields one row and identical `{ sequences }`: `crdt-update-idempotency.test.ts` "stores a retried update once and answers the same sequences"; also covered live in `tests/sync-harness`.
- #2296 storage accounting not charged twice: `crdt-update-idempotency.test.ts` "charges storage once for a retried update" (asserts `storageUsed() === 3` after two identical 3-byte pushes).
- #2296 compat, additive/no client change: `crdt-update-idempotency.test.ts` "applies on a populated database without touching existing update rows"; response shape unchanged (no route file touched).
- #2296 swarm-found regression (retry near a full quota refused because reservation ran before dedupe): fixed in the same PR with a red-first test (`crdt-update-idempotency.test.ts`, quota-on-retry case per pr2404-receipts.md and tasks.md PR16 verdict line).

## PR17 (#2297 part a, P3.3) live

Review 2026-09-24 adds two gaps that must close before the legacy sweep is deleted: pre-cursor backlog (one final full CRDT sweep on first `note_body`-negotiating launch) and journal body coverage.

- #2297 E2E body edit on A appears on B via `/sync/changes` with no `crdt_updated` frame delivered: `body-crdt-feed-delivery.e2e.ts` (B's CRDT pulls disabled via `disableCrdtBodyPullsForTests`; base fails, branch passes).
- #2297 crash test, process dies between slice commit and LevelDB flush, journal replay applies the body and the cursor is correct: `pull-coordinator-note-bodies.test.ts` "a crash before the landing leaves the cursor on the page, and the re-pull lands it".
- #2297 existing CRDT round-trip and compaction tests still green: body-crdt suite 34/36 at PR17 head (V6 and outbox-restart pre-existing-failure/passing-alone, per tasks.md PR17 commit line); CI "Unit & integration tests" pass.
- #2297 `git diff --stat` shows net deletion: **not applicable to this PR** — PR17 is explicitly part a (apply from the feed); the deletion of the old `crdt_updated`/sweep/watermark machinery is part b, PR18.
- #2297 Review gap 1, pre-cursor backlog / one final full sweep before deleting old machinery: `full-sync-runner.test.ts` (6+ dedicated tests, lines ~1322-1466) plus `pull-coordinator-note-bodies.test.ts` "marks the legacy sweep pending when bodies are served and resets it when they are not".
- #2297 Review gap 2, journals carry bodies too, tested through the feed: `docs/protocol/07-crdt-updates.md` §7.17.5 states it explicitly; `pull-coordinator-note-bodies.test.ts` "applies a journal body edit through the feed"; E2E exercises both a note and a journal edit through B's feed-only path.
- #2297 "B issued no `/sync/crdt/updates` GET" is manual server-log evidence in PR #2419; PR18 adds it as an assertion to `body-crdt-feed-delivery.e2e.ts`.

## PR18 (#2297 part b, narrowed by its Review) — PR #2430

The #2297 Review binds deletion to a later release, so PR18 makes owed tracking durable and deletes only the vault-wide latch; the deletions moved to #2421 (PR36/PR37 below).

- #2297 E2E: a body edit reaches B through `/sync/changes` with no `crdt_updated` delivered: `body-crdt-feed-delivery.e2e.ts` (B's CRDT pulls disabled, asserts no GET to `/sync/crdt/updates`).
- #2297 crash test (dies between slice commit and body landing, re-pull lands it, cursor right): `pull-coordinator-note-bodies.test.ts` "a crash before the landing leaves the cursor on the page, and the re-pull lands it"; a debt survives restart: "a record debt the batch did not pay survives a restart and the next engine pays it"; live `body-crdt-debt-restart.e2e.ts` (base red, branch green).
- #2297 existing CRDT round-trip and compaction tests green: CI Unit & integration tests; live body-crdt suites.
- #2297 journal bodies through the feed: `pull-coordinator-note-bodies.test.ts` "applies a journal body edit through the feed" (PR17); PR18 debts key on the doc id, notes and journals alike.
- #2297 net deletion: moved to PR36/PR37 (#2421), merge-gated; disclosed in #2430.

## PR19 (#2298 P3.4)

Review 2026-09-24 blocker: `SyncQueueManager.enqueue` coalesces on `(itemId, type)` and overwrites payload — naive `note_body` enqueue would lose edits. Resolved via a separate append-only path, one of the two options the issue's own text allowed.

- #2298 crash test, updates enqueued but not pushed survive restart and are pushed as updates, not a full-state snapshot: `note-body-outbox.test.ts` "pushes updates a previous process enqueued but never flushed, as updates" (unit); `body-crdt-outbox-restart.e2e.ts` (full process restart).
- #2298 ordering test, updates for one note posted in enqueue order after merge: `note-body-outbox.test.ts` "posts one note's updates in enqueue order when they merge into several".
- #2298 `git diff --stat` shows net deletion (~500 lines target): actual full diff -1153 net lines (1740 insertions, 2893 deletions), exceeds the target (pr2406-receipts.md).
- #2298 Review blocker, two updates enqueued before a flush both reach the server (append-only, no coalescing loss): `queue.test.ts` "keeps two updates enqueued for one note before a flush as two rows, in order (#2298)"; also "keeps note body rows away from every record push method (#2298)", "holds at most one unsent full-state row per note (#2298)".

## PR20 (#2299 P3.5) — PR #2425

- #2299 a snapshot with `coversThrough = 50` leaves an update at cursor 51: `crdt-snapshot-covers-through.test.ts` "prunes the updates at or below coversThrough = 50 and leaves the update at cursor 51".
- #2299 without the field, behavior unchanged: same file, "keeps today's rule without the field: the first snapshot takes the whole log" and the second-snapshot variant.
- #2299 desktop sends `LAST_CURSOR`: `snapshot-covers-through.test.ts` "claims LAST_CURSOR for a note whose bodies all landed, and the server prunes through it".
- #2299 Review: a tracked-unapplied body at cursor 40 with `LAST_CURSOR = 50` is never pruned: `snapshot-covers-through.test.ts` "never prunes a tracked-unapplied body at cursor 40 once LAST_CURSOR is 50" (implemented as a claim/refusal protocol, not the `min(...)` formula; disclosed).
- #2299 compare-and-swap (redesign): the `describe('the claimed snapshot is never replaced by one that does not cover it (#2299)')` block; dormant until `CRDT_CLAIM_MIN_DESKTOP_VERSION` is set (Rollout).
- #2299 delete the destructive/non-destructive routing: narrowed; the routing stays while owed pulls exist and old servers ignore C (Decisions 2026-09-25 PR20).

## PR21 (#2302 P4.3)

Review 2026-09-24 adds a required, most-data-risky rule: a locally-synced row absent after a purged-cursor re-pull is deleted locally, not re-pushed.

- #2302 device offline past retention pushes an update to a purged item -> server rejects or client is told to re-pull, no resurrection: `tombstone-marker.test.ts` "refuses a concurrent update with SYNC_DELETE_WINS per item, HTTP 200, neighbours accepted", "refuses an unchanged old clock as SYNC_REPLAY_DETECTED", "accepts a re-create whose clock happens strictly after the marker and clears both flags".
- #2302 row with missing blob is reported, not dropped, does not block the page: `tombstone-marker.test.ts` "returns the page-mates in cursor order and names the lost row in blobMissing", "answers 200 for a slice that holds only a lost blob", "drops, without marking, a row whose blob was replaced after it was read", "clears blob_missing_at on the next accepted push"; desktop `purged-tombstones.test.ts` "records a blobMissing entry, applies nothing to it, keeps the row, and advances the cursor".
- #2302 Review addition, resurrection-prevention rule (delete-locally-not-re-push on absence after a purged-cursor re-pull): `purged-tombstones.test.ts` (13 tests) plus `pull-envelope.test.ts` (4 tests) plus `purged-tombstone-guard.test.ts` (new file, clockless-local/pending-write/newer-local-write/unknown-device/cursor-0 cases), including the explicit converse "keeps a synced local row the server no longer has after a re-pull from cursor 0" and "leaves the local row untouched when a deleted id comes back with no entry of any kind" — proving the engine deletes only on an explicit marker fact, not on mere absence (more conservative than the review's minimum ask).
- #2302 original design note, client needs a new handler for a purge hint (none existed before): `purged_tombstones` capability negotiation + `purgedTombstones`/`blobMissing` schema fields + `pull-envelope.ts` admission + `purged-tombstone-guard.ts` refusal — new code, matches the review's correction.
- #2302 disclosed narrowings (all with residual risks documented in `docs/protocol/05-record-sync.md` §5.12.3, and filed as follow-ups): clock regression on a re-created item deferred to #2409; unsigned server-asserted deletes deferred to #2408; bounded double refund accepted; pre-existing hard-deleted tombstones stay unprotected.
- #2302 follow-up found in review, orphan blob-chunk cleanup bind-limit bug: filed as #2414, shipped as PR31 (see below).

## PR22 (#2303 P4.4)

Review 2026-09-24 struck `rate_limits` deletion from scope (live writers: OTP attempt limiting, exception budget) and clarified `checkQuota` itself stays (only its push-path pre-estimate call is removed).

- #2303 tests updated, `pnpm --filter @memry/sync-server test` green: CI "Typecheck, test, and Worker bundle" shows sync-server `Test Files 82 passed (82)`, including `push-batch-pipeline.test.ts` (18 tests) and `sync.test.ts` (105 tests).
- #2303 net deletion: ambiguous wording, resolved per pr2400-receipts.md — the only production file touched (`services/sync.ts`) nets to a deletion (`estimatePushBatchBytes` helper and its call site removed); the total diff (+67/-17) is net-positive only because of new regression tests and a docs paragraph, which the repo's own house rule requires. Disclosed and justified, not a blocker.
- #2303 per-item refusal instead of whole-batch 413 when near quota: `push-batch-pipeline.test.ts` "refuses an item that does not fit per item, writing nothing, instead of throwing", "at quota, refuses only growing items and commits deletes and shrinking updates".
- #2303 `splitIntoWaves` kept rather than deleted: disclosed narrowing, matches one of the two options the issue's own Fix section explicitly allowed ("Either delete it ... or leave it").

## PR23 (#2383 P4.6)

- #2383 table test over §6.3.2's rows including tie and `_offline` rows: `settings-sync.merge-rule.test.ts` (rows 1-10, `it.each`), covering ties (rows 2, 3, 7) and `_offline` (rows 4, 5, 6).
- #2383 device A removes `general.foo` (ticked), device B still holds it, after both pull both have it removed: **not satisfied as literally written — disclosed and justified narrowing.** `settings-sync.merge-rule.test.ts` `describe('settings removal is not propagated yet (#2383)')` asserts B **keeps** its value after A clears its own copy. §6.9.0 amended in the same commit set (normative text changed from "REMOVED" to "the local value is kept"); code comment explains the closed-schema echo-vs-removal ambiguity; tracked by new issue #2399 (upstream dependency #2183).
- #2383 desktop and Rust core produce identical merged settings for a shared fixture set: 16/18 shared vectors match byte-for-byte between TS and Rust; the 2 that don't are the absent-winner cases from the item above, explicitly flagged `rustPending`.
- #2383 comment references this issue: `#2383` in `settings-merge.ts`, `settings-sync.ts`, `settings-sync.merge-rule.test.ts`, `settings-merge.json` generator, and the protocol doc.

## PR24 part 1 (#2304 steps 2/3/5-check, #2399) — PR #2407

- #2304 step 1 (P1.2 cursor equivalent): verified 2026-09-24, `push.rs` has no cursor reference; nothing to port. No test needed.
- #2304 step 2 (P2.3 wake filter/coalescing): `sync_realtime.rs` `a_wake_at_or_below_the_applied_cursor_runs_no_pass_and_is_never_stored`, `wakes_during_a_running_pass_coalesce_into_one_trailing_pass`, `a_cancelled_queued_wake_does_not_swallow_later_wakes` (stronger than #2290's stated acceptance; matches the review's warning about correctness).
- #2304 step 3 (P2.5 inline changes): `sync_engine.rs` `an_incremental_first_page_applies_inline_items_and_pulls_only_the_rest`, `an_all_inline_page_makes_no_pull_request`, `only_the_first_page_of_an_incremental_run_asks_inline`, `a_pull_with_no_stored_cursor_does_not_ask_inline`.
- #2304 §5.14 non-envelope hold (mirrors #2285): `sync_engine.rs` `a_pull_response_that_is_not_an_envelope_holds_the_cursor_and_refuses_the_run`, `a_non_envelope_remainder_refuses_the_page_even_with_inline_items`.
- #2304 P1.8 check (#2382 iOS applicability): disclosed deferral — `push.rs` grepped for `cursor`, no hits, confirming nothing to repair at step 1; the actual one-time re-pull repair for the pre-P1.1 server race lands in part 2 (PR24b).
- #2304 conformance tests exist for each ported step: satisfied for steps 2/3/§5.14 above; step 4 (P2.7) and step 5 (P3.3) are explicitly part 2, not this PR.
- #2399 shared settings-merge vectors pass in Rust with no `rustPending` flags, including `requeue`: both `rustPending` flags removed from `settings-merge.json`; `the_shared_settings_merge_vectors_match_desktop` asserts `requeue`; confirmed via full `cargo test -p memry-core` (934/934 passed).
- #2399 a Rust test reproduces the repro steps and keeps the iOS value: `a_desktop_echo_of_a_stripped_setting_keeps_the_ios_value` (follows the exact 4-step repro from the issue).
- #2399 re-queue on concurrent settings merge: `a_concurrent_path_requeues_and_a_dominated_one_does_not` (unit), `a_concurrent_settings_merge_requeues_the_merged_payload` (integration, asserts outbox row count).

## PR24 part 2 (#2304 steps 4/5, one-time Rust re-pull) — PR #2418

- #2304 step 4 (P2.7, narrowed per #2294's Review to equal-clock-and-identical-payload only): `sync_equal_clock.rs` `an_equal_clock_skips_only_an_identical_payload`, `an_equal_clock_with_a_different_payload_still_applies`.
- #2304 step 5 (P3.3, note_body feed, mirroring #2297's Review gaps): pre-cursor backlog closed via `sync.note_body_legacy_pull` debt mechanism (structural equivalent to desktop's sweep, disclosed): `sync_note_body_feed.rs` `the_legacy_body_pull_runs_once_over_held_documents_after_a_delivered_run`, `a_refused_run_owes_no_legacy_body_pull`.
- #2304 step 5, journals carry bodies through the feed: `sync_note_body_feed.rs` `a_journal_body_lands_through_the_feed_and_a_deleted_journal_drops_it` (added after the receipts note, head a5ece4144).
- #2304 #2382 one-time re-pull repair (Rust mirror): `sync_cursor_repair.rs` `an_install_with_a_cursor_re_pulls_the_feed_once_and_records_done`, `a_pending_repair_resumes_from_the_stored_cursor_and_never_resets_again`, `a_fresh_install_goes_straight_to_done`.

## PR25 (#2301 P4.2)

- #2301 a throw between row write and enqueue rolls back the row, no clocked-but-unqueued row possible for migrated types (tasks/projects first): satisfied via a **disclosed architecture substitution** — a durable `sync_intents` journal (T1 row+intent, T2 clock+queue+intent-delete) rather than the issue's literal "outer transaction passed into enqueue" shape. `commands-unit-of-work.test.ts` "publishes nothing when the write throws"; `sync-intents.test.ts` (large suite); `migrate.test.ts`.
- #2301 `onItemEnqueued` observed only after the outer commit: `queue.test.ts` "fires only after the outer transaction commits", "wakes once for several enqueues in the same tick".
- #2301 P1.5 sweep finds zero rows for migrated types in a soak run: **not satisfied, explicitly disclosed.** Merge-gated: PR25 ships the instrument (`dirty_recovery_residual`, `sync_intents_replayed`) but the soak data does not exist yet; #2286 (P1.5) is still open. tasks.md marks PR25 "Merge-gated" for exactly this reason.
- #2301 process note (not a code defect): #2301's own "Depends on P1.5" and criterion 3 are unresolved at PR merge time despite the PR using a "Closes #2301" auto-close phrase — flagged in pr2417-receipts.md as a tracking risk for the merge owner, not a test gap.

## PR26 (#2300 P4.1) — PR #2437, merge-gated

- #2300 frame with items: item visible before any `/sync/changes`, `LAST_CURSOR` unchanged: `engine-socket-items.test.ts` "socket items apply before the wake pull answers and leave LAST_CURSOR alone".
- #2300 bad signature: no apply, the pull quarantines: `engine-socket-items.test.ts` "a frame item with a bad signature is not applied, and the pull quarantines it".
- #2300 re-delivery by the pull is skipped (equal clock + identical payload, #2294 narrowing): inherited through the shared `ItemApplier`.
- #2300 journaled file ops on the fast path (round 2 H1): `socket-apply.test.ts` session/journal/replay cases.
- #2300 `sync_e2e_ms` p50 <= 0.35 s: the merge gate itself; measured after release on the combined pull + socket `e2e_latency` metric.
- #2300 live: `sync-socket-items.e2e.ts` (every HTTP pull severed; `pull attempts=2 delivered=0`, Worker `itemsSent=1`).

## PR36/PR37 (#2421) — PRs #2444, #2445, merge-gated

- `crdt_updated` becomes a wake once the legacy sweep is done and the frame has a cursor; otherwise per-note pull: `engine-crdt.test.ts` wake cases; `engine-crdt-wake.test.ts` (unmerged until the cursor lands, latched across a full sync, coalesced and refused-reconnect cases).
- Sweeps deleted, debts still paid: `full-sync-runner.test.ts` "no 15-minute sweep fires", "a socket that dropped and came back queues no sweep", "a manifest re-pull queues no sweep", "the debts it holds are still paid"; live `body-crdt-debt-restart`, `body-crdt-feed-delivery`.
- Record body narrowed only where served: `pull-coordinator-note-bodies.test.ts` narrowing cases and each excluded case (legacy pending, unusable table, withheld, conflict, rowless, record not applied, restart).
- Mirror writes gone, the reader kept: `crdt-body-debts.test.ts` mirror cases.
- Legacy sweep deletion: not done, by ruling (it licenses #2299 claims); disclosed in #2445.

## PR27 (#2385, mid-run discovery, spinoff of #2284/#2386)

- #2385 crash test, delete applied inside a page, crash before flush, replay removes the file: `bulk-apply.test.ts` "#then a crash between commit and flush is healed by replay removing the file" (primitive level); `page-apply-file-writes.test.ts` "removes the file on replay after a crash between commit and flush" (handler-integration level, via `journalHandler.applyDelete`).
- #2385 a file re-created locally after the crash is not removed by replay: `bulk-apply.test.ts` "#then a file re-created locally after the crash is not removed by replay"; `page-apply-file-writes.test.ts` "keeps a file re-created locally after the crash" — both stamp the re-created file's mtime strictly after `deferredAt`.
- #2385 comment references this issue: 11 occurrences of `#2385` across `bulk-apply.ts`, `note-handler.ts`, `journal-handler.ts`, both test files, and `sync-protocol.md`.

## PR29 (#2408) — PR #2431

- #2408 a forged or missing attestation is never applied: the attack matrix in `purged-tombstone-guard.test.ts` and `purged-tombstones.test.ts` (row and file byte-identical, apply never called).
- #2408 old shed rows follow a documented rule: always refused as `unattested` (05 §5.12.3).
- #2408 Rust parity: `delete_attestation_vectors.rs`, `push_seal.rs`; the Rust core never declares `purged_tombstones` (documented residual).

## PR30 (#2409) — PR #2432

- #2409 a re-create within retention is accepted with no type allowance: `tests/sync-harness/tests/recreate-after-delete.test.ts` (Miniflare Worker); `tombstone-marker.test.ts` "a re-create seeded from its tombstone clock (#2409)".
- #2409 a stale device's update against a re-created item is refused or merged: `recreate-clock-seeding.test.ts` "a stale device" block; server "refuses an unchanged pre-delete version as SYNC_REPLAY_DETECTED per item".
- #2409 old rows (no recorded clock) keep today's behavior: `recreate-clock-seeding.test.ts` "old rows (no recorded tombstone)".
- #2409 Rust parity: `domain_journal.rs`, `domain_folders.rs`, `recreate_clock_vectors.rs`, `recreate.rs` tag-definition tests (added in the main rebase: main's new `tag_admin` recreate).

## PR32 (#2420, narrowed by its comment) — PR #2426

- `crdt_updated` carries the highest reserved cursor: `crdt-broadcast-cursor.test.ts` "carries the highest cursor an update push reserved", snapshot single and batch cases.
- Omitted on a duplicate-only retry: "omits the cursor on a duplicate-only retry and still broadcasts".
- Every parser tolerates it (contracts, desktop, Rust `socket_frame.rs`); a malformed cursor drops the field, never the frame.
- No client behavior change (consumed by PR36).

## PR33 (#2423) — PR #2433

- A runtime-down delete then re-create of a tag, a folder config and a bookmark, with no recorded tombstone clock, ends live on both devices: `stale-pending-delete.test.ts` `it.each(ACCEPTANCE_TYPES)`.
- A no-snapshot fallback delete never pushes `{dev:1}`: `stale-pending-delete.test.ts` "a delete with no snapshot (#2423)" (6 types).

## PR34 (#2424, narrowed) — PR #2434

- Harness adopts through the real `adoptVaultLocally`: `test-hooks.test.ts`; live `sync-adoption-store-restart.e2e.ts` (red with the old hook, green now).
- A failed store move opens the pre-adoption store in place and retries next launch: `crdt-store-path.test.ts` "opens the pre-adoption store in place when the move fails, and moves it next launch".

## PR35 (#2429) — PR #2436

- A delete committed between two pages of one run, for an item applied on page 1, is applied on page 2: `run-applied-cursors.test.ts` "applies a delete of X that committed between page 1 and page 2" (plus update, no-serverCursor fallback, inline variants); `purged-tombstones.test.ts` "applies a purged tombstone for an item the same run applied on an earlier page".
- A duplicate at the same cursor is still skipped: "skips X on page 2 when it is listed at the cursor already applied".

## #2413 (tooling) — PR #2415

- The changed-E2E job finishes when a PR touches a shared package: above 100 selected tests it runs only the PR's changed specs (dry-run of the selection step against real `playwright --list` output; actionlint clean); main's 8-shard `e2e-full` keeps full coverage (disclosed narrowing of the issue's option 2).

## PR31 (#2414, found in PR21 review)

- #2414 chunk the id list under the D1 bind limit: `orphan-chunk-cleanup.test.ts` "reaps more orphaned chunks than one statement can bind..." (150-row case, `ORPHAN_CHUNK_BATCH = 90`).
- #2414 one bulk `storage.delete(keys)` per chunk: same test, mock assertion `toHaveBeenCalledTimes(1)` per batch.
- #2414 cap rows per tick to fit the subrequest budget: `ORPHAN_CHUNK_LIMIT = 300`, documented subrequest math (13/tick) matches `pack-backfill.ts`'s reserved-budget note.
- #2414 add a test with more than 100 orphaned rows: same 150-row test, present and passing.
- #2414 additional races fixed beyond the issue's stated Problem/Trace (re-referenced chunk losing bytes; retried-upload-after-delete): disclosed in the PR's own "Problem" item 2 and "Residual" paragraph; covered by two dedicated tests, not a silent addition.

## Decisions

- PR00: main was red on Linux (EventKit provider tests). Fixed in its own PR and placed at the stack root so the stack's CI can go green.
- PR03: protocol 05 §5.14 said a non-envelope page is dropped and the cursor advances; #2285 (Review) requires holding it. Changed the doc with the reason (server fault, not a poisoned item). The shared TS pull engine and the Rust core still drop; added to PR24 (#2304) scope.
- PR03: interrogate found the ledger retry would 400 past 100 ids, orphan repair would tombstone children of a schema-invalid parent on every device, and ledger items would trigger a full re-pull on every manifest check. All three fixed with tests.
- #2385 filed (journal the note/journal file deletes); it is a child of #2279 and is covered by an extra unit after PR24.

Full trail in `decisions.tsv` (worktree root, uncommitted).

- PR01: live lane runs on the Playwright two-device harness (`tests/sync-harness` Miniflare Worker + two Electron profiles) rather than staging: same two-device shape, real Worker code, no deploy.
- PR01: #2382 key is `cursorSkipRepair` with states absent / `pending:<cursor>` / `done`. The issue asked for "flag only after a clean pull"; kept (done only after a delivered pull), but an interrupted repair resumes from the persisted cursor instead of resetting again. Reason: interrogate found a permanent re-pull loop on a breaker page.
- PR01: the reset runs under the sync lock; a busy lock defers the repair to the next full sync.
- PR01: fresh installs (no cursor or cursor 0) record `done` immediately.
- PR01: `/sync/push` no longer raises `device_sync_state.last_cursor_seen` (server mirror of #2283).
- PR01: rejected zeroing `maxCursor` for old clients: it changes a field's meaning, and P1.8 heals old installs on upgrade.
- PR02: journal file deletes stay un-journaled, matching note-handler; follow-up issue filed.
- Stack order changed: PR11 (#2291) is stacked right after PR08 because it was ready first; PR09, PR13, PR10 follow it. No code dependency is crossed (P2.4 only gates P4.1).
- PR04: types with no dirty marker (settings, tag__, folder_config, property_definition, calendar__, canvas, agent_*) get a stated exemption pointing at P4.2 (#2301), not a new column. The `_offline` rebind hook now also runs on the live enqueue path for nine services, same trade-off #2179 made for tasks.
- PR05: #2287's "self-healing by construction" only holds with §6.5.2 P3; settings now re-queue after a concurrent merge. Legacy `local` clock entries are kept, not rebound.
- PR07: `/sync/changes` refs gain optional `serverCursor` (never a pull cursor, §5.11) and `committedAtMs`; migration 0010 adds nullable `committed_at_ms`. Clock skew handled by the lowest-RTT midpoint offset. Metrics reuse `sync_run_completed` with a new `action` so older servers accept the batch.
- PR11: the contracts parser dropped calendar/linking payloads; added typed variants instead of the issue's literal "ignored" (which would break calendar push and linking).
- PR13 (#2293 item 3): per-note CRDT 429 gate is invalid. Every CRDT push route shares one per-device `crdt_push` bucket and the DO counts 429'd requests, so a per-note gate multiplies wasted requests. Global gate kept.
- PR09 (#2289): cycles started outside `scheduleSync` (initial full sync, IPC sync-now, billing, stop) have no `inFlightSync` promise; the engine signals cycle end so a pending push runs once. No timer, never after `stop()`.
- Owner gate list now includes `node scripts/check-line-ceilings.mjs` (600 lines per memry-core Rust file); PR #2407 tripped it and was split.
- PR14 interrogate (2 reviewers): writing LAST_CURSOR inside the last slice's transaction advanced it ahead of post-commit work a re-pull used to re-drive (corrupt refetch, applyCrdtBatch/unmerged-debt). Ruling: cursor in the slice tx only when the page has no such work; otherwise after it, as before; CRDT notes flagged unmerged inside the slice tx.
- PR21 interrogate (2 reviewers): markers fed to the Rust core became clockless cross-type deletes plus permanent bare tombstones; desktop could delete clockless or freshly re-created local rows; orphan repair re-opened on cooldown; shed could orphan R2 objects over the subrequest budget. Rulings: markers served only to clients declaring a feed-only `purged_tombstones` token and never on cursor 0; desktop refuses clockless-local and pending-re-create cases; manifest create repair only after a delivered pull; orphan repair tombstones only on a positive gone answer; bulk R2 delete, mark only deleted rows; audit cron dropped. Filed #2408 (signed delete attestation) and #2409 (re-create clock seeding).
- PR22 (#2303): the brief said keep the checkQuota pre-estimate; the Review says remove it. Review wins: removed. splitIntoWaves stays (per-item rejection of a duplicate id is unattributable, §5.5).
- PR23 (#2383): §6.9.0 removal-on-absent-winner deferred (desktop's closed schema strips unmodelled values but echoes their clocks; removal would delete settings on newer devices). Rust already removes and does not re-queue: filed #2399 (child of #2279).
- PR10 live lane in CI: sync E2E on Linux never opened a socket (app.getVersion() is `0.0` for `out/main/index.js`; harness MIN_APP_VERSION 0.1.0 answered 426). Harness floor lowered to 0.0.0 in its own commit on PR10; CI now shows wakes=23 pulls=5.
- PR16: red-team found a retry of stored bytes near a full quota was refused (reservation before dedupe). Fixed in the PR: hashes looked up before reserving.
- PR21 (#2302): runner A (marker rows kept forever, typed purgedTombstones/blobMissing sibling lists, never delete on absence). Coordinator ruling: a `create` over a purged marker is accepted only for deterministic-id types (journal, tag, folder path, ...), otherwise a re-created journal/tag would never sync again.
- PR24 (#2304): the Rust core may hold rows skipped by the pre-P1.1 server race; part 2 adds a one-time re-pull (data-preserving), mirroring #2382.
- PR25 (#2301): runner B (sync_intents journal; domain row + intent in one transaction, clock + outbox after). PR26 (#2300): runner B (opt-in socket items applied at a quiescent point; feed owns the watermark and all failure policy).
- PR12 (#2292): inline is asked only when `fullSyncActive` is false, which in practice is the socket wake and the 60 s periodic pull (every `engine.fullSync()` sets the flag). Kept: those are the latency path; manual/startup syncs keep today's two-request shape.
- PR15 on PR12: one getChanges path; a note_body subscriber asking inline=1 gets inline record items and noteBodies in one page (P3.3 desktop will do both).
- PR10 live lane: CI run of sync-wake-coalesce showed wakes=0 (every DO broadcast `sent:0`: A's socket never connected in CI). Added a socket-state hook and a wait-for-socket step with diagnostics; investigating on the next CI run.
- PR12 (#2292) design: top-level `inline` array of `/sync/pull` items on `GET /sync/changes?inline=1`, id-granular coverage, only on the first page of a non-bootstrap run (`/tmp/sa-arch/p25-a.md`). Deviates from the issue's ref-fields shape: tombstones can't carry ref fields and byte identity with `/sync/pull` comes free.
- 2026-09-25: PR12 (#2402) 'Electron E2E changed' was cancelled at the 35-minute job limit: the PR changes `@memry/contracts` plus an e2e file, so `--only-changed` selects all 662 tests. The only failures among the 150 that ran were `editor-command-flows.e2e.ts` paste tests, pre-existing on main since #2364 renamed `data-paste-link-menu` to `data-inline-choice-menu` (sync stack touches no renderer file; selector swap passes 4/4 locally). Fixed in a standalone PR off main (fix/e2e-paste-menu-selector). The job-length limit is pre-existing CI behavior, filed as a follow-up.
- 2026-09-25: Correction: PR01 #2384 is open (base PR00 #2387), not merged. Nothing in the stack is merged; merging stays with Kaan.
- 2026-09-25: PR25 (#2301) interrogate (/tmp/sa-interrogate/pr25-{a,b}.md): moving clock bump, tombstone and enqueue into one T2 regressed three paths when T2 fails: the delete tombstone rolls back (pull resurrects), the dirty sweep re-pushes at the stale clock and the replay rejection marks it synced, and pulls overwrite the un-clocked edit. Ruling: tombstone written in T1; sweep skips rows with a pending intent; drain intents every sync cycle and before applying a remote upsert for that item (defer if the drain fails); validate + cap + dead-letter intents with a clock-bumping fallback; cascade delete snapshots carry real clocks; per-event try/catch in the publisher loop; journal `when` monotonic test; rebase onto PR21 309534651.
- 2026-09-25: Swarm args must use short or rev-parsed SHAs; a hand-expanded full SHA for PR14's base did not exist and both lanes had to correct it.
- 2026-09-25: PR26 (#2300) interrogate: a stale frame could re-create a row the pull already deleted (cursor-only coverage ignores pages committed ahead of LAST_CURSOR); quiescence was checked one await before the writes; one failed flush disabled the fast path and leaked a waiter per frame; a fast-path conflict requeue could be deleted by an in-flight push ack (§6.5.2 P3). Ruling: in-run owned-through mark from each read page's nextCursor plus serialized frames; synchronous quiescence re-check; replay reconciles unlandedOps; fast path ineligible while a push is in flight; server decides the budget from payload sizes before building items; hint-only for expired tokens; 50-item cap; telemetry cap; ITEM_SYNCED only for changed rows.
- 2026-09-25: Tooling PRs off main, found mid-run: #2412 (e2e paste-menu selector, pre-existing since #2364) and #2415 (PR E2E runs only the changed specs when `--only-changed` selects more than 100 tests; closes #2413). The final restack puts both under PR00 so every stacked PR's CI inherits them; until then #2402's E2E job cannot finish.
- 2026-09-25: Follow-up #2414 (orphan blob-chunk cleanup binds up to 1000 ids) filed and attached to the epic; implemented in this stack since it is an epic sub-issue.
- 2026-09-25: Mid-run follow-ups that block no unit stay open and are listed in the final report, per goal.md ("include it only if it blocks a unit"): #2408 (signed delete attestations), #2409 (re-create clock seeding). #2414 was small and safety-relevant (it can drop attachment bytes), so it ships as PR31.
- 2026-09-25: PR24b (#2304 part 2) started in parallel with the PR17 review fixes; Rust-only, so its later restack is mechanical. Its note_body parity follows the PR17 review rules (no journal, per-entry fetch failures owe a pull, land before the cursor), not PR17's pre-review code.
- 2026-09-25: PR24b Rust legacy body pull scope: option B, a one-time whole-body pull only for docs this device already holds body state for (the Rust core windows bodies on purpose: RECENT_BODY_LIMIT on first sync, the rest fetched on open, which is whole-body anyway). note_body goes in the header outside the record declaration (no restart_on_new_declaration); per-doc durable `sync.body_owed:<docId>` debt, set before the cursor write, cleared only after a merged whole-body pull, and SnapshotPusher refuses while it is set.
- 2026-09-25: PR17 review fix, "store only" replaced after it broke body-crdt C3/C4 (stored raw bytes suppress the markdown write-back when the doc later opens): a known note with no persisted doc gets no merge and no store but is owed a whole-body pull; a body for an id with no row is dropped (not stored, not owed, so nothing can write a deleted note back). The record's arrival pulls the whole body; PR18 must keep that when it removes applyCrdtBatch.
- 2026-09-25: Final chain order above PR14: PR21 -> PR31 -> PR25 -> PR24b -> PR17 -> PR18 -> PR20 -> PR26. PR21/PR31/PR25 do not depend on PR17, so PR17 moves up instead of restacking three opened PRs; PR18/PR20 follow PR17; PR26 stays last.
- 2026-09-25: PR20 (#2299 coversThrough) goes before PR18 (#2297 part b) in the chain. PR18 deletes the unmerged-debt machinery, which today is the only guard keeping a destructive snapshot push from pruning a peer's unmerged body; coversThrough is its replacement, so it must land first. Final order above PR14: PR21 -> PR31 -> PR25 -> PR24b -> PR17 -> PR20 -> PR18 -> PR26. Per the #2297 Review, PR18 keeps the legacy full sweep and the per-note owed-pull path that PR17 relies on; the rest of the old machinery is deleted only where nothing in the stack still needs it.
- 2026-09-25: PR20 (#2299) design approved: with `coversThrough` C the server moves the snapshot watermark to the covered prefix (update rows above the old watermark up to the first NULL-cursor or >C row) so §7.8 clients re-fetch the snapshot instead of skipping pruned rows; deletes only rows with a non-NULL cursor <= C and seq <= the new watermark; NULL-cursor rows are never deleted by a C push; a C push whose existing snapshot has server_cursor > C is refused per note (CRDT_SNAPSHOT_NOT_COVERED), since overwriting an unseen snapshot is the same loss class. Desktop sends C only after the legacy sweep is done and the note is unflagged, captured at encode time. The destructive/non-destructive routing and CRDT_UNMERGED_DEBT stay (owed pulls are session-only; old servers ignore C); PR18 must make per-note owed tracking durable before deleting them. Rust sends C only when its legacy key is done and resets that key when a page without bodies moves the record cursor.
- 2026-09-25: PR17 round-2 ruling: the rowless invariant has one owner (NoteBodyFeed plus a row guard on queued pulls); feed entries for unknown ids and for ids whose record is on the same page are skipped before any fetch; desktop declares note_body only when LAST_CURSOR is non-zero, so bootstraps and cursor resets keep 500-row pages and get bodies from the record-page pull and legacy sweep; transport-class failures owe the rest of the page without ledger entries; the ledger holds only content faults and stays out of the quarantine list.
- 2026-09-25: PR20 redesign after review: per-write snapshot blob keys (`blob_key` column), guard folded into the upsert's `ON CONFLICT ... WHERE` with the prune in the same batch, `covers_through` stored on the row (same-signer stale push is a 200 no-op; a push without C onto a covered row is refused per note), optional `baseRevision` compare-and-swap, local-only toggle and CRDT store quarantine withdraw the claim, legacy sweep set from the data DB, Rust body_pull takes the baseline on an unknown revision and claims per document. Server must deploy at 100% (no gradual Worker rollout). Migration 0014 additive.
- 2026-09-25: PR18 (#2297 part b) design: architect runner a adopted (/tmp/sa-arch/p18-a.md); runner b not needed, since the #2297 Review binds deletion to a later release. No body-delivery path is dead today (runs from cursor 0, servers before or rolled back past #2295, the legacy sweep, devices offline through a rollback, owed feed entries), so PR18 is durable per-note owed tracking (`crdt_body_debts`, data-DB migration 0060, written before the cursor at every known-debt site, hydrated at start, settled only by a clean walk or a rowless drop, per-row backoff) plus deleting the vault-wide debt latch it replaces; `CRDT_UNMERGED_DEBT` stays as a write-only mirror for downgrades. Decisions: re-upgrade detection by the mirror's `updated_at`; speculative sweep flags are durable while the legacy key is not `done`; a quarantined or fresh CRDT store owes every note and re-arms the legacy key; a local-only toggle owes the note. The goal row's net deletion moves to follow-ups gated on `minWriteVersion` (PR18b: crdt_updated as a wake, sweeps and probe deleted; PR18c: legacy sweep and mirror deleted) plus an additive server wake (`changes_available` on CRDT commits).
- 2026-09-25: PR29 (#2408) design runner A adopted. Existing `purged_tombstones` gate, no new token. Markers shed before attestations existed are always refused (any local-clock rule would compare against the server's own asserted clock). `unknown_device` refusal and manifest re-upload kept unchanged. vaultId not bound (the item signature does not bind it either). Rust scope narrowed to producer + verifier + vectors: the core never declares `purged_tombstones`, so it never receives markers, and porting a new delete path to iOS adds risk without closing anything #2408 names. A revoked signer this device never cached is refused (documented residual).
- 2026-09-25: PR30 (#2409) design runner A adopted. Desktop `sync_tombstone_clocks` (0061, unbounded like server markers); core `tombstone_clock` column (0004). The server allowance stays until `minWriteVersion` passes this release on desktop and iOS and clients can learn marker clocks. Core parity changes accepted: folder re-create at a deleted path succeeds; a tombstone strictly older than a revived row is skipped. Final chain above PR17: PR20 -> PR18 -> PR29 -> PR30 -> PR26 (PR29/PR30 built in parallel off 0d8186199; disjoint files and migration numbers: D1 0014 PR20, 0015 PR29; desktop 0060 PR18, 0061 PR30).
- 2026-09-25: PR20 round 2. The same-device replace arm is removed: a device id is no proof of state (restore, clone, stale retry after a base-arm write). Own pushes go through the compare-and-swap or `server_cursor <= C` like anyone else. Claims stay dormant until Kaan raises the desktop `min_write_version` to the PR20 release and sets `CRDT_CLAIM_MIN_DESKTOP_VERSION`, because released desktops loop at 1 Hz on the 409 through the oversized-update fallback. Until then every push takes the pre-#2299 rules byte for byte.
- 2026-09-25: PR29 escalation: attestation refusals count as `missing` in the corrupt refetch, so orphan repair treats a refused parent as absent (it already trusts server absence; attestation adds no new attacker capability there). Documented in 05 §5.12.3. A missing token or failed key fetch must hold the page, never refuse.

- 2026-09-26: Stack rebased onto main `d71c6f87d` (12 commits). Conflicts resolved by meaning, not by side: (1) main's journal G0 rule (empty/null `content` keeps the file body) moved into PR02's synchronous `buildJournalEntryWrite`; (2) main stamps pulled Rust log rows with the local epoch-ms clock so the search index re-reads them, which the stack had replaced with server seconds: local ms now on every path, the `note_body` feed included (PR24b); (3) main's Rust snapshot-meta probe kept, counted in the body step's request budget and sent once per 100 owed documents (PR24b, probe in `body_pull/probe.rs` for the 600-line ceiling); (4) PR20's two-argument `baseline_due` applied to the probe clause; (5) core migration `0004_inbox` shipped on main, so tombstone clocks became core migration `0005` (unreleased); (6) main's new `tag_admin` recreated a deleted tag definition with a fresh `{device:1}` clock, the #2409 class: it now writes through `write_over_tombstone` (PR30, two tests red on main's code). Patch-id check: only PR02, PR15 (docs count), PR24b, PR20, PR29 (context only), PR30, PR17 (context only) and PR34 changed; the changed ones were re-verified by swarm.
- 2026-09-26: Main was red on its own (Desktop CI: two renderer tests plus the EventKit tests; Editor and crypto gates: stale editor-web asset). Tooling fixes sit at the stack root so every stacked PR inherits them: #2387 (EventKit, plus the renderer fix first opened as #2438 because the root must be green on main by itself), #2412, #2415, #2440. GitHub marked #2438 merged into `fix/eventkit-provider-test-platform` when that branch fast-forwarded to it; nothing reached main.
- 2026-09-26: #2421 is valid work gated on rollout, so it ships as merge-gated PRs (PR36 part b, PR37 part c) like PR25/PR26, not as an open issue. PR36: `crdt_updated` becomes a wake only when the legacy sweep is done and the frame carries a cursor (a cursorless frame keeps the per-note pull: only the cursor proves a #2420 server); reconnect, 15-minute, forced and manifest sweeps deleted; probe and watermark sequence kept (they settle hydrated debts for one POST and serve the kept legacy sweep); record debts narrowed only where the feed demonstrably serves the body. PR37 ruling: the design's PR18c row (delete the legacy sweep) predates PR20; the legacy sweep is the only writer of `noteBodyLegacySweep = 'done'`, which licenses coverage claims, so deleting it would turn PR20 off for every new or re-armed device. PR37 keeps the sweep and deletes only the `CRDT_UNMERGED_DEBT` mirror writes (the reader stays for epoch resets and older builds).
- 2026-09-26: Main moved again (#2439, editor toolbar, no overlap with the stack); folded into one final rebase with PR36/PR37 to spend one CI round.

- 2026-09-26: PR36 interrogate (/tmp/sa-interrogate/pr36-{a,b}.md, no critical; B: 1 high). Removing the per-note `crdt_updated` pull also removed its unmerged flag, so an unclaimed first snapshot could prune the peer row just announced. A wake during a full sync was dropped. The new flush could strand active-editor debts in a refused `scheduleSync`. The tick pull never paid its owes. `feedServes` trusted "row existed before apply" after a rowless drop and ignored the missing-table fallback and a downgrade that moved the cursor. Ruling /tmp/sa-owner/pr36-ruling.md:
  - wake cursor per note keeps the note unmerged until `LAST_CURSOR` reaches it; a wake refused during a full sync is latched;
  - one guarded flush after every non-full pull; priority ids re-queued on refusal;
  - leftover record-skipped bodies queued;
  - one `servesRecordBody` predicate: also requires the key `done`, a durable debt store, and no durable rowless-withheld row (never pulled, so PR17's rule holds);
  - no claims while debts are session-only;
  - a `noteBodyFeedCursor` mismatch at start re-arms the legacy sweep.

- 2026-09-26: PR36 round 2 (/tmp/sa-interrogate/pr36r2-{a,b}.md): every round-1 finding closed; 0 critical/high. Found: a rowless leftover whose record failed wrote no withheld memory; a wake coalesced into a queued pull was lost across a full sync; the floor timer re-armed after dispose; `withheld` overloaded into `crdt_body_debts` (masking, leak, downgrade hiding a real debt). Ruling /tmp/sa-owner/pr36-ruling-r2.md:
  - one rowless-drop helper;
  - withheld moves to its own additive table (desktop data migration 0062), cleared by a whole-body merge or a delete tombstone, and reports unmerged so no push prunes;
  - one `pendingWakeCursor`;
  - a disposed guard;
  - detached compaction bound to its own vault's DB handle.

## Blockers

## Staging deploy log

- 2026-09-24T23:20:24Z PR15 owner: one read-only aggregate on staging `crdt_updates` sizes (`wrangler d1 execute memry-sync-staging --env staging --remote`, `changed_db: false`): 11 rows, p50 212 B, p99 287 B, max 332 B. No deploy, no write.

## Rollout

Runbook for Kaan. Nothing in the stack is merged or deployed by this session; staging was only read (one aggregate query, logged above).

**Order.** Merge the stack root to tip. Every release deploys the Worker first, then desktop, then iOS (Rust core). Every server change tolerates old clients; every client change tolerates an old server.

**D1 migrations, additive, apply before the Worker that uses them:**

| Migration                            | PR   | Content                                               |
| ------------------------------------ | ---- | ----------------------------------------------------- |
| `0010_sync_items_committed_at_ms`    | PR07 | nullable `committed_at_ms`                            |
| `0011_crdt_server_cursor`            | PR15 | CRDT rows share the record cursor; old rows stay NULL |
| `0012_crdt_update_hash`              | PR16 | partial unique index                                  |
| `0013_sync_items_tombstone_marker`   | PR21 | marker columns, rows kept forever                     |
| `0014_crdt_snapshot_covers_through`  | PR20 | `covers_through` column                               |
| `0015_sync_items_delete_attestation` | PR29 | nullable attestation column                           |

Desktop data migrations `0059` (PR25), `0060` (PR18), `0061` (PR30), `0062` (PR36, `crdt_body_withheld`) must ship in that order. Core data migration `0005` (PR30) runs on first launch of the new iOS build.

**Soak and gates, in order:**

1. **PR01.** Deploy the Worker (cursor reserved in the commit batch; push no longer moves `last_cursor_seen`), then the desktop build carrying the one-time repair (#2382).
2. **PR07.** Build the `sync_e2e_ms` / `sync_push_lag_ms` PostHog dashboard before any phase-2 client ships. It is the measurement behind the PR26 gate.
3. **PR08, then a 48 h soak, then PR09.** Deploy the per-device 300/min `sync_push` limit. Watch `sync_push` 429 telemetry for 48 h. Only then release PR09's leading-edge push (300 ms).
4. **PR20 claims stay dormant after deploy.** Deploy the Worker at 100%, never gradually: a mixed fleet can walk the watermark backward. Claims turn on only when both hold: `CRDT_CLAIM_MIN_DESKTOP_VERSION` is set, and the desktop `client_policies.min_write_version` reaches that version. Set them once telemetry shows released desktops are on the PR20 build; earlier, released desktops loop on the 409.
5. **PR21 / PR29.** Markers are served only to clients declaring `purged_tombstones`, and never on cursor 0. No gate beyond the Worker deploy.
6. **PR25 (#2301) merge gate.** Merge only when the P1.5 sweep reports residual rows (`dirty_recovery_residual`) for tasks/projects in production.
7. **PR26 (#2300) merge gate.** Merge only when `sync_e2e_ms` p50 after phase 2 is still above about 0.7-1 s. Read the combined pull + socket `e2e_latency` metric.
8. **PR36 (#2421 part b) merge gate:**
   - (a) desktop `minWriteVersion` at or above the build that ships PR17 and PR18;
   - (b) a decision that the Worker is never rolled back past migration `0011` (#2295);
   - (c) #2420 (PR32) deployed. A frame without a cursor keeps the per-note fallback.
9. **The `minWriteVersion` raise that ends `crdt_updated`.** Once `minWriteVersion` passes the PR36 build, every client treats `crdt_updated` as a wake. The server may then stop sending it; that is a separate, later server change.
10. **PR37 (#2421 part c) merge gate.** `minWriteVersion` at or above PR36, so no client reads the `CRDT_UNMERGED_DEBT` mirror as its own state.
11. **iOS.** Release the core-parity builds (PR24 parts 1 and 2, PR30 core) after the Worker. Raise the iOS `minWriteVersion` only after the part 2 build is out.

**Rollback.**

- A Worker rollback stays safe for desktop until PR36 merges; after that, gate (b) above forbids it.
- A desktop downgrade reads the stale `lastCrdtSweepAt` and simply sweeps again.
- Never roll a Worker back past `0014` while claims are on.

## Final report

Status on 2026-09-26. The stack is rebased onto main `ba6ce80d2` (#2387, the old stack root, was merged by Kaan). Nothing was merged or deployed by this session.

**Stack, root to tip** (each PR's base is the row above; the first targets `main`). "PASS" means the swarm verdict comment at the head SHA: red lane (production changes reverted, the regression tests fail for the intended reason) plus the receipts lane (PR-body claims vs diff).

| #   | PR    | Scope                                    | Verdict                                                                  |
| --- | ----- | ---------------------------------------- | ------------------------------------------------------------------------ |
| 1   | #2412 | tooling: e2e paste selector              | PASS                                                                     |
| 2   | #2415 | tooling: #2413 E2E selection cap         | PASS                                                                     |
| 3   | #2440 | tooling: main's stale editor-web asset   | red on main before, current after (`editor:check`); verdict at tip gates |
| 4   | #2384 | #2282 #2283 #2382 cursor-skip, live      | PASS                                                                     |
| 5   | #2386 | #2284 journal apply in tx                | PASS (re-verified after the main rebase)                                 |
| 6   | #2388 | #2285 schema-invalid                     | PASS                                                                     |
| 7   | #2390 | #2286 dirty recovery                     | PASS                                                                     |
| 8   | #2391 | #2287 settings device clock              | PASS                                                                     |
| 9   | #2392 | #2310 manifest throttle log              | PASS                                                                     |
| 10  | #2393 | #2280 #2281 e2e trace                    | PASS                                                                     |
| 11  | #2394 | #2288 push rate limit per device         | PASS                                                                     |
| 12  | #2395 | #2291 WS contract parser                 | PASS                                                                     |
| 13  | #2396 | #2289 leading-edge push                  | PASS                                                                     |
| 14  | #2397 | #2293 push self-heal                     | PASS                                                                     |
| 15  | #2398 | #2290 honor wake cursor, live            | PASS                                                                     |
| 16  | #2400 | #2303 server dead code                   | PASS                                                                     |
| 17  | #2401 | #2383 settings merge spec                | PASS                                                                     |
| 18  | #2402 | #2292 inline changes, live               | PASS                                                                     |
| 19  | #2403 | #2295 CRDT server cursor, live           | PASS (re-verified)                                                       |
| 20  | #2404 | #2296 idempotent CRDT store              | PASS                                                                     |
| 21  | #2405 | #2385 journal remote deletes             | PASS                                                                     |
| 22  | #2406 | #2298 CRDT outbox                        | PASS                                                                     |
| 23  | #2407 | #2304 part 1, #2399                      | PASS                                                                     |
| 24  | #2410 | #2294 slice cursor tx, live              | PASS                                                                     |
| 25  | #2411 | #2302 tombstone purge marker             | PASS                                                                     |
| 26  | #2416 | #2414 orphan chunk cleanup               | PASS                                                                     |
| 27  | #2417 | #2301 transactional outbox (merge-gated) | PASS                                                                     |
| 28  | #2418 | #2304 part 2                             | PASS (re-verified)                                                       |
| 29  | #2419 | #2297 part a note-body feed, live        | PASS                                                                     |
| 30  | #2425 | #2299 coversThrough                      | PASS (re-verified)                                                       |
| 31  | #2426 | #2420 crdt_updated cursor                | PASS                                                                     |
| 32  | #2430 | #2297 part b durable body debts          | PASS                                                                     |
| 33  | #2431 | #2408 signed delete attestation          | PASS                                                                     |
| 34  | #2432 | #2409 recreate clock seed                | PASS (re-verified; + tag_admin fix)                                      |
| 35  | #2433 | #2423 stale pending delete fold          | PASS                                                                     |
| 36  | #2434 | #2424 adoption-store rename              | PASS (re-verified)                                                       |
| 37  | #2436 | #2429 pull-run newer version             | PASS                                                                     |
| 38  | #2437 | #2300 WS fast path (merge-gated), live   | PASS                                                                     |
| 39  | #2444 | #2421 part b (merge-gated)               | see verdict comment                                                      |
| 40  | #2445 | #2421 part c, narrowed (merge-gated)     | see verdict comment                                                      |

Outside the stack: #2387 (EventKit and renderer tests) was merged into main by Kaan; #2438 was folded into it.

**Closed as invalid:** none. Every issue was valid or partially valid. The narrowings are in the Validity log and in each PR body.

**Gates at the stack tip** (`e8c94b3ca`):

| Gate                                                    | Result                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| root `pnpm test` (10 packages)                          | desktop 23686, sync-server 1544, contracts 2331, sync-client 206 |
| harness                                                 | 36                                                               |
| `cargo test -p memry-core`                              | 1169                                                             |
| clippy, fmt                                             | pass                                                             |
| `pnpm lint`                                             | 0 errors                                                         |
| `pnpm typecheck`, typecheck:test                        | pass                                                             |
| `check:architecture`, `check:contracts`                 | pass                                                             |
| line ceilings, vectors:check, ipc:check, editor:check   | pass                                                             |
| `git diff --check`                                      | clean                                                            |
| `docs:impact --base origin/main --strict`, `docs:build` | pass                                                             |

Live lanes at the tip all pass: cursor-skip, wake-coalesce, inline-changes, socket-items, equal-clock-echo, body-crdt-feed-delivery, body-crdt-debt-restart, body-crdt-create-propagation ×2, adoption-store-restart.

**Left open, by design:**

1. **Merge-gated PRs.** Kaan decides, per the Rollout section:
   - #2417 (P1.5 residual rows);
   - #2437 (`sync_e2e_ms` p50);
   - #2444 and #2445 (`minWriteVersion`, no Worker rollback past `0011`, #2420 deployed).
2. **#2299 claims are dormant** until `CRDT_CLAIM_MIN_DESKTOP_VERSION` is set and the desktop `min_write_version` reaches it (Rollout step 4).
3. **#2297's "net deletion" is partial.** #2444 deletes the sweeps. The legacy sweep, the probe and the watermark sequence stay, because they license #2299 claims and settle debts cheaply. See Decisions 2026-09-26.
4. **Documented residuals:**
   - the unsigned pre-attestation shed rows are always refused (05 §5.12.3);
   - a first run of the #2444 build trusts `done` over a cursor another build moved (07 §7.17.5);
   - a watchdog-abandoned zombie push can delete a coalesced requeue (06 §6.6.2);
   - `body-crdt-coverage-variants.e2e.ts` V6 fails locally on the stack's base as well; the spec skips itself on CI and documents a two-device reconnect race (#273 class).
5. **CI.** Every PR runs the full check set against its own head. The rebase onto `ba6ce80d2` re-queued them; results at the time of writing are in each PR's checks.
6. **Merging.** Merge root to tip. Each PR's base branch then becomes `main` as the one below it lands.
