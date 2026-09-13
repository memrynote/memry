# Phase 4 handoff — specs/002-native-foundation-ios

Overwritten each session. Everything below was observed by the orchestrator, not
reported by a subagent. Where a number came from a subagent it says so.

## Where the work is

Branch `native-core-phase-3` in `.worktrees/native-core-phase-3`, fast-forwarded
with `origin/main` and pushed straight to main, no PR, per Kaan's standing
instruction.

## State: **Phase 4 at 8 of 21.** Phase 3 closed 64/64.

**21, not 24** — T149, T150 and T151 are **CUT** by Kaan's decision. Read the
Scope decisions block at the top of Phase 4 in `tasks.md` first.

| Wave | Tasks                                                              | Status   |
| ---- | ------------------------------------------------------------------ | -------- |
| W1   | T140 `CoreExecutor`, T141 `CoreEvents`                             | **DONE** |
| W2   | T142 `ErrorMapping` + `Log`, T143 `Keychain`                       | **DONE** |
| W3   | T144 `FileProtection`, T145 `Transport`                            | **DONE** |
| W4   | T146 `Reachability` + `Camera`, T147 `SignInView` + **the wiring** | **DONE** |
| W5   | T148 Google, T152 `RecoveryPhraseView`                             | **NEXT** |

## THE SHELL IS WIRED. That changed this session.

Seven tiers had landed with **zero non-test call sites** — the exact state in
which Phase 3 shipped five real bugs behind a green suite. T147 ended it:
`AuthSession` is constructed with the real `Keychain` and the real
`URLSessionTransport`, and `MemryApp` shows `AuthRootView`.

The evidence that matters is a **break-test**, not a passing one: swapping the
real `Keychain` for a **working** in-memory `SecureStore`, or the real transport
for a **working** stub, fails the suite. A fake that behaves correctly still
fails. That is the only assertion shape that distinguishes "wired" from "wired
to something else", and it is the shape every later wiring task should copy.

## The exact next wave

**W5: T148 and T152, two agents.**

- **T148** `Features/Auth/GoogleSignIn.swift` — `ASWebAuthenticationSession`,
  auth code + PKCE, `prefersEphemeralWebBrowserSession = true`, `state` and
  verifier validated, ID token posted to `POST /auth/oauth/google/native`,
  `canceledLogin` a non-error, **no GoogleSignIn-iOS SDK** (R14). The server side
  is ready — the route exists at `auth.ts:435` and reads `GOOGLE_IOS_CLIENT_ID`,
  which **Kaan has now configured in staging**. Confirmed present.
- **T152** `Features/Unlock/RecoveryPhraseView.swift` — 24-word entry, the
  verifier checked **before any key is stored** so a wrong phrase leaves nothing
  partially unlocked, and errors that tell an unknown word from a checksum
  failure from an Argon2id OOM. This is `CoreExecutor`'s canonical caller: the
  64 MiB derivation is the blocking call that must not run on the main actor.
  **A recovery-phrase word is not displayable in error copy** (`DESIGN.md`
  §Error copy, defect 96) — the view may highlight it in the field instead.

Then W6 = T153/T154 (QR + SAS), W7 = T155 (vaults, and it **owns T144's call
site** — defect 105), W8+ = T156–T160, W9 = T161/T162 with Kaan.

## Gate baseline — re-run and observed at the end of this session

| Gate                                                         | Result                                           |
| ------------------------------------------------------------ | ------------------------------------------------ |
| `cargo fmt --all --check`                                    | clean                                            |
| `cargo clippy --all-targets -- -D warnings`                  | clean                                            |
| `cargo test`                                                 | **526 passed, 0 failed, 1 ignored, 35 binaries** |
| `node scripts/check-line-ceilings.mjs`                       | passed (105 files)                               |
| `pnpm --filter @memry/contracts vectors:check`               | **11 classes**                                   |
| `swiftlint lint --strict`, all 17 new Swift files            | **0 violations, 0 serious**                      |
| xcodebuild `Unit`, 11 suites scoped, iPhone 17 **simulator** | **102 passed, 0 failed, 0 skipped**              |

The single ignored Rust test is deliberate: `outbox_durability.rs`'s child
process, re-invoked by its parent to simulate SIGKILL.

No Rust changed this session. `git diff --exit-code` on the generated Swift is
clean because the UniFFI surface was not touched.

Anything worse than this is the next session's to fix, not to inherit.

## Things that will cost you a run if you do not know them

1. **`swiftlint --strict --path <file>` does not exist** on SwiftLint 0.65.1.
   The working form is `cd apps/ios && swiftlint lint --strict <relative-path>`,
   run from `apps/ios` so the config and the nested `MemryTests/.swiftlint.yml`
   are found. The W1 brief had the wrong form and both agents hit it.
2. **Never run the bare `Unit` test plan.** Spec-defect 93: `SpikeTests`' S2
   case makes a **live staging HTTP call with no time limit** and hangs the whole
   plan when staging is slow. It cost two runs. Always scope with
   `-only-testing:MemryTests/<Suite>`.
3. **`SpikeS4Tests/pressureNeverLooksLikeAWrongPhrase()` fails on a simulator by
   design** — it is the device-gated T082 test asserting `isDevice`. Not a
   regression, not yours.
4. **`xcodebuild` lies about the count.** Swift Testing suites are invisible to
   the XCTest counter; a run that executed 58 tests prints `Executed 0 tests`.
   Real numbers only from
   `xcrun xcresulttool get test-results summary --path <bundle>.xcresult`.
5. **Two agents' runs collide.** A concurrent break sweep poisoned one agent's
   full-plan run — it saw the _other_ agent's deliberately-broken file and
   reported two failures that were not its own. Scope every run, and run the
   orchestrator's own verification only when no agent is mid-sweep.
6. **`-only-testing:` with a name that matches nothing runs nothing and still
   prints `TEST SUCCEEDED`** (spec-defect 106). Swift Testing suite names are
   **struct names, not file names**, and here they diverge:
   `TransportTests.swift` holds `TransportHTTPTests` and `ResponseBodyTests`;
   `FileProtectionTests.swift` holds `VaultFilesRealFilesystemTests` and
   `VaultFilesSubstitutedPlatformTests`. My own verification run reported **64
   passed** where the truth was **102**. Derive the names from the source
   (`grep -hoE '^(struct|final class) [A-Za-z0-9_]+' apps/ios/MemryTests/*.swift`)
   and **precompute the expected total before reading the result** — the failure
   mode is a plausible smaller number, not an error.
7. **The simulator does not implement data protection at all**, measured rather
   than assumed. `URL.resourceValues(.fileProtectionKey)` returns
   `NSFileProtectionCompleteUntilFirstUserAuthentication` for a file set to
   `.complete`, one set to `.none`, and one never touched — the target
   entitlement's default echoed back. **Any assertion on the effective class
   passes with the code under test deleted.** Spec-defect 104. Same family as the
   simulator keychain, which has no lock state.
8. **No `project.pbxproj` edit is needed for a new file.** The project uses
   `PBXFileSystemSynchronizedRootGroup` for `Memry`, `MemryTests`,
   `MemryUITests` and `MemryConformanceTests`. A new `.swift` file in those
   directories is picked up automatically. This removes the shared-file conflict
   between concurrent agents; say so in every brief.

## What landed, and what it is NOT

`CoreExecutor` — one serial `DispatchQueue(qos: .userInitiated)` bridged with
`withCheckedThrowingContinuation`. Fronts the **blocking** surface only;
`AuthSession`'s seven `async throws` methods are awaited directly. Cancellation
decided: before-start cancels and never enters the core, after-start completes.

`CoreEvents` — one `AsyncStream`, `.bufferingNewest(256)`, single-consumer,
`consume()` returns `nil` on the second call. An event is a `Topic` plus a
`Scope`, and a `Scope` carries at most an identifier, so a producer that wants to
send state **finds it cannot express one**. `CoreEventEmitter`'s whole surface is
`emit(_:) -> Void`, which is what stops a Rust-called seam re-entering the core.

`ErrorMapping` — all **14** generated enums, not the 7 in `core-api.md`'s table:
the seam errors come back nested inside `AuthError.SecureStore`,
`CrdtError.Storage` and `ApiError.Transport`. Exhaustive, no `default:`.

`Log` — every message parameter is a `StaticString`, so
`log.info("phrase \(phrase)")` **does not compile**. No entry point accepts a
`String`.

`Keychain` — data-model §B exactly, and the **event hub's first producer**:
`secureStoreLocked` fires from the single `errSecInteractionNotAllowed` arm.

**NONE OF IT IS CONSTRUCTED IN PRODUCTION YET, and W3 made that worse rather
than better.** Two of the three gaps W3 found are call sites that did not exist:
nothing called the `FileProtection` seam at all (defect 105, now T155's), and
**nothing can call `open_socket`** — `RealtimeClient` is not exported and appears
**zero times** in the generated Swift, so T145's socket half is unreachable from
the core by construction until band B3 exports a `Sync` object (defect 103). The
checkpoint does not need the socket: US3 is sign in, unlock, browse, and a
realtime hint only shortens a pull the shell can drive itself.

**That is the Phase 3 lesson live.** `grep` confirms zero non-test call sites for `CoreExecutor`,
`CoreEvents`, `ErrorMapping`, `Log` and `Keychain`. Phase 3 shipped five tiers
that were implemented, tested behind fakes, and never called — every one passed
the whole unit suite. **T147 is where these become wired**, and until it lands
they are unproven. T147's task text now says so, and also makes T147 the task
that ratifies `UserFacingError`'s shape before eleven views inherit it.

`VaultFiles` implements `FileProtection` — named for the platform noun because
the generated protocol owns `FileProtection` and the clash **cannot be
qualified past** (`MemryCore` is also a public enum in its own module). Its
`openingVault(_:open:)` makes the sidecar sweep structural: prepare, the caller's
own open closure, then the sweep, so a caller cannot skip it. The sweep refuses
to report success when no database exists, and runs on **every** open.

`URLSessionTransport` implements `Transport`. **HTTP half only is ticked.** A
non-2xx crosses as a response with its body, which is what keeps the
outbox-wedging 400 diagnosable. Bodies past 1 MiB stream to a file and cross
memory-mapped, unlinked on map. `waitsForConnectivity` off and redirects not
followed, both because either is an invisible retry the core cannot see or
cancel.

## Device evidence already banked

Taken on the **physical iPhone 12 Pro** (`8025C79A-F257-500F-8BA1-A14122135B2D`),
iOS 27.0, arm64. **Re-run these against the final build for T162 — do not reuse
these numbers as the final evidence.**

| Run                        | Result                                               |
| -------------------------- | ---------------------------------------------------- |
| `Unit`, whole plan, device | **160 passed, 0 failed**                             |
| `Conformance`, device      | **12 passed, 0 failed** — T162's first evidence item |

**T082 is CLOSED.** It was Phase 3's only BLOCKED item, and blocked for exactly
one reason: no physical iPhone. All three S4 assertions passed on hardware — the
64 MiB derivation succeeds with no pressure, under memory pressure it either
succeeds or fails as `Crypto` and **never** as a phrase error, and a wrong phrase
is a phrase error and never a crypto one. That is the distinction
`CryptoError::OutOfMemory` exists to preserve, now evidenced on the metal.

**T144's device half landed too** (spec-defect 104). The measurement test asserts
a different thing on each platform, and the effective-class test is **skipped**
off-device rather than vacuously passed, so a green simulator run can never read
as that having held.

Bundle-identifier and keychain-group swaps were backed up to `/tmp`, applied, and
reverted; `git status` confirmed `project.pbxproj` and `Memry.entitlements`
unchanged. **Always confirm that revert.**

## Two corrections to things this project believed

**"The fourth OTP request hangs with no output" was never a hang** (defect 109).
It is the retry ladder obeying the server: `http.rs` turns a 429's `Retry-After`
straight into the delay with **no ceiling**, and the per-IP limiter is 10 per
**3600 s** with `Retry-After` set to the remaining window — so an eleventh OTP
call from one address suspends for up to an hour. And it **cannot be
interrupted**: `rust_future_cancel` appears **zero** times in the generated
bindings, so cancelling the Swift `Task` does not stop an in-flight core call
(defect 108). Two sessions were spent treating this as a rate-limit mystery.
Capping the honoured delay in the core's ladder is a **decision for Kaan**, not a
Phase 4 task.

**iOS CI was red on `main` for the whole of Phase 3 and the first half of Phase
4, and nobody noticed** (defect 112) — because the per-file `swiftlint` every
brief prescribes passes cleanly while CI runs it project-wide. **The gate the
tasks ran was not the gate CI ran.** Fixed here; run `pnpm check:architecture`
and a bare `swiftlint lint --strict` from `apps/ios` before declaring a wave
green, not just the per-file form.

## The defect log: 113 logged, 113 closed, **0 open**

Eleven closed this session, 89 to 99. The two most consequential:

- **89** — T141 and research R15 both named "the Rust-to-Swift event foreign
  trait" in the definite singular. **No such trait exists.** The core exports
  twelve; nine are Swift-implemented and Rust-called, and every one of the nine
  is request-shaped. The eight-seam list is closed, so a subagent following T141
  literally would have invented a ninth seam or quietly built something else
  under the task's name. Caught **before dispatch**, by reading the seams
  directory rather than trusting the task text. New `shell-seams.md` §"There is
  no event seam" replaces the missing trait with the rule that was the point: **a
  Swift method Rust calls MUST NOT re-enter the core.**
- **94** — `DESIGN.md` gave one sentence about error copy, so T142 wrote 64
  user-facing sentences with no source. Now §"Error copy, in detail", seven
  normative bullets, each tied to a failure already in this log.

Also: **90** R15's premise contradicted by seven `async` `AuthSession` methods;
**91** a main-thread assertion is a false-green generator on this toolchain;
**92** nobody owned `CoreEvents.consume()`, now T158's; **93** the Unit plan is
non-hermetic; **95** `UserFacingError`'s shape was unratified, now T147's;
**96** a recovery-phrase word is not displayable; **97** `ApiError::Status`
forces a 5xx/4xx split in the shell, recorded as deliberate and bounded;
**98** nothing in the spec mentioned localization while FR-077 requires RTL;
**99** an `AsyncStream` test that drains a fixed count **hangs** instead of
failing.

## Break-tests found three weak assertions this session

The discipline that caught five in Phase 3 caught three more. All three were
green under the exact bug they were written for.

1. **A main-thread assertion passed with the entire `DispatchQueue` hop
   deleted.** A `nonisolated async` function on this toolchain hops to the global
   concurrent executor, so the work left the main thread with no queue at all.
   Now asserts queue identity via `__dispatch_queue_get_label(nil)`. Defect 91.
2. **A nested-error test compared two mapped values, and under the collapse
   mutation both sides moved together** and it stayed green. Now asserts what the
   user actually reads.
3. **An `AsyncStream` test HUNG rather than failed** under a missing yield — 21
   minutes of silence that looked exactly like a deadlock in the seam under test.
   Defect 99.

A fourth mutation **would not compile** (duplicate enum raw values), so that
assertion's guarantee came from the language rather than the test; it was
retargeted at something the test does catch. Worth imitating: when a break will
not compile, the test was not carrying the weight you thought.

**Make every subagent break every new assertion, watch it fail, restore, and
report what it observed.** It is the highest-yield instruction in the brief.

## Simulator evidence, and what it is not

Every number above is from the **iPhone 17 simulator**, iOS 26.5, arm64.

For the Keychain this caveat has teeth and is stated in the code: 9 of 18 tests
make real `SecItem*` calls, but the simulator keychain has no Secure Enclave and
no lock state, so `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` is stored
there as an attribute that **gates nothing**. `errSecInteractionNotAllowed`
cannot be produced on demand at all — that arm is covered only at the mapping
layer, through a protocol that substitutes the platform rather than the store.
Whether the device honours the class, and whether a background task can read the
signing key before first unlock, is **device evidence and belongs to T161/T162**.

The physical **iPhone 12 Pro** (`8025C79A-F257-500F-8BA1-A14122135B2D`, iOS 27.0,
Developer Mode on) is available and was not needed this session. Signing recipe
is unchanged and is in `phase4.txt`: team `TV343Q4W8A`, bundle id
`com.memry.app.t094`, and **never** pass `PRODUCT_BUNDLE_IDENTIFIER=` on the
command line — it applies to the embedded `MemryCore` framework too and iOS
refuses the install.

## Blocked on Kaan

- **Nothing blocks W3.** Nothing was run against staging this session; no network
  call was made by the orchestrator or by any subagent.
- **The staging recovery phrase was pasted into a chat transcript in Phase 3 and
  Kaan was asked to rotate it.** Still unconfirmed. Anything that unlocks against
  staging should confirm the phrase works before assuming.
- **Localization (defect 98) needs a decision before T160**, or the strings
  landed in `ErrorMapping.swift` get rewritten. They are literals today.
- **No iOS support/feedback channel is documented anywhere** in the spec or
  `PRODUCT.md`, so no error copy tells a user to report a problem (defect 94).
- Phase 3 left two markers in Kaan's real notes, since removed, and a second
  `memry-cli` device registered at `/tmp/g5b` that is **worth revoking** with the
  other stale ones. Account was at 21 of 50 devices.

## Checkpoint status

**NOT MET.** The checkpoint needs T162: the device `Conformance` `.xcresult`
re-run against this build, plus T161 naming each test vault unlocked by **each**
of the two paths — recovery phrase and device link — on a phone that had never
seen it, repeated on an account holding two vaults. Twenty tasks remain, T144
through T162, and no vault has been opened on a phone yet.
