# Tasks: Memry Mobile — Vault Parity Mobile App

**Input**: Design documents from `/specs/001-mobile-app/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Included where the constitution mandates them — crypto parity, and every
seam that can lose data (outbox, CRDT merge, offline-reconnect) against **real**
adapters (Constitution III). No blanket TDD elsewhere.

**Organization**: Phases map 1:1 onto the release train from the decision record
(plan.md §Release Train). **Train gates are serial** (Constitution: a phase does
not start until the prior gate is green with evidence) — this overrides the
generic "stories in parallel" pattern: parallelism ([P]) exists _within_ phases
only. Train Phase 4 hosts stories US3–US9 + vault-parity completion; those may
interleave, with the recorded cut order at the tail (canvas viewer first, then
reminders).

Migration file numbers are indicative — assign the next free number in each
ledger at land time (server D1 ledger continues from 0005; mobile ledger starts
at 0001).

## Format: `[ID] [P?] [Story?] Description with file path`

---

## Phase 1: Setup — Train Phase 0 spike (Gate **G0**)

**Purpose**: Scaffold + retire the four open risks (R1–R4) before anything
depends on them. Everything throwaway-tolerant except fixtures, boundary rule,
CI. Verification: [quickstart.md](./quickstart.md) §Phase 0.

- [x] T001 Scaffold `apps/mobile`: Expo SDK 57 (pin ≥ 57.0.9), dev client + `expo prebuild` (iOS 17 target), Hermes, expo-router skeleton — `apps/mobile/package.json`, `apps/mobile/app.config.ts`, `apps/mobile/src/app/_layout.tsx` _(SDK 57.0.15; prebuild output in `apps/mobile/ios/`, deployment target 17.0; router skeleton under `src/app/`)_
- [x] T002 Configure Metro for the pnpm monorepo (workspace deps, package-exports resolution) and add `@memry/contracts` as a raw `./src/*.ts` workspace dep — `apps/mobile/metro.config.js` _(proven: `expo export --platform ios` bundles `@memry/contracts/crypto` + `@memry/app-core/ids` from raw TS)_
- [x] T003 [P] Add mobile reachability rule to `scripts/check-architecture-boundaries.js`: fail on any node builtin or `electron` import reachable from `apps/mobile`; prove red with a planted `node:fs` import, then green
- [x] T004 [P] Create `.github/workflows/mobile-ci.yml` (lint, `tsc -p apps/mobile`, Vitest for RN logic, boundary check) and exclude `apps/mobile` from root turbo `typecheck`/`test` filters (temporary — removed by T031) — `turbo.json`, root `package.json` filters _(root filters are explicit allowlists that never included mobile — exclusion holds by construction; all CI steps verified green locally)_
- [x] T005 [P] Crypto vector generator + desktop proof suite: emit `packages/contracts/test-vectors/crypto-vectors.json` covering every record-§6 primitive (Argon2id 64 MiB/ops 3 per `packages/contracts/src/crypto.ts:28`, XChaCha20-Poly1305, Ed25519 seed/detached, kdf_derive_from_key, generichash keyed+length, auth, scalarmult, box_keypair, full vault-unlock flow); Vitest proves it against Node libsodium — `packages/contracts/scripts/gen-crypto-vectors.ts`, `packages/contracts/src/__tests__/crypto-vectors.test.ts`
- [x] T006 R1 spike: integrate `react-native-libsodium` v1.7.x + Expo config plugin in `apps/mobile` (research.md §B5/§C-R1) _(v1.7.0 installed, plugin in app.config.ts, prebuild green)_
- [x] T007 R1 spike: expose `crypto_scalarmult` (known gap; full libsodium is linked) via `patch-package` or upstream PR — `patches/react-native-libsodium@1.7.0.patch` _(pnpm patch: JSI host functions `jsi_crypto_scalarmult{,_base}` + TS wrappers + BYTES constants; native compile verified at first device build)_
- [x] T008 R1 gate check: on-device harness runs all of `crypto-vectors.json`; **PASS = byte parity on every vector** (G0-a; fail ⇒ research.md §R1 fallback ladder, train stops) — `apps/mobile/src/crypto/__harness__/vector-parity.ts` _(2026-08-23: **PARITY OK 33/33** on the reference device, release build — Argon2id 64 MiB included, no memory kill; also 33/33 on simulator. R1 CLOSED)_
- [x] T009 [P] R2 gate check: benchmark app runs the research.md §R2 protocol (bulk insert, point reads, FTS5, Yjs append/replay, cold open) on both drivers on the reference device, release build; record table + decision in research.md §R2 (G0-c) — `apps/mobile/src/db/__bench__/driver-bench.ts` _(driver DECIDED: expo-sqlite — owner decision 2026-08-23, so single-driver threshold validation; **device release run ALL PASS 7/7**, table recorded in research.md §R2; two findings: prepared-statement bulk inserts mandatory (9× vs per-row), FTS5-vtab close segfault workaround)_
- [x] T010 [P] R3 gate check: Metro bundles `@memry/contracts` + a pure `app-core` slice from raw TS source; release-mode boot on device; desktop dev + landing dev + root typecheck unaffected (G0-b; fail ⇒ research.md §R3 mitigation ladder) _(2026-08-23: release build with embedded bundle boots and runs the full G0 demo on the reference device — workspace raw-TS imports exercised end-to-end; root `pnpm typecheck` green; metro.config.js is app-local so desktop/landing tooling untouched. R3 finding: Hermes lacks global `crypto.getRandomValues` — libsodium-backed polyfill in `src/lib/crypto-polyfill.ts`, first import of the root layout)_
- [x] T011 [P] R4 gate check: bridge throughput rig — minimal WebView, envelope per [contracts/webview-bridge.md](./contracts/webview-bridge.md), 50 KB doc, 10 keystrokes/s × 60 s, release build; record p95s + envelope counters, tune `T_flush`/`B_max` into the contract (G0-d) — `apps/mobile/src/editor/__rig__/bridge-throughput.tsx` _(2026-08-23 device release run: delivery p95 **2.0 ms** (≤ 100 budget), apply p95 0.08 ms, seq gaps **0**, 5 MB doc-load **116 ms**; adopted T_flush=24 ms, B_max=256 KiB. Caveat, recorded honestly: msgs/envelope = 1.0 because 10/s keystrokes (100 ms apart) never overlap a 24 ms flush window — coalescing is arithmetically unreachable in this workload, not defective; the batching proof re-runs at G3 on the real editor where Yjs update clusters arrive faster than T_flush)_
- [x] T012 Implement the mobile crypto module over the parity-proven binding, matching the `@memry/contracts` crypto surface — `apps/mobile/src/crypto/libsodium.ts` _(proven in anger: the T014 device run drove this module end-to-end on real production data — Argon2id 64 MiB, KDF contexts, verifier, AEAD unwrap+open — with a desktop-equal plaintext hash)_
- [x] T013 [P] R6 desk spike: Apple review compliance memo (guidelines 3.1.x mapping, double-subscription notice wording, fallback plan) — `specs/001-mobile-app/apple-review-memo.md`
- [x] T014 **G0 gate demo**: device signs in to staging, pulls one desktop-created encrypted note, decrypts via T012, plaintext markdown SHA-256 equals desktop's; attach evidence bundle (CI links, parity output, benchmark table, hashes) to the Phase 0 issue — evidence names the pinned reference device (quickstart §Prerequisites), which all later perf gates reuse _(2026-08-23 DONE on the reference device — iPhone 12 Pro, release build, against **production** (owner decision; staging half-seeded): OTP → device reg → 24-word phrase → Argon2id 64 MiB (no memory kill) → verifier match → pull → deflate-flag decompress → note "Dune" sha256 `34115c91e2a584b63772cbb817eaad8b0ed35d4814433ca4e53a62f09d5dbcc3` byte-equal to desktop `parseMarkdownNote(raw).content` in both vault copies. Screenshots captured; evidence-bundle attachment to the Phase 0 issue still to do)_

**Checkpoint — G0**: all five G0 checks green with evidence. Train may proceed.

> **G0 GREEN — 2026-08-23.** (a) parity 33/33 on device ✓ · (b) release boot +
> workspace raw-TS on device ✓ · (c) expo-sqlite thresholds 7/7 ✓ ·
> (d) bridge p95 2.0 ms / seq gaps 0 / 5 MB 116 ms ✓ (coalescing re-proven at
> G3) · (e) production note decrypted on device, sha256 byte-equal to desktop ✓.
> Reference device pinned: iPhone 12 Pro (quickstart §Prerequisites).
> Deviation on record: G0-e ran against production (owner decision —
> staging half-seeded); spike's only account write was the revocable
> device-registration row. **Phase 2 (extraction) may start.**

---

## Phase 2: Foundational — Train Phase 1 extraction + server safety kit (Gate **G1**)

**Purpose**: `@memry/sync-client` lands **before** mobile consumes it, desktop
green in the same change (Constitution I). Server-side production-safety kit is
additive and precedes any mobile write exposure. Verification: quickstart §Phase 1.

### Extraction

- [x] T015 Seam inventory: scan `apps/desktop/src/main/sync/` (314 files) + `packages/app-core` (18 node-touching) + `packages/storage-vault` (1); map every hit to one of the 10 seams (e.g. `network.ts` → http-client/runtime, `crdt-pending-notes.ts` → crdt-persistence); zero unassigned — `packages/sync-client/docs/seam-inventory.md` _(`packages/sync-client/docs/seam-inventory.md` + regenerable `scan-seams.mjs`. 174 non-test files scanned, 69 platform-touching, all assigned. **Three findings**: (1) vault file I/O (20 files) fits none of the ten seams — recommend widening `VaultDirectory` into `VaultFileSystem` rather than an 11th seam; **needs owner sign-off and blocks T018–T021**; (2) 23 `*-sync.ts` files are platform-bound only by the `BetterSQLite3Database` **type** — a type widening, no seam; (3) `node:events`/`node:crypto`/`node:os` are mechanical substitutions, not seams)_
- [x] T016 Scaffold `packages/sync-client` (package.json with raw `./src` exports matching workspace conventions, tsconfig, turbo wiring) — `packages/sync-client/package.json` _(`packages/sync-client` — raw `./src` exports matching workspace convention, `base.json` tsconfig with `types: []` so node globals cannot leak in, registered in the root `typecheck` filter allowlist; `pnpm typecheck` 18/18 green)_
- [x] T017 Define the 10 adapter interfaces exactly per [contracts/platform-adapters.md](./contracts/platform-adapters.md) — platform-free types only — `packages/sync-client/src/adapters/*.ts` _(one file per seam under `src/adapters/`, plus `SyncPlatformAdapters` and `SYNC_ADAPTER_SEAMS`. Lifted verbatim from contracts/platform-adapters.md; platform-free types only — `Uint8Array` for bytes, Promises for effects)_
- [ ] T018 Move platform-free sync engine files (item-handlers registry, outbox logic, vector clocks, protocol client) into `packages/sync-client/src/` as import-path-only diffs, one seam per commit _(**FIXED POINT REACHED — 79 modules extracted, every gate green; the remaining 60 platform-free files are one recorded knot.** Six slices landed: vector-clock proof → 15 zero-dep modules + Drizzle widening (canonical `DrizzleDb` in `@memry/db-schema/drizzle-db`, zero `await`s added) → logging/telemetry facades + outbox spine (`queue`, `offline-clock`, 19 record services, types + 11 handlers) → http error taxonomy + `retry` → platform-free `emitter.ts` + `attachment-events` (engine/network/websocket now extend it) → `env.ts` + `certificate-pins`/`sync-server-url`/`cert-hash-cli` + `@noble/hashes` sha256 in `agent-message-handler` (interface stays sync) + `randomUUID` globals. **What deliberately did not move:** the engine core (engine/, push/pull coordinators, apply-item, decrypt/encrypt, the item-handler registry + its 8 vault/crypto-bound handlers, manifest-check, …) — the dependency scan shows every one of them transitively reaches the concrete `http-client`/`crdt-provider`/vault/database/i18n/store modules, so they move only when the engine consumes the seams instead of the concrete modules. That is a behaviour-affecting refactor, not an import-path diff, and it is split out of this phase on record (seam-inventory.md §Surface). Landmine burned twice: `vi.mock` by old relative path goes inert after a move — specifiers must move with the module.)_
- [x] T019 Move CRDT merge/pending logic behind the `CrdtPersistence` + `CrdtProvider` seams — `packages/sync-client/src/crdt/` _(the platform-free drain half of `crdt-pending-notes.ts` → `src/crdt/pending-notes.ts` (coalescing/deferral/abort machinery + synchronous `PendingNoteStore` contract; desktop keeps the fsync'd-JSON store and a thin wrapper, 21-case suite passes unchanged). The merge math was already in the package (`compactYDoc`, snapshot watermark, batch broadcaster). Both CRDT seams have desktop adapters: `DesktopCrdtPersistenceAdapter` (seam 3 over y-leveldb — proven against a REAL store in `crdt-adapters.test.ts`) and `DesktopCrdtProviderHost` (seam 8 over `CrdtProvider`: echo-guarded transport attach with pre-open buffering). The compaction orchestration stays in `crdt-provider.ts` on record — its invariants are ActiveDoc lifecycle checks, not portable merge logic. 7/7 adapter tests green)_
- [x] T020 Desktop adapter implementations (electron/node imports allowed **only** here) — `apps/desktop/src/main/sync/adapters/*.ts` _(all ten seams: eight non-CRDT adapters (http over resolveSyncServerUrl + real NetworkMonitor signal, certificate-pinning, VaultFileSystem honoring the full contract — relative `/` paths, atomic parent-creating writes, no mkdir, ignore-guarded removeDirIfEmpty —, crdt-store-path, crdt-preflight, device-registration with real Ed25519 via injected key store, attachment-store, runtime) + the two CRDT adapters from T019. `wiring.ts` holds the production factories — electron imports live only there, which the seam scanner now records as the sanctioned platform edge. Conformance (T023 suite) 22/22 against real fs/crypto/network under node; CRDT seams covered by `crdt-adapters.test.ts` against real y-leveldb)_
- [x] T021 App-core split: move the 18 node-touching files behind seams or into desktop; pure domain stays importable by mobile — `packages/app-core/src/` _(**discovery that changed the destination:** desktop never consumed the node-touching services — it imports only `/reminders` `/markdown` `/ids`; the sole consumer of `createMemryApp` is `apps/cli`. The 14 node-bound modules + 4 node-backed suites moved to `apps/cli/src/app-core/` as import-path-only diffs; new `service-types.ts` keeps the contract types in the package so the staying pure modules (graph, search-tools, tags, …) never reach node implementations; the 8 pure services' `DataDb` now aliases the widened `DrizzleDb`. app-core scans **zero** platform-touching files; app-core tests 5/5, cli tests 15/15 incl. real-DB suites)_
- [x] T022 Migrate sync test suites with their code; desktop suites pass unchanged (assertion changes require written justification in the PR) _(policy through every slice: platform-clean suites move (18 now run inside `@memry/sync-client` — 168 tests), DB/fs-backed suites stay in desktop on real fixtures and import the package. Zero assertion changes; the only test edits are mock-path retargets forced by moves and two type-only fixes to leave the typecheck exclude backlog, each justified in its commit)_
- [x] T023 Adapter conformance suite runnable against any implementation (desktop under node now; mobile later) — real adapters, not mocks — `packages/sync-client/src/adapters/__tests__/conformance.ts` _(`src/adapters/__tests__/conformance.ts` — `runAdapterConformance(harness, api)` with `describe`/`it`/`expect` injected, so desktop's Vitest run and mobile's on-device run share one suite. Real adapters: the harness supplies a live set per test. `harness.skip` exists but every entry needs a PR justification)_
- [x] T024 Boundary check walks real `apps/mobile` → `@memry/sync-client` reachability; green with the spike app importing the package _(real edge: `apps/mobile/src/spike/g0-demo.ts` now decodes pulled payloads via `decompressPayload` from `@memry/sync-client/compress` — both shells share the exact decompress code. Red/green proof captured: planted `node:fs` in `compress.ts` → `architecture boundary check failed: packages/sync-client/src/compress.ts -> node:fs (node builtin reachable from apps/mobile)`; removed → passed)_
- [x] T025 Targeted desktop E2E smoke on the extraction branch: sync push/pull, offline reconnect, CRDT merge specs only _(12/12 passed in 4.6 min on the built app against the real sync-server harness: `manual-sync-smoke` (A creates online, both sync, B opens), `network-control` (both devices online → offline → online), `body-crdt-same-note-merge` M1–M8 (offline/offline, online/offline, same-block and same-cursor merges), `sync-field-merge-queue` (offline project field merge + note tombstone with queue retry). Gotcha for the next runner: the playwright global-setup only builds when `BUILD_BEFORE_TEST=1` — an unbuilt worktree times out every launch at 180 s)_
- [x] T026 [P] Docs impact for the extraction (`pnpm docs:impact --base origin/main --strict` + updates under `apps/docs/src/`) _(green against both the stack base and this branch's own commits; `apps/docs/src/architecture/monorepo.md` records `@memry/sync-client`, the app-core contract/implementation split and the driver-agnostic `DrizzleDb`; `sync-handlers.md` records the handler split, the adapter layer and the conformance run; `pnpm docs:build` green)_

### Server production-safety kit (additive; contracts/sync-protocol-additions.md §1–4)

- [x] T027 [P] D1 migration `apps/sync-server/migrations/0006_client_gate.sql`: `client_policies` table + write-attribution columns (`client_platform`, `client_version`, nullable) per [data-model.md](./data-model.md) §3b–3c; hand-verified against production-shaped rows _(migration `apps/sync-server/migrations/0006_client_gate.sql`: `client_policies` + attribution columns on `sync_items`, `crdt_updates`, `crdt_snapshots` + partial index; empty table = today's behaviour, no backfill; verified by `schema/d1.test.ts` applying the real ledger)_
- [x] T028 [P] Client-gate middleware: parse `x-memry-client` (malformed ⇒ treated absent, logged), enforce min-version (426 `CLIENT_UPGRADE_REQUIRED`) and kill switch (403 `PLATFORM_WRITES_DISABLED`) on writes only; reads never gated — `apps/sync-server/src/middleware/client-gate.ts` + `client-gate.test.ts` _(`src/middleware/client-gate.ts` — parse + gate in ONE middleware so a router cannot be mounted gated-but-unparsed; reads never gated; kill switch beats floor; every uninterpretable policy resolves to ALLOW. Response keeps the project envelope `{ error: { code, message, minVersion? } }` — deviation recorded in contracts/sync-protocol-additions.md §2)_
- [x] T029 [P] Stamp attribution columns on every item-write path from the header — `apps/sync-server/src/routes/` write handlers + tests _(`processPushItem` → `sync_items`; `storeUpdates`/`storeSnapshot` → `crdt_updates`/`crdt_snapshots`. Latest-writer semantics on conflict. Existing positional doubles in `crdt.test.ts` / `sync.test.ts` updated for the new bind arity — assertion-only, justified inline)_
- [x] T030 [P] Embed platform policy in the account/status response so clients learn of a flipped switch without attempting a write — `apps/sync-server/src/routes/` + additive response field tests _(`GET /sync/status` gains optional `clientPolicy`; contracts `SyncStatus` + `SyncStatusSchema` extended additively. Header-less clients get byte-identical responses and pay no extra query)_
- [x] T031 Backward-compat suite: header-less (legacy desktop) requests behave byte-for-byte as today across all touched endpoints — `apps/sync-server/src/__tests__/legacy-client-compat.test.ts` _(`src/__tests__/legacy-client-compat.test.ts`, 15 cases, driven against a **real** SQLite D1 provisioned from the migration ledger (`src/__tests__/d1-sqlite.ts`) — only auth is stubbed. Full sync-server suite green: 1032/1032, coverage thresholds met)_
- [x] T032 Remove the temporary `apps/mobile` exclusion from root turbo filters; root `pnpm typecheck && pnpm test` green with mobile included; `mobile-ci.yml` keeps device-specific jobs only (plan T1.9) _(the filters are allowlists, so this was an ADD: `--filter=@memry/mobile` joined both root scripts; root typecheck green with mobile included, mobile test green (passWithNoTests). Deviation on record: mobile-ci.yml keeps its lint/typecheck/test/boundary steps for now — no workflow runs the root scripts yet, so collapsing to device-only jobs would leave mobile with zero CI; noted in the workflow header)_
      **Checkpoint — G1**: full quickstart §Phase 1 command list green; extraction PRs show mechanical diffs; desktop behaviour unchanged.

> **G1 GREEN on the gate's criteria — 2026-08-23 (second pass).**
> Command list: lint ✓ · typecheck 19/19 (mobile included) ✓ · test:desktop
> 1378 files / 18011 tests, 0 failures ✓ · sync-client 17 files / 168 ✓ ·
> sync-server 1032 ✓ · app-core 5/5 · cli 15/15 · mobile ✓ ·
> check:architecture (mobile red/green re-proof) ✓ · check:contracts ✓ ·
> ipc:check ✓ · targeted E2E 12/12 ✓ · docs:impact --strict (stack base AND
> branch base) + docs:build ✓ · git diff --check ✓.
> Extraction diffs mechanical; desktop behaviour unchanged (18k unit + 12 E2E
> on the built app). **One recorded exception:** T018's engine knot — 60
> platform-free files whose move requires the engine to consume the seams
> instead of the concrete modules (behaviour-affecting; split out, see the
> T018 annotation and seam-inventory.md §Surface). All ten seams have
> conformance-proven desktop adapters, so Phase 3 can start against the
> package while that refactor proceeds.

**Seam amendment (owner decision, 2026-08-23) — no longer blocking.** T015 found
that vault file I/O (~20 files) mapped to none of the ten seams: `VaultDirectory`
owned roots, `AttachmentStore` attachment bytes, `CrdtStorePath` the CRDT store
location, and nothing owned note/journal reads and writes. Seam 6 is widened to
**`VaultFileSystem`** (roots _plus_ relative-path read/write/list/rename/remove,
atomic writes, no `mkdir`), rather than adding an eleventh seam — the count stays
ten. Interface: `packages/sync-client/src/adapters/vault-file-system.ts`;
amendment recorded in
[contracts/platform-adapters.md](./contracts/platform-adapters.md) §6 and
[seam-inventory.md](../../packages/sync-client/docs/seam-inventory.md) finding 1.
The content half deliberately matches the existing `NoteContentStore`, which
desktop already implements and T034 already commits mobile to.

**Known follow-up inside T018–T021 (has a fix, not a decision):**
`item-handlers/agent-message-handler.ts` hashes with a **synchronous**
`createHash('sha256')` inside `applyUpsert`, which the `SyncItemHandler`
interface declares as sync. WebCrypto's `subtle.digest` is async, so the
substitution is `@noble/hashes` (already in the tree, already a direct dep of
`apps/mobile`) rather than making the whole handler interface async.

---

## Phase 3: User Story 1 — Open Your Vault on Your Phone (P1) 🎯 MVP — Train Phase 2 (Gate **G2**)

**Goal**: Existing user signs in, unlocks with password or recovery phrase,
browses their real vault read-only; production-safety kit verified end-to-end.

**Independent Test** (spec US1): on a phone that has never seen a real
desktop-created vault, sign in, unlock via password and separately via recovery
phrase, browse recent content. Standalone value: read-only companion.

- [x] T033 [US1] Mobile DB module: chosen driver (per R2 decision), open-per-vault, migration runner, ledger `0001_baseline.sql` (meta, sync_items, folders, note_bodies, sync_cursors, yjs_updates, yjs_snapshots, outbox, attachments per data-model.md §1; `NSFileProtectionCompleteUntilFirstUserAuthentication`; DB and attachment files live under Application Support — non-evictable storage, never Caches, so unsynced writes survive OS cache eviction) — `apps/mobile/src/db/index.ts`, `apps/mobile/src/db/migrations/0001_baseline.sql` _(IMPLEMENTED — `src/db/index.ts` open-per-vault + migration runner over `PRAGMA user_version`; ledger `0001_baseline.sql` with shipped-string parity test (`migrations.test.ts` 2/2). R2 findings baked in: prepared-stmt bulk path, FTS5 drop-before-close. Deviation on record: DB+files live under Documents/vaults/<id> — expo-file-system exposes no Application Support path; the constraint (non-evictable, never Caches) holds, NSFileProtection entitlement set in app.config.ts. lint/typecheck/test/architecture/contracts/ipc all green 2026-08-23 (root battery on this branch; desktop 17997 tests untouched-green); on-device proof rides T054)_
- [x] T034 [P] [US1] SQLite-backed `NoteContentStore` implementing the existing interface over `note_bodies` (raw markdown incl. frontmatter) — `apps/mobile/src/db/note-content-store.ts` _(IMPLEMENTED — `src/db/note-content-store.ts`: desktop's exact interface over `note_bodies` (+ unique `path` column added to the baseline); id-keyed rows with path addressing; journal paths via the pure `@memry/storage-vault/journal-format`)_
- [x] T035 [P] [US1] Secure-store module with the data-model §2 key map (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, never logged) — `apps/mobile/src/lib/secure-store.ts` _(IMPLEMENTED — `src/lib/secure-store.ts`: exact data-model §2 key map, WHEN_UNLOCKED_THIS_DEVICE_ONLY, values never logged, dependency-free base64)_
- [x] T036 [US1] `SyncHttpClient` adapter: fetch + NetInfo online signal + `isMetered` — `apps/mobile/src/adapters/http-client.ts` _(IMPLEMENTED — `src/adapters/http-client.ts`: fetch + NetInfo online signal + real isMetered (isConnectionExpensive/cellular); never invents headers)_
- [x] T037 [P] [US1] `CertificatePinning` explicit no-op adapter (`isEnforced() → false`, documented decision) — `apps/mobile/src/adapters/certificate-pinning.ts` _(IMPLEMENTED — explicit no-op, isEnforced()→false, decision documented in-file)_
- [x] T038 [P] [US1] `Runtime` adapter: app version, platform, foreground/background hooks, project logger seam — `apps/mobile/src/adapters/runtime.ts` _(IMPLEMENTED — expo-constants version (`<semver>+<build>`), AppState fg/bg hooks, logger seam via `src/lib/logger.ts`)_
- [x] T039 [P] [US1] `VaultDirectory` + `CrdtStorePath` adapters over the app sandbox (per-vault roots, provision path must not dead-end on a new device) — `apps/mobile/src/adapters/vault-directory.ts`, `apps/mobile/src/adapters/crdt-store-path.ts` _(IMPLEMENTED as the widened seam — `src/adapters/vault-file-system.ts` implements the FULL VaultFileSystemAdapter (roots + contents, atomic tmp+rename writes, relPath guards, removeDirIfEmpty never recursive, provision never dead-ends) + `crdt-store-path.ts`)_
- [x] T040 [US1] `DeviceRegistration` adapter backed by secure-store Ed25519 keypair — `apps/mobile/src/adapters/device-registration.ts` _(IMPLEMENTED — secure-store-backed Ed25519, sign closure only (private key never crosses the seam), expo-device model)_
- [x] T041 [US1] `CrdtPersistence` adapter over `yjs_updates`/`yjs_snapshots` (append durable before resolve; compaction) — `apps/mobile/src/adapters/crdt-persistence.ts` _(IMPLEMENTED — `local.<docId>` namespace over yjs_updates/yjs_snapshots so local appends can never collide with server sequence rows (recorded for Phase 4's doc manager); durable-at-commit WAL)_
- [x] T042 [P] [US1] `CrdtPreflight` adapter (`PRAGMA quick_check` + schema-version assert) — `apps/mobile/src/adapters/crdt-preflight.ts` _(IMPLEMENTED — PRAGMA quick_check + schema-version assert; missing store healthy-by-vacancy like desktop's access probe)_
- [x] T043 [US1] Auth screens: sign-in, vault picker (multi-vault, FR-004) — `apps/mobile/app/(auth)/sign-in.tsx`, `apps/mobile/app/(auth)/vaults.tsx` _(IMPLEMENTED — `(auth)/sign-in.tsx` (OTP two-step, needsSetup guarded), `(auth)/vaults.tsx` multi-vault picker; VoiceOver labels on every control)_
- [x] T044 [US1] Vault unlock: password path (Argon2id → KDF contexts → verifier → AEAD) and recovery-phrase path, wrong-password error with nothing partially unlocked — `apps/mobile/app/(auth)/unlock.tsx`, `apps/mobile/src/lib/vault-unlock.ts` _(IMPLEMENTED — `(auth)/unlock.tsx` + `src/lib/vault-unlock.ts`: 24-word phrase → mnemonicToSeed → Argon2id 64MiB → verifier match BEFORE the vault key is stored, so a wrong phrase leaves nothing half-unlocked. On record: the product has no separate vault password (G0 finding) — the phrase is the credential; device unlock is the local boundary per decision record §8)_
- [x] T045 [US1] Wire `@memry/sync-client` pull pipeline with the mobile adapters (pull-only engine start) — `apps/mobile/src/sync/engine.ts` _(**Owner decision 2026-08-23 — option (b)**: the pull pipeline is written clean inside `@memry/sync-client` on top of the ten seams (pull-only, US1 scope: metadata for all 12 types + note bodies), rather than refactoring desktop's 60-file engine knot to consume the seams (option (a) — behaviour risk, own PR + canary, weeks of US1 blockage). Desktop behaviour unchanged; pull semantics — cursor, delete-clock, type negotiation — must match desktop's exactly so the two engines cannot drift. IMPLEMENTED: `packages/sync-client/src/pull/` — RecordPullEngine (cursor/breaker/page-drop/tombstone/apply-order semantics mirrored from desktop's PullCoordinator, 8 tests) + CrdtBodyPuller (snapshot-baseline/prune-gap/watermark rules, 3 tests; safe deviation on record: an unresolvable signer STOPS the note's watermark instead of advancing-and-owing) + platform-free record/CRDT decrypt with byte-identical CBOR signature payloads over an injected crypto provider; wired on mobile in `apps/mobile/src/sync/engine.ts` over the ten adapters. sync-client suite 19 files/179 green)_
- [x] T046 [US1] Inject `x-memry-client: ios/<semver>+<build>` on every request via the engine/http adapter (contracts §1) _(IMPLEMENTED — `buildClientHeaderValue('ios', semver+build)` attached to every seam request in `packages/sync-client/src/pull/http.ts`; header-shape test green)_
- [x] T047 [US1] Windowed first sync: metadata for all 12 types + last-30-day bodies, per-scope cursors, determinate progress UI, app usable during (FR-008) — `apps/mobile/src/sync/first-sync.ts`, `apps/mobile/src/features/sync/progress.tsx` _(IMPLEMENTED — `src/sync/first-sync.ts` 3-phase windowed run (refs → all payload blobs newest-first → 30-day CRDT bodies), durable-before-cursor so kills resume; determinate `progress.tsx` strip, app usable behind it)_
- [x] T048 [US1] On-demand body fetch (`payload_state: metadata-only → full`) on note open — `apps/mobile/src/sync/body-fetch.ts` _(IMPLEMENTED — `src/sync/body-fetch.ts` on note open: record blob if metadata-only + CRDT body pull; payload_state only ever advances)_
- [x] T049 [US1] Notes browse UI: folder tree + note list (read-only) — `apps/mobile/app/(vault)/notes/index.tsx` _(IMPLEMENTED — `(vault)/notes/index.tsx`: folder-grouped read-only list from payload projections, pending-count surfaced, refresh on sync events)_
- [x] T050 [US1] Read-only note body preview (plain markdown render; placeholder until the Phase 4 editor replaces it) — `apps/mobile/app/(vault)/notes/[id].tsx` _(IMPLEMENTED — `(vault)/notes/[id].tsx` plain markdown text preview (explicit Phase-4 placeholder); CRDT state materialized via the best-effort `note-materializer.ts` serializer — the real converter needs @blocknote/server-util (jsdom) and cannot run on Hermes, recorded in-file)_
- [x] T051 [US1] Read-only mode client behaviour: react to 426/403/status policy — explicit banner + plain explanation + update path, outbox parked never dropped, auto-resume on clear (FR-010) — `apps/mobile/src/sync/read-only-mode.ts` _(IMPLEMENTED — `src/sync/read-only-mode.ts` state machine fed by clientPolicy on /sync/status (sent WITH the client header, so the switch is learned without a write) + banner in `status.tsx` with plain explanation and update path; outbox parking is structurally a no-op until Phase 4 writes exist, hooks in place. Kill-switch/version-gate DRILLS ride T056)_
- [x] T052 [US1] Foreground sync triggers + `expo-background-task` registration (BGAppRefreshTask; resumable, interruptible) — `apps/mobile/src/sync/background.ts` _(IMPLEMENTED — `src/sync/background.ts`: expo-task-manager task + expo-background-task registration, foreground AppState trigger; resumable by construction (durable page-by-page pulls))_
- [x] T053 [P] [US1] Sync/degraded-state UI using desktop's vocabulary (offline, syncing, locked, read-only) — `apps/mobile/src/features/sync/status.tsx` _(IMPLEMENTED — `src/features/sync/status.tsx` with desktop vocabulary: offline/syncing/locked/read-only; a11y roles + labels)_
- [x] T054 [US1] Seam tests on real adapters: pull pipeline → SQLite rows → NoteContentStore round-trip; conformance suite (T023) green against the mobile adapters — `apps/mobile/src/sync/__tests__/pull-pipeline.test.ts` _(DONE — on-device harness `src/sync/__harness__/us1-seam-harness.ts` runs the shared conformance suite against the REAL mobile adapters plus a live pull→SQLite→NoteContentStore round-trip; dev runner screen `(dev)/seam-tests.tsx`. Evidence: on-device run on the reference device against staging — conformance 26/26 PASS, round-trip 6/6 PASS, metadata-only 0, corrupt-marked 0 (2026-08-26 screenshot; first device green 2026-08-24 after #1817/#1822/#1823/#1826); re-verified 2026-08-26/27 against the post-#1858 server after staging reset + device wipe + fresh 10k-item first sync. Trail: PR #1827, issue #1729)_
- [x] T055 [P] [US1] Maestro smoke flow: sign-in → unlock → browse → open note — `apps/mobile/.maestro/us1-unlock-browse.yaml` _(DONE — green run on iPhone 17 Pro simulator 2026-08-25, signed-in session path; gotchas on record: `JAVA_HOME=/opt/homebrew/opt/openjdk`, note body matches by accessibility label not testID. Flow re-exercised end-to-end on the physical reference device 2026-08-26/27 post-#1858 after device wipe. Trail: PR #1827, issue #1730)_
- [x] T056 [US1] **G2 drills + evidence** (quickstart §Phase 2): 20-trial <5 s visibility (desktop→phone), kill-switch drill (staging flip → read-only without restart → drain on re-enable), version-gate drill, attribution query on staging D1, and SC-004 measurement — 10,000-item staging vault over Wi-Fi: recent content browsable within 2 min of unlocking on the reference device _(DONE — owner-verified 2026-08-27 on the reference device against the post-#1858 staging server after a full staging reset + device wipe: kill-switch flip → read-only banner without restart, re-enable clears; version-gate 99.0.0 → upgrade banner, NULL clears; attribution on reseeded D1 — desktop rows `client_platform=NULL`, zero `ios` rows (mobile writes start Phase 4); desktop→phone visibility observed <5 s; SC-004 — 10k-item vault over Wi-Fi, recent content browsable ≤2 min from unlock, first sync resumable across kill+relaunch, airplane-mode relaunch opens without network. Recordings/screenshots with the owner; trail in PR #1827, issue #1731)_

**Checkpoint — G2**: all four drills green. This is the MVP: a trustworthy read-only companion on the developer's own device.

> **Phase 3 COMPLETE, G2 GREEN — 2026-08-27.**
> T033–T053 implemented and green on the code gates (lint ✓ · typecheck 20/20
> incl. mobile app+test configs ✓ · root test battery 11/11 tasks — desktop
> 17997 untouched-green, sync-client 179 (11 new pull-engine tests), mobile
> migration parity 2/2 ✓ · check:architecture ✓ · check:contracts ✓ ·
> ipc:check ✓ · docs:impact --strict clean ✓ · git diff --check ✓).
> Owner decision recorded at T045: pull engine option (b) — clean pull-only
> engine inside `@memry/sync-client` on the ten seams; desktop untouched.
> **G2 declared 2026-08-27**: T054 ✓ 2026-08-26 (on-device 26/26 + 6/6, clean
> table), T055 ✓ 2026-08-25 (Maestro green), T056 ✓ 2026-08-27 (all drills +
> SC-004 owner-verified on the reseeded staging vault, post-#1858 server) —
> evidence in PR #1827, issues #1729/#1730/#1731. Observed while drilling, on
> record: first-sync phase C progress is indeterminate under an all-recent
> vault (bar pinned at 80% "Fetching recent notes…" for the 10k tail) —
> cosmetic, not a gate item; candidate Phase 14 polish fix. The one recorded
> Phase 2 exception (#1728, T018 engine knot) stays open — it is not a G2
> item.

---

## Phase 4: User Story 2 — Edit Notes Anywhere, Offline First (P1) — Train Phase 3 (Gate **G3**)

**Goal**: Full-richness note editing via the WebView BlockNote editor over an
RN-owned Y.Doc; durable offline writes; convergence with desktop.

**Independent Test** (spec US2): with sync suspended, edit + create notes;
force-quit; relaunch; reconnect; all edits appear on desktop intact; a
concurrent desktop edit to the same note merges without loss.

- [x] T057 [US2] `editor-web` bundle: BlockNote + `@memry/editor-schema` built to a self-contained local HTML asset (no network at open) — `apps/mobile/editor-web/` (vite config, `src/main.tsx`) _(IMPLEMENTED — `apps/mobile/editor-web/` is its own workspace package (vite + `@blocknote/core` + `@memry/editor-schema`, NO React: `BlockNoteEditor.create().mount()` is the vanilla path, which drops react-dom from the bundle entirely). `scripts/build-editor-web.mjs` inlines vite's output into ONE html document with a CSP of `default-src 'none'` — the no-network-at-open rule is enforced, not just intended. Recorded deviation: the document is stored GZIPPED + base64 in the generated module (4.5 MB → 1.0 MB) because BlockNote plus its code-block highlighter is 4.5 MB of JS and a literal that size lands in every checkout, diff and Metro bundle; pako (already a mobile dep) inflates it once, before mount, off the keystroke path. Schema is `createServerBlockSpecs()` + `createServerInlineSpecs()` — the headless set is complete by construction, and a spec this schema lacks is DELETED from the shared Y.Doc by y-prosemirror — with only `wikiLink` (tappable, carries `data-target`) and `inlineImage` (resolves through `asset-req`) re-flavoured for touch)_
- [x] T058 [US2] Bridge contract types + generation for both sides per [contracts/webview-bridge.md](./contracts/webview-bridge.md) (envelope v1, all message types; `ipc:check`-style drift gate in mobile-ci) — `packages/contracts/src/webview-bridge.ts`, generation script _(IMPLEMENTED — `packages/contracts/src/webview-bridge.ts`: envelope v1, every message type, zod schemas both directions, `T_flush`/`B_max`/counters. Both halves IMPORT it (the guest is a workspace package), so the types cannot drift by construction — no generation step to go stale. The real drift risk is the PREBUILT asset, so the `ipc:check` discipline was applied there: the build stamps a hash over editor-web sources + this contract, `pnpm --filter @memry/mobile editor:check` fails on a stale asset (wired into mobile-ci), and the same hash rides in the `ready` handshake so it also fails at runtime. Contract additions recorded in contracts/webview-bridge.md: `sentAt` (T074 needs a send stamp it did not fabricate), `asset.status`/`revision` ("not downloaded yet" is a normal state under Wi-Fi-only), `insert-image`)_
- [x] T059 [US2] RN-side bridge provider: batching (`T_flush`/`B_max` from R4), `seq` gap detection → resync, `sid` origin tagging — `apps/mobile/src/editor/bridge-provider.ts` _(IMPLEMENTED — `bridge-provider.ts`: T_flush/B_max batching, `sid` origin tag, per-sender `seq`, and a gap → full `doc-load` resync (never silent absorption — a dropped update leaves the replicas diverged with no symptom until a later edit lands on the wrong state). Delivery samples feed T074)_
- [x] T060 [US2] WebView-side bridge counterpart: batching, base64 framing, `ready` handshake, zero web-storage persistence — `apps/mobile/editor-web/src/bridge.ts` _(IMPLEMENTED — `editor-web/src/bridge.ts`, mirror of the RN half against the same contract module. `ready` handshake, base64 framing, zod-validated envelopes, gap reported back as `err/BRIDGE_SEQ_GAP`. Persists nothing and clears web storage on boot)_
- [x] T061 [US2] RN-side Y.Doc ownership: doc manager wiring `CrdtProvider` host ↔ bridge transport ↔ `CrdtPersistence` — `apps/mobile/src/editor/doc-manager.ts` _(IMPLEMENTED — `doc-manager.ts` owns the Y.Doc and replays BOTH CRDT halves: server rows under the bare doc id with the SERVER's sequence, local rows under `local.<docId>` with their own (the namespace split recorded in Phase 3 — reading one half is a doc missing the other side's edits). Origin symbols split guest/remote so a pulled update is never re-queued)_
- [x] T062 [US2] Durability rule: every WebView-originated update written to SQLite **before** ack into the outbox pipeline; WebView process-death recovery (re-create + `doc-load` replay) with test — `apps/mobile/src/editor/__tests__/durability.test.ts` _(IMPLEMENTED — `applyFromGuest` commits to SQLite and only then acks into the outbox; `durability.test.ts` asserts the ORDER against a call log rather than eventual appearance, plus: a refused store acks nothing, both halves replay, process death recovers from what was persisted, remote updates never re-queue. **7/7 green**)_
- [x] T063 [US2] Outbox drain worker: push queue → server, backoff, park/resume on read-only signals; note create/rename/move/delete + folder ops enqueued — `apps/mobile/src/sync/outbox.ts` _(IMPLEMENTED — `sync/outbox.ts`: store + drain. CRDT updates push before record ops (a body edit landing after its own note's delete would apply to a tombstone); jittered exponential backoff; 403/426 PARK the queue and stop the pass without accruing backoff, so the first drain after the switch clears is not idle. Push encryption is `@memry/sync-client/push` — new platform-free twins of desktop's `encryptItemForPush` / `encryptCrdtUpdate`, pinned against the pull decryptors by `roundtrip.test.ts` (**9/9 green**), because a byte out of place there is an item every other device silently rejects)_
- [x] T064 [US2] Editor screen replaces the T050 preview: WebView host, `cfg` (theme/locale/RTL/reduced-motion/readOnly), keyboard handling; plus note-management UI — create, rename, move-to-folder, delete (wired to the T063 enqueued ops; FR-012) — `apps/mobile/app/(vault)/notes/[id].tsx`, `apps/mobile/src/editor/editor-view.tsx`, `apps/mobile/src/features/notes/manage.tsx` _(IMPLEMENTED — `editor-view.tsx` (WebView host, `cfg`, keyboard avoidance, WebView-process-death recovery via `doc-load` replay), `(vault)/notes/[id].tsx` (editor + read-only banner + metadata panel), `features/notes/manage.tsx` (rename/move/delete), create + create-from-template on the notes list. Every write goes through `note-ops.ts`, which reads the stored payload VERBATIM and mutates only its own fields)_
- [x] T065 [US2] Seam tests (real adapters, scripted against staging or local sync-server): (a) concurrent desktop+mobile edits to the same note converge with neither side lost; (b) **delete-vs-edit tombstone**: note deleted on one device while edited on the other resolves deterministically and identically on both shells (constitution III mandated seam); (c) **unknown-field round-trip**: a newer-desktop payload fixture survives a mobile edit cycle with unknown fields unstripped — `apps/mobile/src/sync/__tests__/convergence.test.ts` _(IMPLEMENTED — `sync/__tests__/convergence.test.ts`, **4/4 green**: (a) concurrent desktop+mobile edits converge to a byte-identical document on both sides (the assertion is equality, not "both contain the words"), (b) delete-vs-edit resolves identically because neither shell arbitrates — both read the same `deletedAt` from the record feed and the body update is orphaned rather than resurrecting, (c) a newer-desktop payload survives a mobile edit with `reviewState`/`pinnedTags`/`futureFlag` intact and both devices' clocks merged. **Recorded deviation**: the scenarios run over the REAL encryptors, decryptors, doc manager and Yjs merge, but against an in-memory relay (`__tests__/relay.ts`) that stores exactly what the server stores — a unit run cannot reach staging's auth + vault provisioning. The staging leg rides the G3 device pass, see g3-evidence.md §2)_
- [ ] T066 [US2] Offline matrix automation: airplane-mode edit + create → force-quit → relaunch → reconnect → complete sync; ≥ 20 scripted runs, 100% pass — `apps/mobile/.maestro/us2-offline-matrix.yaml` + driver script _(AUTOMATION LANDED, RUN OUTSTANDING — flow + `scripts/us2-offline-matrix.mjs` (`pnpm --filter @memry/mobile test:offline-matrix -- --runs 20`). The radio is NOT scriptable from Maestro (neither the simulator nor a device exposes airplane mode to the accessibility tree), so the driver owns the transitions and the scenario is TWO flows with the cut between them — one file would mean restoring the network only after the flow exited, making the reconnect assertion pass vacuously offline. The cut itself is a prompt by default, or `--offline-cmd`/`--online-cmd`: `simctl status_bar --dataNetwork hide` only REPAINTS the status bar and leaves the simulator online, so driving the matrix with it would report a green that means nothing. The offline flow asserts the app's own Offline banner for the same reason. The flow waits on the OUTBOX-depth banner (`Unsynced changes`), deliberately distinct from the pull indicator — a run that waited on "Syncing" would call a still-full outbox a success. **The task's verification IS the 20 runs; unchecked until they are green.**)_
- [x] T067 [US2] Wiki-links: alias rendering, tap navigation (incl. heading targets) via `nav` bridge msg, autocomplete via `wiki-query`/`wiki-candidates` (FR-014) — editor-web plugin + `apps/mobile/src/editor/wiki-links.ts` _(IMPLEMENTED — guest half in `editor-web/src/wiki-links.ts` (tap → `nav`, flushed immediately so navigation is not behind the 24 ms batch; `[[` → `wiki-query`; `pointerup`/`pointerdown` rather than `click`, because the chip is `contenteditable=false` and iOS moves the selection between down and up), RN half in `editor/wiki-links.ts` (title resolution incl. `Title#Heading`, exact-case preferred, prefix-then-substring candidates))_
- [x] T068 [P] [US2] Tags view/add/remove with desktop's case-preserving semantics (FR-015) — `apps/mobile/src/features/notes/tags.tsx` _(IMPLEMENTED — `features/notes/tags.tsx` + `addTag`/`removeTag` in note-ops: stored exactly as typed, deduped case-INSENSITIVELY. Storing the lower-cased form would rewrite every existing `#Roadmap` on the note's next mobile edit)_
- [x] T069 [P] [US2] Note properties view/edit with desktop type semantics (FR-016) — `apps/mobile/src/features/notes/properties.tsx` _(IMPLEMENTED — `features/notes/properties.tsx`. **Recorded deviation**: desktop reads a property's type from the vault's definition FILES ([[property-defs-and-project-links-live-in-files]]), which mobile has no reader for, so the type is inferred from the stored value using desktop's own fallback rules and an edit never RETYPES a value — writing `"3"` over a number would change the column for every other device. `project` stays reserved)_
- [x] T070 [P] [US2] Create note from template (FR-017) — `apps/mobile/src/features/notes/from-template.ts` _(IMPLEMENTED — `features/notes/from-template.ts` reads pulled `template` sync items (mobile has no `.memry/templates` reader) and seeds tags + properties; template properties are a LIST, note properties a record)_
- [x] T071 [US2] Undo/redo within session via `exec` bridge command (FR-018) _(IMPLEMENTED — `exec:undo`/`exec:redo` flushed immediately, driven from the note header)_
- [x] T072 [US2] `AttachmentStore` adapter (sandbox files, NSFileProtection) + lazy download honoring Wi-Fi-only default + per-item override + placeholder-with-fetch-action UX; late-arriving attachment becomes visible without recreating the note — `apps/mobile/src/adapters/attachments.ts`, `apps/mobile/src/features/attachments/` _(IMPLEMENTED — `adapters/attachments.ts` (manifest fetch → signature verify → decrypt → per-chunk hash check → whole-file checksum, mirroring desktop's framing byte-for-byte; manifest crypto is shared in `@memry/sync-client/push/attachment-manifest.ts` with its own round-trip + swap-detection tests) and `features/attachments/resolve.ts`. Wi-Fi-only default with a per-item override; `pending` is a first-class answer so the editor renders a placeholder rather than a broken image, and a bumped revision makes a late file appear without recreating the note. **Migration 0003** (additive) records the manifest filename: a note's reference is a PATH and sync addresses a blob by id, and desktop bridges the two by writing the file under the manifest's own name — so the basename pairing is the mapping, not a guess)_
- [x] T073 [US2] Insert images/attachments from photo picker/files into a note (upload path through outbox) — `apps/mobile/src/features/attachments/insert.ts` _(IMPLEMENTED — `features/attachments/insert.ts`: photo picker / document picker → chunked encrypt → initiate/PUT/complete → signed manifest → THEN the note's `attachmentReferences` (union, never replace) → then the block. Reference before blob is a broken image on every other device; the note push carrying `attachmentReferences` is what makes peers fetch at all)_
- [ ] T074 [US2] Keystroke-latency instrumentation + G3 measurement on the 50 KB staging note, release build, reference device — `apps/mobile/src/editor/__rig__/latency.ts` _(INSTRUMENTATION LANDED, MEASUREMENT OUTSTANDING — `LatencyRecorder` times DELIVERY (guest flush → RN receipt) and PERSIST (receipt → SQLite commit) separately and reports p50/p95/p99 of their sum. What the budget gates is stated in the module: the WebView renders its own keystroke locally, so the bridge is off the critical render path and a rig timing the local character would report ~0 ms and prove nothing — the number is the END-TO-END ECHO, which is the part that can lose work. Always on (two `Date.now()` calls per update): a measurement path that exists only in a dev build measures a different app than the one G3 gates. **The measurement itself needs the reference device on a release build — debug WebView messaging is a different number, not a slower one.**)_
- [x] T075 [P] [US2] Bridge envelope/message counters exposed in dev builds (batching proof for G3) _(IMPLEMENTED — counters on both ends (`envelopesSent`, msgs-per-envelope histogram, seq gaps, resyncs), surfaced by "Bridge metrics" in the note screen's Info panel under `__DEV__`, formatted by `formatG3Report`)_
- [x] T076 [US2] Background-transition flush: `exec:flush` + outbox drain on `onBackground` _(IMPLEMENTED — and the ORDER is the point: `controls.flush()` sends `exec:flush` and AWAITS the resulting persists (bounded at 2 s, because iOS gives a backgrounding app seconds), then the outbox drains. Draining first reads the queue before the last keystrokes have finished their round trip through the WebView. Wired app-wide in `sync/background.ts` (foreground: drain then pull; background: drain) and in the note screen)_
- [ ] T077 [US2] **G3 evidence bundle** (quickstart §Phase 3) → then open internal TestFlight ring (5–10 real vaults) — only with the G2 kill switch verified live _(BUNDLE SHAPED — `specs/001-mobile-app/g3-evidence.md` carries the five gates with their commands and empty checkboxes. Code gates are filled and green; the four device gates (offline matrix 20/20, on-hardware convergence incl. delete-vs-edit, <50 ms end-to-end p95, msgs/envelope > 1.00) and the live kill-switch check are Kaan's. Note carried forward from G0-d: the batching claim is UNPROVEN until real typing shows coalescing — at 10 keystrokes/s a 24 ms window never coalesces, which is arithmetic, and G3 does not pass on a hand-wave.)_

**Checkpoint — G3**: offline matrix 100%, convergence proven, <50 ms p95, batching proven. Write path is now trusted behind the kill switch.

---

## Phase 5: User Story 3 — Manage Tasks and Get Reminded (P2) — Train Phase 4 begins (Gate **G4** accumulates)

**Goal**: Task capture/schedule/complete with recurrence, priorities, projects;
local-notification reminders.

**Independent Test** (spec US3): create a recurring task with a reminder on
mobile; complete an instance; recurrence advances; desktop reflects it; reminder
fires on time with the app closed.

- [ ] T078 [US3] Migration `0002_tasks_projects.sql`: typed projections for tasks + projects (+ `reminders_local`) mirroring desktop field semantics; field-level vector clocks ride `sync_items.vector_clock` — `apps/mobile/src/db/migrations/0002_tasks_projects.sql`
- [ ] T079 [US3] Seam test: concurrent field edits (date on desktop, priority on mobile) both survive after sync — real adapters — `apps/mobile/src/sync/__tests__/task-field-merge.test.ts`
- [ ] T080 [US3] Task views: today / upcoming / by-project / completed with desktop membership semantics (FR-020) — `apps/mobile/app/(vault)/tasks/index.tsx`
- [ ] T081 [US3] Task CRUD: due/scheduled dates, priority, recurrence, project assignment (FR-019) — `apps/mobile/src/features/tasks/`
- [ ] T082 [US3] Note-checkbox ↔ task consistency on mobile edits (markdown is truth; FR-021) — `apps/mobile/src/features/tasks/note-checkbox-sync.ts`
- [ ] T083 [US3] Projects: list + project view (tasks + notes), create/edit (FR-022) — `apps/mobile/app/(vault)/projects/`
- [ ] T084 [US3] Reminders: schedule local notifications from synced data (expo-notifications), `reminders_local` bookkeeping, tap opens item (FR-023) — `apps/mobile/src/features/reminders/scheduler.ts` _(record cut order: reminders are the second-to-last cut)_
- [ ] T085 [US3] Stale-notification reconciliation: item completed/deleted elsewhere ⇒ sensible open state, never a ghost/crash; plus clock-skew behaviour — reminders fire per scheduled wall-clock and reconcile predictably with a wrong device clock (spec edge cases) — `apps/mobile/src/features/reminders/reconcile.ts`
- [ ] T086 [P] [US3] Maestro flow: recurring task + completion + reminder-fire verification — `apps/mobile/.maestro/us3-tasks.yaml`

---

## Phase 6: User Story 4 — Daily Journal on the Go (P2)

**Goal**: One-tap today's entry; one entry per day; full editor.

**Independent Test** (spec US4): today's entry opens in one tap from fresh start;
a past date opens exactly the desktop-created entry for that date.

- [ ] T087 [US4] Journal domain wiring: one-entry-per-day guarantee via shared app-core semantics; never a duplicate day (FR-024) — `apps/mobile/src/features/journal/journal-store.ts`
- [ ] T088 [US4] Journal UI: today in one interaction, date navigation/backfill — `apps/mobile/app/(vault)/journal/index.tsx`, `apps/mobile/app/(vault)/journal/[date].tsx`
- [ ] T089 [US4] Journal entries open in the US2 editor (journal doc ids through the same bridge/doc-manager; FR-025)
- [ ] T090 [US4] Seam test: same-day concurrent desktop+mobile journal edits merge into one entry; plus clock-skew cases — journal "today" resolution and task due logic behave predictably with a wrong device clock, and sync convergence is unaffected by skew (spec edge case) — `apps/mobile/src/sync/__tests__/journal-merge.test.ts`

---

## Phase 7: User Story 5 — Quick Capture to Inbox and Triage (P2)

**Goal**: Capture in ≤ 2 interactions from app start, offline; triage to
note/task/discard.

**Independent Test** (spec US5): capture within two interactions; convert one
item to task, one to note, discard one; verify on desktop.

- [ ] T091 [US5] Quick capture: entry point reachable in ≤ 2 interactions from app start, fully offline (FR-029) — `apps/mobile/app/(vault)/inbox/capture.tsx`
- [ ] T092 [US5] Inbox list + pending-count badge on entry points (FR-030) — `apps/mobile/app/(vault)/inbox/index.tsx`
- [ ] T093 [US5] Triage actions: → note / → task (content carried), discard; inbox item cleared — `apps/mobile/src/features/inbox/triage.ts`
- [ ] T094 [P] [US5] Maestro flow: capture → triage → desktop-side verification — `apps/mobile/.maestro/us5-inbox.yaml`

---

## Phase 8: User Story 6 — Manage Your Calendar (P3)

**Goal**: Month + day/agenda views of events, dated tasks, journal days; event
CRUD.

**Independent Test** (spec US6): create timed + all-day events on mobile; both
render on desktop; move one to another day; change syncs.

- [ ] T095 [US6] Migration `0003_events.sql`: calendar-event projection with desktop semantics — `apps/mobile/src/db/migrations/0003_events.sql`
- [ ] T096 [US6] Calendar views: month grid + day/agenda showing events, dated tasks, journal-entry days (FR-026) — `apps/mobile/app/(vault)/calendar/index.tsx`
- [ ] T097 [US6] Event create/edit/delete: title, date, timed/all-day, duration (FR-027) — `apps/mobile/src/features/calendar/event-editor.tsx`
- [ ] T098 [US6] Tap-through: calendar item opens underlying task / journal entry / event (FR-028)

---

## Phase 9: User Story 7 — Home at a Glance (P3)

**Goal**: Local-data home summarizing today; honors synced config where concepts
exist.

**Independent Test** (spec US7): with due tasks, recent notes, pending inbox
items — each home section shows correct items and navigates correctly.

- [ ] T099 [US7] Home screen: today's due/overdue tasks, recent notes, journal shortcut, inbox count — renders from local data, never waits on network (FR-031) — `apps/mobile/app/(vault)/index.tsx`
- [ ] T100 [US7] Honor synced home configuration where the concept exists on mobile; omit desktop-only widgets gracefully, never broken (FR-032) — `apps/mobile/src/features/home/config-map.ts`
- [ ] T101 [US7] Section tap-through navigation to items/views

---

## Phase 10: User Story 9 — Find Anything Fast (P3)

**Goal**: Ranked offline FTS over notes, journals, tasks, inbox.

**Independent Test** (spec US9): airplane mode; search a phrase known to exist in
a note, a task title, and a journal entry; all three found and open correctly.

- [ ] T102 [US9] Migration `0004_fts.sql`: FTS5 virtual tables (notes, journal, tasks, inbox) with tokenization matching desktop index semantics — `apps/mobile/src/db/migrations/0004_fts.sql`
- [ ] T103 [US9] Incremental index maintenance on sync apply + local edit; full rebuild path (drop/recreate FTS never touches item rows) — `apps/mobile/src/db/fts-indexer.ts`
- [ ] T104 [US9] Search UI: ranked cross-type results, each opens the right item, works offline; UI states its full-text scope (semantic search is desktop-only — absent capability says so, FR-046) (FR-038) — `apps/mobile/app/(vault)/search.tsx`
- [ ] T105 [P] [US9] Maestro flow: airplane-mode three-type search — `apps/mobile/.maestro/us9-search-offline.yaml`

---

## Phase 11: User Story 8 — View Canvases, Read-Only (P3) — recorded first cut if schedule slips

**Goal**: Faithful pan/zoom read-only canvas viewing; provably no writes.

**Independent Test** (spec US8): open a desktop-created canvas with shapes, text,
connectors; verify fidelity, pan/zoom, explicit read-only label, byte-identity
after viewing.

- [ ] T106 [US8] Canvas list + read-only renderer with pan/zoom — render mechanism decided in writing before this phase starts (default: WebView-rendered static SVG export of the scene JSON; zero mutation path); fidelity criterion: side-by-side snapshot fixtures vs desktop's export for shapes, text, connectors (FR-033) — `apps/mobile/app/(vault)/canvas/index.tsx`, `apps/mobile/app/(vault)/canvas/[id].tsx`
- [ ] T107 [US8] Explicit view-only label + write-block guarantee; byte-identity test: canvas payload hash unchanged after a viewing session (FR-034, SC-006) — `apps/mobile/src/features/canvas/__tests__/byte-identity.test.ts`
- [ ] T108 [US8] Pan/zoom gesture verification on device (large canvas)

---

## Phase 12: Vault-parity completion — bookmarks, saved filters, settings (no single story; FR-035–037, SC-005, feeds G4)

**Purpose**: The remaining synced types/behaviours vault parity requires; grouped
here because the spec assigns them FRs but no dedicated story.

- [ ] T109 [P] Bookmarks: list, open, create, delete + sync projection (FR-035) — `apps/mobile/app/(vault)/bookmarks.tsx`
- [ ] T110 [P] Saved filters: apply with desktop-identical results over the same data (shared filter engine from app-core; FR-036) — `apps/mobile/src/features/filters/apply.ts`
- [ ] T111 [P] Settings application: synced preferences applied where the concept exists; unknown groups round-trip unstripped (FR-037, edge case) — `apps/mobile/src/features/settings/apply.ts`
- [ ] T112 **G4 evidence** (quickstart §Phase 4): 12-type audit checklist on a real production-format vault; offline FTS; reminder fires app-closed; canvas hash identical

**Checkpoint — G4**: all 12 synced types readable; audit attached.

---

## Phase 13: User Story 10 — Subscribe on Your Phone (P4) — Train Phase 5 (Gate **G5**)

**Goal**: StoreKit 2 purchase activates sync entitlement; either-platform
entitlement honored; double subscription surfaced honestly.

**Independent Test** (spec US10): sandbox purchase activates sync-gated features;
an account also holding an active web subscription surfaces the
double-subscription state with guidance.

- [ ] T113 [US10] D1 migration `apps/sync-server/migrations/0007_apple_iap.sql`: `apple_transactions` table per data-model §3a; extend `SyncEntitlementSource` union with `'apple'` in `apps/sync-server/src/services/entitlements.ts` (TEXT column — zero DDL for the enum)
- [ ] T114 [US10] ASSN V2 endpoint: JWS x5c verification via `@apple/app-store-server-library` on Workers, environment separation, idempotent by `notificationUUID`, `originalTransactionId → user_id` mapping, durable-write-then-200 — `apps/sync-server/src/routes/webhooks-apple.ts`
- [ ] T115 [US10] Purchase-attach endpoint: authenticated app posts transaction proof; server verifies with Apple, binds `apple_transactions` row to the account, recomputes entitlement, returns snapshot (≤ 1 min activation; contracts §5b) — `apps/sync-server/src/routes/iap-apple.ts`
- [ ] T116 [US10] Entitlement merge: `active(paddle) ∪ active(apple)`, later expiry governs, `source` records governing platform; additive `doubleSubscription` field in status when both active (contracts §5c) — `apps/sync-server/src/services/entitlements.ts`
- [ ] T117 [US10] Server tests: sandbox/production webhook fixtures, replay/out-of-order, unknown `originalTransactionId` (store-and-hold or reject-and-log — never guess an account), legacy-client response-shape unchanged — `apps/sync-server/src/routes/webhooks-apple.test.ts`
- [ ] T118 [US10] `expo-iap` integration + config plugin + product configuration; purchase, restore, subscription-status wiring — `apps/mobile/src/features/billing/iap.ts`
- [ ] T119 [US10] Paywall UI — calm, no dark patterns (Constitution IV); purchase + restore flows — `apps/mobile/app/(vault)/settings/subscription.tsx`
- [ ] T120 [US10] Double-subscription notice UI with guideline-safe wording from the T013 memo (informational, no external purchase link; FR-041) — `apps/mobile/src/features/billing/double-subscription-notice.tsx`
- [ ] T121 [US10] Entitlement-lapse-while-offline UX: data readable/exportable, queued changes handled per policy with a clear message, never silently dropped (spec edge case)
- [ ] T122 [P] [US10] Compliance artifacts: `ITSAppUsesNonExemptEncryption`, `PrivacyInfo.xcprivacy` + required-reason APIs in `apps/mobile/app.config.ts`; accurate App Privacy label draft (telemetry declared, not identity-linked — FR-043)
- [ ] T123 [US10] In-app account deletion UI over the existing `account-deletion` service (FR-042) — `apps/mobile/app/(vault)/settings/account.tsx`
- [ ] T124 [US10] **G5 evidence** (quickstart §Phase 5): sandbox purchase ≤ 1 min, ASSN sandbox drill, double-sub simulation notice, deletion flow against staging

**Checkpoint — G5**: sandbox purchase enables sync; billing honesty verified.

---

## Phase 14: Polish & Store Prep — Train Phases 6–7 (Gate **G6** → submission)

**Purpose**: Cross-cutting quality + review-ready build.

- [ ] T125 [P] Accessibility audit + fixes across all screens: WCAG AA contrast, VoiceOver labels on every interactive element, reduced-motion honored, RTL layout walk (FR-044, SC-011)
- [ ] T126 [P] App Privacy labels finalized in App Store Connect from the T122 draft
- [ ] T127 Performance re-verification on the release build: G2 <5 s and G3 <50 ms numbers re-measured on the reference device (Constitution V: regression blocks release)
- [ ] T128 [P] App Store Connect metadata, screenshots, reviewer notes + dedicated reviewer test vault (from the T013 memo)
- [ ] T129 External TestFlight build submitted and approved
- [ ] T130 [P] Docs: mobile section under `apps/docs/src/` + `pnpm docs:impact --base origin/main --strict` + `pnpm docs:build` green
- [ ] T131 Internal-ring beta feedback burn-down (7-day two-shell parallel use, zero divergence target — SC-007)
- [ ] T132 App Store submission + review-response buffer (R6 fallback from T013 armed)

**Checkpoint — G6**: archive validates with zero errors; external TestFlight approved; accessibility pass. Then submit.

---

## Dependencies & Execution Order

### Phase dependencies (train gates are SERIAL — constitution)

```
Setup/Phase 1 (G0) → Foundational/Phase 2 (G1) → US1/Phase 3 (G2) → US2/Phase 4 (G3)
  → Train Phase 4 = {US3, US4, US5, US6, US7, US9, US8, parity} (G4)
  → US10/Phase 13 (G5) → Polish/Phase 14 (G6 → submit)
```

A gate must be green **with evidence** before the next phase starts. G0 and G1
are never skipped (record §11).

### Story dependencies (within the train)

- **US1** ← Phases 1–2 only. **US2** ← US1 (vault, sync engine, adapters).
- **US4 (journal)** ← US2 (editor). **US3, US5, US6, US7, US9, parity** ← US1
  foundation + US2 write path (outbox) for their edit operations.
- **US8 (canvas)** ← US1 only (read-only). **US10** ← US1 + Foundational server
  kit; independent of Phase-4 stories.
- Within Train Phase 4, stories interleave freely for a solo developer;
  recommended order is as listed (US3 → US4 → US5 → US6 → US7 → US9 → US8),
  keeping the recorded cut order at the tail: **canvas viewer (US8) is cut
  first, reminders (T084–T086) second** — each cut is a written decision.

### Parallel opportunities

- Phase 1: T003, T004, T005 together after T001–T002; T009, T010, T011, T013 as
  independent spikes once the scaffold boots.
- Phase 2: server kit T027–T030 is fully parallel to extraction T015–T025
  (different apps).
- Phase 3: adapter tasks T037, T038, T039, T042 in parallel after T033; T034,
  T035 in parallel.
- Phase 13: server track (T113–T117) parallel to app track (T118–T121) after
  T113 lands.

## Implementation Strategy

- **MVP = Phase 1 → Phase 3 (US1)**: a read-only companion on the developer's
  own vault — standalone value, zero write risk. Validate G2 fully before any
  write code.
- **Write risk is staged**: the write path (US2) exists only behind a verified
  kill switch; the internal TestFlight ring opens after G3, external testers
  only at Phase 14. A mobile write bug syncs into desktop vaults — this ordering
  is the mitigation.
- **Incremental delivery**: each Train-Phase-4 story lands as an independently
  testable increment against the per-story Independent Test; G4 audits the sum.
- **Solo pacing**: ~26 weeks per the record; slip is absorbed by the recorded
  cut order, never by skipping gates.

## Notes

- **Accessibility is an acceptance criterion on every UI task, not a phase**: each screen/component task (T043–T044, T049–T050, T053, T064, T067–T073, T080–T084, T088, T091–T093, T096–T101, T104, T106, T119–T120, T123) ships with VoiceOver labels on interactive elements, WCAG AA contrast, logical/RTL-safe layout, and reduced-motion honored (Constitution IV). T125 is the final **audit**, not the first pass.
- [P] = different files, no dependency on an incomplete task.
- Every task's verification standard: Constitution's definition of done (lint,
  typecheck, tests, architecture/contract checks, docs where user-visible). No
  check-off without green evidence (Constitution III).
- Android follows iOS from the same codebase 4–8 weeks post-v1 (record §2) —
  out of this task list by decision.
