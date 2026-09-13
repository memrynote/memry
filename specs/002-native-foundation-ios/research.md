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
- **Measured, spike S3, iOS 26.5 — the condition above is NOT met by
  `.nonPersistent()` alone, and the fallback is the one we are taking.**
  `about:blank` is **not** a secure context (`isSecureContext=false`,
  `crypto.subtle=false`), so the decision above is unavailable and the
  `WKURLSchemeHandler` fallback is forced. Under the custom scheme with
  `.nonPersistent()` set, all three storage APIs still **resolve**. The
  condition holds only with a `WKUserScript` at `.atDocumentStart` that
  removes them.
  **That is a weaker guarantee and the difference is the whole point**: the
  opaque origin denied storage as a **platform** guarantee that no script
  could undo, whereas a document-start denial is **JavaScript-level** and is
  defeated by anything running before it, outside it, or after a
  same-document navigation re-creates the globals. Recorded here so the
  security claim a later reader inherits is the true one rather than the one
  this decision originally promised. See spec-defect 82 and the S3 note.
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
- **The executor fronts the blocking surface, not literally every call**
  (spec-defect 90). "Core exposes synchronous blocking functions" above is
  true of the ten exported free functions and of `RuntimeHost`, and **false of
  `AuthSession`**: seven of its nine methods are `async throws` in the
  generated Swift — `refresh`, `registerDevice`, `renewSetupToken`,
  `requestEmailCode`, `resendEmailCode`, `signOut`, `verifyEmailCode`. Only
  `state` and `markRevoked` are synchronous. Those seven are **awaited
  directly**, never routed through the queue: they suspend rather than block,
  so there is no thread to move them off, and forcing one through a serial
  queue parks a queue thread on a semaphore and stalls every other core call
  behind a network round trip. `contracts/core-api.md` marks which is which.
- **Cancellation is settled here** (spec-defect 90), because
  `withCheckedThrowingContinuation` is not cancellable and a blocking core
  call cannot be interrupted — Rust is inside libsodium or SQLite and there is
  nothing to poll. Cancelled **before the work starts**, including while it
  waits its turn behind another call: it never runs, `run` throws
  `CancellationError`, the core is never entered. Cancelled **after the work
  starts**: it runs to completion and the result is delivered, because
  resuming early leaves the call in flight with nobody holding it and discards
  an answer the core already paid for. The claim must be made atomically by a
  bit shared between the cancellation handler and the queued block, so a late
  cancel is a no-op by construction rather than by timing.
- **A main-thread assertion does not evidence the executor, and asserting one
  produces a false green** (spec-defect 91). The SE-0461 rationale above is
  written in the present tense and **is not in force on this toolchain**:
  `-swift-version 6` here does not enable `NonisolatedNonsendingByDefault`, so
  a `nonisolated async` function still hops to the global concurrent executor.
  Deleting the `queue.async` hop entirely therefore leaves `isMainThread()`
  returning `false` — the work runs on
  `com.apple.root.user-initiated-qos.cooperative`, off the main thread and on
  no queue of ours. Observed by breaking the code and watching the test stay
  green. A test must assert **queue identity**
  (`__dispatch_queue_get_label(nil)` against the label the executor was built
  with), because the guarantee was always "this serial queue" and never "some
  other thread". Note also that `Thread.isMainThread` and `Thread.current` are
  unavailable from an asynchronous context under Swift 6; use
  `pthread_main_np()`.
- **A test over an `AsyncStream` must not drain a fixed count, because it hangs
  instead of failing** (spec-defect 99). A fixture that awaits N elements and
  asserts on them never returns when the bug under test is a **missing** yield:
  the `await` simply parks. Observed — one `xcodebuild` sat for 21 minutes and
  printed nothing, and the stall was indistinguishable from a deadlock in the
  seam under test, which is the worst possible failure signal for concurrency
  work. **A hang is worse than a failed assertion, because a hang looks like
  slowness.** Emit a sentinel, `finish()` the stream, drain to completion, and
  compare the **whole** history — then a missing element, a duplicated element
  and a wrong payload are three distinct failures rather than one timeout. Carry
  a `.timeLimit` as the backstop, never as the mechanism.
- **`-only-testing:` with a name that matches nothing runs nothing and reports
  `TEST SUCCEEDED`** (spec-defect 106). Swift Testing suite names are **struct
  names, not file names**, and the two diverge freely. A run scoped by file name
  selected none of the intended suites and reported 64 passed where the truth was
  102 — 38 tests never executed, no warning about the unmatched filter. Derive
  the suite names from the source and **precompute the expected total before
  reading the result**: a scoped run's failure mode is a plausible smaller number,
  not an error.
- **The `Unit` test plan is not hermetic** (spec-defect 93). `SpikeTests`'
  S2 case makes a **live staging HTTP call** through `URLSession`, and it has
  no time limit: when staging is slow or unreachable it hangs the whole plan
  with no error, which cost two runs in the first Phase 4 wave and looks
  exactly like a deadlock in the code under test. Scope an evidence run with
  `-only-testing:` rather than running the bare plan, and read a hang there as
  the network before suspecting the change.

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
- **Two more simulator gotchas, each of which cost a run in spike S3** —
  both produce a _wrong-looking result with no error_, which is why they are
  written down:
  - **The QuickPath introduction overlay** covers the accessory view
    entirely on a fresh simulator, so a correctly-rendered toolbar looks
    absent. Dismiss it before capturing anything.
  - **`defaults write com.apple.Accessibility ReduceTransparencyEnabled`
    does not reach `UIAccessibility`.** The value persists in the plist
    across a device reboot and the app still reads `false`. Only driving the
    Settings switch works. This one is the dangerous half: it makes a run
    taken with the setting _off_ look like a Reduce Transparency run, which
    would put a wrong screenshot into G3a's evidence under a true caption.
    Have the app render its own state badge so the screenshot proves itself.
- **Device rendering is still open (U).** Spike S3's captures are
  **simulator** images. They evidence the _layout_ contract — the accessory
  view renders above the software keyboard, and contrast, legibility and hit
  targets hold under Reduce Transparency — and they do **not** evidence
  device rendering of Liquid Glass on a keyboard accessory view, which stays
  open alongside T082's blocked device tier. A simulator capture is partial
  evidence for layout and no evidence for material rendering; do not let one
  close the other.

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

| Spike                                                 | Passes when                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 UniFFI XCFramework hello-world in an empty iOS app | the app calls a Rust function and gets a typed error back; **and** a UniFFI foreign-trait callback logs `Thread.current`, recording which thread Rust calls back on; **and** a test asserts the callback does not re-enter the core while a core lock is held, which is the failure mode `@unchecked Sendable` hides |
| S2 async foreign-trait HTTP adapter                   | a round trip to staging `/health` completes through the `Transport` trait, with the cancellation path exercised                                                                                                                                                                                                      |
| S3 WKWebView opaque origin and keyboard toolbar       | `window.isSecureContext && !!crypto.subtle` is true on `about:blank`; the `inputAccessoryView` override shows the SwiftUI toolbar; **and** a device screenshot of that toolbar with Reduce Transparency on, which is the only evidence that settles the Liquid Glass uncertainty in section E                        |
| S4 Argon2id 64 MiB on hardware                        | unlock completes in the foreground under memory pressure, and the OOM return of `crypto_pwhash` either surfaces as its own error rather than "wrong phrase" **or is shown unreachable** — the device answered the latter: jetsam kills the app before `malloc` refuses                                               |

## Resolution status

All Technical Context unknowns resolved. Items in section E are risks with
named verification tasks, not open decisions.

## Addenda — G3 evidence

Written as the evidence was observed, not reconstructed afterwards. Each line
is a command that was run and its result.

### T094, the three G3 evidence items

| Item                                                                                                            | Result                                                                 |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `cargo test -p memry-core` green on host, 100% of committed vectors passing                                     | **PASS** — 314 tests, 0 failed; all eleven classes green byte for byte |
| `build-xcframework.sh`, then `git diff --exit-code packages/swift/MemryCore/Sources/MemryCore/Generated/`       | **PASS** — clean, exit 0                                               |
| `xcodebuild test … -destination 'platform=iOS,name=<iPhone 15>' -testPlan Conformance` on a **physical device** | **BLOCKED — not passed, not waived**                                   |

The clean binding diff is the item that could have failed silently: it proves
the committed Swift matches what the current Rust generates, rather than being
an artefact someone forgot to regenerate after changing the FFI surface.

### The device tier is BLOCKED by decision, and G3 closes with it named

Kaan chose simulator-only; no physical iPhone 15 is attached to this machine.
**T082, T093 and T094's third item are therefore open, not satisfied.**

T093 says so itself, and it is restated here because it is the kind of thing a
later reader assumes was covered: **a simulator run is NOT evidence for the
`aarch64-apple-ios` crypto build.** The simulator target is
`aarch64-apple-ios-sim`, it runs on the host's own CPU, and it exercises
neither the device's memory pressure nor the device's libsodium build. In
particular T082's question — whether Argon2id at 64 MiB with ops 3 OOMs on a
real iPhone 15, and whether `crypto_pwhash`'s `-1` is distinguishable from a
wrong passphrase — cannot be answered anywhere but on the device.

**What was attempted here.** `xcodebuild test -scheme Memry -testPlan
Conformance` was run against an **iPhone 17 simulator**, under
`~/.memry/xcodebuild.lock` because xcodebuild and DerivedData are shared across
worktrees. It **did not run the tests**: the build failed compiling the
generated bindings.

```
SwiftCompile normal arm64 packages/swift/MemryCore/Sources/MemryCore/Generated/memry_core.swift
  Passing closure as a 'sending' parameter risks causing data races between
  code in the current task and concurrent execution of the closure
** TEST FAILED **
```

This is a real finding and is recorded rather than retried away: **the
generated Swift does not compile under the iOS app's Swift 6 strict-concurrency
settings.** The Rust side and the xcframework build are green, and
`uniffi-bindgen-swift` emits the file happily, which is exactly why nothing
caught it — "the generated Swift is committed and the diff is clean" says
nothing about whether it compiles in the app that consumes it. The surface grew
async objects (`AuthSession`, `RuntimeHost`) in the auth wave, and Swift 6's
`sending` rules are stricter than the generator's output assumes.

Until it is resolved, the simulator conformance run cannot produce evidence
either, so the device tier is blocked twice over: once by the absent hardware
and once by this. Carried as an open item.

## Addenda — B0 spike notes (T079–T083, gate G3a)

Four notes, one per spike, each with an explicit verdict. Written from runs on
this machine; every quoted line is copied out of the run's own output.

**The rig, stated once.** Xcode 26.6 (17F113), iOS 26.5 simulator runtime
(23F77), destination
`platform=iOS Simulator,id=A7E3D181-58A5-4982-9899-4FD15F5666DC` — **iPhone 17**.
Every `xcodebuild` invocation held `~/.memry/xcodebuild.lock`, because
DerivedData is shared across worktrees. The spike scaffolding is
`apps/ios/Memry/Spikes/`, `apps/ios/MemryTests/SpikeTests.swift` and
`apps/ios/MemryUITests/SpikeS3*UITests.swift`; no `crates/memry-core/src` file
was touched and the FFI surface is unchanged, so
`packages/swift/MemryCore/Sources/MemryCore/Generated/` did not move.

`xcodebuild test -scheme Memry -testPlan Unit` → **TEST SUCCEEDED**, 6 tests in
4 suites. This is the first iOS-side evidence in this feature: the G3 addendum
above records that the generated Swift did not compile under the app's Swift 6
settings, and that is now fixed (`MemryCoreGenerated` is its own Swift 5
target; `MemryCore` stays at Swift 6) — the app builds, links and runs.

### S1 — UniFFI XCFramework hello-world and callback threading — **PASS**

The easy half. `coreVersion()` returned `0.1.0` through
`MemryCoreFFI.xcframework`, and a bad phrase came back as a **variant**, not a
string:

```
[spike S1/hello]
  coreVersion() = 0.1.0
  typedError=MemryCoreGenerated.RecoveryError.WrongWordCount(actual: 4)
```

The half that was actually at risk. Section E carries "UniFFI callback
threading guarantees" as uncertain, with the instruction to treat callbacks as
_any thread, re-entrant_. The spike drives the real exported `AuthSession` to
`Registered` over a stub `Transport`, then calls `refresh()` — the one exported
path that reaches `TokenManager::refresh`, which holds its `flight` mutex
across the `SecureStore` reads, the `Transport::send` await and the
`store_session` writes (`protocol/auth.rs:423`). Eighteen callbacks, every one
logging `Thread.current`:

```
states=SignedOut -> AwaitingOtp -> SetupPending -> Registered -> Registered
refresh=refresh() returned Registered   elapsed=0.09s
Transport.send(.../auth/otp/request) | thread=<NSThread: 0x108501bc0>{number = 10, name = (null)} main=false qos=25
SecureStore.get(deviceSigningKey)     | thread=<NSThread: 0x108501bc0>{number = 10} main=false qos=25 reentrant=state()=AwaitingOtp
Transport.send(.../auth/otp/verify)   | thread=<NSThread: 0x108501680>{number = 6}  main=false qos=25
SecureStore.get(setupToken)           | thread=<NSThread: 0x108501680>{number = 6}  main=false qos=25 reentrant=state()=SetupPending
Transport.send(.../auth/devices)      | thread=<NSThread: 0x10870d8c0>{number = 7}  main=false qos=25
SecureStore.get(refreshToken)         | thread=<NSThread: 0x10870d8c0>{number = 7}  main=false qos=25 reentrant=state()=Refreshing; nested refresh() -> threw AuthError.InvalidState(action: "refresh", state: "Refreshing")
Transport.send(.../auth/refresh)      | thread=<NSThread: 0x10870e9c0>{number = 8}  main=false qos=25
SecureStore.set(refreshToken)         | thread=<NSThread: 0x10870e9c0>{number = 8}  main=false qos=25 reentrant=state()=Refreshing; nested refresh() -> threw AuthError.InvalidState
```

Four facts come out of that, and section E's guidance survives all four:

1. **Never the main thread.** Every callback ran on an unnamed `NSThread` with
   `qualityOfService = 25` — a tokio worker, not a Cocoa queue. A shell seam
   that touches UIKit, or that assumes `@MainActor`, is wrong by construction.
2. **Not one thread, and not a stable one.** Threads 5, 6, 7, 8, 9 and 10 all
   appeared. The thread is stable _within_ one `await` chain and changes between
   them, which is exactly the shape that lets a wrong assumption survive
   testing and fail later. `@unchecked Sendable` on a seam implementation is
   therefore an obligation, not a formality: the spike's own `SecureStore` is
   `NSLock`-guarded for this reason.
3. **A callback can re-enter the core, and it does not deadlock.**
   `session.state()` called from inside `SecureStore.get` returned every time,
   including from the callbacks that run with `flight` held — the
   `reentrant=state()=Refreshing` lines. Nothing in UniFFI serialises or guards
   the boundary.
4. **The re-entrant call that would contend for the held lock is refused before
   it can.** A nested `refresh()` issued from inside the callback threw
   `AuthError.InvalidState(action: "refresh", state: "Refreshing")`. **This is
   the state machine protecting the lock, not the lock protecting itself.** The
   `flight` mutex is genuinely held across a foreign call; the only reason
   today's surface cannot deadlock on it is that `AuthSession::refresh` refuses
   any entry that is not `Registered` or `SessionExpired` (`api/auth.rs`), and
   `Refreshing` is neither. A future exported method that reaches a held lock
   without a state gate in front of it re-opens this. The watchdog that would
   have caught a hang (5 s, on a detached task) never fired:
   `reentrantRefreshTimedOut=false`.

The rule for the shell, which the spike asserts rather than asserts about: a
seam implementation does no work that calls back into the core. The spike
violates it deliberately, under a watchdog, because that is the only way to
know what happens.

### S2 — async foreign-trait `Transport` over `URLSession` — **PASS**, with one leg recorded as unreachable

R5 flags async foreign traits as the least-travelled UniFFI path. They work.
`SpikeURLSessionTransport` implements the real `Transport` protocol over
`URLSession`; the core built the request, called Swift, awaited it, and read
the answer back into a typed error:

```
[spike S2]
  GET /health (shell-driven) -> 200 {"status":"ok"}
  core-driven url=https://sync-staging.memrynote.com/auth/otp/request requests=1
  core-driven outcome=AuthError.Api(source: ApiError.Status(status: 400, code: Optional("VALIDATION_ERROR"), message: "Invalid request body"))
  cancel outcome=AuthError.Api(source: ApiError.Transport(source: TransportError.Cancelled)) requests=1
  Transport.send(GET  .../health)            | thread=<NSThread: 0x10870fd00>{number = 9}
  Transport.send(POST .../auth/otp/request)  | thread=<NSThread: 0x108501200>{number = 5}
  Transport.send(POST .../auth/otp/request)  | thread=<NSThread: 0x10870e9c0>{number = 8}
```

- **Cancellation is exercised and behaves.** The shell cancelled the in-flight
  `URLSessionTask` after 1 ms; the seam mapped `URLError.cancelled` to
  `TransportError.Cancelled`, and the core issued **exactly one** request.
  Chapter 00 §0.6 says a cancel must not count against the retry budget, and
  `retryable_transport` agrees (`protocol/http.rs:447`) — this is that rule
  observed from the other side of the FFI rather than from a Rust unit test.
- **A non-2xx crossed as a response, not an error**, as
  `contracts/shell-seams.md` requires: staging's 400 became
  `ApiError::Status { code: "VALIDATION_ERROR" }`, which means the core read the
  body the shell handed it.

**The `/health` leg is not Rust-driven, and saying so is the point of this
paragraph.** No exported function or object method issues a request to
`/health`. The only requests the current FFI surface causes Rust to make are
`AuthSession`'s `/auth/*` routes; `GET /health` appears in the core solely in
`crates/memry-core/tests/http_client.rs`, never on an exported path. The
`/health` line above is the same `Transport` object called **directly from
Swift**, so it is evidence about the `URLSession` adapter and about staging,
not about the foreign-trait hop. The foreign-trait hop is evidenced by the
other two lines, against the closest unauthenticated route the surface can
reach. Inventing an exported `health_check(transport)` to close the gap would
have been an FFI-surface change, which is a decision and not a spike.

A malformed address was used deliberately: staging refuses it with
`VALIDATION_ERROR` before any mail is sent. No credential under `~/.memry/staging/`
was read.

### S3 — `WKWebView` opaque origin and keyboard toolbar — **FAIL on R10's decision; the recorded fallback was taken and it passes**

Section E asks "whether an opaque-origin document is a secure context". **It is
not.** R10's decision — `loadHTMLString(html, baseURL: about:blank)` with
`websiteDataStore = .nonPersistent()` — measured:

```
[spike S3 about:blank (R10 decision)]
  origin=null
  isSecureContext=false crypto.subtle=false
  localStorage throws=true  sessionStorage throws=true  indexedDB unavailable=true
```

The privacy half of R10 holds completely: all three storage APIs are gone. The
capability half does not: no secure context means **no `crypto.subtle`**, so
the editor bundle cannot use WebCrypto on this origin.

R10 names exactly one fallback, `WKURLSchemeHandler`, and it works:

```
[spike S3 memry:// (R10 fallback, WKURLSchemeHandler)]
  origin=memry://editor
  isSecureContext=true crypto.subtle=true
  localStorage throws=false sessionStorage throws=false indexedDB unavailable=false
```

**R10's own admissibility condition is not satisfied by the fallback as
configured.** R10: the fallback "is only admissible paired with
`websiteDataStore = .nonPersistent()` **and** a startup assertion that
`localStorage`, `sessionStorage` and `indexedDB` each throw or are
unavailable". `.nonPersistent()` was set, and all three were still handed to
the document — the real origin re-enables web storage exactly as R10's cost
note predicted. The condition can be made to hold, and the spike shows the only
way found to do it: remove the three APIs from `window` in a `WKUserScript` at
`.atDocumentStart`, before any other script runs.

```
[spike S3 memry:// + storage denied at document start]
  origin=memry://editor
  isSecureContext=true crypto.subtle=true
  localStorage throws=true  sessionStorage throws=true  indexedDB unavailable=true
```

That is a **JavaScript-level denial, not the platform-level guarantee the
opaque origin gave for free**, and the difference should be stated wherever
this decision is finally written down: the opaque origin made "the WebView
persists nothing" true in WebKit; the shim makes it true in the guest, where a
future frame, a `WKContentWorld` mistake or an injected script could reach
around it. `.nonPersistent()` remains the backstop — nothing survives the data
store either way — but the guarantee is now two mechanisms deep instead of one.

**Verdict**: the decision as written **FAILS**; the fallback, plus the
storage-denial user script, **PASSES** and is what the bridge should be built
on. `apps/ios/Memry/Spikes/SpikeSchemeHandlerFallback.swift` is the measured
configuration.

**The toolbar.** R16's `inputAccessoryView` override works, is cached across
getter calls, and returns `nil` on demand so WebKit's own bar can be hidden —
asserted in `SpikeS3Tests`. Two screenshots, both from the iPhone 17 simulator
with the **hardware keyboard disconnected** (the UI test asserts
`app.keyboards.firstMatch` exists, so a reconnected hardware keyboard fails the
test instead of quietly producing a picture with no toolbar in it):

| File                                                                 | Shows                                                                                                                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/ios/SpikeEvidence/S3-keyboard-toolbar-default.png`             | the SwiftUI toolbar in the accessory view above the software keyboard; four `.glassEffect(.regular.interactive())` buttons and a `RT OFF` capsule              |
| `apps/ios/SpikeEvidence/S3-keyboard-toolbar-reduce-transparency.png` | the same toolbar with Reduce Transparency on; the badge reads `RT ON` and the banner reads `ReduceTransparency=ON`, so the screenshot proves its own condition |

Under Reduce Transparency the Liquid Glass capsules render as flat, opaque
shapes: no blur, no translucency, contrast and legibility preserved, layout and
hit targets unchanged. Nothing disappears and nothing needs a fallback style.

**These are simulator screenshots, not device screenshots.** T081 asks for
device ones; the device tier is blocked by decision, stated in the addendum
above. The simulator renders the same UIKit and SwiftUI material stack, so it
is real evidence about the accessory view and about the Reduce Transparency
code path — it is **not** evidence about GPU-dependent Liquid Glass rendering
on device hardware, and section E's Liquid Glass line should stay open until a
device run exists.

One thing worth recording because it cost a run: on a fresh simulator iOS shows
the QuickPath introduction **over** the keyboard, which covers the accessory
view entirely. The UI test dismisses it. `xcrun simctl spawn <udid> defaults
write com.apple.Accessibility ReduceTransparencyEnabled -bool true` does **not**
reach `UIAccessibility.isReduceTransparencyEnabled` — it was tried, it survived
a device reboot in the plist, and the app still read `false`. Driving the real
switch in Settings is the only route that worked.

### S4 — Argon2id 64 MiB ops 3 on real hardware — **RUN. Answered, and the answer is not the one the task expected.**

Run on a physical **iPhone 12 Pro (iPhone13,3), arm64, iOS 27.0**, against the
device slice `ios-arm64` and the device's own libsodium. `MemryTests` Unit plan,
`apps/ios/SpikeEvidence/T082-device.xcresult`, **9 passed, 0 failed**.

**Divergence from the task, stated rather than glossed**: T082 names an
**iPhone 15** and this is an iPhone 12 Pro. Both carry 6 GB, and the substantive
question — can the 64 MiB arena fail to allocate, and is that `-1` separable
from a wrong phrase — is answered on real hardware with the real libsodium. It
is not the device the task names.

**T082's two questions, and what was observed:**

1. **Does `crypto_pwhash` OOM at 64 MiB on a memory-pressured phone?**
   **No — because the phone kills the app first.** An unbounded ballast run
   (64 MiB blocks, written not merely reserved, so iOS commits them) ended with
   the test process **killed by jetsam**: `Test crashed with signal kill`, taking
   every other test in the process with it. `malloc` never refused. The failure
   mode the task worries about is **not reachable on iOS through memory
   pressure**: the process dies before `crypto_pwhash` can return `-1`.

   At a bounded **1536 MiB** of touched ballast the derivation completed
   normally (`outcome=succeeded`), so the arena is not fragile at ordinary
   pressure either.

2. **Is the `-1` distinguishable from a wrong passphrase?**
   **Yes, structurally, and it does not depend on the pressure question.**
   `sodium.rs` validates the Argon2id parameters _before_ the call, so a `-1`
   that survives the check can only be an allocation failure, and it surfaces as
   `RecoveryError::Crypto` — a different variant from `BadChecksum`,
   `UnknownWord`, `WrongWordCount`, `NonAscii` and `VerifierMismatch`. The
   device test asserts a bad checksum takes a phrase arm and **never** the crypto
   arm, and asserts the pressure path is either success or `Crypto`, never a
   phrase error. Both held.

**Verdict: PASS**, with the first question answered in the negative — the risk
R3 raised is real in principle and unreachable in practice on iOS, and the
separation that would have mattered exists anyway. The bounded 1.5 GiB test is
kept as the repeatable one; the jetsam run is recorded here and deliberately not
repeated, because a suite that kills itself proves the point once and thereafter
only destroys unrelated evidence.

**No run was made.** Kaan chose simulator-only and no physical iPhone is
attached to this machine.

**Superseded by the run above — kept because the reasoning still holds.** What
follows was written while no device was attached. Its argument against a
simulator run was correct and remains correct; only its conclusion ("T082 is
open") is out of date, and the reason is worth keeping: the simulator executes
on the host CPU against host memory with a _different_ libsodium binary, so it
could answer neither of S4's questions. The device run answered both.

One prediction in it was wrong and the device corrected it. It assumed the
allocation failure could be reproduced by inducing pressure. **It cannot on
iOS** — jetsam kills the process before `malloc` refuses. The distinction the
core draws is real and structural, but it is reached by parameter validation
before the call, not by ever observing the `-1`.

### G3a, as it stands

| Spike                                                             | Verdict                   | Fallback taken                                                                                                                |
| ----------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| S1 UniFFI XCFramework hello-world, callback threading             | **PASS**                  | none needed                                                                                                                   |
| S2 async foreign-trait `Transport` over `URLSession`              | **PASS**                  | none needed; the `/health` leg is shell-driven because no exported path reaches `/health`                                     |
| S3 `WKWebView` opaque origin and keyboard toolbar                 | **FAIL** on `about:blank` | R10's `WKURLSchemeHandler` fallback, plus a document-start storage-denial user script, which together pass                    |
| S4 Argon2id 64 MiB ops 3, iPhone 12 Pro (not the iPhone 15 named) | **PASS**                  | none needed; the OOM is unreachable on iOS — jetsam kills the app first — and the crypto/phrase separation holds structurally |

**All four spikes have a result.** S3 is a FAIL with its fallback taken and
recorded; S4 ran on hardware and answered its first question in the negative.
The device was an iPhone 12 Pro rather than the iPhone 15 the task names — same
6 GB class, real libsodium, real jetsam — and that substitution is stated in the
S4 note rather than left for a reader to notice.
