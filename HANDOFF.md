# Phase 4 handoff — specs/002-native-foundation-ios

Overwritten each session. Everything below was observed by the orchestrator,
not reported by a subagent. Where a number came from a subagent it says so.

## Where the work is

Branch `native-core-phase-3` in `.worktrees/native-core-phase-3`,
fast-forwarded with `origin/main` and pushed straight to main, no PR, per
Kaan's standing instruction.

## STOP HERE FIRST: defect 114 is closed; five tasks remain

The defect log is **130 logged, 128 closed, 2 open**. **Neither open entry
blocks the checkpoint.**

| #       | State                                                                                                                                                                                                                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **128** | The local vault key verifier has **nowhere to live on iOS** — `SecureStoreKey` is a closed five-entry enum and the core exports no settings surface — so data-model §C.2's "both verifiers are checked" is false there. The account verifier still catches a wrong phrase.                                        |
| **130** | The `CodeCapture` seam exposes **no camera preview**, so scanning is blind: the screen can say the camera is running but not show what it is pointed at, and the failure is silent. The paste fallback is a complete path, so T161 is unaffected. **Decide before the camera path goes in front of a real user.** |

**114 closed on 2026-09-14** and it is the entry worth reading once more. It
began as "the core exports nothing the rest of Phase 4 needs" and ended with
every capability exported **and called** — the standard the entry itself
insisted on, which is why T235 deliberately left it open until T153/T154 landed.

**The pattern it exposed is the thing to carry forward.** Work was specified
against a capability nobody had checked existed **five times in one phase**:
114, 124, 125, 127, and the cut T156a. Every one would have been caught by a
`grep` over
`packages/swift/MemryCore/Sources/MemryCore/Generated/memry_core.swift`
**before the brief was written**. The fifth was caught that way. Do it first,
every time.

## State: **Phase 4 at 22 of 24 ticked.** Phase 3 closed 64/64.

T149, T150, T151 and **T156a** are **CUT**; T163, T164, T165 and T235 were
**added**. **T156a was cut today**: `Notes` exports only `folders`/`list`/`read`,
T126 built the CRUD in Rust in Phase 3 and none of it reached the FFI — and it
is write work in a read-only phase, needing the vault key on `Vault`, sealing,
the outbox and the push path. Cut, not deleted; nothing depends on it. Read the Scope decisions block at the top of Phase 4 first.

| Wave | Tasks                                                          | Status           |
| ---- | -------------------------------------------------------------- | ---------------- |
| W1   | T140 `CoreExecutor`, T141 `CoreEvents`                         | **DONE**         |
| W2   | T142 `ErrorMapping` + `Log`, T143 `Keychain`                   | **DONE**         |
| W3   | T144 `FileProtection`, T145 `Transport`                        | **DONE**         |
| W4   | T146 `Reachability` + `Camera`, T147 `SignInView` + the wiring | **DONE**         |
| W5   | T148 Google, T152 `RecoveryPhraseView`                         | **DONE**         |
| W6   | T160 design tokens, T163 B3 account exports                    | **DONE**         |
| W7   | T164 `Vault`/`Notes` read, T165 restore + shell wiring         | **DONE**         |
| W8   | **T235 device-linking exports (new-device half)**              | **NEXT**         |
| W9+  | T155, T156, T156a, T157, T158, T159, then T161/T162 with Kaan  | partly unblocked |

**Open: T157, T158, T159, T161, T162** — five, none blocked on a decision.

## What this session actually changed

**The phase was built on an assumption nobody had checked.** Seven tasks were
written against a core surface that did not exist, and two independent agents
hit that wall from opposite directions within twenty minutes. Kaan chose to
build band B3's **minimum**, and that was affordable only because the behaviour
was already there and tested — `protocol/account.rs` already had the two
account reads, and `domain/notes.rs`, `domain/folders.rs` and the repositories
are what the `memry` CLI already drives. **Only the UniFFI layer was missing.**
If a future export turns out to need behaviour that is not already there,
**reopen 114** — the narrow choice rests entirely on that.

**T163** exported `keyMaterial`, `vaults`, `beginProviderSignIn` and
`completeProviderSignIn`. **T164** exported the read slice of `Vault` and
`Notes`. **T165** closed defects 121 and 123 and wired the shell onto all of it,
so T148 and T152 finally have production call sites and are ticked.

**T160** landed the design tokens with real adoption — `SignInView` lost 23
hard-coded values and `RecoveryPhraseView` 31, including two near-identical
48-line copies of one error view.

Three things the agents got right that are worth imitating:

- T148 **refused to wire a Google button** it could not complete, because a
  button that opens a real consent screen and then cannot sign anyone in is
  worse than no button. It stayed unwired until T165 could finish it.
- T148 also hit `check:architecture` with a `URLSession` in `GoogleSignIn.swift`
  and **did not weaken the gate** — it deleted the default exchange so the type
  now _requires_ its transport. T165 later routed that exchange over the **one**
  existing `Transport` seam rather than a new file under `Memry/Seams/`, which
  would have passed the gate while defeating the rule it exists for.
- T164 **exported the folder projection honestly** and documented that
  unconfigured folders have no row (defect 124), rather than inventing a product
  policy inside the core.

## iOS CI was red on `main` on every run, and is fixed (defect 115)

Defect 112 fixed four causes and CI **stayed red**. Four more, three of them
false reds:

1. **`try #require(Self.isDevice)` is not a skip — it is a failure.** Swift
   Testing's `#require` records an expectation failure when the condition is
   false. Both device-gated tests failed on every simulator run while their doc
   comments said "skipped rather than vacuously passed off-device". The comment
   and the code disagreed, and the comment is what everyone read — including
   the previous HANDOFF, which called it "by design, not a regression, not
   yours". Now `.enabled(if:)` traits, which genuinely skip. **Same family as
   defect 104, inverted**: 104 passed where it should have skipped, 115 failed
   where it should have skipped.
2. **CI ran unsigned.** `CODE_SIGNING_ALLOWED=NO` meant no
   `keychain-access-groups` entitlement, so every `SecItem*` returned
   `errSecMissingEntitlement` (-34018) and all seven `KeychainRealStoreTests`
   failed. Those are the only tests that prove data-model §B's identities
   against the **real** keychain, and they had never run on CI once. Now ad-hoc
   signed (`CODE_SIGN_IDENTITY=-`), provisioning off, no team.
3. **A simulator constant was pinned as a literal**, including a _directory's_
   read-back as `nil`. The local and CI simulators disagreed. Re-asserted as
   invariance — all three read-backs identical, so the value carries no
   information — plus a non-nil check so "could not tell" cannot satisfy it.
4. **Loopback listener readiness 5 s → 20 s.** First test in a `.serialized`
   suite on a cold runner. The bound stays, so a listener that never binds
   still fails loudly instead of hanging.

**The standing rule stands and is why this was found**: run a bare
project-wide `swiftlint lint --strict` from `apps/ios`, run
`pnpm check:architecture`, and check
`gh run list --workflow=ios-ci.yml --limit 3` before believing main is green.
The per-file `swiftlint` every brief prescribes is not the gate CI runs.

## Gate baseline — re-run and observed by the orchestrator this session

| Gate                                                   | Result                                         |
| ------------------------------------------------------ | ---------------------------------------------- |
| `cargo fmt --all --check`                              | clean                                          |
| `cargo clippy --all-targets -- -D warnings`            | clean                                          |
| `cargo test`                                           | **577 passed, 0 failed, 1 ignored**            |
| `node scripts/check-line-ceilings.mjs`                 | passed (140 files)                             |
| `pnpm --filter @memry/contracts vectors:check`         | passed (11 classes)                            |
| `pnpm check:architecture`                              | passed                                         |
| `swiftlint lint --strict` (project-wide, bare)         | **0 violations, 0 serious, 70 files**          |
| xcodebuild `Unit`, **whole plan**, iPhone 17 simulator | **284 total, 282 passed, 0 failed, 2 skipped** |
| generated Swift diff vs HEAD                           | **0 deleted lines**                            |
| **iOS CI on `main`**                                   | **GREEN**, both jobs, verified job-by-job      |

The 284 was **precomputed before the result was read**.
The 2 skips are exactly the device-gated tests from defect 115(a), which
previously failed. The xcodebuild run used the **same signing flags the
workflow now passes**, and the keychain suite passed under them with an empty
`DEVELOPMENT_TEAM` — which is the CI configuration.

The single ignored Rust test is deliberate: `outbox_durability.rs`'s child
process, re-invoked by its parent to simulate SIGKILL.

No Rust changed this session, so `git diff --exit-code` on the generated Swift
is clean and the UniFFI surface is untouched.

## The Unit plan is hermetic — the old warning is retired

Previous handoffs said "never run the bare `Unit` plan" because `SpikeTests`'
S2 case made a live staging call and hung it. **The spikes were deleted**
(defect 112), so that case is gone and the bare plan is safe — this session ran
it whole, which is the only reason the real 196 was visible at all. Scoping
every run is what let defect 106's "plausible smaller number" hide for so long.

## Things that will cost you a run if you do not know them

1. **`swiftlint --strict --path <file>` does not exist** on SwiftLint 0.65.1.
   Use `cd apps/ios && swiftlint lint --strict <paths>`, run **from
   `apps/ios`** so the config and the nested `MemryTests/.swiftlint.yml` are
   found. And run the **bare** form too — see defect 115.
2. **`#require` fails; `.enabled(if:)` skips.** Defect 115. If you want a test
   to not run off-device, the trait is the only thing that does that.
3. **`-only-testing:` with a name that matches nothing runs nothing and prints
   `TEST SUCCEEDED`** (defect 106). Swift Testing suite names are **struct
   names, not file names**, and they diverge. Derive them with
   `grep -hoE '^(struct|final class) [A-Za-z0-9_]+' apps/ios/MemryTests/*.swift`
   and **precompute the expected total before reading the result** — the
   failure mode is a plausible smaller number, not an error.
4. **`xcodebuild` lies about the count.** Swift Testing suites are invisible to
   the XCTest counter. Real numbers **only** from
   `xcrun xcresulttool get test-results summary --path <bundle>.xcresult`.
5. **The simulator is not the device.** No data protection, no camera, no
   keychain lock state, host CPU and host memory. An Argon2id result here is
   evidence about the Mac. Branch on `targetEnvironment(simulator)` and skip.
6. **The entitlement is a floor, not a default** (defect 113). A file set to
   `.none` still reads back as `completeUntilFirstUserAuthentication`. And
   `URL.resourceValues` answers `NSURLFileProtection…` while
   `FileProtectionType.rawValue` is `NSFileProtection…` — comparing raw strings
   across the two APIs fails on a _correctly_ protected file.
7. **No `project.pbxproj` edit is needed for a new file.**
   `PBXFileSystemSynchronizedRootGroup` covers `Memry`, `MemryTests`,
   `MemryUITests` and `MemryConformanceTests`.
8. **Two concurrent agents are the safe cap**, and their file ownership must be
   disjoint down to the individual shared file. Three have died without writing
   anything — they serialise on `crates/target` and on `xcodebuild`. A new
   agent's first file typically appears 10–15 minutes in; that is reading, and
   it is correct.
9. **`MemryTests` is ONE Swift module, so two agents must never add test
   files to it at the same time.** A single file that fails to compile takes
   down every suite in the target, including the other agent's, and
   `-only-testing:` **cannot** route around it. This cost an hour: one agent's
   seven compile errors blocked the other's verification entirely, while the
   blocked agent's retry loop kept taking the xcodebuild lock to run a build
   that could never succeed — starving the only party who could fix it. If two
   agents must run concurrently, **only one may add tests**, or split them
   across targets. The orchestrator caused this by dispatching both into
   `MemryTests` at once.
10. **Verify a break-sweep revert after an INTERRUPTED sweep, not just a
    completed one.** An agent's sweep was killed mid-break, leaving that break
    applied; it then re-recorded its md5 baseline from the already-broken file,
    so the baseline encoded the bug. It was caught only because the next run's
    "B0 baseline" failed with exactly that break's signatures. Re-hash against a
    record taken before the sweep started, and treat a baseline that fails as
    evidence the baseline is wrong rather than evidence the code is.
11. **A whole-plan run that writes NO xcresult is ONE TEST BLOCKED FOREVER,
    not a Swift Testing bug.** This cost most of a night. A unit test pressed a
    real Google button, `ASWebAuthenticationSession` opened, and it waited for a
    human — nothing timed out, nothing errored, nothing logged. Three agents each
    correctly said "not my suites"; suite-bisecting, disabling parallelism and
    erasing the simulator could none of them find it. **Find it in one run**:
    `-parallel-testing-enabled NO`, then diff `started` against `finished` in the
    raw log — the stall is the last `started` line. And never let a unit test
    drive a seam that waits on a person.
12. **`test-without-building` silently runs a STALE binary when DerivedData
    paths differ.** An agent built into `-derivedDataPath build`; the
    orchestrator then ran `test-without-building` with no `-derivedDataPath`,
    hit the default DerivedData, and tested code that did not contain the fix —
    producing a completely convincing wrong answer. **Pair
    `build-for-testing test-without-building`, or pass the same
    `-derivedDataPath` the build used.**
13. **A test whose premise is "this is not configured yet" is a test of ambient
    build state**, and it inverts the day the feature starts working. Two
    instances of this landed in one morning from one `Info.plist` edit; the
    first was caught and split into `GoogleConfigurationTests`, the second was
    missed one file over and is what caused gotcha 11. Assert the thing that is
    true either way, or inject the absence.
14. **A stale queued `cargo test` will report a failure that no longer exists.**
    `crates/target` is shared, so with two agents a `cargo test` can sit queued
    15+ minutes and then report against source the other agent has since fixed.
    This happened **three times** in one session, and the agent reading its own
    output has no way to tell. Both agents flagged it rather than claiming a
    number, which was right. **The only reliable move is to re-run the failing
    target directly** — seconds once the lock is free. Never commit or diagnose
    on a whole-suite number you did not watch complete against the current tree.
15. **NEVER revert a break with `git checkout --`. It is wrong in BOTH
    directions.** On an **untracked** file it silently does nothing, so the
    break stays applied and every later result is measured against broken code.
    On a **tracked** file it does something far worse: it resets to HEAD and
    **destroys every uncommitted edit in that file**, including the task's own
    work. An agent lost all four of its edits to `NotesListView.swift` this way
    mid-sweep, which then contaminated the next break with two spurious
    failures that looked like real findings. **A revert must be an inverse
    patch, or a byte-for-byte copy-back from a pre-sweep snapshot, verified by
    hash afterwards.** The old wording of this entry mentioned only the
    untracked half and is why the tracked half was walked into.
16. **`git checkout --` does nothing for an untracked file.** A subagent's
    break-test sweep used it to revert, and its new files were untracked, so the
    deliberate breaks accumulated silently across iterations. The same command
    would have destroyed its tracked edit had git not errored first. Revert a
    break by inverse patch, and re-verify on restored code.
17. **An async core call cannot be cancelled** (defect 108) —
    `rust_future_cancel` appears **zero** times in the bindings. Never offer a
    Cancel button over a suspended core call.

## Device evidence already banked

Physical **iPhone 12 Pro** (`8025C79A-F257-500F-8BA1-A14122135B2D`), iOS 27.0,
arm64. **Re-run against the final build for T162 — do not reuse these numbers.**

| Run                        | Result                                               |
| -------------------------- | ---------------------------------------------------- |
| `Unit`, whole plan, device | **160 passed, 0 failed**                             |
| `Conformance`, device      | **12 passed, 0 failed** — T162's first evidence item |

**T082 is CLOSED** on that hardware. Signing recipe: team `TV343Q4W8A`, bundle
id `com.memry.app.t094`, and **never** pass `PRODUCT_BUNDLE_IDENTIFIER=` on the
command line — it applies to the embedded `MemryCore` framework too and iOS
refuses the install. Back up `project.pbxproj` and `Memry.entitlements` to
`/tmp`, `sed`, run, restore, **and confirm the revert with `git status`.**

## The defect log: **125 logged, 122 closed, 3 open**

All three open entries **block a task**, and each needs a decision rather than
more effort. They are in the STOP HERE FIRST table at the top.

Closed this session: **115** (iOS CI red on every run — `#require` is not a
skip, and CI ran unsigned so the real-keychain tests had never executed once),
**116** (chapter 02 documented the native OAuth route nowhere), **117**
(`MemryGoogleClientID` had no named home), **118** (`DESIGN.md` mandated the
tint for focus emphasis at 2.80:1 against a 3:1 floor — **desktop is affected
and NOT fixed**), **119** (four mobile font families iOS does not bundle),
**120** (colour roles named with no values, `--surface-active` the binding
constraint), **121** (cold-launch session restore), **122** (a module path is
ABI), **123** (no exported edge out of `AwaitingProviderToken` for a cancelled
sheet).

**Three lessons from this batch are worth more than the entries:**

1. **A transition that names several causes on one line is a transition nobody
   checks has several call sites.** §C.1 drew one edge for "cancelled, expired,
   or rejected"; only _rejected_ was implemented, and a user who dismissed the
   Google sheet was stranded permanently (123).
2. **An exported type's Rust module path is part of its ABI** (122). Moving one
   churns the FFI checksum of every method that mentions it. After **any**
   surface change: regenerate, then confirm
   `diff /tmp/old.swift <generated> | grep -c '^<'` is **0**. Additive changes
   delete nothing. **Nothing else catches this** — Phase 3 ended with a stale
   binding.
3. **A colour the user chooses can never be what a contrast requirement rests
   on** (118). `--tint` is any hex, so deriving `--tint-ring` from it repairs
   nothing. The tint fills; ink carries contrast.

And the correction worth keeping: **121's first recorded reason was wrong.** It
said a restore belongs in a method because a constructor "can fail for network
reasons" — but `new` already returns `Result`, and the restore makes no request
at all. The real argument is the **keychain**: the entries are
`AfterFirstUnlockThisDeviceOnly`, so a boot before first unlock reads `Locked`,
not absent, and swallowing that into `SignedOut` _is_ the defect one layer down.
The entry now carries the real reason.

## Blocked on Kaan

1. **ANSWERED (build B3's minimum) — but a new hole is open and unscoped:
   device linking has no export of any kind.** `link`, `pair` and `sas` return
   **zero** hits in the generated bindings, so T153 (QR) and T154 (SAS) are as
   blocked as everything was this morning, and no task covers it. The
   checkpoint needs it: the replacement Independent Test requires unlocking
   every vault **by scanning the desktop's code** on a phone cleared of all
   state, which is exactly T153/T154. T235 now covers the linking
   exports against chapter 03, and it is the largest remaining unknown.
2. **`MemrySyncEnvironment` and `MemryGoogleClientID` are both absent from
   `Info.plist`** (defects 110, 117). A release build is deliberately
   `notConfigured` until both land. Required before any release or TestFlight
   build.
3. **The staging recovery phrase was pasted into a Phase 3 transcript.** Kaan
   was asked to rotate it; still unconfirmed. Confirm it works before assuming.
4. **Capping the honoured `Retry-After` in the core's ladder** (defect 109) is
   a core change and a decision, not a task. The per-IP OTP limiter is 10 per
   3600 s and sets `Retry-After` to the remaining window, so an eleventh call
   can suspend for an hour and cannot be interrupted.
5. **Localization** (defect 98) is out of scope for Phase 4 but needs a
   decision before the literals in `ErrorMapping.swift`, `SignInCopy.swift`,
   `GoogleSignInCopy.swift` and `Features/Unlock/` are rewritten.
6. **No iOS support or feedback channel is documented anywhere** (defect 94),
   so no error copy tells a user to report a problem.
7. A second `memry-cli` device is registered at `/tmp/g5b` and is worth
   revoking. Account was at 21 of 50.
8. **T161/T162 need Kaan and the phone**, about half an hour together — but
   they are unreachable until item 1 is answered.

## Checkpoint status

**Every line of code Phase 4 calls for is written, wired and verified. What
remains is evidence, and it needs Kaan and the phone.**

| Path                                                    | State                                  |
| ------------------------------------------------------- | -------------------------------------- |
| Sign in (email OTP, Google)                             | built and wired                        |
| Unlock by recovery phrase                               | built and wired                        |
| Unlock by device link                                   | built and wired                        |
| Pick a vault, open it through `VaultFiles.openingVault` | built and wired                        |
| Browse notes and folders, preview a note                | built and wired, read-only by decision |
| Sign out and revocation                                 | built and wired                        |
| Session restore across a relaunch                       | built and wired                        |
| The event hub has a consumer                            | built and wired                        |

**Remaining: T161 and T162 — about half an hour with Kaan, the phone and a
desktop.**

### The plan for T161

The approved replacement Independent Test (Scope decisions, Phase 4): on the
**single** phone, unlock every test vault **by recovery phrase**; then **clear
the app's data so the device holds no vault, no keys and no registration**, and
unlock the same vaults again **by scanning the desktop's code**. Repeat on an
account holding two vaults. **The evidence must say explicitly that two phones
registered against one account at once was not covered** — that bar is replaced,
not reinterpreted.

Practicalities, each learned the hard way:

- **Gather the device-link evidence through the PASTE path, not the camera.**
  Spec-defect 130: `CodeCapture` exposes no preview, so aiming is blind and
  failure is silent. The paste field is a complete path that every wiring test
  drives. Treat the camera as a separate, smaller exercise afterwards.
- **`MemrySyncEnvironment` is NOT needed.** A debug build with the key absent
  resolves to staging by design. It is needed only for a release or TestFlight
  build, and the two tempting ways to add it are both wrong — the reasons are
  written into `Info.plist` itself.
- **`MemryGoogleClientID` is present** (Kaan supplied it). Note that adding it
  was a behaviour change that broke two tests whose premise was its absence.
- **The staging recovery phrase works** (Kaan confirmed). It has now been pasted
  into two transcripts. **Rotate it after T161.**
- Signing recipe for the device is unchanged: team `TV343Q4W8A`, bundle id
  `com.memry.app.t094`, and **never** pass `PRODUCT_BUNDLE_IDENTIFIER=` on the
  command line. Back up `project.pbxproj` and `Memry.entitlements`, `sed`, run,
  restore, **and confirm the revert with `git status`.**
- **Re-run the device `Conformance` and `Unit` plans against the final build.**
  The banked numbers (12 passed / 160 passed) are from an older build and are
  T162's first evidence item only once re-taken.

**No vault has been opened on a phone yet.** That is the whole of what is left.
