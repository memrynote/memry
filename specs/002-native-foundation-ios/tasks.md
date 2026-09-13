# Tasks: Memry Native, Foundation + iOS Shell

**Input**: Design documents from `/specs/002-native-foundation-ios/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Included where the constitution mandates them. The protocol vectors are
not a test suite bolted on afterwards, they are Phase 2's deliverable (Constitution
III). Every sync seam that can lose data (outbox durability, CRDT merge, tombstones,
offline reconnect, kill switch) is tested against **real** adapters and, where the
path reaches it, the real staging server. Mocked-boundary tests are never cited as
gate evidence (FR-072). No blanket TDD elsewhere.

**Organization**: Phases map onto the release train in plan.md (A1, A2, A3, B0, B1,
B2, B3, C1, C2, C3, D). **Train gates are serial** (Constitution: a phase does not
start until the prior gate is green with evidence). That overrides the generic
"stories in parallel" pattern: parallelism (`[P]`) exists _within_ a phase only.
Phase 1 carries the A3 CI moves early, because the two gates it rescues die the day
`apps/mobile` is frozen.

Migration numbers are indicative. `data.db` and `index.db` carry independent
`PRAGMA user_version` counters (data-model §A.0); assign the next free number in each
ledger at land time.

## Format: `[ID] [P?] [Story?] Description with file path`

A task added after this list was numbered takes a suffix letter (`T062a`, `T156a`,
`T214a`) and sits next to the task it belongs with, so no existing id ever moves.

---

## Phase 1: Setup, scaffolds and the A3 CI moves (Gate **G2b**)

**Purpose**: Put the Rust workspace, the Swift package, the Xcode project, and the
two CI workflows on disk, and rescue the two gates that currently live in
`mobile-ci.yml` before `apps/mobile` is frozen. Nothing here depends on the protocol
spec, and nothing after here may start until G2b is green.

- [x] T001 Create the Rust workspace root `crates/Cargo.toml`: `resolver = "3"`, members `memry-core`, `memry-cli`, `uniffi-bindgen-swift`, and a `[workspace.dependencies]` block carrying every pin from plan.md Technical Context (`uniffi = "=0.32.1"`, `yrs = "0.27.4"`, `libsodium-sys-stable = "1.24.0"`, `zeroize = "1.8"`, `bip39 = "2.2.2"`, `rusqlite = "0.40.2"` with `bundled`/`backup`/`functions`/`trace`/`limits`, `ciborium = "0.2.2"`, `flate2 = "1.1.10"`, `tokio = "1.53.1"`, `async-trait = "0.1.92"`, `thiserror = "2"`, `tracing`, `uuid`, `base64 = "0.22"`, `hex`, `time`), edition 2024, `rust-version = "1.89"`
- [x] T002 Create `crates/memry-core/Cargo.toml` with `crate-type = ["staticlib", "cdylib", "lib"]`, the `uniffi` proc-macro dependency in library mode with the `tokio` feature, a `native-transport` feature gate, and `dryoc = "1.0.0"`, `proptest = "1"`, `insta = "1"` as dev-dependencies; add `crates/memry-core/src/lib.rs` with `uniffi::setup_scaffolding!()` and nothing else
- [x] T003 [P] Create `crates/uniffi-bindgen-swift/` (Cargo.toml plus a two-line `src/main.rs`) pinned to the same `uniffi = "=0.32.1"` as the workspace, so bindgen and runtime metadata versions cannot drift (research R1)
- [x] T004 [P] Create `crates/memry-cli/Cargo.toml` skeleton depending on `memry-core` with `native-transport`, plus `reqwest = "0.13.5"` (`rustls-no-provider`, `json`, `http2`, `stream`), `tokio-tungstenite = "0.30.0"`, `rustls = "0.23"` (`ring`)
- [x] T005 Write `crates/memry-core/build-xcframework.sh`: build `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `x86_64-apple-ios`, export `IPHONEOS_DEPLOYMENT_TARGET=26.0` so the C slices agree with the iOS floor, rename the generated modulemap to `module.modulemap`, assemble `MemryCoreFFI.xcframework`, and emit generated Swift into `packages/swift/MemryCore/Sources/MemryCore/Generated/`
- [x] T006 [P] Create `packages/swift/MemryCore/Package.swift`: `binaryTarget` for `MemryCoreFFI.xcframework` plus a `MemryCore` target wrapping the checked-in generated Swift
- [x] T007 Create `apps/ios/Memry.xcodeproj` and the `apps/ios/Memry/` group skeleton (`App/`, `Core/`, `Seams/`, `Editor/`, `Features/`, `Design/`, `Generated/`, `Resources/`, `Scripts/`) with iOS 26.0 deployment target, Swift 6.2 in Swift 6 language mode and **no** `-default-isolation MainActor` (research R15), the local `MemryCore` package added, `MemryTests` (Swift Testing) plus `MemryUITests` (XCTest) targets, and the three test plans `Unit`, `UI`, `Conformance` so CI can `build-for-testing` once and `test-without-building` per plan (research R19)
- [x] T008 [P] Create `apps/ios/Memry/Resources/Info.plist` and the entitlements file: `NSCameraUsageDescription` (absent means a crash, research R13), `ITSAppUsesNonExemptEncryption` key present, `com.apple.developer.default-data-protection` set to `NSFileProtectionCompleteUntilFirstUserAuthentication`, and the `fetch`/`processing` background modes
- [x] T009 Create `.github/workflows/rust-ci.yml`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test -p memry-core`, plus a regenerate-and-diff step over `packages/swift/MemryCore/Sources/MemryCore/Generated/` modelled on `pnpm ipc:check`
- [x] T010 Create `.github/workflows/ios-ci.yml`: `xcodebuild build-for-testing` once then `test-without-building` per test plan, `.xcresult` archived as an artifact, SwiftLint, a grep gate that fails on `print(` in Swift or `console.` in `packages/editor-web/src` (Constitution II), a regenerate-and-diff over `apps/ios/Memry/Generated/EditorWebAsset.swift`, and the two gates inherited from `mobile-ci.yml` (editor-asset input freshness and the crypto-vector parity test); add `apps/ios/.swiftlint.yml` in the same change (no `print`, no force-unwrap outside tests, file-length warnings at the plan's line ceilings, which T018 turns into a check)
- [x] T011 `git mv apps/mobile/editor-web packages/editor-web` and drop the now-redundant `apps/mobile/editor-web` entry from `pnpm-workspace.yaml` (`packages/*` covers it); the package name `@memry/editor-web` does not change (research R17)
- [x] T012 Repair every path the move broke, without editing anything in place under `apps/mobile`: the editor build script and its `editor:check` counterpart in `packages/editor-web/package.json`, `turbo.json` pipeline entries, tsconfig references, and the `.github/workflows/mobile-ci.yml` steps that pointed at the old path
- [x] T013 Rename the guest transport global in `packages/editor-web/src/bridge.ts` from `window.ReactNativeWebView.postMessage` to a host-agnostic `window.MemryHost.postMessage` with feature detection, keeping the `interactive-widget=overlays-content` viewport meta; `BRIDGE_PROTOCOL_VERSION` stays 1, so this is a transport rename and not a protocol change (research R10)
- [x] T014 Delete the files the move and the rename left stranded under `apps/mobile` (the old `editor-web` references and the RN-only bridge host), by deletion only, because the frozen shell accepts no edits in place (Constitution, Frozen React Native Shell)
- [x] T015 [P] Add `packages/editor-web/dist/` to `.prettierignore` and to `.gitattributes` as `-diff -merge linguist-generated`, so a 1.19 MB checked-in asset never lands in a review diff (research R17)
- [x] T016 [P] Repoint the mobile pointers in `DESIGN.md` from the frozen `apps/mobile` paths to `apps/ios/Memry/Design/`, and add the empty Liquid Glass section heading that T228 fills (research R15)
- [x] T017 [P] Extend `scripts/check-architecture-boundaries.js` with the iOS rule: fail on any `URLSession` or `URLSessionWebSocketTask` reference outside `apps/ios/Memry/Seams/`; prove it red with a planted reference in `apps/ios/Memry/Features/`, then green (Constitution I, data-model §D.4)
- [x] T018 [P] Write `scripts/check-line-ceilings.mjs` enforcing the per-directory line ceilings the plan states (600 lines for a `crates/memry-core/src/*` module, 400 for a file under `apps/ios/Memry/Features/`, 300 for a generator under `packages/contracts/scripts/`) and run it in both `rust-ci.yml` and `ios-ci.yml`, so a file past its ceiling fails the build instead of a review note (Constitution II)
- [x] T019 **G2b evidence**: `ios-ci.yml` runs green on a PR with both inherited gates executing, `apps/mobile/editor-web` no longer exists, and root `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test` is green after the move

**Checkpoint, G2b**: the mobile-ci gates are reproduced in `ios-ci.yml` before the freeze is enforced. **PASSED.**

Evidence, all on `main` at `41dc40954`:

- `ios-ci.yml` green: https://github.com/memrynote/memry/actions/runs/34727642321 — both jobs pass, including `Gates inherited from mobile-ci` (editor-asset freshness + crypto-vector parity) and `Build once, run every test plan` (Unit, Conformance, UI).
- `rust-ci.yml` green: https://github.com/memrynote/memry/actions/runs/34727642316 — fmt, clippy, `cargo test -p memry-core`, and the regenerate-and-diff over the committed Swift bindings on a clean runner.
- `apps/mobile/editor-web` no longer exists; the bundle is `packages/editor-web`.
- Root `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test` green locally after the move (20,600 desktop tests; the single lint warning predates this branch).

Deviations from the task text, recorded rather than hidden:

1. The evidence run is a **push to `main`**, not a PR — landed directly at Kaan's instruction. The same two workflows run on `pull_request`, so the PR path is configured but unexercised.
2. T007 named `MemryTests` + `MemryUITests`; a third target `MemryConformanceTests` was added. Xcode 26 does not match Swift Testing suite IDs inside `.xctestplan` selection (five identifier forms tried, each selected zero tests), so the three plans partition by target instead.
3. T014's "RN-only bridge host" was **not** deleted. Deleting `apps/mobile/src/editor/` would cascade into `session`, `doc-manager`, the notes routes and the sync engine — most of the app — and would put T019's `pnpm typecheck` out of reach. Only the 17 test files that could no longer resolve `../../editor-web` were deleted. The bridge host is still live and is Phase C work.
4. T012 says not to edit in place under `apps/mobile`, but four dead references there pointed at moved files (two `package.json` scripts, a tsconfig `exclude`, an eslint ignore). They were removed; leaving them would have left `pnpm --filter @memry/mobile editor:check` crashing on a missing file.

---

## Phase 2: Foundational = User Story 1, the protocol written down (P1) 🎯 MVP part 1, trains A1 + A2 (Gates **G1**, **G2**)

**Goal**: `docs/protocol/` chapters 00 to 14 state every normative fact in
[contracts/protocol-spec-outline.md](./contracts/protocol-spec-outline.md), and
`packages/contracts/test-vectors/` carries 275 cases plus 5 fuzz families generated
by production code paths and verified by the desktop suite.

**Independent Test** (spec US1): hand the chapters and the vector files to a reader
with no access to the implementation and confirm they can state, for any vector,
which bytes go in and which must come out and why. Standalone value even if no phone
is ever built: the protocol stops being tribal knowledge.

**No Rust exists yet and none may start.** G2 is the gate.

**Every open question T035 to T046 names is already answered**, from source, in
[contracts/protocol-answers.md](./contracts/protocol-answers.md). Read it before
writing a chapter: the answer, its `path:line` citations, the decisions taken on
2026-09-13, and the errata against the outline are all there. Those tasks are now
transcription plus citation checking, not research. That file also lists five code
defects found while answering, each tracked as a GitHub issue; they are not the
chapter author's to fix.

### A1: the chapters (Gate G1)

- [x] T020 [US1] Write `docs/protocol/00-overview-and-versioning.md` from `packages/contracts/src/crypto.ts:13-14`, `pack-format.ts:58-60`, `webview-bridge.ts:22`, `linking-api.ts:3`, `apps/sync-server/src/index.ts:216-226`, `apps/sync-server/src/lib/errors.ts:10-96`, `packages/sync-client/src/pull/http.ts:98-121`; it also carries the two cross-chapter rules (every normative sentence cites `path:line`; there is no negotiated wire protocol version, only the client header floor and per-format version bytes)
- [x] T021 [US1] Write `docs/protocol/01-identity-and-keys.md` from `apps/desktop/src/main/crypto/recovery.ts:11-55`, `keys.ts:19-183`, `vault-key-state.ts:14-26`, `keychain-account.ts:17-32`, `packages/contracts/src/crypto.ts:20-76`, `apps/desktop/src/main/lib/id.ts:13-49`
- [x] T022 [US1] Write `docs/protocol/02-auth-and-sessions.md` from `apps/sync-server/src/routes/auth.ts:234-1015`, `packages/contracts/src/auth-api.ts`, `apps/sync-server/src/lib/jwt-verify.ts:5-47`, `apps/desktop/src/main/sync/token-manager.ts:14-237`, `device-registration.ts:51-236`
- [x] T023 [US1] Write `docs/protocol/03-device-linking.md` from `apps/sync-server/src/routes/linking.ts:82-276`, `packages/contracts/src/linking-api.ts`, `apps/desktop/src/main/crypto/keys.ts:143-229`, `apps/desktop/src/main/sync/linking-service.ts:63-512, 654-732`, `packages/contracts/src/cbor-ordering.ts:15-19`
- [x] T024 [US1] Write `docs/protocol/04-record-envelope.md` from `packages/sync-client/src/push/record-encrypt.ts:36-107`, `pull/record-decrypt.ts:42-154`, `apps/desktop/src/main/sync/encrypt.ts:35-109`, `crdt-encrypt.ts:11-94`, `packages/sync-client/src/compress.ts`, `packages/sync-client/src/pull/cbor.ts`, `apps/desktop/src/main/crypto/cbor.ts`, `apps/sync-server/src/services/sync.ts:96-167`
- [x] T025 [US1] Write `docs/protocol/05-record-sync.md` from `apps/sync-server/src/routes/sync.ts:79-565`, `services/sync.ts:30-233, 470-540`, `lib/sync-types.ts:34-46`, `packages/contracts/src/sync-api.ts`, `packages/sync-client/src/pull/engine.ts`, `pull/http.ts:18-121`, `apps/desktop/src/main/sync/engine/sync-context.ts:126-140`, `engine/push-coordinator.ts:132-263`; it states the 13 types this phone declares (spec Assumptions) against the shipped client's 25
- [x] T026 [US1] Write `docs/protocol/06-vector-clocks-and-field-merge.md` from `packages/sync-client/src/vector-clock.ts`, `field-merge.ts:11-137`, `offline-clock.ts:31-101`, `item-handlers/types.ts:53-68`, `packages/contracts/src/sync-api.ts:166-173`, `packages/contracts/src/settings-sync.ts:78-108`
- [x] T027 [US1] Write `docs/protocol/07-crdt-updates.md` from `apps/sync-server/src/routes/sync.ts:571-1146`, `services/crdt.ts:86-146, 310-360, 690-770`, `packages/sync-client/src/pull/crdt-pull.ts`, `apps/desktop/src/main/sync/crdt-encrypt.ts`
- [x] T028 [P] [US1] Write `docs/protocol/08-pack-container.md` from `packages/contracts/src/pack-format.ts` in full plus `sync-api.ts:488-551`, stating that packs are optional and a client that never fetches one is still conforming (Q08.4)
- [x] T029 [P] [US1] Write `docs/protocol/09-realtime.md` from `packages/contracts/src/sync-socket.ts` in full plus `apps/sync-server/src/durable-objects/user-sync-state.ts:22-355`, including the reconnect and backoff policy that exists nowhere today and what a client does between a 4003 close and a successful refresh (Q09.4)
- [x] T030 [P] [US1] Write `docs/protocol/10-bootstrap-session.md` from `packages/contracts/src/bootstrap-api.ts` in full, `apps/sync-server/src/routes/bootstrap.ts:33-180`, `apps/sync-server/src/lib/errors.ts:41-55`, and answer whether the session is required for SC-007 or an optimisation (Q10.1)
- [x] T031 [P] [US1] Write `docs/protocol/11-client-policy.md` from `apps/sync-server/src/lib/client-identity.ts:8-82`, `middleware/client-gate.ts:9-66`, `packages/contracts/src/sync-api.ts:262-287`, `packages/sync-client/src/pull/client-header.ts`, `specs/001-mobile-app/contracts/sync-protocol-additions.md:11-85`; it states the status poll interval a conforming client uses so a flipped switch takes effect without a restart (Q11.2, FR-070)
- [x] T032 [US1] Write `docs/protocol/12-note-body-format.md` from `packages/contracts/src/ipc-crdt.ts:57`, `webview-bridge.ts:35`, `packages/app-core/src/markdown.ts`, `packages/shared/src/markdown-source.ts`, `packages/editor-schema/src/blocks/markdown.ts`, `packages/editor-schema/src/inline/*.ts`, `packages/shared/src/date-mention.ts`, `packages/shared/src/{inline-colors,block-markers,block-colors,link-references}.ts`, `packages/shared/src/critic-markup/`, `packages/editor-schema/src/conformance.ts`; the chapter records that markdown and blocks convert **only** inside the editor bundle (decision T042) and that the core's only text operation is `extract_text`
- [x] T033 [P] [US1] Write `docs/protocol/13-payload-schemas.md` from `packages/contracts/src/sync-payloads.ts` (twelve types) and `packages/contracts/src/settings-sync.ts` (`settings`), making the verbatim-payload obligation at `packages/sync-client/src/pull/store.ts:5-10` normative rather than a store comment (Q13.2, the whole of FR-033)
- [x] T034 [P] [US1] Write `docs/protocol/14-attachments.md` from `packages/contracts/src/blob-api.ts`, `apps/sync-server/src/routes/blob.ts:150-838`, `apps/desktop/src/main/sync/attachments.ts:44, 220-243, 447-522, 808-810, 1363-1364`, `packages/sync-client/src/push/attachment-manifest.ts`, and name the minimal read-only route set an inline-image-only client needs (Q14.1)

### A1: the open questions that block a second implementation

- [~] T035 [US1] **Partially done — the chapter half is written, the code half is deliberately deferred.** `docs/protocol/07-crdt-updates.md` §7.1 states the journal rule normatively and §7.1.1 records the decision to correct the constants. The constant correction itself is **#2186**, and this phase was instructed not to fix the tracked issues inside it, so `CRDT_SYNC_ITEM_TYPES` and `EncryptedCrdtItemSchema` are unchanged. Close this task with #2186. Original text: Resolve Q07.1, the journal question FR-003 names: state normatively in `docs/protocol/07-crdt-updates.md` that a journal body is a collaborative document keyed by `j<YYYY-MM-DD>`, then either correct `CRDT_SYNC_ITEM_TYPES` and `EncryptedCrdtItemSchema.type` in `packages/contracts/src/{sync-api.ts:91,crypto.ts:194}` or document the constant as record-envelope-scoped only, with the desktop and sync-server suites green in the same change
- [x] T036 [US1] Resolve Q06.1 and Q06.2 in `docs/protocol/06-vector-clocks-and-field-merge.md`: write the complete winner-selection order (primary `clockTotal` comparison, `_offline` tie-break, default winner when neither dominates) and either construct the case where two devices each treating themselves as local disagree, or prove it cannot happen and record the proof; FR-002 is not satisfied until this section says which
- [x] T037 [US1] Resolve Q06.3 in the same chapter: specify the canonical value-equality form a Rust implementation must reproduce for `JSON.stringify` comparison, including that `{a:1,b:2}` and `{b:2,a:1}` count as differing and that `null` and `undefined` differ, and record the behaviour change if a defined canonical comparison is mandated instead
- [x] T038 [US1] Resolve Q12.1 in `docs/protocol/12-note-body-format.md`: either specify the real frontmatter key ordering that both implementations adopt, or state that the only guarantee is the unedited verbatim path and that any frontmatter edit may reorder keys; remove the interim disclaimer at `packages/app-core/src/markdown.ts:110-111` in the same change
- [x] T039 [US1] Resolve Q04.1 in `docs/protocol/04-record-envelope.md`: state the packed CRDT header as **160** bytes with the signature at offset **96** and fix all four stale comments in the same change, `apps/desktop/src/main/sync/crdt-encrypt.ts:35` (signature offset; the comment says 72, and `docs/ideas/2026-09-12-native-ios-rust-core-plan.md:42` already says 160, so there is no 168-byte figure left to correct), `packages/sync-client/src/pull/record-decrypt.ts:72-74` and `push/record-encrypt.ts:74-76` (CBOR does not preserve a nested object's key order, the encoder sorts), and `apps/desktop/src/main/crypto/cbor.test.ts:68` (cite RFC 8949 §4.2.3 length-first, not §4.2.1)
- [x] T040 [US1] Resolve Q05.3 in `docs/protocol/05-record-sync.md`: state **both** canonicalisations of the same four blob fields explicitly, the R2 object and `contentHash` under `JSON.stringify(payload, Object.keys(payload).sort())` giving `dataNonce, encryptedData, encryptedKey, keyNonce` (`apps/sync-server/src/services/sync.ts:247-269`), and the signature under canonical CBOR length-first (RFC 8949 §4.2.3) giving `keyNonce, dataNonce, encryptedKey, encryptedData`, with a sentence saying a Rust implementation must reproduce both and may assume neither
- [x] T041 [US1] Resolve Q07.2 in `docs/protocol/07-crdt-updates.md`: write the client snapshot obligation, when a phone **may** push a snapshot and when it **must**, given there is no server-side threshold and the platform-free engine pushes none (`packages/sync-client/src/pull/crdt-pull.ts:16-18`); this is data-model §E.2 and it decides whether `yjs_snapshots` ever holds a server-bound row this core wrote
- [x] T042 [US1] Resolve Q12.2 in `docs/protocol/12-note-body-format.md`, both directions, and write the answer as normative: markdown to blocks and blocks to markdown run **inside the editor bundle** through `doc-load.seedMarkdown` (`packages/contracts/src/webview-bridge.ts:41-60`; `seed-from-markdown` is a planned rename that does not exist in production) and `export-markdown`, where "editor bundle" means the WebView on mobile and the headless editor in Electron main on desktop; the Rust core never parses or serialises BlockNote markdown, owns `extract_text` only, and FR-041 byte identity is satisfied structurally for **existing** notes because the phone never writes a vault file and desktop writes back from the Y.Doc; the chapter must also state the three carve-outs, that a create or duplicate record's `content` does become vault bytes through desktop, that a tag or property edit regenerates frontmatter, and that a non-empty `criticMarkupMarks` disables source restoration. Q12.3 and Q12.4 (the three-way merge and its edit-distance budget) do not vanish: they stay normative as **desktop write-back behaviour** that other clients rely on but need not reproduce, and `MAX_EDIT_DISTANCE` is named an implementation budget rather than a protocol constant
- [x] T043 [US1] Resolve Q01.2, Q01.3 and Q01.4 in `docs/protocol/01-identity-and-keys.md`: the recovery-phrase normalisation both implementations apply before `mnemonicToSeed` and whether it changes behaviour for any phrase a user already holds; whether a phone stores the master key, the vault key, or both (desktop stores the master key and derives the vault key on demand, `apps/desktop/src/main/crypto/keys.ts:123-137`); and the confirmation that every vault on an account shares one vault key with separation by `vaultId` routing only, which FR-021 depends on
- [x] T044 [US1] Resolve Q12.5 in `docs/protocol/12-note-body-format.md`: list the **seven** Y.Doc roots a note document carries (`probe` is not one of them, it lives on a throwaway doc at `apps/desktop/src/main/sync/crdt-persistence.ts:229-231`) with each root's writer, reader and the consequence of dropping it; the rule is stronger than "which ones", every root MUST survive including roots this spec does not name (FR-033), which means a client MUST snapshot with a full-state encode and MUST NOT rebuild a document by copying named roots
- [x] T045 [US1] Resolve Q03.1 to Q03.5 in `docs/protocol/03-device-linking.md` (the `linkingSecret` shape and size, which requests `LINKING_IP_MISMATCH` binds and what a Wi-Fi to cellular move does mid-flow, the session TTL, the two optional encrypted blocks and whether a phone must consume them, and the HMAC-SHA-256 versus HMAC-SHA512-256 split); these block C1, because FR-020 cannot be implemented against five unknowns
- [x] T046 [US1] Sweep every remaining open question in `contracts/protocol-spec-outline.md` (Q00.1 to Q14.4, excluding those closed by T035 to T041): each is either answered in its chapter or restated there as an explicit "undefined, do not rely on this"; a question silently dropped is how it becomes a divergence
- [x] T047 [US1] Implement the FR-008 mechanism named in the outline's cross-chapter obligation 3: a digest over each chapter's fact tables asserted against the constants they were derived from, run inside the vector verifiers so a covered format change that skips the chapter fails the build, in `packages/contracts/src/__tests__/protocol-chapters.test.ts`
- [x] T048 [US1] Create `specs/002-native-foundation-ios/checklists/protocol-spec.md`: every `Qnn.n` from `contracts/protocol-spec-outline.md` listed with its state, answered (with the chapter section) or explicitly undefined; the must-answer set Q12.2, Q07.1, Q06.1, Q06.3, Q06.4, Q05.3, Q12.1, Q12.5, Q01.2, Q01.3, Q01.4, Q07.2, Q13.2, Q10.1, and Q03.1 through Q03.5 must all read answered (not undefined) before G1 is declared
- [x] T049 [US1] Close the export-compliance checkbox wording now rather than during submission week: read the existing desktop App Store filing, record the exact wording and the answers it uses in `specs/002-native-foundation-ios/compliance.md`, and note any difference the Rust core's statically linked libsodium makes (research §E, R18)
- [x] T050 [US1] Create `specs/002-native-foundation-ios/spec-defects.md`: the log SC-002 counts, one entry per question that required reading implementation source during core development, each closed by a specification change; it starts empty and must have zero open entries at G5

### A2: generators and vectors (Gate G2)

- [x] T051 [US1] Lift the deterministic `SyncCryptoProvider` from `packages/sync-client/src/push/roundtrip.test.ts:21-64` into `packages/contracts/test-vectors/deterministic-provider.ts` so generator and verifier share one implementation (`generateFileKey` returns `FILE_KEY`, `encrypt` uses `NONCE_24_A` for content and `NONCE_24_B` for the wrap, every other method is real libsodium)
- [x] T052 [US1] Create `packages/contracts/scripts/gen-protocol-vectors.ts`: one entry point emitting every composite class, an optional class filter so a single class regenerates in isolation, and `--check` which regenerates into a temporary directory and diffs against the committed files without writing
- [x] T053 [P] [US1] Add `"vectors:generate"` and `"vectors:check"` to `packages/contracts/package.json`, each running both generators (today the only documented invocation of the existing generator is a comment at `packages/contracts/scripts/gen-crypto-vectors.ts:13`), and write `packages/contracts/test-vectors/README.md`: what each file is, how to regenerate it, and the three governing rules (vectors come from production paths, verification is a separate program from generation, a format change updates chapter and vectors in the same change)
- [x] T054 [US1] Close the hand-copied KDF table defect: assert in `packages/contracts/src/__tests__/crypto-vectors.test.ts` that the vector's seven context and subkey-id pairs equal the production map at `apps/desktop/src/main/crypto/keys.ts:19`, instead of the generator's copy at `gen-crypto-vectors.ts:25-35` drifting silently (conformance-vectors §3 change 1)
- [x] T055 [US1] Extend `packages/contracts/scripts/gen-crypto-vectors.ts` to emit `packages/contracts/test-vectors/bip39-unlock.json`, 8 cases: the four `bip39` cases (known 24-word English mnemonic to its 64-byte seed through `mnemonicToSeed`, PBKDF2-HMAC-SHA512 2048 iterations with the literal salt `mnemonic`; the same mnemonic mixed-case with doubled internal spaces and the seed it actually produces today; an invalid-checksum mnemonic with its validation result; a 12-word mnemonic) plus `recoveryPhraseUnlock`, `accountKeyVerifier`, `localVaultKeyVerifier`, `wrongPhrase`, and the `deviceId` derivation as a named case, `deviceId = hex(crypto_generichash(16, ed25519PublicKey, null))` (`apps/desktop/src/main/crypto/keys.ts:81`); `crypto-vectors.json` stays byte-for-byte as committed, so the frozen file is never mutated (conformance-vectors §3 changes 2 and 3)
- [x] T056 [US1] Generate `packages/contracts/test-vectors/record-envelope.json`, 12 cases plus 2 vault-name envelope cases, 14 in total, from **desktop's** writer `apps/desktop/src/main/sync/encrypt.ts:35-109` through the T051 provider, covering both envelope shapes and the signed CBOR bytes; desktop is the reference implementation, so the vector records what desktop produces
- [x] T057 [US1] Generate `packages/contracts/test-vectors/crdt-update.json`, 8 cases, over the packed layout from `apps/desktop/src/main/sync/crdt-encrypt.ts`, pinning the 160-byte header, the signature at offset 96, and a snapshot blob travelling in the same packed shape as an update
- [x] T058 [P] [US1] Generate `packages/contracts/test-vectors/cbor-canonical.json`, 14 cases, through the production encoder (`packages/sync-client/src/pull/cbor.ts`, `apps/desktop/src/main/crypto/cbor.ts`), including a nested map and at least one key pair where RFC 8949 length-first order and lexicographic order disagree, plus the shortest-int and float16 narrowing forms (research R6)
- [x] T059 [P] [US1] Generate `packages/contracts/test-vectors/compression.json`, 9 cases, through `compressPayload`/`decompressPayload` (`packages/sync-client/src/compress.ts`), pinning the 1-byte flag framing (`0x00` stored, `0x01` zlib), the under-64-byte stored rule, the does-not-shrink stored rule, the RFC 1950 `78 9c` header, and a truncated stream as a hard error; record the `pako` version in `meta`
- [x] T060 [US1] Generate `packages/contracts/test-vectors/field-merge.json`, 30 cases, by running the real `packages/sync-client/src/field-merge.ts:11-137` and `vector-clock.ts` and recording the output rather than predicting it: winner plus conflict set per case, the `clockTotal` cases, the `_offline` tie-break and its rebind (`offline-clock.ts:31-101`), `null-versus-undefined`, and `object-values-same-content-different-key-order`, which is the single likeliest Rust divergence
- [x] T061 [US1] Generate `packages/contracts/test-vectors/pack-container.json`, 10 **reader-only** cases: the server's MPAK writer is not imported into `packages/contracts` (the architecture check forbids it and a generator that reimplements the writer proves the generator), so the cases are recorded container bytes plus their expected parse, asserted against the reader in `packages/contracts/src/pack-format.ts`
- [x] T062 [US1] Export `packages/contracts/test-vectors/markdown-roundtrip/cases.json` (89 cases: 80 existing from `packages/editor-schema/src/conformance.ts`, 4 storage, 5 out-of-band encodings) and `fuzz-families.json` (5 seeded families), with an explicit out-of-band-encodings group covering inline colours, block markers, suggestion marks, link references and the preserved markdown source; this corpus proves the **editor bundle**, which is where markdown conversion lives (FR-005)
- [x] T062a [P] [US1] Write the registry parity test `packages/editor-schema/src/__tests__/registry-parity.test.ts` (Vitest): it reads the 33 block, inline and style type names spec FR-040 enumerates from the checked-in list file `packages/editor-schema/src/registry-manifest.json` and fails when `createMemrySchema` produces a type the list does not name, or the list names a type the registry does not produce (FR-040)
- [x] T063 [US1] Generate `packages/contracts/test-vectors/payload-schemas.json` from `packages/contracts/src/sync-payloads.ts` and `settings-sync.ts`: four cases per subscribed item type, 52 in total, a valid payload, a boundary payload, an unknown-field case proving the field survives, and the expected verbatim round trip of that unknown-field instance, which is the whole of FR-033 expressed as vectors
- [x] T064 [US1] Generate `packages/contracts/test-vectors/device-linking.json` from `apps/desktop/src/main/crypto/keys.ts:143-229`: the X25519 exchange, named cases for `scanProof`, `scanConfirm` and `keyConfirm` covering both MACs (the scan channel's HMAC-SHA-256 keyed by the decoded 32-byte `linkingSecret`, and the confirm channel's libsodium `crypto_auth`, i.e. HMAC-SHA512-256, keyed by `macKey`) and the SAS derivation including its `2^32 mod 10^6` modular bias, which MUST be reproduced rather than corrected, so the linking path a phone must implement is pinned before C1
- [x] T065 [US1] Generate `packages/contracts/test-vectors/text-extract.json` from desktop's Y.Docs: document bytes in, extracted plain text out with heading and list markers kept, so the core's only text operation is measured against desktop rather than against a Rust author's taste
- [x] T066 [P] [US1] Write the verifier `packages/contracts/src/__tests__/bip39-unlock.test.ts`: recompute every case with Node libsodium and `bip39`, and assert the `accountKeyVerifier` comparison is over the base64 **strings** re-encoded as UTF-8 rather than the decoded bytes (`apps/desktop/src/main/crypto/recovery.ts:48-55`)
- [x] T067 [P] [US1] Write the verifier `packages/contracts/src/__tests__/record-envelope.test.ts`: verify signatures rather than only comparing bytes, assert decrypt reproduces the recorded plaintext, and assert `packages/sync-client/src/push/record-encrypt.ts` produces **byte-identical** output to the desktop-generated vector, which is the check that keeps the two TypeScript writers from drifting
- [x] T068 [P] [US1] Write the verifier `packages/contracts/src/__tests__/crdt-update.test.ts`, asserting header length 160 and signature offset 96 against the production constants, not against a literal in the test
- [x] T069 [P] [US1] Write the verifier `packages/contracts/src/__tests__/cbor-canonical.test.ts`, asserting both production encoders produce the same bytes for every case
- [x] T070 [P] [US1] Write the verifier `packages/contracts/src/__tests__/compression.test.ts`, including the truncated-stream hard-error case
- [x] T071 [P] [US1] Write the verifier `packages/contracts/src/__tests__/field-merge.test.ts`, asserting winner **and** conflict set per case (FR-002 requires both)
- [x] T072 [P] [US1] Write the verifier `packages/contracts/src/__tests__/pack-container.test.ts`
- [x] T073 [P] [US1] Write the verifier `packages/contracts/src/__tests__/markdown-roundtrip.test.ts` over `cases.json` and the seeded fuzz families, asserting byte identity on the unedited path (data-model §D.1)
- [x] T074 [P] [US1] Write the verifier `packages/contracts/src/__tests__/payload-schemas.test.ts`, asserting the unknown-field cases survive a parse-and-re-emit cycle unchanged
- [x] T075 [P] [US1] Write the verifier `packages/contracts/src/__tests__/device-linking.test.ts`, recomputing both MACs and the SAS with Node libsodium
- [x] T076 [P] [US1] Write the verifier `packages/contracts/src/__tests__/text-extract.test.ts`, running each document through the desktop extractor and comparing to the recorded text
- [ ] T077 [US1] **G1 evidence**: a review checklist walked against `contracts/protocol-spec-outline.md` confirming every normative fact is stated with a `path:line` citation, every open question is answered or explicitly marked undefined, and `pnpm docs:build` renders all fifteen chapters
- [ ] T078 [US1] **G2 evidence**: `pnpm --filter @memry/contracts vectors:check` green (it regenerates every deterministic class into a temporary directory and diffs against the committed files; CI never runs `vectors:generate`, which writes); `pnpm --filter @memry/contracts test` green with case counts matching the conformance-vectors §14 totals table; `pnpm test:desktop` green; the evidence also shows the new tests running in all three pickups with no wiring change (desktop vitest `shared` project at `apps/desktop/config/vitest.config.ts:34`, root `turbo run test --filter=@memry/contracts`, `ios-ci.yml`) and the CI check that fails if a second `crypto-vectors.json` ever appears (research R19)

**Checkpoint, G1**: every chapter states its facts with citations. Evidence: the T077 checklist output plus the `pnpm docs:build` log.

**Checkpoint, G2**: the desktop suite verifies every vector class and fails when a vector and the implementation disagree. Evidence: the T078 command outputs (`vectors:generate` clean diff, `@memry/contracts test` green with the count table, `test:desktop` green) and the committed vector files. **No Rust may be written before this checkpoint.**

---

## Phase 3: User Story 2, the core proves a full round trip with no UI (P1) 🎯 MVP part 2, trains B0 + B1 + B2 + B3 (Gates **G3**, **G4**, **G5**)

**Goal**: `crates/memry-core` reproduces every vector byte for byte, then `memry-cli`
signs in to staging, unlocks a desktop-created vault, pulls, edits, pushes, and
converges with a real desktop on the other side.

**Independent Test** (spec US2): from a terminal, with no shell application
installed, run the round trip against staging with a real desktop signed into the
same account, and watch each direction land.

### B0: spikes that retire risk (Gate G3a)

- [ ] T079 [US2] Spike S1: UniFFI XCFramework hello-world, a single exported function called from an empty iOS app through `crates/memry-core/build-xcframework.sh` and `packages/swift/MemryCore`; the same spike logs `Thread.current` inside a UniFFI callback and asserts the callback is **not** re-entrant while the core holds a lock (research §E); pass/fail note in `specs/002-native-foundation-ios/research.md` §Addenda
- [ ] T080 [US2] Spike S2: async foreign-trait transport, a `Transport` implemented in Swift over `URLSession`, called from Rust for a round trip to staging `/health`, because async foreign traits are the least-travelled UniFFI path (research R5); pass/fail note
- [ ] T081 [US2] Spike S3: `WKWebView` with `loadHTMLString(html, baseURL: about:blank)` and `websiteDataStore = .nonPersistent()`, smoke-asserting `window.isSecureContext && !!crypto.subtle`, plus device screenshots of the keyboard `inputAccessoryView` with the hardware keyboard off, one default and one under Reduce Transparency (research §E); pass/fail note, and if the opaque origin is not a secure context the `WKURLSchemeHandler` fallback is taken here and recorded
- [ ] T082 [US2] Spike S4: Argon2id 64 MiB ops 3 on a real iPhone 15 under memory pressure through `libsodium-sys-stable`, confirming `crypto_pwhash` OOM (-1) is distinguishable from a wrong phrase; pass/fail note
- [ ] T083 [US2] **G3a evidence**: all four spike notes committed in `research.md` §Addenda with an explicit PASS or FAIL and, for any FAIL, the fallback taken

### B1: crypto, canonical CBOR, compression, BIP-39 (Gate G3)

- [x] T084 [US2] Implement the libsodium safe wrapper in `crates/memry-core/src/crypto/sodium.rs`: `sodium_init` once behind `Once`, roughly ten functions, `sodium_memzero` paired with `zeroize` on every Rust-owned buffer, and `crypto_pwhash` OOM surfaced as a distinct typed error rather than "wrong phrase" (research R3)
- [x] T085 [US2] Implement `crates/memry-core/src/crypto/keys.rs`: the seven KDF contexts and subkey ids, Argon2id at 64 MiB ops 3, master key, vault key derivation with the fixed context and no vault id mixed in, `deviceId = generichash(16, ed25519_pk)`, the account key verifier as base64 strings compared as UTF-8, and the local vault key verifier over `memry/vault-key-verifier/v1/<vaultId>`
- [x] T086 [US2] Implement `crates/memry-core/src/crypto/recovery.rs`: `bip39 = "2.2.2"` English only, `Mnemonic::parse_normalized` then `to_seed_normalized("")`, seed in `Zeroizing<[u8; 64]>`, with "word not in list" and "bad checksum" as distinct error variants (research R8, FR-027)
- [x] T087 [US2] Implement `crates/memry-core/src/crypto/cbor.rs`: one `canonical_cbor::encode` over `ciborium` that applies the recursive length-first bytewise map sort **before** encoding and enforces the `CBOR_FIELD_ORDER` allowlist at the top level, with `Option::None` mapping to omission and never to `f6`/`f7` (research R6, R-B1)
- [x] T088 [P] [US2] Implement `crates/memry-core/src/protocol/compress.rs` over `flate2` `ZlibEncoder`/`ZlibDecoder`: the 1-byte flag framing ported exactly, stored under 64 bytes or when compression does not shrink, and a truncated stream as a hard error with its own regression test (research R7, R-B2)
- [x] T233 [US2] Implement the **MPAK pack container reader** of `docs/protocol/08` in `crates/memry-core/src/protocol/pack.rs`: `MPAK` magic, version 1, the 8-byte header, the 53-byte footer, the `PACK_MAX_ENTRIES` 4096 ceiling and the three kind codes (`record` 0, `crdt_snapshot` 1, `crdt_update` 2); **reader only** — the writer is server-side and is deliberately not ported (`packages/contracts/test-vectors/README.md` rule 1) — and `crates/memry-core/tests/pack_vectors.rs` covering the committed `pack-container` class, 5 cases plus 5 error cases. Discovered while closing T089: no Phase 3 task assigned it.
- [x] T234 [US2] Implement **device linking** of `docs/protocol/03` in `crates/memry-core/src/protocol/linking.rs`: the X25519 ECDH, the three HKDF subkeys (`memrylnk/5`, `memrymac/6`, `memrysas/7`), the scan and confirm channel MACs, the master key block, and the SAS derivation **reproducing the modular bias rather than correcting it** (§3.6); plus `crates/memry-core/tests/linking_vectors.rs` covering the committed `device-linking` class, 6 cases plus 2 failure cases. The relaxed `LINKING_IP_MISMATCH` (#2184) is a settled decision — implement the chapter, not today's TypeScript. Discovered while closing T089: no Phase 3 task assigned it.
- [x] T089 [US2] Implement the vector harness in `crates/memry-core/tests/vectors.rs`: `include_str!` the committed JSON files directly from `packages/contracts/test-vectors/` so there is exactly one copy of each vector in the repo, one test function per class
- [x] T090 [US2] Add the `dryoc` cross-check test in `crates/memry-core/tests/dryoc_parity.rs`: every primitive vector run through a second, independent Rust implementation, so a `libsodium-sys-stable` build quirk cannot pass unnoticed (research R3)
- [x] T091 [US2] Define the typed error surfaces in `crates/memry-core/src/api/errors.rs`: one error enum per surface (auth, vault, sync, storage) crossing the FFI as variants, never as a rendered string (Constitution II)
- [x] T092 [US2] Export the crypto surface through UniFFI proc-macros in `crates/memry-core/src/api/crypto.rs` and write `specs/002-native-foundation-ios/contracts/core-api.md` describing the exported objects (Client, Vault, Sync, Notes, Tasks), with keys crossing as bytes and never as `String`
- [ ] T093 [US2] Add the on-device conformance target `apps/ios/MemryTests/ConformanceTests.swift`: Swift Testing `@Test(arguments:)` over the **same** vector files through the generated bindings, run under the `Conformance` test plan; the simulator run is not evidence for the `aarch64-apple-ios` crypto build (research R19)
- [ ] T094 [US2] **G3 evidence**: `cargo test -p memry-core` green on host with 100% of committed vectors passing; `crates/memry-core/build-xcframework.sh` then `git diff --exit-code packages/swift/MemryCore/Sources/MemryCore/Generated/` clean; `xcodebuild test -project apps/ios/Memry.xcodeproj -scheme Memry -destination 'platform=iOS,name=<iPhone 15>' -testPlan Conformance` green on a physical device, `.xcresult` archived

**Checkpoint, G3**: 100% of committed vectors pass in both tiers. Evidence: the host `cargo test -p memry-core` log, the clean generated-Swift diff, and the device `Conformance` test-plan `.xcresult` (SC-001).

### B2: protocol, auth, storage, record sync, CRDT (Gate G4)

- [x] T095 [US2] Define the eight foreign traits in `crates/memry-core/src/seams/`: `SecureStore`, `FileProtection`, `Notifications`, `BackgroundExec`, `Reachability`, `Transport`, `EditorHost`, `CodeCapture`, each `#[uniffi::export(with_foreign)]`, and write `specs/002-native-foundation-ios/contracts/shell-seams.md`; transport is **one** trait in `crates/memry-core/src/seams/transport.rs` with `send(request)` and `open_socket(...)`, not two, and it is deliberately dumb, one request in and status plus headers plus bytes out, with no retry, auth, or protocol logic (FR-017, data-model §D.7)
- [x] T096 [US2] Implement the runtime host in `crates/memry-core/src/api/runtime.rs`: one lazily created tokio runtime (`rt-multi-thread`, 2 to 4 workers) in a `OnceLock`, never dropped, with `on_background`/`on_foreground` hooks and a resume debounce, because tokio timers fire late-and-at-once after suspension (research R5)
- [x] T097 [US2] Implement the HTTP client logic in `crates/memry-core/src/protocol/http.rs` over the `Transport` seam: retry ladder, backoff, token refresh, error-body parsing per `docs/protocol/00`, and the `x-memry-client` header on every request (FR-034)
- [x] T098 [US2] Implement auth in `crates/memry-core/src/api/auth.rs` and `protocol/auth.rs`: email one-time code sign-in, token lifecycle and refresh, `sessionNonce` handling per `docs/protocol/02`, and device registration with the `nonce:jti` challenge signature
- [x] T099 [US2] Implement `crates/memry-core/src/storage/connection.rs`: one `Connection` per database behind `Arc<Mutex<_>>`, all SQL inside `spawn_blocking` and the mutex never held across an await, WAL, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`, and a startup assertion that `fts5` is present in `pragma_compile_options` (research R4)
- [x] T100 [US2] Implement the migration runner in `crates/memry-core/src/storage/migrations.rs`: read `PRAGMA user_version`, run each newer migration's statements in one transaction, set `user_version` **outside** that transaction immediately after it commits, forward only, never dropping a column; independent counters per database (data-model §A.0)
- [x] T101 [US2] Write `crates/memry-core/src/storage/migrations/data/0001_baseline.sql`: the source-of-record tables from data-model §A.2, `meta`, `sync_items` (no CHECK on `item_type`), `yjs_updates`, `yjs_snapshots`, `outbox`, `sync_cursors`, `attachments`, `local_notifications`, `note_bodies`
- [x] T102 [US2] Write `crates/memry-core/src/storage/migrations/data/0002_projections.sql`: the typed projections from data-model §A.4, `folders`, `notes`, `journal_entries`, `note_tags`, `tag_definitions`, `tag_categories`, `property_definitions`, `templates`, `tasks`, `projects`, `project_statuses`, `project_links`, `task_activity`, `reminders`, `settings`, `settings_field_clocks`; the journal-as-collaborative-document tables stay marked pending G1 ratification of T035 until that chapter lands
- [x] T103 [US2] Write `crates/memry-core/src/storage/migrations/index/0001_fts.sql`: `fts_notes(id UNINDEXED, title, content, tags)` and `fts_tasks(id UNINDEXED, title, description, tags)` with `porter unicode61`, plus `note_links`, `note_properties`, `index_meta`; and implement the delete-and-rebuild path for a missing, corrupt, or unexpected-version `index.db` (data-model §A.5)
- [x] T104 [US2] Implement the repositories and per-type projectors in `crates/memry-core/src/storage/repositories/`: `sync_items.payload` stored verbatim and never re-serialised, every projection a parse of a copy, and a local edit merging changed keys into the parsed copy rather than serialising the projection row (data-model §A.1, FR-033); instants the core orders by are stored as INTEGER epoch milliseconds and wire-shaped date and wall-clock values as TEXT exactly as the payload carries them (data-model §A.6)
- [x] T105 [US2] Implement the record envelope in `crates/memry-core/src/protocol/envelope.rs`: decrypt and encrypt per `docs/protocol/04`, the canonical CBOR signing payload, and **both** canonicalisations from T040, the JSON key sort for the blob and `contentHash` and the CBOR sort for the signature
- [x] T232 [US2] Implement the **packed CRDT envelope** of `docs/protocol/04` §4.11 in `crates/memry-core/src/protocol/crdt_envelope.rs` (its own file: `envelope.rs` is at the 600-line ceiling and the two envelopes share no wire shape): `pack` and `unpack` over the 160-byte header with the signature at offset 96 and the AEAD ciphertext following, and `crates/memry-core/tests/crdt_vectors.rs` covering the committed `crdt-update` class.
- [x] T106 [US2] Implement item-type negotiation in `crates/memry-core/src/protocol/types.rs`: declare exactly the 13 subscribed types from spec Assumptions, drop an unrecognised declared name silently, and treat a zero-row first page on a vault known to hold items as a failure to report and never as an empty vault (FR-032)
- [x] T107 [US2] Implement the pull loop in `crates/memry-core/src/sync/pull.rs`: cursor per scope, page limit per `docs/protocol/05`, per-item schema validation so one malformed item never poisons its page mates, the page breaker that marks a run unsuccessful without writing a success state, and tombstone handling (data-model §C.3, §D.3)
- [x] T108 [US2] Implement the sync engine state machine in `crates/memry-core/src/sync/engine.rs` exactly as data-model §C.3 draws it, with every pass serialised through an exclusive queue, because two concurrent passes race the cursor
- [x] T109 [US2] Implement the yrs document registry in `crates/memry-core/src/crdt/registry.rs`: `Arc<Doc>` per document, `Doc::with_client_id` derived from the device id, root types created before the first `apply_update`, every exported method opening and closing its own transaction through `try_transact_mut` with `TransactionAcqError` mapped to a typed error, and the `observe_update_v1` `Subscription` held for the document's lifetime (research R2)
- [x] T110 [US2] Implement the two-namespace update log in `crates/memry-core/src/crdt/update_log.rs`: server rows under the bare document id with the server's sequence, local rows under `local.<docId>` with their own, so a local append can never collide with a server sequence row
- [x] T111 [US2] Implement the document lifecycle in `crates/memry-core/src/crdt/lifecycle.rs` exactly as data-model §C.4 draws it, including `Unreadable` as a first-class state and the bounded LRU with a grace period
- [ ] T112 [US2] Implement `crates/memry-cli/src/transport.rs`: the one `Transport` foreign trait, `send` over `reqwest` and `open_socket` over `tokio-tungstenite`, behind the `native-transport` feature, with no logic beyond moving bytes
- [ ] T113 [US2] Implement the CLI commands in `crates/memry-cli/src/main.rs`: `login`, `unlock --recovery-phrase-file`, `vaults`, `pull --vault`, `notes list`, `notes show`, matching the quickstart §G4 invocations exactly
- [ ] T114 [US2] G4 precondition: confirm staging is actually configured for the round trip before blaming the client, `BOOTSTRAP_SESSION_HMAC_KEY` present (its absence returns 501 and looks exactly like a client bug, Q10.3) and a `client_policies` row for platform `ios` existing with writes enabled; record both checks in the G4 transcript
- [ ] T115 [US2] **G4 evidence**: a recorded CLI transcript showing `login` completing against staging, the new device appearing in the desktop device list, a desktop-created vault unlocking, `pull` completing, `notes list` printing titles, and, for a pulled note, `extract_text` output equal to desktop's extracted text for the same document with matching Y.Doc state vectors after sync (byte identity of the vault file stays desktop's to prove, because the phone never writes one)

**Checkpoint, G4**: the core reads a real vault headlessly. Evidence: the T115 CLI transcript, including the staging precondition checks from T114 and the extracted-text equality with matching state vectors.

### B3: push, outbox, policy, snapshots, bootstrap, domain, search (Gate G5)

- [ ] T116 [US2] Implement the outbox in `crates/memry-core/src/sync/outbox.rs`: every change written to `outbox` and its source table in **one** transaction that commits before any acknowledgement reaches the shell, the editor surface, or the user; collapse-to-newest applies to non-CRDT operations only, and CRDT rows are acknowledged per sequence because collapsing them would drop updates a peer has not seen (FR-030, data-model §C.4)
- [ ] T117 [US2] Implement the push wave in `crates/memry-core/src/sync/push.rs`: `PUSH_BATCH_SIZE` 100 halving down to 1 on a 5xx with the reduced size held as a ceiling for the rest of the run, `MAX_PUSH_ITERATIONS` 50, CRDT updates pushed before record operations so a body edit never lands on a tombstone
- [ ] T118 [US2] Implement client policy in `crates/memry-core/src/sync/policy.rs`: `ReadOnly`, `BlockedUpgrade` and `Unentitled` as three distinct states that never collapse, each parking the outbox with no attempt, no backoff and no row removed, reads never gated, and the policy learned from `clientPolicy` on `GET /sync/status` without attempting a write (FR-035, data-model §C.3)
- [ ] T119 [US2] Implement snapshot push and prune in `crates/memry-core/src/crdt/snapshots.rs` under the client obligation written at T041, including the watermark stability rule
- [ ] T120 [US2] Implement the bootstrap session client in `crates/memry-core/src/sync/bootstrap.rs` per `docs/protocol/10`, including the behaviour when a first sync outlives the 6-hour absolute lifetime and falls back to steady-state pacing mid-run (Q10.2)
- [ ] T121 [US2] Implement the realtime hint client in `crates/memry-core/src/sync/socket.rs` over the `Transport` seam's `open_socket` per `docs/protocol/09`: a hint triggers a pull, the socket is never a data path, with the reconnect and backoff policy the chapter now states
- [ ] T122 [US2] Implement the first-sync sub-sequence in `crates/memry-core/src/sync/first_sync.rs`: refs to the end, then metadata newest first, then bodies for the recent window, durable before the cursor advances so a kill resumes, with determinate progress reported to the shell and app open never blocked (FR-028)
- [x] T123 [US2] Implement `crates/memry-core/src/crdt/text_extract.rs`: `extract_text(doc)`, a plain-text walker over the `prosemirror` XmlFragment that keeps heading and list markers, feeding FTS indexing and list previews; the core never parses or serialises BlockNote markdown, so this is the only text operation it owns
- [ ] T124 [US2] Implement the markdown conversion pair **in the editor bundle**, `packages/editor-web/src/markdown-bridge.ts`: the existing `export-markdown` message plus a new `seed-from-markdown` used on note creation and template application, with both messages added to `packages/contracts/src/webview-bridge.ts` at `BRIDGE_PROTOCOL_VERSION` 1; BlockNote and `@memry/editor-schema` are the only markdown implementation on the phone path. The create-time `content` payload is handed to `seed-from-markdown` **verbatim**: the guest splits frontmatter with the shared splitter already in the bundle (`@memry/shared`) and parses the body with BlockNote, so the core does no markdown handling at all, frontmatter included. A new note's tags and properties come from the note record payload, never from frontmatter
- [ ] T125 [US2] Implement `crates/memry-cli/src/edit.rs`: `notes edit --append` applies a minimal schema-shaped `blockContainer > paragraph > text` node through yrs, purely so the G5 round trip has a headless write that a real desktop renders correctly; it is not a markdown path and it is not reachable from the phone
- [ ] T126 [P] [US2] Implement notes, folders and templates domain logic in `crates/memry-core/src/domain/{notes,folders,templates}.rs`: create, rename, move, delete, create-from-template, with folder ids as paths (data-model §A.4)
- [ ] T127 [P] [US2] Implement tags and properties domain logic in `crates/memry-core/src/domain/{tags,properties}.rs`: tags stored exactly as typed and deduped case-insensitively, property values never retyped by an edit, matching desktop semantics (FR-047, FR-048)
- [ ] T128 [P] [US2] Implement journal domain logic in `crates/memry-core/src/domain/journal.rs`: one entry per calendar day keyed `j<YYYY-MM-DD>`, routed as a collaborative document per T035 (FR-054)
- [ ] T129 [P] [US2] Implement tasks and projects domain logic in `crates/memry-core/src/domain/{tasks,projects}.rs`: field-level merge over `field_clocks` per `docs/protocol/06`, task views (today, upcoming, by-project, completed) with desktop membership semantics, projects read and assign only (FR-057, FR-060)
- [ ] T130 [P] [US2] Implement settings domain logic in `crates/memry-core/src/domain/settings.rs`: the payload is parsed as **raw JSON** and merged by dotted path rather than through a closed schema, so a group this core does not model survives verbatim instead of being stripped on parse (Q13.1, FR-033, FR-063)
- [ ] T131 [US2] Implement search in `crates/memry-core/src/domain/search.rs`: FTS5 queries over `fts_notes` and `fts_tasks` with `bm25(fts_notes, 0.0, 2.0, 1.0, 1.0)` and `bm25(fts_tasks, 0.0, 2.0, 1.0, 1.0)`, which are part of the contract and not a tuning knob, indexed from `extract_text` output (T123), plus incremental maintenance against `index_meta` watermarks (FR-053)
- [ ] T132 [US2] Real-adapter seam test: outbox durability, in `crates/memry-core/tests/outbox_durability.rs` against a real `rusqlite` database, asserting the **order** against a call log, that a refused store acknowledges nothing, and that a simulated process death leaves the batch either present or never acknowledged (Constitution III, FR-030)
- [ ] T133 [US2] Real-adapter seam test: CRDT convergence, in `crates/memry-core/tests/crdt_convergence.rs` against real yrs and a real database, asserting a concurrent core edit and desktop edit converge to a byte-identical document rather than to "both contain the words"
- [ ] T134 [US2] Real-adapter seam test: delete versus edit, in `crates/memry-core/tests/tombstone.rs`, asserting a note deleted on one device while edited on the other resolves deterministically and identically, with the body update orphaned rather than resurrecting the note
- [ ] T135 [US2] Real-adapter seam test: unknown fields and unknown types, in `crates/memry-core/tests/unknown_fields.rs`, asserting a newer-desktop payload survives an edit cycle with unmodelled keys intact and that a page carrying an unsubscribed type neither fails the page nor advances the cursor past unprocessed work (SC-014, FR-032, FR-033)
- [ ] T136 [US2] Real-adapter seam test: offline then reconnect, in `crates/memry-core/tests/offline_reconnect.rs`, asserting a queued wave drains completely after a simulated reachability transition and that the drain runs on the transition rather than waiting for the next timer
- [ ] T137 [US2] Real-server drill: kill switch, run through `memry-cli` against staging with the `ios` write switch flipped, asserting `PLATFORM_WRITES_DISABLED` is reported, the outbox is intact with `attempt_count` unchanged, reads continue, and the queue drains on the first pass after the switch clears (FR-015, FR-070)
- [ ] T138 [US2] Close `specs/002-native-foundation-ios/spec-defects.md`: every question that required reading implementation source during B1 to B3 is logged and closed by a specification change; SC-002 requires zero open entries at this gate; each entry links the chapter diff that closed it, so the log is auditable rather than assertable
- [ ] T139 [US2] **G5 evidence**: a recorded round-trip session showing `memry-cli` edit to desktop under 5 s and desktop edit to `memry-cli` under 5 s, the concurrent note and task edits converging with both field changes surviving, the T137 kill-switch drill output, `cargo test -p memry-core` green including T132 to T136, and `spec-defects.md` with zero open entries

**Checkpoint, G5**: the write path is trusted headlessly. Evidence: the T139 recorded session plus the `cargo test -p memry-core` output and the empty open-entry list in `spec-defects.md` (SC-002, SC-004). **No shell UI may start before this checkpoint** (FR-016).

---

## Phase 4: User Story 3, open your vault on your iPhone (P1), train C1 part 1

**Goal**: sign in, unlock by recovery phrase or by scanning a desktop code, pick a
vault, browse real notes and folders read-only.

**Independent Test** (spec US3): on a phone that has never seen it, take a real
desktop-created vault, sign in, unlock by recovery phrase, then unlock a second phone
by scanning the desktop's code; verify recent content is browsable. Repeat on an
account holding two vaults.

- [ ] T140 [US3] Implement `apps/ios/Memry/Core/CoreExecutor.swift`: one serial `DispatchQueue` fronting every core call through `withCheckedThrowingContinuation`, since UniFFI objects are `@unchecked Sendable` and a Swift actor would double-serialize (research R15)
- [ ] T141 [US3] Implement `apps/ios/Memry/Core/CoreEvents.swift`: the Rust-to-Swift event foreign trait whose Swift implementation only yields into an `AsyncStream` with `.bufferingNewest(256)` and never re-enters the core, because callbacks run synchronously on the calling Rust thread while locks may be held
- [ ] T142 [P] [US3] Implement `apps/ios/Memry/Core/ErrorMapping.swift`: each core error enum rendered to user-facing copy in the shell, with no raw error object ever shown (Constitution II); the same change adds `apps/ios/Memry/Core/Log.swift`, an OSLog `Logger` per subsystem as the shell's only logging path, with no `print` in the target and no key material, token, or note text ever passed to it (Constitution II, FR-023)
- [ ] T143 [US3] Implement `apps/ios/Memry/Seams/Keychain.swift`: the five `KEYCHAIN_ENTRIES` under `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` with `kSecUseDataProtectionKeychain`, non-synchronizable, values as raw bytes and never base64 strings, `SecItemAdd` as add-or-update, and `errSecInteractionNotAllowed` (-25308) surfaced as "locked" rather than "absent" (data-model §B, research R11)
- [ ] T144 [P] [US3] Implement `apps/ios/Memry/Seams/FileProtection.swift`: `Application Support/<bundle>/vault/<vaultId>/` created with `completeUntilFirstUserAuthentication`, `isExcludedFromBackup = true` on the directory, and the protection class re-asserted on the `-wal` and `-shm` sidecars after first open, because sidecars do not inherit it reliably; a test asserts the **effective** class read back from the database file and both sidecars after the first open equals `NSFileProtectionCompleteUntilFirstUserAuthentication`
- [ ] T145 [US3] Implement `apps/ios/Memry/Seams/Transport.swift`: the single `Transport` seam, `send` over `URLSession` (large blob fetches returning a file path rather than `Data`) and `open_socket` over `URLSessionWebSocketTask` (closed on background, reopened on foreground), with zero retry, auth, or reconnect logic, all of which stays in Rust
- [ ] T146 [P] [US3] Implement the two small seams: `apps/ios/Memry/Seams/Reachability.swift` over `NWPathMonitor`, reporting online and whether the path is expensive with no interpretation of either, and `apps/ios/Memry/Seams/Camera.swift`, `AVCaptureMetadataOutput` with `.qr`, output added **before** `metadataObjectTypes` is set and debounced to the first valid hit then `stopRunning()` (research R13)
- [ ] T147 [US3] Implement `apps/ios/Memry/Features/Auth/SignInView.swift`: email one-time code entry with `.textContentType(.oneTimeCode)`, paste and typing as the real mechanism, with autofill treated as a bonus that may arrive 10 to 15 s late
- [ ] T148 [US3] Implement `apps/ios/Memry/Features/Auth/GoogleSignIn.swift`: `ASWebAuthenticationSession` with authorization code plus PKCE against the iOS OAuth client, `prefersEphemeralWebBrowserSession = true`, `state` and verifier validated, the ID token posted to the existing `POST /auth/oauth/google/native`, `canceledLogin` treated as a non-error, and no GoogleSignIn-iOS SDK anywhere in the target (research R14)
- [ ] T149 [US3] Implement `apps/ios/Memry/Features/Auth/AppleSignIn.swift`: `AuthenticationServices` Sign in with Apple, persisting the name and email delivered on the **first** authorization because the platform never delivers them again, and accepting a private relay address (FR-018)
- [ ] T150 [US3] Add the additive `apple` provider server-side in `apps/sync-server/src/routes/auth.ts`: Apple identity token verification on the same native endpoint, with the sync-server suite green in the same change and header-less legacy clients byte-identical (plan Decision Record Fidelity)
- [ ] T151 [US3] Implement the Apple account-link step in `apps/ios/Memry/Features/Auth/AppleAccountLink.swift` plus its server counterpart: a relay address cannot be matched to an existing account by email, so the flow offers an explicit link-to-existing-account path that verifies the real address with a one-time code before linking (spec Assumptions, App Review 4.8)
- [ ] T152 [US3] Implement `apps/ios/Memry/Features/Unlock/RecoveryPhraseView.swift`: 24-word entry, the verifier checked **before** any key is stored so a wrong phrase leaves nothing partially unlocked, and errors that distinguish an unknown word from a checksum failure and from an Argon2id OOM (FR-019, FR-027)
- [ ] T153 [US3] Implement `apps/ios/Memry/Features/Unlock/QRLinkView.swift`: scan through the `CodeCapture` seam, with manual code entry as the real fallback and not a nicety, since the camera does not exist in CI (research R13)
- [ ] T154 [US3] Implement `apps/ios/Memry/Features/Unlock/SASConfirmView.swift`: the short verification code displayed on both screens, with the desktop confirming before any key material transfers, and a scan by an already-linked device resolving to the existing registration rather than minting a duplicate (FR-020, spec edge case)
- [ ] T155 [US3] Implement `apps/ios/Memry/Features/Vaults/VaultListView.swift`: every vault on the account listed at the unlock step and the switch reachable later from settings, driving the core's `Unlocked -> VaultChoice` transition rather than computing one, with queued writes for the previous vault preserved and never misattributed (FR-021, data-model §C.2, spec edge case)
- [ ] T156 [US3] Implement `apps/ios/Memry/Features/Notes/NotesListView.swift` and `apps/ios/Memry/Features/Folders/FolderTreeView.swift`: the same hierarchy as desktop, rendered from core snapshots, with `navigationDestination` kept out of lazy containers (research R15)
- [ ] T156a [US3] Implement the notes and folders CRUD surface in `apps/ios/Memry/Features/Notes/NoteActions.swift` and `apps/ios/Memry/Features/Folders/FolderActions.swift`: create (empty and from a template), rename, move and delete, offered through system context menus and swipe actions, each action a call into the T126 core APIs with no logic of its own (FR-039)
- [ ] T157 [US3] Implement `apps/ios/Memry/Features/Notes/NoteReadView.swift`: read-only markdown rendering as the pre-editor surface, explicitly labelled as the placeholder T176 replaces
- [ ] T158 [US3] Implement `apps/ios/Memry/Features/Sync/SyncStatusView.swift`: the degraded-state vocabulary shared with desktop (offline, syncing, locked, read-only, unentitled) plus determinate first-sync progress, each state a value the core computed (FR-075, FR-028)
- [ ] T159 [US3] Implement sign-out and revocation in `apps/ios/Memry/Features/Account/SignOutService.swift`: sign-out deletes all five keychain entries, both database files and `images/`, and zeroes in-memory keys; a revocation detected on next contact does the same and records why so the locked screen can explain itself (FR-025, FR-026)
- [ ] T160 [P] [US3] Implement `apps/ios/Memry/Design/Tokens.swift`: the tokens mirrored from `DESIGN.md`, with logical leading/trailing properties only, dynamic type, and reduce-transparency and reduce-motion branched at the modifier level (FR-077)
- [ ] T161 [US3] Device test `apps/ios/MemryTests/UnlockTests.swift` plus a scripted device run: every real desktop-created test vault unlocks by recovery phrase and, separately, by device linking, on a physical iPhone against staging (SC-003)
- [ ] T162 [US3] **SC-001 and SC-003 evidence**: the T094 device `Conformance` `.xcresult` re-run against this build, plus the T161 device test output naming each vault unlocked by each of the two paths, recorded before any external testing

**Checkpoint**: a read-only companion on a real vault. Evidence: the T162 device test output and `.xcresult`.

---

## Phase 5: User Story 4, edit notes anywhere, offline first (P1), train C1 part 2 (Gate **G6**)

**Goal**: the WebView-hosted BlockNote editor over bridge protocol v1, with the core
owning the document and the guest persisting nothing.

**Independent Test** (spec US4): with sync suspended, edit and create notes;
force-quit; relaunch; reconnect; every edit appears on desktop intact, and a
concurrent desktop edit to the same note merges without loss.

- [ ] T163 [US4] Implement `apps/ios/Memry/Editor/EditorWebView.swift`: a `WKWebView` subclass loaded with `loadHTMLString(html, baseURL: about:blank)` on a configuration whose `websiteDataStore` is `.nonPersistent()`, one long-lived instance owned by an `@Observable` host above the view tree, `isInspectable` under `#if DEBUG` only (research R10)
- [ ] T164 [US4] Implement `apps/ios/Memry/Editor/BridgeMessageHandler.swift`: `WKScriptMessageHandler` registered through a **weak proxy** and removed in `deinit`, because `add(_:name:)` retains the handler and a strong registration leaks the whole host
- [ ] T165 [US4] Implement the host-to-guest send path in `apps/ios/Memry/Editor/BridgeSend.swift` using `callAsyncJavaScript(_:arguments:in:.page)`, passing the envelope as a value rather than re-parsing a 350 KB source string every 24 ms, with the shim injected as a `WKUserScript` at document start in `.page`
- [ ] T166 [US4] Implement the bridge replica feed in `crates/memry-core/src/crdt/bridge.rs` behind the `EditorHost` seam, whose Swift conformance is the type `EditorHostBridge` in `apps/ios/Memry/Editor/EditorHostBridge.swift`: the core sends `doc-load` and update batches, receives guest updates, and applies them; batching lives on both ends (Constitution V, SC-016)
- [ ] T167 [US4] Enforce the durability order in `crates/memry-core/src/crdt/bridge.rs`: a guest update is appended to `yjs_updates` and enqueued in `outbox` in one transaction, and the in-memory document advances only after that transaction commits, with a test asserting the order against a call log rather than eventual appearance (FR-030)
- [ ] T168 [US4] Implement `apps/ios/Memry/Editor/KeyboardToolbar.swift`: override the `inputAccessoryView` getter on the `WKWebView` subclass to return a cached `UIInputView` hosting the SwiftUI toolbar through `UIHostingController`, with an explicit height and `translatesAutoresizingMaskIntoConstraints = true`, returning `nil` to hide WebKit's default bar (research R16)
- [ ] T169 [US4] Apply `glassEffect` inside one `GlassEffectContainer` on the editor toolbar and nowhere else in the app; branch on reduce-transparency at the modifier level and capture a device screenshot, since Liquid Glass on keyboard accessory views is undocumented (research §E)
- [ ] T170 [US4] Build the editor asset: emit `packages/editor-web/dist/editor.html` (raw, 1.19 MB) and `packages/editor-web/dist/manifest.json` carrying `contractHash` over inputs and `sha256` over output bytes plus `byteCount` (research R17)
- [ ] T171 [US4] Generate `apps/ios/Memry/Generated/EditorWebAsset.swift` from the manifest and add `apps/ios/Memry/Resources/editor.html` as a file reference; Node never runs from an Xcode build phase
- [ ] T172 [US4] Write `apps/ios/Memry/Scripts/verify-editor-asset.sh` and wire it as an Xcode run script with declared inputs and outputs, comparing `shasum` of the bundled `editor.html` against the manifest and failing the build on a mismatch (FR-042)
- [ ] T173 [US4] Implement the runtime handshake in `apps/ios/Memry/Editor/BridgeHandshake.swift`: the `ready` message carries the loaded bundle's `contractHash`, a mismatch or an absent hash **refuses** to initialise the editor surface rather than warning, and increments a counted `staleAsset` event (FR-042, SC-009)
- [ ] T174 [US4] Add the secure-context smoke assertion to the editor boot path in `packages/editor-web/src/bridge.ts` and assert it in `apps/ios/MemryTests/EditorSecureContextTests.swift`: `window.isSecureContext && !!crypto.subtle`, failing loudly if the opaque origin is not a secure context
- [ ] T175 [US4] Implement content-process-termination recovery in `apps/ios/Memry/Editor/EditorWebView.swift`: on `webViewWebContentProcessDidTerminate`, reload, await `ready`, replay a full `doc-load`, with a test that the replica returns to the core's state
- [ ] T176 [US4] Implement the refuse-to-edit path in `apps/ios/Memry/Features/Notes/NoteEditorView.swift`: when the loaded bundle cannot build every node type in the document, the body is not opened for editing, the refusal is stated plainly, reading stays available through `note_bodies`, and no node is removed (FR-043, data-model §C.4 `Unreadable`)
- [ ] T177 [P] [US4] Implement wiki-link navigation and autocomplete: the guest half in `packages/editor-web/src/wiki-links.ts` flushing a navigation message immediately rather than behind the 24 ms batch, and the resolution half in `crates/memry-core/src/domain/wiki_links.rs` including `Title#Heading` targets and prefix-then-substring candidates (FR-046)
- [ ] T178 [P] [US4] Implement tags and properties editing UI in `apps/ios/Memry/Features/Notes/{TagsView,PropertiesView}.swift` over the T127 core APIs, preserving letter-case and never retyping a property value (FR-047, FR-048)
- [ ] T179 [P] [US4] Implement create-from-template in `apps/ios/Memry/Features/Notes/TemplatePickerView.swift`: the template's markdown is seeded into the new document through the `seed-from-markdown` bridge message (T124), never by a Rust markdown parser (FR-049)
- [ ] T180 [P] [US4] Implement undo and redo in `apps/ios/Memry/Editor/EditorCommands.swift` through the bridge `exec` command, flushed immediately (FR-050)
- [ ] T181 [US4] Implement lazy inline image fetch in `crates/memry-core/src/domain/attachments.rs` plus `apps/ios/Memry/Features/Notes/InlineImageView.swift`: unmetered-first by default with an explicit per-item override, a placeholder while bytes are absent, a bumped revision making a late file visible without recreating the note, and a bounded cache (FR-045)
- [ ] T182 [US4] Implement the background flush order in `apps/ios/Memry/App/SceneLifecycle.swift`: send the editor flush and await the resulting persists (bounded, because iOS gives a backgrounding app seconds), **then** drain the outbox; draining first reads the queue before the last keystrokes have finished their round trip
- [ ] T183 [US4] Expose the boundary counters from the core in `crates/memry-core/src/crdt/bridge.rs` and surface them in `apps/ios/Memry/Editor/BridgeMetrics.swift`: an **FFI-call counter**, a bridge envelope size and cadence histogram, `envelopesSent`, messages-per-envelope, `seq` gaps, resyncs, and `staleAsset`; they are core-owned values so a device test can assert them rather than a human reading a debug panel (SC-016)
- [ ] T184 [US4] Write the editor smoke UI test `apps/ios/MemryUITests/EditorSmokeTests.swift` (XCTest, the one UI test in the plan): the editor is not blank and accepts a character, plus an RTL case with the app forced to a right-to-left locale; editor semantics stay in the web-layer tests
- [ ] T185 [US4] Automate the offline matrix as a Swift Testing plan, `apps/ios/MemryTests/OfflineMatrixTests.swift` driven by `apps/ios/Memry/Scripts/offline-matrix.sh`: network conditioning through `xcrun simctl status_bar` and the network link conditioner profile rather than a human toggling airplane mode, edit and create, force-quit, relaunch, reconnect, with the **run count recorded** in the test output and 100% completion required across at least 20 runs (SC-008)
- [ ] T186 [US4] **G6 evidence**: an Instruments trace captured on a physical iPhone 15, release build, typing 30 characters into a 50 KB note showing keystroke-to-render under 50 ms; a device test asserting the T183 core counters, FFI calls per keystroke equal to zero and the envelope histogram showing no flush faster than 24 ms and no envelope over 256 KB; and a recorded stale-asset run where `editor.html` is swapped for a previous build and the surface refuses to initialise with the `staleAsset` counter at 1

**Checkpoint, G6**: editing is trusted on device. Evidence: the Instruments trace file, the counter readout and the stale-asset refusal recording (SC-006, SC-009, SC-016). The T185 offline matrix is counted once, at G7.

---

## Phase 6: User Story 5, organise and find (P2), train C2 begins

**Goal**: folder operations, tag browsing, and ranked offline full-text search.

**Independent Test** (spec US5): create, rename, move and delete folders and verify
each on desktop; then in airplane mode search a phrase present in a note, a task and
a journal entry and verify all three are found in desktop's order.

- [ ] T187 [US5] Implement folder operations UI in `apps/ios/Memry/Features/Folders/FolderOpsView.swift` over the T126 core API: create, rename, move, delete, with the resulting hierarchy identical to desktop (FR-051)
- [ ] T188 [P] [US5] Implement tag browsing in `apps/ios/Memry/Features/Tags/TagsBrowseView.swift`: every tag with its tagged items, desktop letter-case behaviour (FR-052)
- [ ] T189 [US5] Implement search UI in `apps/ios/Memry/Features/Search/SearchView.swift`: ranked cross-type results over notes, journal entries and tasks, each opening the right item, working offline, with the surface stating that its scope is full text because semantic search is desktop-only (FR-053, FR-076)
- [ ] T190 [US5] Ranking parity test `crates/memry-core/tests/search_ranking.rs`: over a fixed corpus, the core's result order equals desktop's for the same queries, asserted against recorded desktop output rather than against intuition (FR-053)
- [ ] T191 [US5] Search p95 test `apps/ios/MemryTests/SearchPerformanceTests.swift`: first page under 300 ms at the 95th percentile on a 10,000-item vault on the iPhone 15, release build (SC-015)
- [ ] T192 [US5] Incremental index maintenance test `crates/memry-core/tests/index_rebuild.rs`: a sync apply and a local edit both update `index.db` against the `index_meta` watermark, and deleting the whole file rebuilds it from `data.db` without touching a `data.db` row

---

## Phase 7: User Story 6, daily journal on the go (P2), train C2

**Goal**: today's entry in one interaction, one entry per day, full editor.

**Independent Test** (spec US6): open today's entry from a fresh app start in one
interaction, write content, then open a past date and verify the desktop-created
entry for that date appears and is editable.

- [ ] T193 [US6] Implement `apps/ios/Memry/Features/Journal/JournalTodayView.swift`: today's entry reachable in one interaction from app open, created if absent (FR-054), with date navigation and backfill in `apps/ios/Memry/Features/Journal/JournalDateView.swift` and never a duplicate entry for the same day
- [ ] T194 [US6] Route journal bodies through the same editor and document manager as notes, keyed `j<YYYY-MM-DD>` per T035, in `apps/ios/Memry/Features/Journal/JournalEditorHost.swift` (FR-055)
- [ ] T195 [US6] Real-adapter test `crates/memry-core/tests/journal_merge.rs`: same-day concurrent core and desktop journal edits merge into one entry, and a wrong device clock changes neither "today" resolution predictability nor convergence (spec edge case)

---

## Phase 8: User Story 7, manage tasks and get reminded (P2), train C2

**Goal**: task capture, scheduling, completion, recurrence, project assignment, and
notifications that fire with the app closed.

**Independent Test** (spec US7): create a recurring task with a reminder; complete an
instance; recurrence advances, desktop reflects it, and the reminder fires on time
with the app closed.

- [ ] T196 [US7] Implement occurrence expansion in `crates/memry-core/src/domain/reminders.rs`: recurrence expanded to concrete occurrences **in Rust**, never in the shell, with stable ids `reminder.<syncItemId>.<occurrenceEpoch>` (FR-037, research R12)
- [ ] T197 [US7] Implement the reconcile pass in `crates/memry-core/src/domain/reminders.rs` over `local_notifications`: a rolling window budgeted at 56 of the platform's 64 slots, recomputed from already-synced data, with the pending count exposed to the shell (FR-062, SC-011)
- [ ] T198 [US7] Implement `apps/ios/Memry/Seams/Notifications.swift`: `UNCalendarNotificationTrigger` per occurrence, generic body text by default because the system stores notification bodies in plaintext, and authorization requested **after** the first reminder is created rather than at launch (research R12)
- [ ] T199 [US7] Register `BGAppRefreshTask` (`com.memry.sync.refresh`) exactly once through the SwiftUI `.backgroundTask` scene modifier in `apps/ios/Memry/App/MemryApp.swift`, re-submitted at the start of each run with `earliestBeginDate = now + 15 min`; double registration kills the app; register `BGProcessingTask` (`com.memry.sync.maintenance`) for post-link download, index rebuild and compaction and `BGContinuedProcessingTask` for a user-initiated Sync now in the same change; only scene registration lives under `App/`, and the `BackgroundExec` seam conformance lives in `apps/ios/Memry/Seams/BackgroundExec.swift`
- [ ] T200 [US7] Device test with the LLDB `_simulateLaunchForTaskWithIdentifier:` SPI, scripted in `apps/ios/Memry/Scripts/simulate-bg-launch.sh`: the refresh task completes a sync pass **with the device locked**, proving the after-first-unlock keychain class and file protection class actually work; the run records the task's **wall time** so the community-observed 30 s budget stops being a guess (research §E), and the expiry handler is exercised too; the simulator never runs background tasks and is not evidence
- [ ] T201 [P] [US7] Implement task views in `apps/ios/Memry/Features/Tasks/TaskViews.swift`: today, upcoming, by-project, completed, with desktop membership semantics (FR-057)
- [ ] T202 [P] [US7] Implement task create and edit in `apps/ios/Memry/Features/Tasks/TaskEditorView.swift`: due and scheduled dates, priority, recurrence, project assignment (FR-056)
- [ ] T203 [US7] Implement note-checkbox and task consistency in `crates/memry-core/src/domain/tasks.rs`: reconciliation runs through the Y.Doc, reading the `inlineCheckbox` and `taskBlock` nodes via yrs and writing the completion back through the same nodes, with the task projection in the same module kept in step; completing in either place on the phone leaves the body document and the task views consistent, and the core never reads or writes markdown to do it (FR-058)
- [ ] T204 [P] [US7] Implement the projects surface in `apps/ios/Memry/Features/Projects/ProjectsView.swift`: read and assign, with the interface stating plainly that creating and editing projects is not available on the phone in this feature rather than failing silently (FR-060, FR-076)
- [ ] T205 [US7] Implement the reminders limitation notice in `apps/ios/Memry/Features/Reminders/RemindersSettingsView.swift`: the app states that only the nearest window is scheduled and that it refills on foreground and on background refresh (FR-062)
- [ ] T206 [US7] On-device timed reminder scenario `apps/ios/MemryTests/ReminderFireTests.swift`: schedule reminders inside the current window, close the app, and record fire time against scheduled time across a stated **run count**, with 99% inside 1 minute required (SC-011)
- [ ] T207 [US7] Real-adapter test `crates/memry-core/tests/task_field_merge.rs`: a date changed on desktop and a priority changed on the phone both survive, and a reminder for an item completed or deleted elsewhere resolves to a sensible open state rather than a ghost (FR-059, FR-061)

---

## Phase 9: User Story 8, settings and safety follow you (P3), train C2 ends (Gate **G7**)

**Goal**: synced preferences applied, read-only mode explained, devices listed and
removable, account deletable, telemetry opt-out present.

**Independent Test** (spec US8): flip the service-side read-only switch while the app
holds queued offline writes; the app drops to read-only with a plain explanation,
reading continues, the queued writes survive and sync when the switch clears. Then
remove a device and delete an account from inside the app.

- [ ] T208 [US8] Implement settings application in `apps/ios/Memry/Features/Settings/SettingsApply.swift`: each synced preference whose concept exists applies, a preference with no equivalent leaves its surface at its default and logs **no** error, and unmodelled groups round-trip unstripped per T130 (FR-063)
- [ ] T209 [US8] Implement read-only mode UI in `apps/ios/Memry/Features/Sync/ReadOnlyBanner.swift`: three distinct explanations for kill switch, version floor, and no active plan, each with its own exit, each using desktop's vocabulary, and the queued-write count visible so a user can see nothing was discarded (FR-035, FR-075); the unentitled variant lives in `apps/ios/Memry/Features/Settings/EntitlementNotice.swift`, keeps already-synced content readable, and names no price, links nowhere, and steers toward no purchase mechanism (FR-065)
- [ ] T210 [P] [US8] Implement the device list in `apps/ios/Memry/Features/Devices/DeviceListView.swift`: every registered device shown, any removable, over a core API (FR-064)
- [ ] T211 [US8] Implement account deletion in `apps/ios/Memry/Features/Account/DeleteAccountView.swift`: the flow completes in-app against the existing service-side deletion behaviour and runs the T159 local wipe so no key material or vault content is left behind (FR-066, App Review 5.1.1(v))
- [ ] T212 [P] [US8] Implement the telemetry opt-out toggle in `apps/ios/Memry/Features/Settings/TelemetryView.swift` and assert in `apps/ios/MemryTests/TelemetryTests.swift` that no emitted event carries an account identifier or a stable device identifier, which is what earns the Data Not Linked to You declaration (FR-067, research R18)
- [ ] T213 [US8] Device drill: revocation, revoke this device from another device while it is offline; on next contact it locks, removes local vault content, and explains why (FR-026, spec edge case)
- [ ] T214 [US8] **G7 evidence**: device test logs from a physical iPhone 15 against staging showing a 10,000-item vault browsable within 2 min of unlocking on Wi-Fi (SC-007), the T191 search p95 under 300 ms, the reminder reconcile pending count never exceeding 56 across a 5,000-reminder seed, and the offline matrix at 100% across at least 20 runs (SC-008)
- [ ] T214a [US7] Device-to-desktop timed sync run `apps/ios/MemryTests/SyncLatencyTests.swift` plus a recorded session log: edit a note and a task on the phone and measure time to visibility on a real desktop, then the same in the other direction, 20 runs per direction on a healthy network, with the p95 recorded in the test output (SC-005)

**Checkpoint, G7**: scale, search, reminders, sync latency and offline durability all measured on device. Evidence: the T214 device test logs naming each measurement and the device they were taken on, plus the T214a p95 sync-latency log (SC-005).

---

## Phase 10: User Story 9, ready for testers (P3), trains C3 + D (Gates **G8**, **G8b**, **G9**)

**Goal**: a build accepted for beta distribution with declarations that are true and
a write path already proven stoppable.

**Independent Test** (spec US9): submit a build for beta distribution and have it
accepted; launch it on every supported device generation without a crash; exercise
the read-only switch end to end against that exact build before any external tester
writes to a real vault.

- [ ] T215 [US9] Write `apps/ios/Memry/Resources/PrivacyInfo.xcprivacy` declaring the four required-reason APIs: FileTimestamp `C617.1`, UserDefaults `CA92.1`, DiskSpace `E174.1`, SystemBootTime `35F9.1`; the statically linked Rust core's `stat` and `mach_absolute_time` use counts as the app's, so one manifest covers it (research R18)
- [ ] T216 [US9] Add the required-reason symbol gate to `.github/workflows/ios-ci.yml`: run `nm -u` over the built binary and fail on any required-reason symbol without a manifest entry, since `rusqlite`'s `bundled` SQLite amalgamation lands `_fstat`, `_statfs`, `_fstatvfs` and `_lstat` in the app's own symbol table
- [ ] T217 [P] [US9] Set `ITSAppUsesNonExemptEncryption = YES` in `apps/ios/Memry/Resources/Info.plist` and record the export-compliance answers in `specs/002-native-foundation-ios/compliance.md` using the checkbox wording already settled in Phase A (T049): no CCATS, annual self-classification under 5D992.c, French declaration if distributing there
- [ ] T218 [P] [US9] Write the nutrition-label worksheet into `specs/002-native-foundation-ios/compliance.md`: telemetry as Data Not Linked to You with tracking No (earned by T212), and synced note payloads as Other User Content, App Functionality, Linked, next to a description stating the service cannot read them; in the same file write the App Review notes: a pre-seeded staging vault with its recovery phrase for the reviewer, and a statement that read-only kill-switch mode explains itself visibly; then seed and verify the reviewer's staging vault itself (notes, folders, tags, tasks, a journal entry, a reminder) by unlocking it end to end on a clean device with the recorded phrase
- [ ] T219 [US9] Accessibility audit across every screen shipped in Phases 4 to 9, naming the WebView editor surface and the keyboard toolbar explicitly: WCAG AA contrast, VoiceOver labels on every interactive element including the toolbar's, reduced motion honoured, reduced transparency honoured (including the T169 glass toolbar), dynamic type inside and outside the WebView, and an RTL walk that covers the editor (FR-077, SC-013)
- [ ] T220 [US9] Launch-without-crash pass on every supported iPhone generation available, recorded per device in `specs/002-native-foundation-ios/compliance.md` (FR-069)
- [ ] T221 [US9] **G8b drill**, against the exact TestFlight build testers will receive: flip the staging `ios` write kill switch with `wrangler d1 execute` on `client_policies`, observe read-only UI without a restart and an outbox that still holds every queued write, clear the row, observe the drain, then query staging D1 for `client_platform = 'ios'` rows in `sync_items`, `crdt_updates` and `crdt_snapshots` carrying this build's version string (FR-036, FR-070; the beta does not open without this)
- [ ] T222 [US9] Archive and upload an internal TestFlight build: `xcodebuild archive` then `xcrun altool --upload-app`, early enough that ITMS mail arrives before the external ring is planned
- [ ] T223 [US9] **G8 evidence**: the App Store Connect processing mail for the internal TestFlight build showing **no** ITMS-91053 and no ITMS-91055, the T216 `nm -u` CI step green, the T219 audit checklist signed off, and the T221 switch drill recording
- [ ] T224 [US9] Open the external beta on real vaults behind the active kill switch, with the T221 drill attached to the invitation record (train D, FR-070)
- [ ] T225 [US9] Build the two-shell digest comparison harness over a digest that is defined rather than assumed: for a note, SHA-256 over the UTF-8 bytes of `title + "\n" + extract_text(doc)`; for a task or journal record, SHA-256 over the canonical JSON of that record's syncable fields. The core side is `crates/memry-core/src/crdt/digest.rs`, reached by `cargo run -p memry-cli -- digest --vault <id>`; the desktop side is `packages/contracts/scripts/digest.ts`, computing the same values through a TypeScript `extract_text` port that the `text-extract.json` vector class covers, so at least 50 items per beta account can be compared daily (SC-010)
- [ ] T226 [US9] **G9 evidence**: a 7-day digest report over at least 50 items per beta account showing 100% match on both shells with zero corrupted items reported (SC-010)

**Checkpoint, G8**: the build is store-legible. Evidence: the App Store Connect processing mail from T223.

**Checkpoint, G8b**: the switch is proven against the exact build testers receive. Evidence: the T221 drill recording (`wrangler d1 execute` flip, read-only UI without a restart, intact outbox, drain on clear) plus the attribution query output naming this build's version string.

**Checkpoint, G9**: two shells agree on real vaults for a week. Evidence: the T226 digest report.

---

## Phase 11: Polish and cross-cutting concerns

- [ ] T227 Docs impact for the whole feature: `pnpm docs:impact --base origin/main --strict` and updates under `apps/docs/src/`, covering the Rust core, the eight seams, the iOS shell, and the `packages/editor-web` move; `pnpm docs:build` green
- [ ] T228 [P] Add the Liquid Glass section to `DESIGN.md` that T016 stubbed: system components everywhere, hand-applied `glassEffect` only on the editor toolbar inside one `GlassEffectContainer`, `tabBarMinimizeBehavior` opt-in, `UIDesignRequiresCompatibility` never shipped, and both reduce-transparency and reduce-motion branches stated
- [ ] T229 [P] Walk `quickstart.md` end to end on a clean machine and a clean device, fixing any command that does not run as written; each gate section must reproduce
- [ ] T230 [P] Re-measure the G6 and G7 numbers on the final release build on the iPhone 15; a regression against a stated threshold blocks release with the force of a failing test (FR-074, Constitution V)
- [ ] T231 Delete or downgrade what the freeze made dead: `.github/workflows/mobile-ci.yml` steps whose gates now live in `ios-ci.yml`, and the `apps/mobile` entries in the architecture boundary check that no longer have a target; do not delete `apps/mobile` itself in this feature

---

## Dependencies & Execution Order

### Phase dependencies (train gates are SERIAL, per the constitution)

```
Phase 1 Setup (G2b)
  -> Phase 2 US1, trains A1 + A2 (G1, G2)
  -> Phase 3 US2, trains B0 + B1 + B2 + B3 (G3a, G3, G4, G5)
  -> Phase 4 US3, train C1 part 1
  -> Phase 5 US4, train C1 part 2 (G6)
  -> Phases 6 to 9, train C2 = {US5, US6, US7, US8} (G7)
  -> Phase 10 US9, trains C3 + D (G8, G8b, G9)
  -> Phase 11 Polish
```

A gate must be green **with the evidence artifact named in its checkpoint** before
the next phase starts. Three of them are absolute: no Rust before G2, no shell UI
before G5 (FR-016), and no external tester before G8b, the switch drill run against
the exact build they will receive (FR-070).

### Story dependencies

- **US1** (Phase 2) depends on Phase 1 only, and on nothing in the Rust or Swift
  trees. It is the one story that delivers value with no phone in the room.
- **US2** (Phase 3) depends on US1: the vectors are the gate the core is measured
  against, and the chapters are what it is built from.
- **US3** (Phase 4) depends on US2 being green headlessly.
- **US4** (Phase 5) depends on US3 for the vault, the seams, and the notes list.
- **US5, US6, US7** depend on US4 for the editor and on US2 for their domain logic.
  Within train C2 they may interleave.
- **US8** depends on everything above it having a surface to degrade.
- **US9** depends on all of them and is a release gate rather than a feature.

### Parallel opportunities

- Phase 1: T003, T004, T006, T008 and T015 to T018 once T001 and T002 exist.
- Phase 2: the eleven verifier tests T066 to T076 are one file each and run together
  once their generators land; chapters T028 to T031, T033 and T034 have no
  cross-references and can be written in any order.
- Phase 3: the domain modules T126 to T130 are separate files over a finished
  storage layer; the five real-adapter tests T132 to T136 are separate files.
- Phase 4: the seam implementations T144 and T146 land in parallel after T140 and
  T143; T145, the one transport seam, is on its own because everything waits on it.
- Phase 5 and later: UI leaf views marked `[P]` touch one file each.
- Nothing crosses a gate. A `[P]` pair inside Phase 5 may run together; a Phase 5
  task and a Phase 6 task may not.

### Parallel Example: Phase 2 verifiers

```bash
# After T055 to T065 have emitted their vector files, launch the verifiers together:
Task: "Write packages/contracts/src/__tests__/bip39-unlock.test.ts"
Task: "Write packages/contracts/src/__tests__/record-envelope.test.ts"
Task: "Write packages/contracts/src/__tests__/crdt-update.test.ts"
Task: "Write packages/contracts/src/__tests__/cbor-canonical.test.ts"
Task: "Write packages/contracts/src/__tests__/compression.test.ts"
Task: "Write packages/contracts/src/__tests__/field-merge.test.ts"
Task: "Write packages/contracts/src/__tests__/pack-container.test.ts"
Task: "Write packages/contracts/src/__tests__/markdown-roundtrip.test.ts"
Task: "Write packages/contracts/src/__tests__/payload-schemas.test.ts"
Task: "Write packages/contracts/src/__tests__/device-linking.test.ts"
Task: "Write packages/contracts/src/__tests__/text-extract.test.ts"
```

## Implementation Strategy

- **MVP = US1 + US2, which means no phone until G5.** The protocol written down and
  a second implementation proven against it is the deliverable that carries value on
  its own: the vault protocol stops being tribal knowledge and a headless client
  reads and writes a real vault. Every phone story is an increment on top of a
  foundation that was already green.
- **Risk is retired before product code touches it.** B0's four spikes exist because
  UniFFI async foreign traits, XCFramework packaging, the opaque-origin secure
  context, and Argon2id at 64 MiB on a memory-pressured phone are each capable of
  invalidating a phase. A spike that fails costs days; the same failure discovered
  in C1 costs the train.
- **Write risk is staged the same way 001 staged it.** The headless write path is
  proven against staging with a real desktop (G5) before any phone writes; the phone
  write path ships behind a kill switch already exercised against the exact build
  (T221) before an external tester touches a real vault. A mobile write bug does not
  stay on mobile, it syncs into the user's desktop vault.
- **Cuts, in the order the spec records them**: reminders first (T196 to T200 and
  T205 to T207), then QR device linking (T153, T154, the camera half of T146, and
  the linking half of SC-003), each
  recorded as a spec amendment **before** work stops. The recovery-phrase path is not
  cuttable. A separate zero-risk cut the spec records: email one-time code as the only
  sign-in, which removes T148 to T151 and App Review 4.8 from the path to TestFlight.
- **Solo pacing.** Phases are serial because there is one developer, not because
  parallelism is forbidden; slip is absorbed by the recorded cut order and never by
  skipping a gate.

## Notes

- **Accessibility is an acceptance criterion on every UI task, not a phase.** Every
  task that creates a SwiftUI surface (T147 to T160, T168 to T181, T187 to T189,
  T193 to T194, T201 to T205, T208 to T212) ships with screen-reader labels on
  interactive elements, WCAG AA contrast, logical leading/trailing layout, dynamic
  type, and reduced-motion and reduced-transparency branches. T219 is the final
  **audit**, not the first pass.
- `[P]` means different files and no dependency on an incomplete task, inside the
  same phase.
- Every task's verification standard is the constitution's definition of done: lint
  or `cargo clippy -D warnings` or SwiftLint, typecheck, tests, architecture and
  contract checks, binding regeneration where a UniFFI definition moved, and docs for
  anything user-visible or agent-relevant. No check-off without the green evidence
  (Constitution III).
- A question that required reading implementation source instead of a chapter is a
  `spec-defects.md` entry the moment it is asked, not at the end of the phase. SC-002
  counts the log, and the log is only honest if it is written while the confusion is
  fresh.
- Android follows from the same core as its own feature after iOS ships, and is out
  of this task list by decision (spec Assumptions).
