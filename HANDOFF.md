# Phase 4 handoff — specs/002-native-foundation-ios

Overwritten each session. Everything below was observed by the orchestrator,
not reported by a subagent. Where a number came from a subagent it says so.

## Where the work is

Branch `native-core-phase-3` in `.worktrees/native-core-phase-3`,
fast-forwarded with `origin/main` and pushed straight to main, no PR, per
Kaan's standing instruction.

## STOP HERE FIRST: Phase 4's checkpoint is not reachable, and no task fixes it

**Spec-defect 114, the log's first open entry.** Two subagents hit the same
wall from opposite directions in one wave, and the orchestrator then re-derived
it directly from `packages/swift/MemryCore/Sources/MemryCore/Generated/memry_core.swift`.

**The core's entire exported Swift surface is:**

- **10 free functions**, all pure crypto or compression: `validate_recovery_phrase`,
  `derive_master_key`, `derive_vault_key`, `account_key_verifier`,
  `account_key_verifier_matches`, `local_vault_key_verifier`,
  `local_device_id_hex`, `compress_payload`, `decompress_payload`, `core_version`.
- **2 objects**: `AuthSession` (nine auth methods) and `RuntimeHost` (five
  lifecycle methods).
- 14 seam protocols and their `…Impl` shims.

`grep` over the generated bindings returns **0** for `oauth`, `google`, `link`,
`pair`, `sas`, `note`, `folder` and any vault API. The two `Vault` hits are
`deriveVaultKey` and `localVaultKeyVerifier` — functions over bytes, not a
vault.

**So seven of the eleven remaining tasks have no call site that can be built:**

| Task                        | Against the real core surface                                  |
| --------------------------- | -------------------------------------------------------------- |
| T148 Google                 | export **landed** (T163); shell wiring is T165, in flight      |
| T152 recovery phrase        | export **landed** (T163); shell wiring is T165, in flight      |
| T153 QR / T154 SAS          | **blocked** — zero device-linking exports                      |
| T155, T156, T156a, T157     | **blocked** — `Vault`/`Notes` read exports are T164, in flight |
| T158, T159                  | **blocked** — `Sync` and `Client` are band B3                  |
| T160 design tokens          | **DONE** — landed, with both screens migrated onto it          |
| T161 / T162 device evidence | **unreachable** — nothing can open a vault                     |

`contracts/core-api.md` already said `Client`, `Vault`, `Sync` and `Notes` were
band B3, "named here so the shape is agreed before the code exists". Phase 4's
task list was written as though they existed. That table now carries a column
naming which Phase 4 task each one blocks, so nobody re-derives this from the
bindings a fourth time.

**This is THE LESSON at phase scale.** Defects 103, 105 and 107 were each one
seam with no call site. 114 is the same thing generalised to the whole feature:
the shell tier can be implemented perfectly and stay unwireable, because there
is nothing on the other side.

**KAAN ANSWERED: build band B3's minimum first.** Not the whole band — only
what US3's checkpoint needs. That was the cheap answer, and the reason it was
cheap is the thing to carry forward: **the behaviour already existed.**
`protocol/account.rs` had `GET /auth/key-verifier` and `GET /sync/vaults`
implemented and tested; `domain/notes.rs`, `domain/folders.rs`, the storage
repositories and `sync/engine.rs` are what the `memry` CLI already drives. Only
the UniFFI layer was missing. **T163 has since landed the account half**, so
the first two bullets of the list above are closed. If the export layer ever
turns out to need behaviour that is not already there, **reopen 114** — the
whole basis of the narrow choice is that it does not.

## State: **Phase 4 at 8 of 21 ticked.** Phase 3 closed 64/64.

**21, not 24** — T149, T150 and T151 are **CUT** by Kaan's decision. Read the
Scope decisions block at the top of Phase 4 in `tasks.md` first.

| Wave | Tasks                                                              | Status                   |
| ---- | ------------------------------------------------------------------ | ------------------------ |
| W1   | T140 `CoreExecutor`, T141 `CoreEvents`                             | **DONE**                 |
| W2   | T142 `ErrorMapping` + `Log`, T143 `Keychain`                       | **DONE**                 |
| W3   | T144 `FileProtection`, T145 `Transport`                            | **DONE**                 |
| W4   | T146 `Reachability` + `Camera`, T147 `SignInView` + **the wiring** | **DONE**                 |
| W5   | T148 Google, T152 `RecoveryPhraseView`                             | **LANDED, NOT TICKED**   |
| W6   | T160 tokens, T163 B3 account exports                               | **DONE**                 |
| W7   | T164 `Vault`/`Notes` read, T165 restore + wiring                   | **IN FLIGHT**            |
| W8+  | T153, T154 (device linking — **still no export**), T155–T159       | **BLOCKED** (defect 114) |

## W5 landed and is deliberately NOT ticked

Both are committed, both are fully tested, and **neither is done**, because
"done" in this phase means a production call site exists.

**T152** — `Features/Unlock/`, the 24-word screen and its view model.
FR-027's order is what the tests hold: `validate_recovery_phrase` → fetch key
material → `derive_master_key` (Argon2id, 64 MiB, through `CoreExecutor` — its
canonical caller) → `account_key_verifier` → `account_key_verifier_matches` →
**and only then** `secure_store.set(.masterKey)`. A wrong phrase stores
nothing. No phrase word ever reaches error copy (defect 96): `UnknownWord`
outlines the offending word in a numbered review of what the user typed, with
an SF Symbol rather than colour alone. `AuthRootView` routes
`AuthState.registered` to it with the real executor and the real `Keychain` —
**but the route is dark**, because `keyMaterial` is `nil` in production for
want of an export. The whole path that _can_ be built is proven against
`bip39-unlock.json`'s `expectedMasterKeyHex` and `expectedAccountKeyVerifierB64`.

**T148** — `ASWebAuthenticationSession`, `prefersEphemeralWebBrowserSession =
true`, auth code plus PKCE, `openid email` only, 32-byte `state` and 32-byte
verifier as two separate CSPRNG draws, S256 challenge computed from the
verifier that same flow later spends, callback refused unless `state` matches,
and `canceledLogin` plus `error=access_denied` both returned as an **outcome
case** rather than thrown, so a caller cannot forget to handle cancellation. No
GoogleSignIn-iOS SDK in the target (R14) — `grep` over `project.pbxproj` and
`Package.swift` is clean, and `xcodebuild -list` resolves only `MemryCore`.

**No Google button was wired, on purpose.** A button that opens a real consent
screen and then cannot sign anyone in is worse for a production user than no
button. `SignInView`, `SignInViewModel`, `SignInCopy` and `AuthComposition` are
untouched.

`check:architecture` caught that agent's first attempt — `URLSession` in
`GoogleSignIn.swift`, a second network path the core cannot see, retry or
kill-switch. **The gate was not weakened.** The default exchange was deleted,
so `GoogleSignIn.init` now _requires_ its transport and the file constructs no
`URLSession`. Where that transport belongs travels with the missing core method.

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
| `cargo test`                                           | **526 passed, 0 failed, 1 ignored**            |
| `node scripts/check-line-ceilings.mjs`                 | passed (116 files)                             |
| `pnpm --filter @memry/contracts vectors:check`         | passed (11 classes)                            |
| `pnpm check:architecture`                              | passed                                         |
| `swiftlint lint --strict` (project-wide, bare)         | **0 violations, 0 serious, 42 files**          |
| xcodebuild `Unit`, **whole plan**, iPhone 17 simulator | **215 total, 213 passed, 0 failed, 2 skipped** |

The 215 was **precomputed before the result was read**.
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
9. **`git checkout --` does nothing for an untracked file.** A subagent's
   break-test sweep used it to revert, and its new files were untracked, so the
   deliberate breaks accumulated silently across iterations. The same command
   would have destroyed its tracked edit had git not errored first. Revert a
   break by inverse patch, and re-verify on restored code.
10. **An async core call cannot be cancelled** (defect 108) —
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

## The defect log: 122 logged, 120 closed, **2 open**

**Two open, and both block the checkpoint:**

- **114** — the core exported nothing the rest of Phase 4 needed. **In
  progress**: T163 closed the account half, T164 is closing the vault/notes
  half. **Device linking is still not exported at all** — `link`, `pair` and
  `sas` return zero hits — so T153 and T154 remain fully blocked and nobody has
  scoped that export yet. That is the next hole.
- **121** — **a session cannot be restored on cold launch.**
  `api/auth.rs:274` sets `SignedOut` unconditionally while the keychain holds a
  valid refresh token, and §C.1 has no edge from "process started, tokens on
  disk" to `Registered`. A registered user who quits and reopens is shown the
  sign-in screen. T165 is fixing it. **This one would have survived every test
  in the suite**: evidence gathered in a single continuous session cannot see
  it, which is precisely what T161's "on a phone holding no prior state" is
  for. Verified by reading the line, not taken on report.

Closed this session: **115** (CI red on every run — `#require` is not a skip,
and CI ran unsigned so the real-keychain tests had never executed), **116**
(chapter 02 documented the native OAuth route nowhere), **117** (nothing said
where the iOS OAuth client id lives), **118** (`DESIGN.md` mandated the tint for
focus emphasis, which is 2.80:1 on white against a 3:1 floor — **desktop is
affected and NOT fixed**), **119** (four mobile font families iOS does not
bundle), **120** (colour roles named with no values, `--surface-active` being
the binding constraint), **122** (**an exported type's Rust module path is part
of its ABI** — moving one churns the FFI checksum of every method that mentions
it).

**The check that 122 leaves behind is worth more than the entry.** After any
change to the exported surface: regenerate, then
`git show HEAD:<generated.swift> > /tmp/old.swift && diff /tmp/old.swift <generated.swift> | grep -c '^<'`
must be **0**. An additive change deletes nothing. Anything deleted means an
existing binding moved, and that is the moment to stop rather than commit.
Nothing else catches it — Phase 3 ended with a stale binding.

## Blocked on Kaan

1. **ANSWERED (build B3's minimum) — but a new hole is open and unscoped:
   device linking has no export of any kind.** `link`, `pair` and `sas` return
   **zero** hits in the generated bindings, so T153 (QR) and T154 (SAS) are as
   blocked as everything was this morning, and no task covers it. The
   checkpoint needs it: the replacement Independent Test requires unlocking
   every vault **by scanning the desktop's code** on a phone cleared of all
   state, which is exactly T153/T154. Someone must scope a T166 for the linking
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

**NOT MET, and not reachable by any remaining Phase 4 task as written.** The
checkpoint needs T162: the device `Conformance` `.xcresult` re-run against the
final build, plus T161 naming each test vault unlocked by **each** of the two
paths — recovery phrase and device link — on a phone holding no prior state,
repeated on an account holding two vaults. No vault has been opened on a phone,
and with the current exports none can be. See spec-defect 114.
