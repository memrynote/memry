# Phase 4 handoff — specs/002-native-foundation-ios

Overwritten each session. Everything below was observed by the orchestrator, not
reported by a subagent. Where a number came from a subagent it says so.

## Where the work is

Branch `native-core-phase-3` in `.worktrees/native-core-phase-3`, fast-forwarded
with `origin/main` and pushed straight to main, no PR, per Kaan's standing
instruction.

## State: **Phase 4 at 4 of 24.** Phase 3 closed 64/64.

| Wave | Tasks                                        | Status                   |
| ---- | -------------------------------------------- | ------------------------ |
| W1   | T140 `CoreExecutor`, T141 `CoreEvents`       | **DONE**, ticked, pushed |
| W2   | T142 `ErrorMapping` + `Log`, T143 `Keychain` | **DONE**, ticked, pushed |
| W3   | T144 `FileProtection` [P], T145 `Transport`  | **NEXT**                 |

## The exact next wave

**W3: T144 and T145, two agents, cap at two.**

- **T144** `apps/ios/Memry/Seams/FileProtection.swift` — `Application Support/<bundle>/vault/<vaultId>/` at `completeUntilFirstUserAuthentication`, `isExcludedFromBackup` on the directory, the class **re-asserted on the `-wal` and `-shm` sidecars after first open** because they do not inherit it reliably. The test must assert the **effective** class read back from the database file _and_ both sidecars.
- **T145** `apps/ios/Memry/Seams/Transport.swift` — the single `Transport` seam. `send` over `URLSession` (large blob fetches return a **file path**, not `Data`), `open_socket` over `URLSessionWebSocketTask`, closed on background and reopened on foreground. **Zero retry, auth or reconnect logic** — all of it stays in Rust. Header keys lowercase in both directions. A non-2xx is a **response**, not an error.

T145 is the bigger of the two and the one the core has waited for since Phase 3.
It is also the second half of T147's wiring.

Then W4 = T146 (`Reachability` + `CodeCapture`), W5 = T147 + T148.

## Gate baseline — re-run and observed at the end of this session

| Gate                                                        | Result                                           |
| ----------------------------------------------------------- | ------------------------------------------------ |
| `cargo fmt --all --check`                                   | clean                                            |
| `cargo clippy --all-targets -- -D warnings`                 | clean                                            |
| `cargo test`                                                | **526 passed, 0 failed, 1 ignored, 35 binaries** |
| `node scripts/check-line-ceilings.mjs`                      | passed (105 files)                               |
| `pnpm --filter @memry/contracts vectors:check`              | **11 classes**                                   |
| `swiftlint lint --strict`, all 10 new Swift files           | **0 violations, 0 serious**                      |
| xcodebuild `Unit`, 6 suites scoped, iPhone 17 **simulator** | **58 passed, 0 failed, 0 skipped**               |

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
6. **No `project.pbxproj` edit is needed for a new file.** The project uses
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

**NONE OF IT IS CONSTRUCTED IN PRODUCTION YET, and that is the Phase 3 lesson
live.** `grep` confirms zero non-test call sites for `CoreExecutor`,
`CoreEvents`, `ErrorMapping`, `Log` and `Keychain`. Phase 3 shipped five tiers
that were implemented, tested behind fakes, and never called — every one passed
the whole unit suite. **T147 is where these become wired**, and until it lands
they are unproven. T147's task text now says so, and also makes T147 the task
that ratifies `UserFacingError`'s shape before eleven views inherit it.

## The defect log: 99 logged, 99 closed, **0 open**

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
