# Research: Memry Native — Foundation + iOS Shell

**Feature**: `002-native-foundation-ios` | **Date**: 2026-09-12 | **Plan**: [plan.md](./plan.md)

Phase 0 output. Every unknown from the plan's Technical Context is closed here.
Format per item: Decision, Rationale, Alternatives, Gotchas. Versions were
verified on 2026-09-12. Confidence marks: (V) verified from a primary source,
(C) community or secondary only, (U) unverified, carried as a risk.

## A. Settled by the decision record (not re-researched)

Rust core via UniFFI; SwiftUI on iOS 26+; yrs for the CRDT; libsodium C for
crypto; WebView-hosted BlockNote via bridge protocol v1; `apps/mobile` frozen;
server unchanged except an Apple identity provider and spec-driven tests;
protocol spec and composite vectors before any Rust. See
`docs/ideas/2026-09-12-native-ios-rust-core-plan.md`.

## B. Three corrections to the plan's premises

These were found while researching and change what the protocol spec and the
Rust code must say. They are already reflected in
[contracts/protocol-spec-outline.md](./contracts/protocol-spec-outline.md).

- **R-B1. Canonical CBOR is sorted, not fixed-order.** `CBOR_FIELD_ORDER` in
  `packages/contracts/src/cbor-ordering.ts` is only the inclusion allowlist
  (unknown keys rejected, `undefined` dropped). `cborg` then sorts map keys
  RFC 8949 §4.2.1 length-first bytewise, recursively
  (`apps/desktop/src/main/crypto/cbor.test.ts:67`). (V) Verified by encoding
  `Map{zzz,a,bb}` with the repo's `cborg@4.5.8`: `a3 6161 02 626262 03 637a7a7a 01`.
- **R-B2. Compression is zlib, not raw deflate.**
  `packages/sync-client/src/compress.ts` uses `pako.deflate`/`inflate`, which
  emit and require RFC 1950 framing (`78 9c`). The editor asset uses gzip
  (`pako.ungzip`). (V)
- **R-B3. The editor bundle is 1.19 MB, not 4.5 MB.**
  `EDITOR_WEB_HTML_BYTES = 1214711`; the 4.5 MB figure in code comments is
  pre-minified JS. The gzip-in-a-TS-string trick exists only because Metro
  serves modules, not files. (V)

## C. Rust core

### R1. UniFFI packaging

- **Decision**: `uniffi = "=0.32.1"`, proc-macro only (no UDL), library mode
  through a workspace-member `uniffi-bindgen-swift` binary, shipped as a local
  Swift Package with a binary-target XCFramework. Generated Swift is checked
  in and gated in CI by regenerate-and-diff, like `pnpm ipc:check`.
- **Rationale**: proc-macros are the maintained path; `uniffi-bindgen-swift`
  is the only generator that emits an XCFramework-compatible modulemap;
  binary-target packaging keeps Xcode from shelling out to `cargo`.
- **Alternatives**: `cargo-lipo` (unmaintained, no XCFramework), `cargo-swift`
  (fine for a spike, owns the package layout), Xcode run-script cargo builds
  (non-hermetic, breaks user-script sandboxing).
- **Gotchas**: metadata contract version must match between bindgen and
  runtime, hence the workspace-member bindgen. Modulemap must be renamed
  `module.modulemap`. `crate-type = ["staticlib", "cdylib", "lib"]`. No
  cancellation across the FFI: expose explicit `cancel()` on long operations.
  Foreign traits (`#[uniffi::export(with_foreign)]`) over deprecated callback
  interfaces. One error enum per surface (auth, vault, sync, storage). Set
  `IPHONEOS_DEPLOYMENT_TARGET` in the build script so the C slices agree with
  the iOS 26 floor.

### R2. yrs

- **Decision**: `yrs = "0.27.4"`. Hold `Arc<Doc>` inside a UniFFI object;
  every exported method opens and closes its own transaction; use
  `try_transact_mut` and map `TransactionAcqError` to a typed error.
- **Rationale**: v1 update codec is the Yjs reference format; `Doc` is
  `Send + Sync`; `TransactionMut` borrows the doc and cannot cross the FFI.
- **Alternatives**: none viable; a different CRDT breaks the protocol.
- **Gotchas**: always `get_or_insert_xml_fragment("prosemirror")` and the
  root maps/arrays before the first `apply_update`. Never use v2 encoding.
  Use `Doc::with_client_id` derived from the device id so each launch does
  not mint a new Yjs client. `Update::decode_v1` errors are typed, never
  unwrapped. `has_missing_updates()` detects out-of-order pending updates.
  Store the `Subscription` from `observe_update_v1` for the doc's lifetime.

### R3. libsodium

- **Decision**: `libsodium-sys-stable = "1.24.0"` plus a hand-written safe
  wrapper (~10 functions). `dryoc` as a dev-dependency cross-check that runs
  every vector through a second implementation.
- **Rationale**: byte parity with `libsodium-wrappers-sumo` on live vaults is
  only guaranteed by the same C code; iOS targets are supported by the crate;
  NEON Argon2 matters because unlock runs 64 MiB / ops 3 in the foreground.
- **Alternatives**: `dryoc` (pure Rust, complete, slower Argon2, parity is a
  claim), `alkali` (stale since 2023), `sodiumoxide` (deprecated),
  `libsodium-rs` (needs system libsodium).
- **Gotchas**: no `fetch-latest`, no `optimized` feature. `sodium_init` once
  behind `Once`. `crypto_pwhash` returns -1 on OOM at 64 MiB on a
  memory-pressured phone: surface as a distinct error, not "wrong phrase".
  Pair `sodium_memzero` with `zeroize` on Rust-owned buffers.

### R4. SQLite

- **Decision**: `rusqlite = "0.40.2"` with `bundled` (FTS5 is compiled in by
  `bundled`; there is no `fts5` feature flag). One `Connection` per database
  behind `Arc<Mutex<_>>`, all SQL inside `spawn_blocking`, never holding the
  mutex across an await. WAL, `synchronous=NORMAL`, `busy_timeout=5000`,
  `foreign_keys=ON`. Hand-rolled `user_version` migrations.
- **Rationale**: pins the engine across simulator, device, CLI; matches the
  constitution's hand-written additive migration rule.
- **Alternatives**: system SQLite (uncontrolled version and options),
  `refinery`/`sqlx` migrations (own history tables, wrong shape).
- **Gotchas**: assert `fts5` in `pragma_compile_options` at startup. Handle
  `-wal`/`-shm` sidecars together on move or delete. Data Protection class
  decides whether background sync can open the file at all (see R11).

### R5. Network transport and async runtime

- **Decision**: HTTP and WebSocket are **shell-provided** through **one**
  UniFFI foreign trait, `Transport`
  (`crates/memry-core/src/seams/transport.rs`), with two methods:
  `send(request)` for a single request-response and `open_socket(...)` for the
  realtime hint channel. One trait rather than two, because both are the same
  seam to the same host and splitting them buys a second implementation of
  the same lifetime rules. iOS implements it over `URLSession` and
  `URLSessionWebSocketTask`; `memry-cli` implements it over `reqwest 0.13.5`
  and `tokio-tungstenite 0.30.0` behind a
  `native-transport` cargo feature. The trait is deliberately dumb: one
  request in, status plus headers plus bytes out; every retry, backoff,
  token-refresh, and protocol decision stays in Rust. One lazily created
  tokio runtime (`rt-multi-thread`, `sync`, `time`, `macros`; 2 to 4 workers)
  in a `OnceLock`, never dropped, with `on_background`/`on_foreground` hooks
  from the shell.
- **Rationale**: iOS suspends raw sockets seconds after backgrounding and
  applies ATS, proxies, and background transfer only to its own stack;
  `reqwest`'s default TLS pulls `aws-lc-rs` with a C/asm cross-build; binary
  size.
- **Alternatives**: `reqwest` on device with `rustls`/`ring` (permanent
  toolchain tax, still bypasses ATS), shell-implemented networking logic
  (violates constitution I).
- **Gotchas**: async foreign traits are the least-travelled UniFFI path;
  spike first (see plan gate G3a). Large blob fetches should return a file
  path, not `Vec<u8>`. Tokio timers fire late-and-at-once after suspension;
  debounce on resume.

### R6. Canonical CBOR

- **Decision**: `ciborium = "0.2.2"` with a recursive length-first bytewise
  map sort applied before encoding, wrapped in one `canonical_cbor::encode`
  that also enforces the `CBOR_FIELD_ORDER` allowlist.
- **Rationale**: ciborium matches `cborg` on every scalar form including
  shortest-int and float16 narrowing; only map ordering differs.
- **Alternatives**: `minicbor` (writes f64 full-width, diverges on floats),
  hand-written encoder (300 lines of bit-twiddling), `serde_cbor`
  (unmaintained).
- **Gotchas**: `Option::None` maps to omission, never `f6`/`f7`. Model every
  integral field as an integer type. Vectors must include a nested map and a
  key pair where length-first and lexicographic order disagree.

### R7. Compression

- **Decision**: `flate2 = "1.1.10"` default backend (`miniz_oxide`).
  `ZlibDecoder`/`ZlibEncoder` for sync payloads, `GzDecoder` for the editor
  asset if ever needed. Port the 1-byte flag framing exactly: `0x00` stored,
  `0x01` zlib, stored when under 64 bytes or when compression does not shrink.
- **Gotchas**: a truncated stream must be a hard error; write the regression
  test the TS side carries a 20-line comment about.

### R8. BIP-39

- **Decision**: `bip39 = "2.2.2"`, English only, `Mnemonic::parse_normalized`
  then `to_seed_normalized("")`, seed wrapped in `Zeroizing<[u8; 64]>`.
- **Gotchas**: distinguish "word not in list" from "bad checksum" in errors.
  Do not enable other wordlists.

### R9. Rust workspace pins

Edition 2024, `rust-version = "1.89"`. Full dependency list with versions is
in [plan.md](./plan.md) under Technical Context.

## D. iOS shell

### R10. WKWebView hosting and bridge port

- **Decision**: `loadHTMLString(html, baseURL: about:blank)` on a
  `WKWebViewConfiguration` with `websiteDataStore = .nonPersistent()`.
  Guest to host via `WKScriptMessageHandler` registered through a weak proxy;
  host to guest via `callAsyncJavaScript(_:arguments:in:.page)`; shim
  injected as a `WKUserScript` at document start in `.page`. One long-lived
  `WKWebView` owned by an `@Observable` host above the view tree.
  `isInspectable` under `#if DEBUG`.
- **Rationale**: the opaque origin makes "the WebView persists nothing" true
  at the platform layer (every storage API throws). `callAsyncJavaScript`
  passes the envelope as a value instead of re-parsing a 350 KB source string
  every 24 ms. WebKit's 7-day storage cap is the concrete reason the core owns
  the Y.Doc.
- **Alternatives**: `loadFileURL` (needless disk write, real origin),
  `WKURLSchemeHandler` (kept as the only fallback if the opaque origin turns
  out not to be a secure context), iOS 26 SwiftUI `WebView` (no guest-to-host
  channel yet).
- **Cost of the fallback, recorded rather than discovered later**: a custom
  scheme gives the document a real origin, which re-enables web storage. The
  constitution rejects a WebView that persists anything. So the fallback is
  only admissible paired with `websiteDataStore = .nonPersistent()` **and** a
  startup assertion that `localStorage`, `sessionStorage` and `indexedDB`
  each throw or are unavailable. If that assertion cannot be made to hold,
  the fallback is not available and the bridge needs a different answer.
- **Bridge port items**: rename the guest transport from
  `window.ReactNativeWebView.postMessage` to a host-agnostic
  `window.MemryHost.postMessage` with feature detection; replace the
  host's `dispatchEvent` source-string injection with `callAsyncJavaScript`;
  keep the `interactive-widget=overlays-content` viewport meta.
- **Gotchas**: `add(_:name:)` retains the handler; use a weak proxy and
  remove in `deinit`. Recovery from `webViewWebContentProcessDidTerminate`
  is reload, await `ready`, replay full `doc-load`. Smoke-assert
  `window.isSecureContext && !!crypto.subtle` in B0/S3.

### R11. Keychain class and file protection (one decision)

- **Decision**: all core secrets `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
  with `kSecUseDataProtectionKeychain`; SQLite files and image cache
  `FileProtectionType.completeUntilFirstUserAuthentication` in
  `Application Support/<bundle>/vault/`, `isExcludedFromBackup = true` on the
  directory, `com.apple.developer.default-data-protection` entitlement set.
  Bytes cross the FFI as `Data`, never `String`. Optional biometric app lock
  later is a UI gate, not a key class change.
- **Rationale**: `WhenUnlocked*` returns `errSecInteractionNotAllowed` inside
  a `BGAppRefreshTask` after the user locks the phone, which is the normal
  case, and `.complete`/`.completeUnlessOpen` cannot open the database on a
  cold background launch. Ciphertext-only background sync would break
  reminder top-up. Memry's threat model is service compromise and a
  powered-off device, not forensic extraction of a booted, locked device.
  Constitution 2.2.0 records this.
- **Alternatives**: `WhenUnlockedThisDeviceOnly` everywhere (breaks
  background sync and reminders), Secure Enclave (P-256 only, cannot hold the
  symmetric vault key or Ed25519, biometric unwrap cannot run in background),
  iCloud Keychain (vault key in Apple custody), third-party wrappers (default
  to the wrong class).
- **Gotchas**: WAL sidecars do not inherit protection reliably; re-assert on
  each sidecar after first open and test on device. `SecItemAdd` must be
  add-or-update. Pre-warming can run launch code while locked; handle -25308.
  Swift has no secure-memory API; keys go to Rust immediately and live in
  `Zeroizing`.

### R12. Background execution and notifications

- **Decision**: `BGAppRefreshTask` (`com.memry.sync.refresh`) re-submitted at
  the start of each run, `earliestBeginDate = now + 15 min`; `BGProcessingTask`
  (`com.memry.sync.maintenance`) for post-link download, index rebuild,
  compaction; `BGContinuedProcessingTask` for user-initiated "Sync now".
  Registration through the SwiftUI `.backgroundTask` scene modifier, once.
  Notifications: reconcile a rolling window with a budget of 56 of the 64
  slots, stable ids `reminder.<syncItemId>.<occurrenceEpoch>`, occurrences
  expanded in Rust, `UNCalendarNotificationTrigger`, authorization requested
  after the first reminder is created, generic body text by default.
- **Rationale**: double registration kills the app; no cadence is
  guaranteed, so foreground sync must fully reconcile; the 64 ceiling is
  Apple-confirmed but eviction policy past it is not (U), so stay under it.
- **Gotchas**: the Simulator never runs background tasks; use the LLDB
  `_simulateLaunchForTaskWithIdentifier:` SPI on device, including expiry.
  Notification bodies are stored in plaintext by the system; never put note
  text in one without an explicit setting.

### R13. Camera QR scanning

- **Decision**: `AVCaptureMetadataOutput` with `.qr`, plus manual code entry
  as the real fallback. VisionKit `DataScannerViewController` optional later.
- **Rationale**: runs once per device at the highest-stakes moment; needs
  zero hardware gates and must be testable in CI, where the camera does not
  exist. VisionKit needs A12+ (C) and never works in the Simulator.
- **Gotchas**: add output before setting `metadataObjectTypes`; debounce to
  first valid hit then `stopRunning()`; `NSCameraUsageDescription` is
  mandatory or the app crashes. The QR carries a short one-time code, not a
  key blob.

### R14. Sign in

- **Decision**: Google through `ASWebAuthenticationSession` with
  authorization code plus PKCE against the iOS OAuth client, code exchanged
  by the app (public client, no secret), ID token posted to the existing
  `POST /auth/oauth/google/native` whose audience is `GOOGLE_IOS_CLIENT_ID`
  (`apps/sync-server/src/routes/auth.ts:441`). No GoogleSignIn-iOS SDK.
  Sign in with Apple through `AuthenticationServices`, with an additive
  `apple` provider on the same native endpoint server-side. OTP entry with
  `.textContentType(.oneTimeCode)` as a bonus, paste and typing as the
  mechanism.
- **Rationale**: the vendor SDK's privacy manifest declares linked coarse
  location, device ID, and usage data for analytics, which would land on the
  App Store listing of an E2E-encrypted notes app. Google's policy allows
  system web-auth sessions and forbids embedded webviews. App Review 4.8
  requires an equivalent private-email option when Google is offered; email
  OTP cannot promise a private address, so Sign in with Apple ships.
- **Alternatives**: GoogleSignIn-iOS 10.0.0 (rejected on the manifest).
  OTP-only on iOS: verified viable, `POST /auth/otp/verify` resolves the
  account with `getOrCreateUserByEmail` (`apps/sync-server/src/routes/auth.ts:283`),
  so a Google-created account signs in by email; with no third-party login
  offered, 4.8 does not apply and no Apple provider or account-linking work
  is needed. Recorded in the spec as a zero-risk cut the owner can take.
- **Gotchas**: `prefersEphemeralWebBrowserSession = true`; validate `state`
  and PKCE; treat `canceledLogin` as non-error. Apple delivers name and email
  only on the first authorization. Emailed-OTP autofill is undocumented and
  10 to 15 s late (C).

### R15. SwiftUI architecture over the core

- **Decision**: core exposes synchronous blocking functions; Rust `async`
  only for genuinely concurrent internals. `@MainActor @Observable` view
  models hold value snapshots. All core access through one `CoreExecutor`
  (serial `DispatchQueue`, `withCheckedThrowingContinuation`). Rust-to-Swift
  events via a foreign trait whose Swift implementation only yields into an
  `AsyncStream` with `.bufferingNewest(256)`. `NavigationStack(path:)` with
  `Codable` routes. Xcode 26.0, Swift 6 language mode, no
  `-default-isolation MainActor`.
- **Rationale**: UniFFI objects are `@unchecked Sendable`; a Swift actor
  would double-serialize. `Task {}` inherits main-actor isolation; SE-0461
  makes nonisolated async run on the caller's actor. Callbacks run
  synchronously on the calling Rust thread while locks may be held, so the
  callback must never re-enter the core.
- **Liquid Glass**: system components everywhere; hand-applied
  `glassEffect` only on the editor's floating toolbar inside one
  `GlassEffectContainer`. `tabBarMinimizeBehavior` is opt-in. Do not ship
  `UIDesignRequiresCompatibility`. Branch on reduce-transparency and
  reduce-motion at the modifier level.
- **Gotchas**: `navigationDestination` not inside lazy containers.
  `DESIGN.md` mobile pointers reference frozen `apps/mobile` paths and have
  no Liquid Glass guidance; update in this feature.

### R16. Keyboard toolbar

- **Decision**: subclass `WKWebView`, override the `inputAccessoryView`
  getter to return a cached `UIInputView` hosting the SwiftUI toolbar via
  `UIHostingController`; return `nil` to hide WebKit's default bar.
- **Rationale**: public API since iOS 13 (WebKit r246229) (V), not a swizzle;
  the toolbar is owned by the keyboard and tracks every transition. SwiftUI
  `.toolbar(placement: .keyboard)` has no documented behaviour for a
  first responder inside `WKWebView` and an open iOS 26.1 VoiceOver and
  XCUITest regression.
- **Alternatives**: `keyboardLayoutGuide` (positions near, not attached;
  still needs the override to hide WebKit's bar), `safeAreaInset` plus
  keyboard notifications (broken around web views on iOS 26, FB20386257),
  RN's `WKContentView` swizzle (private API).
- **Gotchas**: cache the instance; explicit height and
  `translatesAutoresizingMaskIntoConstraints = true`. Liquid Glass on
  keyboard accessory views is undocumented (U): spike with a screenshot on
  device. "Keyboard up without a tap" has no public API; have the guest call
  `.focus()` inside a real touch handler. Turn off the simulator hardware
  keyboard before any toolbar test.

### R17. Editor bundle packaging

- **Decision**: `git mv apps/mobile/editor-web packages/editor-web` (it is
  already `@memry/editor-web`); emit and check in `dist/editor.html` (1.19 MB,
  raw) plus `dist/manifest.json` carrying two hashes, `contractHash` over
  inputs and `sha256` over output bytes; generate
  `apps/ios/Memry/Generated/EditorWebAsset.swift`. Three gates: CI input
  freshness, an Xcode run script comparing `shasum` to the manifest with
  declared inputs and outputs, and the runtime `ready` handshake that
  refuses to initialise on mismatch or absence of `contractHash`.
- **Rationale**: Node must not run from an Xcode build phase (hermeticity,
  script sandboxing, 30 to 60 s per compile); the RN host only warns on
  mismatch, iOS tightens to refuse.
- **Gotchas**: add `packages/editor-web/dist/` to `.prettierignore` and
  `.gitattributes` (`-diff -merge linguist-generated`). The editor-asset
  freshness gate and the crypto-vector parity run in `mobile-ci.yml` die with
  the frozen app; move both to `ios-ci.yml` before freezing.

### R18. Compliance

- **Privacy manifest**: app-level `PrivacyInfo.xcprivacy` declaring
  FileTimestamp C617.1, UserDefaults CA92.1, DiskSpace E174.1, SystemBootTime
  35F9.1. The statically linked Rust core's `stat`/`mach_absolute_time` use
  counts as the app's; link statically so one manifest covers it. Upload an
  internal TestFlight build early to surface ITMS-91053.
- **Export compliance**: `ITSAppUsesNonExemptEncryption = YES`; no CCATS
  (industry-standard algorithms); French declaration if distributing there;
  annual self-classification under 5D992.c. Confirm the App Store Connect
  checkbox wording against the existing desktop filing (U).
- **Nutrition labels**: telemetry as Data Not Linked to You, tracking No,
  which is earned only if events carry no account id or stable device id;
  guideline 5.1.1(ii) also requires an in-app opt-out for anonymous usage
  data. Apple publishes no end-to-end-encryption carve-out, so declare
  synced note payloads as Other User Content, App Functionality, Linked,
  next to a description that says the service cannot read them.
- **Guideline 3.1.3(b)**: a store-distributed build that honours a web
  subscription must also sell that plan in-app. Not a TestFlight gate;
  carried into feature 003 with in-app purchase.
- **Required-reason symbols from Rust**: `rusqlite` `bundled` links the
  SQLite amalgamation, so `_fstat`, `_statfs`, `_fstatvfs`, `_lstat` land in
  the app's own symbol table. CI runs `nm -u` over the built binary and
  fails on any required-reason symbol without a manifest entry.
- **5.1.1(v)**: in-app account deletion is mandatory and must destroy local
  keys and vault content through the sign-out path.
- **Review notes**: pre-seeded staging vault plus recovery phrase for the
  reviewer; read-only kill-switch mode must explain itself visibly.

### R19. Testing

- **Decision**: Swift Testing for unit tests, XCTest for UI and performance
  tests, same target, `@Suite(.serialized)` where SQLite is shared. One thin
  XCUITest for "editor is not blank"; editor semantics stay in the web-layer
  tests. Conformance vectors run in two tiers from the identical file:
  `cargo test` via `include_str!`, and on-device Swift Testing with
  `@Test(arguments:)` through the generated bindings. Three test plans
  (Unit, UI, Conformance); `build-for-testing` once, `test-without-building`
  per plan; archive `.xcresult`.
- **Gotchas**: `Bundle.module` does not exist in Xcode-project test targets.
  The simulator does not validate the `aarch64-apple-ios` crypto build.
  CI check that fails if a second `crypto-vectors.json` appears.

## E. Carried as explicitly uncertain

- `BGAppRefreshTask` time budget (community-observed ~30 s only).
- Eviction policy past 64 pending notifications (budget 56 so it does not matter).
- Liquid Glass treatment of keyboard accessory views and rendering under
  Reduce Transparency (B0/S3 produces the screenshot).
- Whether an opaque-origin document is a secure context (smoke-asserted in B0/S3).
- Emailed-OTP autofill reliability.
- Export-compliance checkbox wording. Closed in Phase A by reading the
  existing desktop filing in App Store Connect and copying its answers; it is
  not a research question, it is a lookup nobody has done yet.
- UniFFI callback threading guarantees (log `Thread.current` in B0/S1;
  treat as any thread, re-entrant).

## F. Spike acceptance (B0, gate G3a)

Each spike is pass or fail with a written note here. No product code comes
out of B0 and nothing in phase A or B depends on its artifacts.

| Spike | Passes when |
|---|---|
| S1 UniFFI XCFramework hello-world in an empty iOS app | the app calls a Rust function and gets a typed error back; **and** a UniFFI foreign-trait callback logs `Thread.current`, recording which thread Rust calls back on; **and** a test asserts the callback does not re-enter the core while a core lock is held, which is the failure mode `@unchecked Sendable` hides |
| S2 async foreign-trait HTTP adapter | a round trip to staging `/health` completes through the `Transport` trait, with the cancellation path exercised |
| S3 WKWebView opaque origin and keyboard toolbar | `window.isSecureContext && !!crypto.subtle` is true on `about:blank`; the `inputAccessoryView` override shows the SwiftUI toolbar; **and** a device screenshot of that toolbar with Reduce Transparency on, which is the only evidence that settles the Liquid Glass uncertainty in section E |
| S4 Argon2id 64 MiB on iPhone 15 | unlock completes in the foreground under memory pressure, and the OOM return of `crypto_pwhash` is reproduced at least once and surfaces as its own error rather than "wrong phrase" |

## Resolution status

All Technical Context unknowns resolved. Items in section E are risks with
named verification tasks, not open decisions.
