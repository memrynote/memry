# Tasks: Memry Mobile — Vault Parity Mobile App

**Input**: Design documents from `/specs/001-mobile-app/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Included where the constitution mandates them — crypto parity, and every
seam that can lose data (outbox, CRDT merge, offline-reconnect) against **real**
adapters (Constitution III). No blanket TDD elsewhere.

**Organization**: Phases map 1:1 onto the release train from the decision record
(plan.md §Release Train). **Train gates are serial** (Constitution: a phase does
not start until the prior gate is green with evidence) — this overrides the
generic "stories in parallel" pattern: parallelism ([P]) exists *within* phases
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

- [ ] T001 Scaffold `apps/mobile`: Expo SDK 57 (pin ≥ 57.0.9), dev client + `expo prebuild` (iOS 17 target), Hermes, expo-router skeleton — `apps/mobile/package.json`, `apps/mobile/app.config.ts`, `apps/mobile/app/_layout.tsx`
- [ ] T002 Configure Metro for the pnpm monorepo (workspace deps, package-exports resolution) and add `@memry/contracts` as a raw `./src/*.ts` workspace dep — `apps/mobile/metro.config.js`
- [X] T003 [P] Add mobile reachability rule to `scripts/check-architecture-boundaries.js`: fail on any node builtin or `electron` import reachable from `apps/mobile`; prove red with a planted `node:fs` import, then green
- [ ] T004 [P] Create `.github/workflows/mobile-ci.yml` (lint, `tsc -p apps/mobile`, Vitest for RN logic, boundary check) and exclude `apps/mobile` from root turbo `typecheck`/`test` filters (temporary — removed by T031) — `turbo.json`, root `package.json` filters
- [X] T005 [P] Crypto vector generator + desktop proof suite: emit `packages/contracts/test-vectors/crypto-vectors.json` covering every record-§6 primitive (Argon2id 64 MiB/ops 3 per `packages/contracts/src/crypto.ts:28`, XChaCha20-Poly1305, Ed25519 seed/detached, kdf_derive_from_key, generichash keyed+length, auth, scalarmult, box_keypair, full vault-unlock flow); Vitest proves it against Node libsodium — `packages/contracts/scripts/gen-crypto-vectors.ts`, `packages/contracts/src/__tests__/crypto-vectors.test.ts`
- [ ] T006 R1 spike: integrate `react-native-libsodium` v1.7.x + Expo config plugin in `apps/mobile` (research.md §B5/§C-R1)
- [ ] T007 R1 spike: expose `crypto_scalarmult` (known gap; full libsodium is linked) via `patch-package` or upstream PR — `patches/react-native-libsodium+1.7.x.patch`
- [ ] T008 R1 gate check: on-device harness runs all of `crypto-vectors.json`; **PASS = byte parity on every vector** (G0-a; fail ⇒ research.md §R1 fallback ladder, train stops) — `apps/mobile/src/crypto/__harness__/vector-parity.ts`
- [ ] T009 [P] R2 gate check: benchmark app runs the research.md §R2 protocol (bulk insert, point reads, FTS5, Yjs append/replay, cold open) on both drivers on the reference device, release build; record table + decision in research.md §R2 (G0-c) — `apps/mobile/src/db/__bench__/driver-bench.ts`
- [ ] T010 [P] R3 gate check: Metro bundles `@memry/contracts` + a pure `app-core` slice from raw TS source; release-mode boot on device; desktop dev + landing dev + root typecheck unaffected (G0-b; fail ⇒ research.md §R3 mitigation ladder)
- [ ] T011 [P] R4 gate check: bridge throughput rig — minimal WebView, envelope per [contracts/webview-bridge.md](./contracts/webview-bridge.md), 50 KB doc, 10 keystrokes/s × 60 s, release build; record p95s + envelope counters, tune `T_flush`/`B_max` into the contract (G0-d) — `apps/mobile/src/editor/__rig__/bridge-throughput.tsx`
- [ ] T012 Implement the mobile crypto module over the parity-proven binding, matching the `@memry/contracts` crypto surface — `apps/mobile/src/crypto/libsodium.ts`
- [X] T013 [P] R6 desk spike: Apple review compliance memo (guidelines 3.1.x mapping, double-subscription notice wording, fallback plan) — `specs/001-mobile-app/apple-review-memo.md`
- [ ] T014 **G0 gate demo**: device signs in to staging, pulls one desktop-created encrypted note, decrypts via T012, plaintext markdown SHA-256 equals desktop's; attach evidence bundle (CI links, parity output, benchmark table, hashes) to the Phase 0 issue — evidence names the pinned reference device (quickstart §Prerequisites), which all later perf gates reuse

**Checkpoint — G0**: all five G0 checks green with evidence. Train may proceed.

---

## Phase 2: Foundational — Train Phase 1 extraction + server safety kit (Gate **G1**)

**Purpose**: `@memry/sync-client` lands **before** mobile consumes it, desktop
green in the same change (Constitution I). Server-side production-safety kit is
additive and precedes any mobile write exposure. Verification: quickstart §Phase 1.

### Extraction

- [ ] T015 Seam inventory: scan `apps/desktop/src/main/sync/` (314 files) + `packages/app-core` (18 node-touching) + `packages/storage-vault` (1); map every hit to one of the 10 seams (e.g. `network.ts` → http-client/runtime, `crdt-pending-notes.ts` → crdt-persistence); zero unassigned — `packages/sync-client/docs/seam-inventory.md`
- [ ] T016 Scaffold `packages/sync-client` (package.json with raw `./src` exports matching workspace conventions, tsconfig, turbo wiring) — `packages/sync-client/package.json`
- [ ] T017 Define the 10 adapter interfaces exactly per [contracts/platform-adapters.md](./contracts/platform-adapters.md) — platform-free types only — `packages/sync-client/src/adapters/*.ts`
- [ ] T018 Move platform-free sync engine files (item-handlers registry, outbox logic, vector clocks, protocol client) into `packages/sync-client/src/` as import-path-only diffs, one seam per commit
- [ ] T019 Move CRDT merge/pending logic behind the `CrdtPersistence` + `CrdtProvider` seams — `packages/sync-client/src/crdt/`
- [ ] T020 Desktop adapter implementations (electron/node imports allowed **only** here) — `apps/desktop/src/main/sync/adapters/*.ts`
- [ ] T021 App-core split: move the 18 node-touching files behind seams or into desktop; pure domain stays importable by mobile — `packages/app-core/src/`
- [ ] T022 Migrate sync test suites with their code; desktop suites pass unchanged (assertion changes require written justification in the PR)
- [ ] T023 Adapter conformance suite runnable against any implementation (desktop under node now; mobile later) — real adapters, not mocks — `packages/sync-client/src/adapters/__tests__/conformance.ts`
- [ ] T024 Boundary check walks real `apps/mobile` → `@memry/sync-client` reachability; green with the spike app importing the package
- [ ] T025 Targeted desktop E2E smoke on the extraction branch: sync push/pull, offline reconnect, CRDT merge specs only
- [ ] T026 [P] Docs impact for the extraction (`pnpm docs:impact --base origin/main --strict` + updates under `apps/docs/src/`)

### Server production-safety kit (additive; contracts/sync-protocol-additions.md §1–4)

- [ ] T027 [P] D1 migration `apps/sync-server/migrations/0006_client_gate.sql`: `client_policies` table + write-attribution columns (`client_platform`, `client_version`, nullable) per [data-model.md](./data-model.md) §3b–3c; hand-verified against production-shaped rows
- [ ] T028 [P] Client-gate middleware: parse `x-memry-client` (malformed ⇒ treated absent, logged), enforce min-version (426 `CLIENT_UPGRADE_REQUIRED`) and kill switch (403 `PLATFORM_WRITES_DISABLED`) on writes only; reads never gated — `apps/sync-server/src/middleware/client-gate.ts` + `client-gate.test.ts`
- [ ] T029 [P] Stamp attribution columns on every item-write path from the header — `apps/sync-server/src/routes/` write handlers + tests
- [ ] T030 [P] Embed platform policy in the account/status response so clients learn of a flipped switch without attempting a write — `apps/sync-server/src/routes/` + additive response field tests
- [ ] T031 Backward-compat suite: header-less (legacy desktop) requests behave byte-for-byte as today across all touched endpoints — `apps/sync-server/src/__tests__/legacy-client-compat.test.ts`
- [ ] T032 Remove the temporary `apps/mobile` exclusion from root turbo filters; root `pnpm typecheck && pnpm test` green with mobile included; `mobile-ci.yml` keeps device-specific jobs only (plan T1.9)

**Checkpoint — G1**: full quickstart §Phase 1 command list green; extraction PRs show mechanical diffs; desktop behaviour unchanged.

---

## Phase 3: User Story 1 — Open Your Vault on Your Phone (P1) 🎯 MVP — Train Phase 2 (Gate **G2**)

**Goal**: Existing user signs in, unlocks with password or recovery phrase,
browses their real vault read-only; production-safety kit verified end-to-end.

**Independent Test** (spec US1): on a phone that has never seen a real
desktop-created vault, sign in, unlock via password and separately via recovery
phrase, browse recent content. Standalone value: read-only companion.

- [ ] T033 [US1] Mobile DB module: chosen driver (per R2 decision), open-per-vault, migration runner, ledger `0001_baseline.sql` (meta, sync_items, folders, note_bodies, sync_cursors, yjs_updates, yjs_snapshots, outbox, attachments per data-model.md §1; `NSFileProtectionCompleteUntilFirstUserAuthentication`; DB and attachment files live under Application Support — non-evictable storage, never Caches, so unsynced writes survive OS cache eviction) — `apps/mobile/src/db/index.ts`, `apps/mobile/src/db/migrations/0001_baseline.sql`
- [ ] T034 [P] [US1] SQLite-backed `NoteContentStore` implementing the existing interface over `note_bodies` (raw markdown incl. frontmatter) — `apps/mobile/src/db/note-content-store.ts`
- [ ] T035 [P] [US1] Secure-store module with the data-model §2 key map (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, never logged) — `apps/mobile/src/lib/secure-store.ts`
- [ ] T036 [US1] `SyncHttpClient` adapter: fetch + NetInfo online signal + `isMetered` — `apps/mobile/src/adapters/http-client.ts`
- [ ] T037 [P] [US1] `CertificatePinning` explicit no-op adapter (`isEnforced() → false`, documented decision) — `apps/mobile/src/adapters/certificate-pinning.ts`
- [ ] T038 [P] [US1] `Runtime` adapter: app version, platform, foreground/background hooks, project logger seam — `apps/mobile/src/adapters/runtime.ts`
- [ ] T039 [P] [US1] `VaultDirectory` + `CrdtStorePath` adapters over the app sandbox (per-vault roots, provision path must not dead-end on a new device) — `apps/mobile/src/adapters/vault-directory.ts`, `apps/mobile/src/adapters/crdt-store-path.ts`
- [ ] T040 [US1] `DeviceRegistration` adapter backed by secure-store Ed25519 keypair — `apps/mobile/src/adapters/device-registration.ts`
- [ ] T041 [US1] `CrdtPersistence` adapter over `yjs_updates`/`yjs_snapshots` (append durable before resolve; compaction) — `apps/mobile/src/adapters/crdt-persistence.ts`
- [ ] T042 [P] [US1] `CrdtPreflight` adapter (`PRAGMA quick_check` + schema-version assert) — `apps/mobile/src/adapters/crdt-preflight.ts`
- [ ] T043 [US1] Auth screens: sign-in, vault picker (multi-vault, FR-004) — `apps/mobile/app/(auth)/sign-in.tsx`, `apps/mobile/app/(auth)/vaults.tsx`
- [ ] T044 [US1] Vault unlock: password path (Argon2id → KDF contexts → verifier → AEAD) and recovery-phrase path, wrong-password error with nothing partially unlocked — `apps/mobile/app/(auth)/unlock.tsx`, `apps/mobile/src/lib/vault-unlock.ts`
- [ ] T045 [US1] Wire `@memry/sync-client` pull pipeline with the mobile adapters (pull-only engine start) — `apps/mobile/src/sync/engine.ts`
- [ ] T046 [US1] Inject `x-memry-client: ios/<semver>+<build>` on every request via the engine/http adapter (contracts §1)
- [ ] T047 [US1] Windowed first sync: metadata for all 12 types + last-30-day bodies, per-scope cursors, determinate progress UI, app usable during (FR-008) — `apps/mobile/src/sync/first-sync.ts`, `apps/mobile/src/features/sync/progress.tsx`
- [ ] T048 [US1] On-demand body fetch (`payload_state: metadata-only → full`) on note open — `apps/mobile/src/sync/body-fetch.ts`
- [ ] T049 [US1] Notes browse UI: folder tree + note list (read-only) — `apps/mobile/app/(vault)/notes/index.tsx`
- [ ] T050 [US1] Read-only note body preview (plain markdown render; placeholder until the Phase 4 editor replaces it) — `apps/mobile/app/(vault)/notes/[id].tsx`
- [ ] T051 [US1] Read-only mode client behaviour: react to 426/403/status policy — explicit banner + plain explanation + update path, outbox parked never dropped, auto-resume on clear (FR-010) — `apps/mobile/src/sync/read-only-mode.ts`
- [ ] T052 [US1] Foreground sync triggers + `expo-background-task` registration (BGAppRefreshTask; resumable, interruptible) — `apps/mobile/src/sync/background.ts`
- [ ] T053 [P] [US1] Sync/degraded-state UI using desktop's vocabulary (offline, syncing, locked, read-only) — `apps/mobile/src/features/sync/status.tsx`
- [ ] T054 [US1] Seam tests on real adapters: pull pipeline → SQLite rows → NoteContentStore round-trip; conformance suite (T023) green against the mobile adapters — `apps/mobile/src/sync/__tests__/pull-pipeline.test.ts`
- [ ] T055 [P] [US1] Maestro smoke flow: sign-in → unlock → browse → open note — `apps/mobile/.maestro/us1-unlock-browse.yaml`
- [ ] T056 [US1] **G2 drills + evidence** (quickstart §Phase 2): 20-trial <5 s visibility (desktop→phone), kill-switch drill (staging flip → read-only without restart → drain on re-enable), version-gate drill, attribution query on staging D1, and SC-004 measurement — 10,000-item staging vault over Wi-Fi: recent content browsable within 2 min of unlocking on the reference device

**Checkpoint — G2**: all four drills green. This is the MVP: a trustworthy read-only companion on the developer's own device.

---

## Phase 4: User Story 2 — Edit Notes Anywhere, Offline First (P1) — Train Phase 3 (Gate **G3**)

**Goal**: Full-richness note editing via the WebView BlockNote editor over an
RN-owned Y.Doc; durable offline writes; convergence with desktop.

**Independent Test** (spec US2): with sync suspended, edit + create notes;
force-quit; relaunch; reconnect; all edits appear on desktop intact; a
concurrent desktop edit to the same note merges without loss.

- [ ] T057 [US2] `editor-web` bundle: BlockNote + `@memry/editor-schema` built to a self-contained local HTML asset (no network at open) — `apps/mobile/editor-web/` (vite config, `src/main.tsx`)
- [ ] T058 [US2] Bridge contract types + generation for both sides per [contracts/webview-bridge.md](./contracts/webview-bridge.md) (envelope v1, all message types; `ipc:check`-style drift gate in mobile-ci) — `packages/contracts/src/webview-bridge.ts`, generation script
- [ ] T059 [US2] RN-side bridge provider: batching (`T_flush`/`B_max` from R4), `seq` gap detection → resync, `sid` origin tagging — `apps/mobile/src/editor/bridge-provider.ts`
- [ ] T060 [US2] WebView-side bridge counterpart: batching, base64 framing, `ready` handshake, zero web-storage persistence — `apps/mobile/editor-web/src/bridge.ts`
- [ ] T061 [US2] RN-side Y.Doc ownership: doc manager wiring `CrdtProvider` host ↔ bridge transport ↔ `CrdtPersistence` — `apps/mobile/src/editor/doc-manager.ts`
- [ ] T062 [US2] Durability rule: every WebView-originated update written to SQLite **before** ack into the outbox pipeline; WebView process-death recovery (re-create + `doc-load` replay) with test — `apps/mobile/src/editor/__tests__/durability.test.ts`
- [ ] T063 [US2] Outbox drain worker: push queue → server, backoff, park/resume on read-only signals; note create/rename/move/delete + folder ops enqueued — `apps/mobile/src/sync/outbox.ts`
- [ ] T064 [US2] Editor screen replaces the T050 preview: WebView host, `cfg` (theme/locale/RTL/reduced-motion/readOnly), keyboard handling; plus note-management UI — create, rename, move-to-folder, delete (wired to the T063 enqueued ops; FR-012) — `apps/mobile/app/(vault)/notes/[id].tsx`, `apps/mobile/src/editor/editor-view.tsx`, `apps/mobile/src/features/notes/manage.tsx`
- [ ] T065 [US2] Seam tests (real adapters, scripted against staging or local sync-server): (a) concurrent desktop+mobile edits to the same note converge with neither side lost; (b) **delete-vs-edit tombstone**: note deleted on one device while edited on the other resolves deterministically and identically on both shells (constitution III mandated seam); (c) **unknown-field round-trip**: a newer-desktop payload fixture survives a mobile edit cycle with unknown fields unstripped — `apps/mobile/src/sync/__tests__/convergence.test.ts`
- [ ] T066 [US2] Offline matrix automation: airplane-mode edit + create → force-quit → relaunch → reconnect → complete sync; ≥ 20 scripted runs, 100% pass — `apps/mobile/.maestro/us2-offline-matrix.yaml` + driver script
- [ ] T067 [US2] Wiki-links: alias rendering, tap navigation (incl. heading targets) via `nav` bridge msg, autocomplete via `wiki-query`/`wiki-candidates` (FR-014) — editor-web plugin + `apps/mobile/src/editor/wiki-links.ts`
- [ ] T068 [P] [US2] Tags view/add/remove with desktop's case-preserving semantics (FR-015) — `apps/mobile/src/features/notes/tags.tsx`
- [ ] T069 [P] [US2] Note properties view/edit with desktop type semantics (FR-016) — `apps/mobile/src/features/notes/properties.tsx`
- [ ] T070 [P] [US2] Create note from template (FR-017) — `apps/mobile/src/features/notes/from-template.ts`
- [ ] T071 [US2] Undo/redo within session via `exec` bridge command (FR-018)
- [ ] T072 [US2] `AttachmentStore` adapter (sandbox files, NSFileProtection) + lazy download honoring Wi-Fi-only default + per-item override + placeholder-with-fetch-action UX; late-arriving attachment becomes visible without recreating the note — `apps/mobile/src/adapters/attachments.ts`, `apps/mobile/src/features/attachments/`
- [ ] T073 [US2] Insert images/attachments from photo picker/files into a note (upload path through outbox) — `apps/mobile/src/features/attachments/insert.ts`
- [ ] T074 [US2] Keystroke-latency instrumentation + G3 measurement on the 50 KB staging note, release build, reference device — `apps/mobile/src/editor/__rig__/latency.ts`
- [ ] T075 [P] [US2] Bridge envelope/message counters exposed in dev builds (batching proof for G3)
- [ ] T076 [US2] Background-transition flush: `exec:flush` + outbox drain on `onBackground`
- [ ] T077 [US2] **G3 evidence bundle** (quickstart §Phase 3) → then open internal TestFlight ring (5–10 real vaults) — only with the G2 kill switch verified live

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
- [ ] T084 [US3] Reminders: schedule local notifications from synced data (expo-notifications), `reminders_local` bookkeeping, tap opens item (FR-023) — `apps/mobile/src/features/reminders/scheduler.ts` *(record cut order: reminders are the second-to-last cut)*
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
