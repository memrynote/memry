# Quickstart: validating Memry Native — Foundation + iOS Shell

Runnable validation scenarios, one per release-train gate in
[plan.md](./plan.md). Each scenario names prerequisites, commands, and the
expected outcome. Implementation detail lives in `tasks.md`; this file only
proves the feature works.

## Prerequisites

- macOS 15.6+, Xcode 26.0 with the iOS 26 SDK, command-line tools selected.
- Rust 1.89+ with targets `aarch64-apple-ios`, `aarch64-apple-ios-sim`,
  `x86_64-apple-ios`.
- Node 22 and pnpm; `pnpm install --frozen-lockfile` at the repo root.
- **Server base URLs.** `--server staging` resolves to
  `https://sync-staging.memrynote.com` and `--server prod` to
  `https://sync.memrynote.com`; `--server local` is `http://localhost:8787`.
  These are not hardcoded anywhere in the product: the desktop reads
  `SYNC_SERVER_URL` from a **gitignored** `.env.<environment>` file
  (`packages/sync-client/src/sync-server-url.ts`), which is why the value is
  written here rather than left to be discovered. A worktree without those
  files silently falls back to localhost, so `pnpm env:check` below is not
  optional.
- Staging credentials: `apps/desktop/.env.staging` linked (`pnpm env:check`),
  a staging test account, and a desktop build pointed at staging
  (`pnpm --filter @memry/desktop dev:staging`).
- A physical iPhone (iPhone 15 is the performance reference) with a
  development profile. The simulator does not run background tasks, has no
  camera, and does not validate the device crypto build.

## G1: protocol specification complete

```bash
ls docs/protocol/                       # 00-overview … 14-attachments present
pnpm docs:build                         # chapters render
```

Expected: every chapter in
[contracts/protocol-spec-outline.md](./contracts/protocol-spec-outline.md)
exists and states its normative facts, and every row of
[checklists/protocol-spec.md](./checklists/protocol-spec.md) is ticked as
answered or explicitly undefined, with the must-answer set in
[plan.md](./plan.md)'s gate table answered rather than deferred.

## G2: conformance vectors verified by desktop

```bash
pnpm --filter @memry/contracts vectors:check      # regenerates into a temp dir and diffs the committed files
pnpm --filter @memry/contracts test               # every vector class asserted from production code paths
pnpm test:desktop                                  # desktop stays green
```

Expected: `vectors:check` reports no difference and writes nothing into the
working tree; vector counts match
[contracts/conformance-vectors.md](./contracts/conformance-vectors.md);
desktop suites green.

## G2b: CI gates moved before the freeze

```bash
gh workflow view ios-ci.yml
pnpm --filter @memry/editor-web check              # input-freshness gate now lives here
```

Expected: `ios-ci.yml` runs the editor-asset freshness check and the vector
parity test; `apps/mobile/editor-web` no longer exists; `packages/editor-web/dist/manifest.json`
carries both `contractHash` and `sha256`.

## G3a: spikes pass or fail

Four spikes, each with a written pass or fail note appended to
[research.md](./research.md) section F. No product code comes out of this
section and nothing in phase A or B depends on its artifacts.

1. **S1 UniFFI XCFramework hello-world** in an empty iOS app. Call a Rust
   function, get a typed error back, log `Thread.current` from a foreign-trait
   callback, and assert the callback does not re-enter the core while a core
   lock is held.
2. **S2 async foreign-trait HTTP adapter**: a round trip to staging `/health`
   through the `Transport` trait, including the cancellation path.
3. **S3 WKWebView**: assert `window.isSecureContext && !!crypto.subtle` on
   `about:blank`, show the SwiftUI keyboard toolbar through the
   `inputAccessoryView` override, and capture a device screenshot of that
   toolbar with Reduce Transparency turned on.
4. **S4 Argon2id 64 MiB on iPhone 15** under memory pressure, reproducing the
   `crypto_pwhash` out-of-memory return at least once.

Expected: four notes, each pass or fail with its artifact. A fail is a
scope decision, not a blocked gate.

## G3: Rust parity on host and device

```bash
cargo test -p memry-core                           # tier 1: include_str! vectors, dryoc cross-check
crates/memry-core/build-xcframework.sh             # XCFramework + generated Swift
git diff --exit-code packages/swift/MemryCore/Sources/MemryCore/Generated/
git diff --exit-code apps/ios/Memry/Generated/EditorWebAsset.swift
swiftlint --strict --config apps/ios/.swiftlint.yml
xcodebuild test -project apps/ios/Memry.xcodeproj -scheme Memry \
  -destination 'platform=iOS,name=<iPhone>' -testPlan Conformance
```

Expected: 100% of vectors pass in both tiers; the on-device run is the
`aarch64-apple-ios` gate, the simulator run is not evidence; both generated
files are byte-identical after regeneration; SwiftLint reports no violation
at strict level.

## G4: headless pull

Preconditions on staging, checked before anything else. A missing secret
makes bootstrap silently unavailable and a missing policy row makes the kill
switch untestable, so both are gates on the gate.

The staging D1 is named **`memry-sync-staging`**. It is written out here
because the name is not derivable from the environment: the three databases
are `memry-sync`, `memry-sync-staging` and `memry-sync-production`, so the
obvious construction "`memry-` plus the environment" is wrong for two of the
three, and `wrangler` answers a wrong name with a generic lookup failure that
reads like a credentials problem. The authority is
`apps/sync-server/wrangler.toml`.

```bash
pnpm --filter @memry/sync-server exec wrangler secret list --env staging \
  | grep BOOTSTRAP_SESSION_HMAC_KEY
pnpm --filter @memry/sync-server exec wrangler d1 execute memry-sync-staging --env staging --remote \
  --command "SELECT platform, writes_enabled, min_write_version FROM client_policies WHERE platform = 'ios';"
```

```bash
cargo run -p memry-cli -- --server staging login --email <account>
cargo run -p memry-cli -- unlock --recovery-phrase-file phrase.txt
cargo run -p memry-cli -- vaults
cargo run -p memry-cli -- pull --vault <id>
cargo run -p memry-cli -- notes list --vault <id>
cargo run -p memry-cli -- notes text <id>          # extract_text output
cargo run -p memry-cli -- notes state-vector <id>  # Y.Doc state vector, hex
```

Expected: OTP login completes, the device appears in the desktop device
list, the vault created on desktop unlocks, note titles print, and for every
note in the vault the extracted text equals desktop's extracted text while
the Y.Doc state vectors match after sync. Byte identity of the markdown file
is **not** asserted here: the core has no markdown serialiser and the phone
never writes vault files.

## G5: headless round trip with a real desktop

```bash
cargo run -p memry-cli -- notes edit <id> --append "from cli"   # a blockContainer > paragraph > text node via yrs
# on desktop: observe the note within 5 s; edit the same note on desktop
cargo run -p memry-cli -- sync --once && cargo run -p memry-cli -- notes text <id>
cargo run -p memry-cli -- tasks set <taskId> --priority high   # concurrent field edit with desktop date change
cargo run -p memry-cli -- debug inject-item --type not_a_real_type --id synthetic-1  # SC-014
cargo run -p memry-cli -- sync --once && cargo run -p memry-cli -- debug dump-item --id synthetic-1
# staging: enable the ios write kill switch
cargo run -p memry-cli -- --client-platform ios sync --once    # expect PLATFORM_WRITES_DISABLED, queue preserved
```

Expected: both directions under 5 s and the appended paragraph is visible on
desktop as a real block; both field edits survive; the synthetic unknown item
type round-trips byte-for-byte through `sync_items.payload` (SC-014);
read-only mode reported and the outbox intact; `spec-defects.md` in this
directory has zero open entries.

## G6: editor budgets and bundle handshake

1. Install a debug build on the iPhone; turn off the simulator hardware
   keyboard if using the simulator for layout only.
2. Open a 50 KB note; type 30 characters inside a device test that reads the
   core's FFI-call counter and its bridge envelope size and cadence
   histogram. Those two counters are the assertion. An Instruments trace is
   context for a failure, never the evidence.
3. Replace `editor.html` with a previous build and relaunch.
4. Unlock a desktop-created vault twice, once by recovery phrase and once by
   QR link with SAS (SC-003).

Expected: keystroke-to-render under 50 ms; the histogram shows no flush
faster than 24 ms and no envelope over 256 KB; the FFI-call counter does not
increase per keystroke; the stale asset is refused with a visible error and
the `staleAsset` counter increments; both unlock paths open the vault.

## G7: scale, search, reminders, offline matrix

1. Link a 10,000-item staging vault on Wi-Fi; time until recent notes open.
2. Run the search benchmark test plan; read p95.
3. Seed 5,000 reminders; run the reconcile test; read pending count.
4. Schedule a reminder a few minutes out on a real device, lock it, and wait
   for the notification to fire. Repeat and record the run count (SC-011).
5. Measure the `BGAppRefreshTask` wall-time budget on device with the phone
   locked, using the LLDB `_simulateLaunchForTaskWithIdentifier:` SPI,
   including the expiry handler.
6. Run the offline matrix as an automated Swift Testing plan driven by
   `simctl` network conditioning: create and edit notes offline, force-quit,
   reboot, reconnect. Record the run count.

Expected: browsable within 2 min; p95 under 300 ms; pending never exceeds
56; the timed reminder fires in every recorded run; the measured background
wall time is written into [research.md](./research.md) section E in place of
the community estimate; every offline edit reaches desktop intact in 100% of
the recorded runs.

## G8: compliance

```bash
xcodebuild archive ... && xcrun altool --upload-app ...   # internal TestFlight
```

Expected: no ITMS-91053/91055 mail; `PrivacyInfo.xcprivacy` declares C617.1,
CA92.1, E174.1, 35F9.1; `ITSAppUsesNonExemptEncryption` is `YES`; account
deletion completes in-app and leaves no local key material; accessibility
audit (contrast, labels, reduced motion, reduced transparency, RTL) passes.

The audit covers the WebView editor surface and its keyboard toolbar
explicitly, since neither is a system control and neither inherits anything:
RTL layout and caret behaviour inside the document, Dynamic Type on the
toolbar and on editor chrome, and VoiceOver reaching every toolbar control
with a label. The XCUITest editor smoke test gains an RTL case so a
right-to-left regression fails a build rather than waiting for the audit.

## G8b: kill switch against the shipped build

```bash
# turn writes off for iOS
pnpm --filter @memry/sync-server exec wrangler d1 execute memry-sync-staging --env staging --remote \
  --command "UPDATE client_policies SET writes_enabled = 0 WHERE platform = 'ios';"
# ... exercise the TestFlight build, then turn writes back on
pnpm --filter @memry/sync-server exec wrangler d1 execute memry-sync-staging --env staging --remote \
  --command "UPDATE client_policies SET writes_enabled = 1 WHERE platform = 'ios';"
# who wrote what, and from which build
pnpm --filter @memry/sync-server exec wrangler d1 execute memry-sync-staging --env staging --remote \
  --command "SELECT item_id, client_platform, client_version, updated_at FROM sync_items ORDER BY updated_at DESC LIMIT 20;"
```

Run against the TestFlight build, not a debug build. Between the two flips:
edit a note, confirm the UI says the app is read-only and explains why, and
confirm the outbox still holds the edit. After the second flip, confirm the
queue drains without the user doing anything.

Expected: read-only state reached without a restart; no queued write lost or
retried into backoff; every write-attribution row for this run carries the
TestFlight build's version string (FR-036, FR-070).

## G9: beta divergence

Expected: over 7 days, the digest comparison of at least 50 items per
beta account matches on both shells in 100% of samples.
