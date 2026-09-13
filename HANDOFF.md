# Phase 4 handoff — specs/002-native-foundation-ios

Overwritten each session. Everything below was observed by the orchestrator,
not reported by a subagent. Where a number came from a subagent it says so.

## Where the work is

Branch `native-core-phase-3` in `.worktrees/native-core-phase-3`,
fast-forwarded with `origin/main` and pushed straight to main, no PR, per
Kaan's standing instruction.

## STOP HERE FIRST: nothing is blocked on a decision any more

The defect log is **128 logged, 126 closed, 2 open**. Neither open entry blocks
the next wave.

| #       | State                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **114** | Device-linking exports **landed** (T235). Stays open until **T153/T154** give them a production call site — by this phase's own standard, an export with no caller is not done. |
| **128** | The local vault key verifier has **nowhere to live on iOS**, so data-model §C.2's "both verifiers are checked" is false there. **Not checkpoint-blocking.**                     |

Kaan settled the three that were blocking: **124** show only configured folders,
**125** preview rather than render, and **T235** for device linking, which has
landed. **The next wave is T153 (QR) and T154 (SAS)** — the screens that close
114 by becoming `DeviceLink`'s callers.

**128 is the one to keep in view.** `derive_vault_key` and
`local_vault_key_verifier` are both exported, but there is nowhere to persist
the result: chapter 01 §1.4.2 keeps it in desktop's settings table, the core
exports no settings surface, and `SecureStoreKey` is a **closed five-entry
enum**. The account verifier (§1.4.1) still catches a wrong recovery phrase, so
this is not urgent — but a sentence in the data model is currently false in the
shipping client, which is precisely what this log exists to surface. The honest
fixes are a sixth `SecureStoreKey` entry (additive, needs a migration story) or
a settings export (band B3's remainder).

**The pattern worth carrying forward.** Defects 114, 124, 125 and 127 are all
the same shape: **work specified against a capability nobody had checked
existed.** Four times in one phase. A `grep` over the generated Swift costs five
seconds and would have caught every one of them before a wave was dispatched.
Do that before writing a brief, not after an agent hits the wall.

## State: **Phase 4 at 16 of 24 ticked.** Phase 3 closed 64/64.

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

**Open: T153, T154, T156, T157, T158, T159, T161, T162** — eight, and none blocked on a decision.

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
| `node scripts/check-line-ceilings.mjs`                 | passed (132 files)                             |
| `pnpm --filter @memry/contracts vectors:check`         | passed (11 classes)                            |
| `pnpm check:architecture`                              | passed                                         |
| `swiftlint lint --strict` (project-wide, bare)         | **0 violations, 0 serious, 57 files**          |
| xcodebuild `Unit`, **whole plan**, iPhone 17 simulator | **247 total, 245 passed, 0 failed, 2 skipped** |
| generated Swift diff vs HEAD                           | **0 deleted lines**                            |
| **iOS CI on `main`**                                   | **GREEN**, both jobs, verified job-by-job      |

The 247 was **precomputed before the result was read**.
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
9. **A stale queued `cargo test` will report a failure that no longer exists.**
   `crates/target` is shared, so with two agents a `cargo test` can sit queued
   15+ minutes and then report against source the other agent has since fixed.
   This happened **three times** in one session, and the agent reading its own
   output has no way to tell. Both agents flagged it rather than claiming a
   number, which was right. **The only reliable move is to re-run the failing
   target directly** — seconds once the lock is free. Never commit or diagnose
   on a whole-suite number you did not watch complete against the current tree.
10. **`git checkout --` does nothing for an untracked file.** A subagent's
    break-test sweep used it to revert, and its new files were untracked, so the
    deliberate breaks accumulated silently across iterations. The same command
    would have destroyed its tracked edit had git not errored first. Revert a
    break by inverse patch, and re-verify on restored code.
11. **An async core call cannot be cancelled** (defect 108) —
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

**NOT MET, but nothing is blocked on a decision and both unlock paths now have
a core to call.**

- **Recovery phrase**: buildable and wired. T163 exports the key material, T165
  restores the session across a relaunch, T155 picks a vault and opens it
  through `VaultFiles.openingVault`.
- **Device link**: the exports landed in T235 (`DeviceLink.scan` / `pollOnce`).
  **T153 and T154 are the missing screens**, and they are the next wave.

After those: T156/T156a (notes and folders — Kaan decided the tree shows only
configured folders), T157 (a **text preview**, not a render), T158 (which owns
`CoreEvents.consume()`, §7.15.1's runtime half and the `snapshot_is_due` poll),
T159, then **T161/T162 with Kaan and the phone, about half an hour together**.

Before T161, two config keys must land in `Info.plist` or the app cannot reach a
server or authenticate as the right OAuth client: **`MemrySyncEnvironment`**
(defect 110) and **`MemryGoogleClientID`** (defect 117). A release build is
deliberately `notConfigured` until then.

No vault has been opened on a phone yet.
