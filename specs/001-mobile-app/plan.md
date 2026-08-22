# Implementation Plan: Memry Mobile — Vault Parity Mobile App

**Branch**: `001-mobile-app` | **Date**: 2026-08-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-mobile-app/spec.md`

**Authoritative inputs, in precedence order**:

1. `.specify/memory/constitution.md` (v1.0.0)
2. `docs/ideas/2026-08-22-mobile-expo-plan.md` — **decision record; every entry is settled and carried into this plan unchanged**
3. `specs/001-mobile-app/spec.md`

No conflict was found between the three documents (they were authored together on
2026-08-22). Where the codebase has drifted from a *count* stated in the decision
record, the decision stands and the count is re-measured at execution time — see
"Decision Record Fidelity" below.

## Summary

Ship Memry on iOS as a second shell over the same E2E-encrypted vault and the same
sync server that live desktop users write to today. Vault parity, not desktop-tool
parity: all 12 synced item types reachable; Agent Chat, importers, semantic search,
and canvas *editing* are explicitly out (canvas is read-only, FTS stays).

Technical approach, per the decision record: Expo (managed + dev client, prebuild)
in `apps/mobile`; native RN UI everywhere except the note body, which is a WebView
hosting BlockNote driven by an RN-owned Y.Doc over a batched, string-only,
base64-framed bridge; SQLite as the store of record (notes as raw markdown incl.
frontmatter, byte-identical to desktop; attachments as `NSFileProtection` sandbox
files; Yjs persistence and the sync outbox in SQLite); a JSI libsodium binding with
byte parity against desktop crypto vectors as a hard gate; `@memry/sync-client`
extracted from desktop **before** any mobile feature code, with 10 platform-adapter
seams; StoreKit 2 IAP with an additive entitlement merge; and the production-safety
kit (client header, min-version table, per-platform write kill switch, attributable
writes) shipped in the shell phase, not at the end.

Delivery is an 8-phase release train (~26 weeks, solo) with serial, verifiable
gates. Phases 0 and 1 are specified to task level below and are not skippable.

## Technical Context

**Language/Version**: TypeScript 5.x; React Native via Expo (managed workflow +
dev client, `expo prebuild`); Hermes engine; React 19.

**Primary Dependencies**:

- Expo SDK (dev client, prebuild, expo-router assumed for navigation)
- JSI libsodium binding — candidate selection in [research.md](./research.md) (R1);
  `libsodium-wrappers-sumo` is WASM and will not run under Hermes
- SQLite driver — `expo-sqlite` vs `op-sqlite`, decided by benchmark in
  research.md (R2); **no `sqlite-vec`** on mobile
- Yjs (RN-side Y.Doc ownership; SQLite-backed persistence adapter replacing
  `y-leveldb`)
- `react-native-webview` hosting BlockNote via `@memry/editor-schema` (single
  source of truth for the schema)
- `expo-secure-store` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) for keys
- StoreKit 2 IAP client library (R8); App Store Server Notifications V2 handler
  on the sync server (Cloudflare Workers)
- Shared workspace packages: `@memry/contracts`, `@memry/app-core` (split),
  `@memry/editor-schema`, `@memry/sync-core`, and the new `@memry/sync-client`

**Storage**: SQLite is the note store (a SQLite-backed `NoteContentStore`
implements the existing interface — **no files for notes**). Note bodies are raw
markdown including frontmatter, byte-identical to desktop, so `app-core` parsing
works unchanged. Attachment bytes are sandbox files with `NSFileProtection`, never
DB blobs. Yjs update log and the sync outbox are persisted in SQLite (in-memory
outbox loses writes when iOS kills the app). Keys live only in the secure store.

**Testing**: Vitest for shared packages and RN logic; device E2E framework decided
in research.md (R5: Maestro vs Detox); a crypto vector-parity suite that runs the
same committed fixtures on desktop (Node libsodium) and on-device (JSI binding) —
byte parity is a hard gate. Sync-seam tests run against the real SQLite adapter,
not mocks (Constitution III).

**Target Platform**: iOS 17+ first. Android from the same codebase 4–8 weeks
later, serialized QA. All requirements apply to both.

**Project Type**: Mobile app in the existing pnpm/turbo monorepo at `apps/mobile`,
plus extraction of `@memry/sync-client` into `packages/`, plus additive sync-server
changes.

**Performance Goals** (Constitution V — release gates, measured on real mid-tier
hardware):

- < 50 ms keystroke-to-visible-character on a 50 KB note through the WebView bridge
- A desktop write visible on the phone in < 5 s on a healthy network (both directions)
- New-device first sync: browsable recent content within 2 min on a 10k-item vault
  over Wi-Fi; app open never blocked on network

**Constraints**: Offline-first (every editable capability works fully offline;
durable across force-quit and restart). First sync pulls metadata + last 30 days of
bodies, the rest on demand. Attachments lazy, Wi-Fi-only by default with per-item
override. Bridge traffic batched on **both** ends (launch requirement, not an
optimization). No cert pinning on mobile; no Face ID gate in v1. Background sync =
foreground + `BGAppRefreshTask`; silent push is v2. Reminders via local
notifications from already-synced data.

**Scale/Scope**: Solo developer, ~26 weeks including IAP. Existing production
vaults (tens of thousands of items) must open unmodified. 12 synced item types.
~46 functional requirements in spec.md.

**Unknowns → research.md**: R1 (libsodium binding), R2 (SQLite driver),
R3 (Metro under pnpm), R4 (bridge throughput), R5 (E2E framework),
R6 (Apple review of double subscription), R7 (BGAppRefreshTask envelope),
R8 (StoreKit client + ASSN V2 verification on Workers). R1–R4 are the decision
record's four open risks; each has an explicit Phase 0 spike and a pass/fail gate
(non-negotiable #4).

## Constitution Check

*GATE: evaluated before Phase 0 research; re-evaluated after design (see
"Post-Design Re-check" at the end of this section).*

| # | Principle / section | How this plan complies | Where enforced |
|---|---|---|---|
| I | Shared Core, Platform Adapters (NON-NEGOTIABLE) | `@memry/sync-client` extracted **before** mobile feature code (Train Phase 1), desktop behaviour unchanged; the 10 electron-touching seams go behind adapter interfaces ([contracts/platform-adapters.md](./contracts/platform-adapters.md)); no logic forks — mobile implements adapters. Vault bytes are the contract: markdown incl. frontmatter byte-identical; crypto vectors byte-identical. | `scripts/check-architecture-boundaries.js` gains the rule *nothing reachable from `apps/mobile` imports a node builtin or `electron`* (Train Phase 0, T0.2); desktop suites green in the extraction change itself |
| II | Code Quality Is A Gate | `mobile-ci.yml` runs lint + typecheck + tests + boundary + contract checks from Train Phase 0 onward; RN↔WebView bridge is a typed, versioned, generated contract ([contracts/webview-bridge.md](./contracts/webview-bridge.md)) — no hand-written `any` at the boundary; project logger + shared error extractor reused; RTL-safe layout from the first screen | CI required checks on `apps/mobile` PRs; `ipc:check`-style generated bridge types |
| III | Test The Seam That Can Lose Data (NON-NEGOTIABLE) | Crypto parity is the Train Phase 0 **gate** — no feature work before byte parity. Outbox persistence, CRDT merge, delete/tombstone, offline-then-reconnect tested against the **real** SQLite adapters. Beta on real vaults opens only after the Phase 3 gate and only with the Phase 2 kill switch live. | Vector-parity suite in CI (desktop + device); Train gate table below; beta precondition encoded in Phase 3/6 gates |
| IV | One Product, Two Shells | Native platform navigation; note body shares `@memry/editor-schema` so semantics match; every absent/read-only capability says so in the UI (canvas viewer labeled view-only; read-only mode has explicit UX); same degraded-state vocabulary as desktop | Spec FR-045/FR-046; out-of-scope table in spec.md |
| V | Performance Is A Budget With Numbers | The three numeric budgets above are phase **gates** (Phases 2, 3), measured on real hardware; bridge batching on both ends is a launch requirement; startup never network-gated; 30-day body window; lazy Wi-Fi-first attachments; no unbounded body caches; no background polling loops | Gate table below; R4 spike measures the bridge before the editor is built |
| — | Mobile Platform Constraints | SQLite store of record; outbox + CRDT state persisted; RN owns the Y.Doc (WebView-owned state rejected — record §4); keys in secure store only; production protection ships in Train Phase 2; store compliance is a Phase 5 deliverable; double subscription detected and surfaced (FR-041); every fallback recorded in spec.md Out-of-Scope | data-model.md §mobile DB; contracts/sync-protocol-additions.md |
| — | Development Workflow & Quality Gates | Serial phase gates with evidence; risk retired first (Phase 0 spikes); desktop stays green in every shared-code change; mobile CI exclusion is temporary and its removal is tracked work (T1.9); scope cuts are written decisions (canvas read-only viewer + reminders cut first, already recorded) | Release train below |

**Pre-research gate result: PASS — no violations, Complexity Tracking empty.**

## Decision Record Fidelity

Every decision in `docs/ideas/2026-08-22-mobile-expo-plan.md` is carried unchanged.
Re-verification against the codebase (2026-08-22) found **count drift only — no
decision conflicts**:

| Record says | Measured today | Disposition |
|---|---|---|
| 227 sync files, 10 touch electron | 314 files under `apps/desktop/src/main/sync/`; **11** direct `electron` importers — the record's 10 plus `network.ts`; `crdt-pending-notes.ts` also imports electron; `crdt-persistence` matched no direct-import grep (indirect) | The **decision** (electron-touching code goes behind platform adapters) stands. The named 10 seams remain the adapter interface list; the seam inventory is re-measured empirically as Phase 1 task T1.1, and any additional electron-touching file is assigned to one of the 10 seams (e.g. `network.ts` → `http-client`/`runtime`) rather than growing the seam list without cause. |
| `@memry/app-core` has 12 node-builtin files | 18 files under `packages/app-core/src` import `node:` builtins | Same disposition: the split decision stands; the file list is T1.1 output. `storage-vault` measured 1 node-touching file — matches the record. |
| "Entitlement row **gains** `source: 'paddle' \| 'apple'`" | `sync_entitlements.source` already exists (TEXT) with values `'none' \| 'paddle' \| 'admin_override' \| 'dev_seed'`; single row per user; D1 migrations at 0005 | Decision realized as: extend the `source` union with `'apple'` (TypeScript-only; column is TEXT — zero DDL) **plus** an additive `apple_transactions` mapping table, which the record independently requires (`originalTransactionId` → account). Later-expiry-wins and double-subscription detection need both platforms' states, hence the mapping table. Fully additive; detailed in [data-model.md](./data-model.md). |
| Production certificate pins are `PLACEHOLDER_...` | Confirmed pre-existing | Out of this plan's scope, tracked as its own issue (record §7 / open risk 5). Mobile ships without pinning **by decision** — do not "fix" this inside mobile work. |

## Project Structure

### Documentation (this feature)

```text
specs/001-mobile-app/
├── plan.md              # This file
├── research.md          # Phase 0 output — settled decisions + spike specs R1–R8
├── data-model.md        # Phase 1 output — mobile SQLite schema, secure-store map,
│                        #   additive server migrations
├── quickstart.md        # Phase 1 output — gate-verification runbook
├── contracts/
│   ├── platform-adapters.md        # the 10 @memry/sync-client seams
│   ├── webview-bridge.md           # RN↔WebView editor bridge protocol
│   └── sync-protocol-additions.md  # client header, version gate, kill switch,
│                                   #   write attribution, ASSN V2, entitlement merge
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
apps/mobile/                       # NEW — Expo app (iOS first)
├── app/                           # expo-router routes
│   ├── (auth)/                    #   sign-in, vault pick, unlock (password | recovery phrase)
│   └── (vault)/                   #   home, notes, note/[id], tasks, journal, calendar,
│                                  #   inbox, canvas/[id], search, settings
├── src/
│   ├── adapters/                  # mobile implementations of the 10 sync-client seams
│   ├── crypto/                    # JSI libsodium wrapper implementing the contracts crypto surface
│   ├── db/                        # SQLite open/migrate + hand-written migrations (mobile ledger 0001…)
│   ├── editor/                    # WebView host, RN-side bridge provider (Y.Doc owner)
│   ├── sync/                      # engine wiring, outbox drain, BGAppRefreshTask registration
│   ├── features/                  # native UI per feature area
│   └── lib/
├── editor-web/                    # BlockNote bundle built to a self-contained HTML asset
├── ios/                           # prebuild output (generated; committed per Expo dev-client practice)
├── app.config.ts / metro.config.js / package.json

packages/sync-client/              # NEW — extracted from apps/desktop/src/main/sync
├── src/
│   ├── adapters/                  # the 10 seam interfaces (platform-free types only)
│   ├── item-handlers/             # per-type sync handlers (moved, platform-free)
│   └── …                          # remaining platform-free sync engine files

packages/app-core/                 # SPLIT — pure domain stays; node-touching files
                                   # move behind adapters or into desktop
apps/desktop/src/main/sync/        # SHRINKS to desktop adapter implementations + wiring

apps/sync-server/
├── migrations/0006…+              # additive: client_policies, apple_transactions,
│                                  #   write-attribution columns
└── src/routes/webhooks-apple.ts   # ASSN V2 (JWS verification)

scripts/check-architecture-boundaries.js   # + mobile reachability rule
.github/workflows/mobile-ci.yml            # NEW — mobile lint/typecheck/test/boundary
```

**Structure Decision**: mobile app in the monorepo at `apps/mobile` (record §3);
sync engine extracted to `packages/sync-client` **before** mobile consumes it
(record §7, Constitution I); server-side changes are additive migrations in the
existing `apps/sync-server` (record §§9–10). Desktop keeps only adapter
implementations and wiring under `apps/desktop/src/main/sync/`.

## Release Train

Carried from the decision record §11 verbatim (weeks, work, order). Each gate is
restated as a **verifiable check** — a command, a measurement on named hardware, or
an observable server behaviour, with evidence attached before the next phase
starts. Serial; a red gate stops the train. If schedule slips, the tail of Phase 4
(canvas read-only, reminders) is cut first — a written decision when it happens.
Phases 0 and 1 are not skippable.

Full checklists for Phases 0–1 follow the table; Phases 2–7 are enumerated at
milestone level and get task-level breakdown in tasks.md.

| Phase | Weeks | Work | Gate (verifiable check) |
|---|---|---|---|
| 0 | 1–2 | Spike: fetch and decrypt one note on device; retire risks R1–R4 | **G0** — all of: (a) vector-parity suite green on device: every fixture in `crypto-vectors.json` reproduced byte-for-byte by the JSI binding (R1 PASS); (b) Metro resolves and bundles `@memry/contracts` + app-core raw `./src/*.ts` imports; app boots on device (R3 PASS); (c) SQLite benchmark meets thresholds and driver is chosen in research.md (R2 PASS); (d) bridge throughput rig sustains typing-burst load on a 50 KB doc under budget (R4 PASS); (e) end-to-end demo: sign in on device, pull one desktop-created encrypted note, decrypt, plaintext markdown SHA-256 equals desktop's |
| 1 | 3–6 | `@memry/sync-client` extraction; app-core split | **G1** — in the extraction PR(s): `pnpm lint && pnpm typecheck && pnpm test && pnpm test:desktop && pnpm check:architecture && pnpm check:contracts` all green; desktop E2E smoke green; zero behaviour diffs (same test suites, no snapshot churn beyond import paths); boundary script proves `apps/mobile` reachability contains no node builtin / electron; root-filter exclusion removal for `apps/mobile` merged (T1.9) |
| 2 | 7–10 | Shell: auth, keys, SQLite store + migrations ledger, sync engine on mobile adapters, read-only note list/detail, **production-safety kit** (x-memry-client header, server min-version table, per-platform write kill switch, server-side write marking) | **G2** — (a) desktop write visible on phone in **< 5 s** (median over 20 trials, healthy network, both a note-body and a metadata change); (b) kill-switch drill: flipping the server config drops the device to explicit read-only without restart, reads keep working, queued writes preserved; (c) below-min-version drill: server rejects writes from a stale client version with the read-only signal; (d) server rows show platform/version attribution for every mobile-originated write |
| 3 | 11–15 | Editor WebView + CRDT bridge + batching; offline write path; outbox drain | **G3** — (a) offline matrix green: airplane-mode edits + force-quit + relaunch + reconnect sync completely, 100% of runs (scripted, ≥ 20 runs); (b) concurrent desktop+mobile edit to the same note converges with neither side lost; (c) **< 50 ms** keystroke-to-render p95 on a 50 KB note on the reference mid-tier device; (d) bridge message counters prove batching (no per-keystroke crossings). Internal TestFlight ring (5–10, real vaults) may open **only after** G3 **and** with the G2 kill switch verified live |
| 4 | 16–19 | Tasks, journal, calendar, inbox, bookmarks, filters, settings apply, FTS search, canvas read-only, reminders | **G4** — all 12 synced types readable on device from a real production-format vault (audit checklist per type); FTS returns ranked offline results over notes/journals/tasks/inbox; reminder fires with app closed; canvas byte-identical after viewing (hash before/after) |
| 5 | 20–22 | StoreKit 2 IAP, ASSN V2 endpoint, entitlement merge (`source:'apple'`), paywall, double-subscription UI, privacy/export declarations, in-app account deletion UI | **G5** — sandbox purchase activates sync entitlement ≤ 1 min without manual steps; ASSN V2 sandbox notification updates the entitlement; simulated Paddle+Apple double-active account surfaces the notice on next open; `ITSAppUsesNonExemptEncryption` + `PrivacyInfo.xcprivacy` + accurate privacy labels drafted and lint-clean; account deletion completes in-app against staging |
| 6 | 23–25 | App Store prep, TestFlight external build, review dry-run | **G6** — review-ready build: archive validates in App Store Connect with zero errors; all declarations attached; external TestFlight approved; accessibility audit pass (WCAG AA contrast, screen-reader labels, reduced-motion, RTL) |
| 7 | 26 | Submission + buffer | — (submission outcome; R6 fallback plan armed) |

### Phase 0 — Spike (weeks 1–2) — start-ready checklist

Goal: retire the four open risks and prove the vault opens. Everything here is
throwaway-tolerant except the fixtures, the boundary rule, and CI.

- **T0.1** Scaffold `apps/mobile`: Expo + dev client + `expo prebuild` (iOS 17
  target), Hermes, expo-router skeleton, workspace deps on `@memry/contracts`
  (raw `./src/*.ts`). Commit `metro.config.js` for the pnpm monorepo (R3 findings
  live here). *Check*: `pnpm --filter @memry/mobile ios` boots on a physical
  device.
- **T0.2** Boundary rule: extend `scripts/check-architecture-boundaries.js` —
  build the import graph reachable from `apps/mobile` and fail on any node
  builtin or `electron`. *Check*: rule red when a node import is planted,
  green after removal.
- **T0.3** `mobile-ci.yml`: lint, `tsc` for `apps/mobile`, Vitest (RN logic),
  boundary check. Root `typecheck`/`test` turbo filters exclude `apps/mobile`
  (temporary — removal is T1.9). *Check*: CI green on the scaffold PR; root
  pipelines untouched.
- **T0.4** Crypto vectors: generator script on desktop emits
  `packages/contracts/test-vectors/crypto-vectors.json` — fixtures for every
  primitive in record §6 (XChaCha20-Poly1305 AEAD, Argon2id 64 MiB/ops 3 per
  `packages/contracts/src/crypto.ts:28`, Ed25519 sign/verify,
  `crypto_kdf_derive_from_key`, `crypto_generichash`, `crypto_auth`,
  `crypto_scalarmult`, `crypto_box_keypair`), plus a real vault-unlock flow
  vector (password → Argon2id → KDF contexts `memry-vault-key-v1` /
  `memry-key-verifier-v1` → AEAD open). Desktop Vitest run proves the file
  against Node libsodium. *Check*: fixture suite green on desktop; file
  committed.
- **T0.5** Spike R1 (libsodium): integrate the candidate JSI binding; on-device
  harness runs every fixture. **Pass/fail**: byte parity on all vectors, incl.
  Argon2id at 64 MiB on-device. Fail → fallback ladder in research.md §R1.
- **T0.6** Spike R2 (SQLite): benchmark `expo-sqlite` vs `op-sqlite` per the
  protocol in research.md §R2 (bulk insert, point reads, FTS5 build+query,
  Yjs-update append/replay, cold open). **Pass/fail**: thresholds in §R2;
  decision recorded in research.md.
- **T0.7** Spike R3 (Metro/pnpm): prove Metro bundles the workspace graph
  (`contracts` → `app-core` pure parts) with raw TS source exports under pnpm.
  **Pass/fail**: clean bundle + boot; no `shamefullyHoist` regression for the
  rest of the monorepo (desktop dev + landing dev still start).
- **T0.8** Spike R4 (bridge): minimal WebView + scripted 10 keystrokes/s burst
  against a 50 KB doc, base64-framed batched frames both directions.
  **Pass/fail**: p95 round-trip under the 50 ms budget envelope; frame counters
  show batching.
- **T0.9** Gate demo (G0-e): device signs in to staging, registers, pulls one
  desktop-created encrypted note, decrypts via the R1 binding, and the plaintext
  markdown hash equals desktop's. *This is the record's Phase 0 definition:
  "fetch and decrypt one note on device."*
- **T0.10** R6 desk-spike (Apple double-subscription review): written compliance
  memo per research.md §R6. **Pass/fail**: no guideline conflict identified in
  the planned paywall/notice UX, fallback documented.

**Exit**: G0 evidence bundle (CI links, device video or Maestro/Detox artifact,
benchmark table, hash comparison) attached to the phase issue.

### Phase 1 — `@memry/sync-client` extraction (weeks 3–6) — start-ready checklist

Rule of the phase (Constitution I): extraction lands **before** mobile consumes
it, desktop behaviour unchanged, desktop suites green *in the same change*.

- **T1.1** Seam inventory: re-run the electron/node-builtin reachability scan over
  `apps/desktop/src/main/sync/` (314 files today) and `packages/app-core`
  (18 node-touching files today), assign every hit to one of the 10 seams —
  `http-client`, `certificate-pinning`, `crdt-persistence`, `crdt-store-path`,
  `attachments`, `vault-directory`, `device-registration`, `crdt-provider`,
  `crdt-preflight`, `runtime` (e.g. `network.ts` → `http-client`/`runtime`,
  `crdt-pending-notes.ts` → `crdt-persistence`). Output: a checked-in mapping
  table. *Check*: zero unassigned hits.
- **T1.2** Define the 10 adapter interfaces in `packages/sync-client/src/adapters`
  exactly as specified in [contracts/platform-adapters.md](./contracts/platform-adapters.md)
  (platform-free types only; no electron/node types leak into signatures).
  *Check*: `pnpm check:contracts` + boundary script green.
- **T1.3** Move the platform-free sync files (item handlers, engine, outbox
  logic, CRDT merge, vector-clock code) into `packages/sync-client` with
  import-path-only diffs. Mechanical commits, reviewable one seam at a time.
- **T1.4** Desktop adapter implementations: `apps/desktop/src/main/sync/` shrinks
  to the 10 seam implementations + wiring (electron imports allowed only here).
- **T1.5** App-core split: move/quarantine the 18 node-touching files (and
  `storage-vault`'s 1) behind existing or new adapter seams; pure domain stays.
- **T1.6** Test migration: sync suites move with their code and run against the
  package; desktop main-process suites keep passing unchanged. Mocked-boundary
  tests may move but do not count as seam evidence (Constitution III).
- **T1.7** Architecture rule graduates: boundary script now walks the real
  `apps/mobile` → `@memry/sync-client` reachability. *Check*: green with the
  spike app importing the package.
- **T1.8** Desktop E2E smoke on the extraction branch (targeted specs, not the
  full red-on-main suite): sync push/pull, offline reconnect, CRDT merge.
- **T1.9** Remove the temporary `apps/mobile` exclusion from root
  `typecheck`/`test` turbo filters (constitution: exclusion is temporary and its
  removal is tracked work). *Check*: root `pnpm typecheck && pnpm test` green
  with mobile included; `mobile-ci.yml` keeps device-specific jobs only.

**Exit**: G1 evidence bundle — the full command list from the gate table, green,
linked from the extraction PR(s).

### Phases 2–7 — milestone enumeration (task-level breakdown in tasks.md)

- **Phase 2 (shell, weeks 7–10)** — auth + vault unlock (password & recovery
  phrase; multi-vault pick), secure-store key handling, mobile DB ledger
  0001 baseline (data-model.md), sync engine running on mobile adapters
  (pull-only first), windowed first sync (metadata + 30-day bodies, determinate
  progress), read-only note list/detail, **and the production-safety kit as
  in-phase deliverables**: `x-memry-client` header on every request,
  `client_policies` table (min-version + write rejection), per-platform kill switch,
  write attribution columns ([contracts/sync-protocol-additions.md](./contracts/sync-protocol-additions.md)).
  Server work is additive migrations 0006+ and must tolerate header-less desktop
  clients unchanged.
- **Phase 3 (editor, weeks 11–15)** — `editor-web` BlockNote bundle; RN-side
  Y.Doc ownership + SQLite Yjs persistence; bridge provider per
  [contracts/webview-bridge.md](./contracts/webview-bridge.md); outbox-backed
  write path; conflict/merge tests on real adapters; undo/redo; wiki-link render/
  navigate/autocomplete; tags & properties editing. TestFlight internal ring
  opens after G3 only.
- **Phase 4 (remaining types, weeks 16–19)** — tasks (views, recurrence,
  note-checkbox consistency), projects, journal (one-per-day), calendar (month +
  agenda, event CRUD), inbox capture + triage, bookmarks, saved filters, settings
  application, FTS5 search, canvas read-only viewer, reminders via local
  notifications. Cut order if late: canvas viewer, then reminders (recorded
  decision at cut time).
- **Phase 5 (billing + compliance, weeks 20–22)** — StoreKit 2 purchase flow +
  paywall; ASSN V2 endpoint with JWS verification and
  `originalTransactionId → account` mapping; entitlement merge
  (either-active entitles; later expiry governs); double-subscription detection
  + notice; `ITSAppUsesNonExemptEncryption`, `PrivacyInfo.xcprivacy`, accurate
  privacy labels (telemetry exists — never declare "collects nothing");
  in-app account deletion UI over the existing service.
- **Phase 6 (store prep, weeks 23–25)** — App Store Connect metadata, screenshots,
  review notes (incl. reviewer test vault), external TestFlight, accessibility
  audit, performance re-verification of G2/G3 numbers on the release build.
- **Phase 7 (week 26)** — submission + review-response buffer; R6 fallback armed.

## Post-Design Constitution Re-check

Re-evaluated after producing research.md, data-model.md, and contracts/:

- **I** — adapter contracts contain no platform types; extraction precedes mobile
  consumption in the train; server migrations are additive and legacy-tolerant.
  PASS.
- **II** — bridge contract is versioned + typed with a generation step; CI gates
  defined from Phase 0. PASS.
- **III** — vector suite + real-adapter seam tests are gate criteria, not
  suggestions; beta precondition encoded twice (G3, record §13). PASS.
- **IV** — read-only/absent capabilities have explicit UI language in spec FRs;
  no desktop-chrome port. PASS.
- **V** — all three numeric budgets appear as gate checks with measurement
  method and hardware named. PASS.

**No violations. Complexity Tracking remains empty.**

## Complexity Tracking

> No constitution violations to justify — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
