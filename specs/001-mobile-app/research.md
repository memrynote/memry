# Research: Memry Mobile

**Feature**: 001-mobile-app | **Date**: 2026-08-22 | **Plan**: [plan.md](./plan.md)

Three tiers. **A** — decisions already settled by the decision record
(`docs/ideas/2026-08-22-mobile-expo-plan.md`): carried unchanged, never
re-opened here. **B** — unknowns resolved by this research pass (desk research,
2026-08-22, sources verified). **C** — the four open risks: they stay open **by
design** until their Phase 0 spike passes; this document specifies each spike
and its pass/fail gate (plan non-negotiable #4).

## A. Settled by the decision record (carried unchanged)

| Decision                                                                                                                                                                                    | Rationale (from the record)                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Expo (managed + dev client, prebuild), `apps/mobile` in this monorepo                                                                                                                       | record §2–3                                                                        |
| Vault parity, not feature parity; Agent Chat / importers / semantic search / canvas editing out; FTS stays; canvas read-only                                                                | record §1                                                                          |
| Native RN UI; note body only in a WebView hosting BlockNote; `@memry/editor-schema` single source of truth                                                                                  | record §4                                                                          |
| **RN side owns the Y.Doc**; WebView gets a bridge provider; string-only base64-framed bridge, batched both ends (launch requirement)                                                        | record §4; WebView-owned Y.Doc + IndexedDB rejected — iOS evicts WKWebView storage |
| SQLite is the note store (no files); bodies raw markdown incl. frontmatter, byte-identical to desktop; attachments as sandbox files with NSFileProtection, never blobs                      | record §5                                                                          |
| JSI libsodium (WASM `libsodium-wrappers-sumo` will not run under Hermes); byte parity with desktop vectors is a hard gate                                                                   | record §6                                                                          |
| Yjs persistence: SQLite-backed adapter replaces `y-leveldb`; outbox persisted in SQLite                                                                                                     | record §6–7                                                                        |
| `@memry/sync-client` extracted **before** mobile code; 10 adapter seams; desktop stays green                                                                                                | record §7                                                                          |
| Foreground sync + `BGAppRefreshTask`; silent push v2; reminders via local notifications from synced data                                                                                    | record §7                                                                          |
| First sync: metadata + last 30 days of bodies, rest on demand; attachments lazy + Wi-Fi-only default                                                                                        | record §7                                                                          |
| **No cert pinning on mobile** (App Store review latency makes a bad pin unfixable); desktop placeholder pins = separate pre-existing issue                                                  | record §7, open risk 5                                                             |
| Keys in `expo-secure-store`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; no Face ID gate v1; password + recovery-phrase unlock paths                                                                  | record §8                                                                          |
| StoreKit 2 IAP in v1; entitlement `source` gains `'apple'`; either-active entitles, later expiry wins; ASSN V2 + `originalTransactionId→account`; double subscription detected and surfaced | record §9                                                                          |
| Production safety kit in Phase 2 (header, min-version table, kill switch, write attribution)                                                                                                | record §10                                                                         |
| 8-phase release train, serial gates; slip cuts canvas viewer then reminders; Phases 0–1 unskippable                                                                                         | record §11                                                                         |
| Store compliance (export declaration, privacy manifest, accurate labels, in-app account deletion) in Phase 5                                                                                | record §12                                                                         |
| TestFlight internal ring (5–10, real vaults) only after G3 + live kill switch                                                                                                               | record §13                                                                         |

## B. Resolved in this research pass

Environment baseline informing everything below: **current Expo = SDK 57**
(RN 0.86.2 at 57.0.9, React 19.2). New Architecture **mandatory** since SDK 55;
**Hermes V1 default** since SDK 56. Pin **SDK 57 ≥ 57.0.9** (57.0.0–.0.8 carry a
Hermes V1 + reanimated memory regression). Sources: expo.dev/changelog/sdk-55…57.

### B1. Device E2E framework → **Maestro** (R5 closed)

- **Decision**: Maestro (CLI 2.6.x) for device E2E; flows run via dev-client
  builds and EAS Workflows' built-in `maestro` step.
- **Rationale**: Expo's official docs document only Maestro for E2E. Detox
  20.51.x officially supports RN 0.77–0.84 while SDK 57 ships RN 0.86 — two
  releases behind current Expo, a structural lag for a solo schedule. Maestro:
  no native build hooks, built-in waits, lighter CI.
- **Alternatives considered**: Detox — gray-box sync is less flaky for pure RN
  and has a `by.web` WebView API (iOS support experimental, unverified for
  2026), but the RN-version cap decides it.
- **Consequence for the editor (feeds R4/G3 test design)**: Maestro reaches
  WKWebView content only through the OS accessibility tree — text selectors
  work when the DOM is accessible; HTML ids/`data-testid` are not reliably
  visible on iOS, and there is no JS-eval escape hatch into the app's WebView.
  Therefore: `editor-web` ships accessibility-friendly markup, and editor E2E
  asserts through **RN-side observable state** (bridge counters, saved doc
  state) rather than DOM poking. This is a test-design constraint, recorded
  here as a decision.

### B2. StoreKit client library → **expo-iap (OpenIAP)** (part of R8)

- **Decision**: `expo-iap` (~v3.4; OpenIAP monorepo, `openiap-apple`, iOS 15+,
  StoreKit 2) as the IAP client; Expo config plugin, dev-client compatible.
- **Rationale**: hyochan's `react-native-iap`/`expo-iap` repos were archived
  2026-08-04 into the actively developed OpenIAP monorepo; npm names unchanged.
  `expo-iap` is the Expo-module path; `react-native-iap` v14+ (Nitro) targets
  bare RN. Subscription status, restore, manage-subscriptions UI, JWS access
  all present.
- **Alternatives considered**: RevenueCat (paid dependency, unnecessary — our
  server already owns entitlements); StoreKit via hand-rolled Expo module
  (schedule cost, no upside in v1).
- **Open flag** (verify in Phase 5, before paywall UX finalizes): offer-code
  redemption sheet (`presentCodeRedemptionSheet`) is not confirmed in
  OpenIAP's API surface (expo-iap issue #87 open at archive time). Not needed
  for G5; do not promise offer codes until verified.

### B3. ASSN V2 verification on the sync server → **`@apple/app-store-server-library` on Workers** (part of R8)

- **Decision**: use Apple's official Node library directly in the Cloudflare
  Worker for JWS x5c `SignedDataVerifier` + ASSN V2 decoding.
- **Rationale**: Workers has full `node:crypto` incl. `X509Certificate` since
  2025-04-08, and `nodejs_compat` is default for compat dates ≥ 2026-08-04.
  Working precedent exists (`burakdede/storekit-cloudflare-workers`, MIT,
  CI-tested against `@latest`, ASSN V2 + D1) — use as reference, not a
  dependency.
- **Alternatives considered**: pure-WebCrypto reimplementation (`jose` +
  `@peculiar/x509`) — no longer necessary; hand-rolled x5c chain walk —
  rejected, crypto we should not own.

### B4. Background execution API → **`expo-background-task`** (R7 closed)

- **Decision**: `expo-background-task` (BGTaskScheduler on iOS) via
  `expo-task-manager`; `registerTaskAsync` with a minimum interval; sync drain +
  pull runs as headless app JS with native modules (network + SQLite is the
  documented intended use).
- **Rationale**: it is the current API; `expo-background-fetch` is deprecated
  and slated for removal.
- **Constraints to design for** (encode in the sync engine, verify in Phase 2):
  iOS scheduling is best-effort/deferred (possibly days for rarely-used apps) —
  the product promise stays "foreground sync + opportunistic background", per
  the record; tasks are interruptible → sync work must be resumable and
  idempotent; simulator unsupported → background-sync verification happens on
  the physical reference device; DB file protection must admit
  before-first-unlock runs (data-model.md §1 chooses
  `CompleteUntilFirstUserAuthentication` — confirm in the Phase 2 drill).

### B5. Candidate facts feeding the spikes (versions verified 2026-08-22)

| Topic                                                                                | Current state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Feeds       |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `react-native-libsodium` (serenity-kit) v1.7.0, active, Expo config plugin, New Arch | Covers crypto_pwhash (custom ops/mem ⇒ Argon2id 64 MiB/3), XChaCha20-Poly1305 AEAD, sign incl. `seed_keypair` + detached, `kdf_derive_from_key`, `generichash` (keyed, custom length), `auth`, `box_keypair`. **Only gap: `crypto_scalarmult`** — binding links **full libsodium**, so exposing it is a small C++/TS patch (upstream PR or `patch-package`), not a new native lib                                                                                                                                                                              | R1          |
| `expo-sqlite` (SDK 57)                                                               | sync+async, prepared statements, Uint8Array BLOBs, **FTS5 on by default**, SQLCipher/libsql options, kv-store; SDK 56 added native ArrayBuffer blobs + session changesets                                                                                                                                                                                                                                                                                                                                                                                      | R2          |
| `@op-engineering/op-sqlite`                                                          | JSI, `executeBatch`/`executeSync`/raw, prepared statements, ArrayBuffer, **update/commit/rollback hooks + reactive queries** (no expo-sqlite equivalent), FTS5 + custom tokenizers, `performanceMode`; prebuild-compatible, no plugin. Gotchas: config must live in **root** package.json under pnpm (podspec walks up); duplicate-SQLite-symbol clash with expo-updates/expo-sqlite (`useThirdPartySQLitePod` / `iosSqlite` workarounds). Perf claims are vendor-run — hence our own benchmark                                                                | R2          |
| Metro/pnpm                                                                           | Isolated node_modules **first-class since SDK 54** (`node-linker=hoisted` now the fallback, not the requirement); monorepo Metro config automatic since SDK 52 (no manual watchFolders); **package exports stable + default** since Metro 0.82/RN 0.79; raw `./src/*.ts` workspace exports work (Metro transpiles workspace sources) but are a **community pattern, not a documented contract** — known failure modes: `exports` maps pointing at `.ts` breaking node/tsc consumers, `react-native` condition mismatches, duplicate react/expo-module versions | R3          |
| `react-native-webview` v16.0.0 (2026-07-11)                                          | **Requires New Architecture** (fine on SDK 57). Single-string postMessage; 20 MB base64 shown passing on iOS **in release mode** (debug is drastically slower — never benchmark in debug). **No modern published throughput benchmark** (the classic slowness issue is 2018-stale; batching guidance is 2021) — exactly why R4 is a spike                                                                                                                                                                                                                      | R4          |
| Yjs under Hermes                                                                     | No known blockers: lib0 feature-detects encoders with JS fallbacks; **Hermes V1 ships TextDecoder natively** (+FinalizationRegistry, faster JSON, >4 GB heaps). Polyfills only if pre-V1 Hermes. Precedent: Serenity Notes (same authors) = E2E-encrypted Yjs on Expo                                                                                                                                                                                                                                                                                          | R4, Phase 3 |

## C. Phase 0 spikes — the four open risks (each with a pass/fail gate)

### R1 — JSI libsodium primitive coverage (record open risk 1)

- **Spike** (T0.5): integrate `react-native-libsodium` v1.7.x in the dev
  client; patch in `crypto_scalarmult` (known gap; full libsodium is linked);
  run the committed `crypto-vectors.json` (T0.4) on the physical device —
  every primitive from record §6, incl. Argon2id at exactly 64 MiB / ops 3
  (`packages/contracts/src/crypto.ts:28`) and the full vault-unlock flow vector.
- **Pass**: byte parity on **all** vectors on device; Argon2id 64 MiB completes
  without memory pressure kills. → G0(a).
- **Fail** (any mismatch or missing primitive that can't be patched): fallback
  ladder, in order — (1) upstream/patch the missing binding against the linked
  libsodium; (2) `s77rt/react-native-sodium` (bundles full libsodium submodule)
  as patch base; (3) own minimal JSI module over vendored libsodium. A fail
  **stops the train** — no feature work on unproven crypto (Constitution III).
- **Alternatives already rejected**: `react-native-nacl-jsi` (no XChaCha AEAD /
  kdf / generichash / auth), `standardnotes/react-native-sodium-jsi` (Argon2 +
  XChaCha only), WASM wrappers (won't run under Hermes — record §6).

### R2 — SQLite driver benchmark (record: "decide in research.md with a benchmark")

> **DECIDED 2026-08-23 — expo-sqlite** (owner decision, Kaan). The
> driver _choice_ no longer waits on the comparative benchmark: first-party
> maintenance, zero config-plugin friction, FTS5 on by default, and one fewer
> native module (drops the op-sqlite duplicate-SQLite-symbol risk entirely).
> The T009 rig is retained in reduced scope: it validates the §R2 workload
> **thresholds** below against expo-sqlite on the reference device (release
> build) — G0-c passes when all five thresholds hold. If a threshold fails,
> re-examine schema/indexing first; re-opening the driver question requires a
> new written decision.
>
> **G0-c RESULT (2026-08-23, iPhone 12 Pro, release build): ALL PASS 7/7.**
>
> | workload                | total   | p95     | threshold   | result |
> | ----------------------- | ------- | ------- | ----------- | ------ |
> | bulk insert 10k+10k     | 1299 ms | —       | ≤ 10 s      | PASS   |
> | 1k point reads          | 256 ms  | 0.30 ms | p95 ≤ 5 ms  | PASS   |
> | FTS5 build 10k          | 214 ms  | —       | ≤ 15 s      | PASS   |
> | 100 ranked FTS queries  | 898 ms  | 9.30 ms | p95 ≤ 30 ms | PASS   |
> | 5k blob appends         | 3120 ms | 0.74 ms | p95 ≤ 5 ms  | PASS   |
> | full log replay         | 15 ms   | —       | ≤ 2 s       | PASS   |
> | cold open → first query | 3 ms    | —       | ≤ 300 ms    | PASS   |
>
> Findings baked into the rig and binding for the real implementation:
> (1) bulk inserts MUST use prepared statements inside a transaction —
> per-row async round-trips measured 11.65 s vs 1.30 s prepared (9×);
> (2) expo-sqlite segfaults in `sqlite3Fts5IndexClose` when a connection
> holding an FTS5 vtab is closed — drop/detach FTS tables before deliberate
> closes (workaround in the rig; upstream report pending).

- **Spike** (T0.6): same benchmark app, both drivers, physical reference
  device, release build. Workload mirrors our real shapes: (a) bulk insert
  10k `sync_items` + 10k bodies (~2 KB each) in transactions; (b) 1k random
  point reads; (c) FTS5 index build over the 10k corpus + 100 ranked queries;
  (d) Yjs pattern — 5k × ~200 B BLOB appends + full-log replay read;
  (e) cold open → first query.
- **Pass/decision rule**: any driver meeting **all** thresholds — (a) ≤ 10 s,
  (b) p95 ≤ 5 ms, (c) build ≤ 15 s / query p95 ≤ 30 ms, (d) append p95 ≤ 5 ms +
  replay ≤ 2 s, (e) ≤ 300 ms — is eligible; among eligible, prefer
  **expo-sqlite** (first-party maintenance, zero config, FTS5 default) unless
  op-sqlite wins any workload by ≥ 2× **or** reactive-query hooks are judged
  necessary for list UIs in Phase 2. Decision + numbers recorded here.
- **Fail** (neither meets thresholds): re-examine schema/indexing before
  driver blame; escalate only with the table attached.
- **Constraint either way**: no `sqlite-vec` (record §6). If op-sqlite wins:
  root-package.json config + expo-updates symbol-clash workarounds are part of
  the landing checklist.

### R3 — Metro under pnpm + raw `./src/*.ts` workspace exports (record open risk 2)

- **Spike** (T0.7): scaffold `apps/mobile` on SDK 57 against the monorepo **as
  it is** (pnpm with `shamefullyHoist: true` today): import
  `@memry/contracts` (+ a pure `app-core` slice) via their raw `./src/*.ts`
  exports; `expo prebuild` + release-mode bundle + boot on device. Then verify
  no regression for the rest of the monorepo: desktop dev, landing dev, root
  typecheck all still work.
- **Pass**: clean Metro bundle with package-exports resolution (default since
  Metro 0.82), app boots, desktop/landing unaffected. → G0(b).
- **Fail modes → ordered mitigations**: (1) exports-condition mismatch → add
  `react-native`/`import` conditions or explicit `sourceExts` mapping;
  (2) hoisting interference → per SDK 54+ isolated-install support, evaluate
  scoping `shamefullyHoist` away from `apps/mobile` (repo-wide node-linker
  change is **out of scope** — desktop toolchain owns that setting);
  (3) last resort: build-step (`tsc --emitDeclarationOnly` + dist exports) for
  the shared packages mobile consumes — a workspace-contract change, flagged to
  Kaan before adopting since it touches desktop packaging too.
- **Note**: raw-TS workspace exports are a community pattern, not a documented
  Expo contract — which is precisely why this stays a gated spike rather than
  an assumption.

### R4 — RN↔WebView bridge throughput while typing (record open risk 3)

- **Spike** (T0.8): minimal WebView + the envelope from
  [contracts/webview-bridge.md](./contracts/webview-bridge.md); 50 KB BlockNote
  doc; scripted 10 keystrokes/s for 60 s; **release build only** (debug-mode
  messaging is known-slow and disqualifying as evidence). Measure: keystroke →
  WebView-local render (must be bridge-independent), WV→RN envelope delivery
  p95, RN-side apply+persist p95, envelopes/s and msgs/envelope both
  directions. Also one 5 MB base64 `doc-load` to bound large-payload behaviour.
- **Pass**: WebView-local render p95 < 50 ms (budget), envelope round-trip
  p95 ≤ 100 ms under burst, envelopes/s ≈ 1/T_flush (proof of batching — never
  ≈ keystroke rate), zero dropped/out-of-order `seq`. Tune `T_flush`/`B_max`
  here. → G0(d); re-verified at G3 on the real editor.
- **Fail**: enlarge batching window / move to delta-only frames / compress
  before base64; if still failing, escalate — the WebView-editor decision
  itself goes back to Kaan with numbers (it is a record decision; changing it
  is not this plan's call).
- **Known-unknown being retired**: no modern published postMessage benchmark
  exists (all substantive data pre-2025) — the spike generates our own.

### R6 — Apple review: double-subscription setup (record open risk 4; desk spike T0.10)

- **Task**: written compliance memo mapping the planned flow to App Review
  Guidelines 3.1.x: IAP is offered in-app (no steering to web checkout from
  iOS); the double-subscription notice is informational (existing Paddle
  subscribers are told they already have an active plan — no external purchase
  link on the notice); account deletion in-app (5.1.1(v)); accurate privacy
  labels.
- **Pass**: no guideline conflict identified; reviewer-notes draft explains the
  dual-platform entitlement honestly; fallback documented (if rejection cites
  the notice, ship v1.0.1 with the notice reworded to platform-neutral text —
  entitlement merge behaviour is server-side and unaffected by review).
- **Fail** (memo finds a conflict): paywall/notice UX is redesigned in Phase 0,
  **before** Phase 5 builds it. Residual risk is acknowledged: App Review is
  not deterministic; Phase 7 carries the buffer.

## Resolution status

| Unknown                             | Status                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| R1 libsodium binding                | Candidate fixed (react-native-libsodium + scalarmult patch); **open until T0.5 passes** — by design        |
| R2 SQLite driver                    | Benchmark protocol + decision rule fixed; **open until T0.6 runs** — by design ("decide with a benchmark") |
| R3 Metro/pnpm                       | Spike + mitigation ladder fixed; **open until T0.7 passes** — by design                                    |
| R4 bridge throughput                | Rig + thresholds fixed; **open until T0.8 passes** — by design                                             |
| R5 E2E framework                    | **Closed: Maestro** (B1)                                                                                   |
| R6 Apple double-subscription review | Desk spike fixed (T0.10); residual risk owned in Phase 7                                                   |
| R7 background API                   | **Closed: expo-background-task** (B4)                                                                      |
| R8 IAP client + ASSN V2 on Workers  | **Closed: expo-iap + Apple's official library on Workers** (B2, B3); offer-code flag tracked to Phase 5    |

No NEEDS CLARIFICATION remains in plan.md's Technical Context: every unknown is
either closed above or is a decision-record open risk deliberately held open
behind a Phase 0 pass/fail gate.
