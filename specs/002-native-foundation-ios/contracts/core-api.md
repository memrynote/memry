# Core API — the surface the shells call

**Feature**: 002-native-foundation-ios. **Status**: living; grows with each
band. **Generated from**: `crates/memry-core/src/api/`, exported through UniFFI
proc-macros and compiled into
`packages/swift/MemryCore/Sources/MemryCore/Generated/`.

This document describes the **shape** of the exported surface and the rules that
shape obeys. It is not a copy of the generated Swift: that file is regenerated
by `crates/memry-core/build-xcframework.sh` and diffed in CI, so a signature
here that drifts from the generated one is a bug in this document.

## The rules the surface obeys

1. **Keys cross as bytes, never as `String`.** A 32-byte key rendered as hex or
   base64 for the FFI hop becomes a secret in Swift's immutable `String`
   storage, which the core cannot zero and which a caller will eventually log.
   `Data` in, `Data` out.

   The two **verifiers** are the deliberate exception. Chapter 01 §1.4.1 defines
   the account key verifier as a base64 string and requires the comparison to
   happen over those strings rather than over the decoded bytes, so handing
   Swift the decoded bytes would make the wrong comparison the easy one to
   write.

2. **Errors cross as variants, never as rendered strings** (Constitution II).
   One enum per surface, so a caller's `switch` is exhaustive over the things
   that surface can actually fail with. A shell that receives
   `CryptoError.OutOfMemory` can tell the user to close some apps; a shell that
   receives `"error: -1"` can only apologise.

3. **The core owns no UI, no networking and no keychain.** Anything that needs
   one crosses a foreign-trait seam the shell fills in (`contracts/shell-seams.md`).

## Error surfaces

**Eight enums, not seven.** `LinkingError` joined with T235 and carries
**fourteen** variants. `ErrorMapping.swift` did not cover it at all when it
landed — a caught one fell through to the unrecognised arm until T153/T154 added
the mapping. That is exactly the failure this table exists to prevent: **a new
error surface is not done until the shell's exhaustive switch covers it**, and
nothing else catches the gap, because the switches carry no `default:` arm by
design and a missing enum simply never reaches them.

| Enum            | Raised by                            | Variants                                                                                                                                                                                                                             |
| --------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CryptoError`   | primitives and derivations           | `InvalidLength`, `InvalidParameter`, `DecryptionFailed`, `EncryptionFailed`, `OutOfMemory`, `InvalidBase64`, `InvalidHex`                                                                                                            |
| `RecoveryError` | the recovery-phrase path             | `UnknownWord`, `BadChecksum`, `WrongWordCount`, `NonAscii`, `VerifierMismatch`, `Crypto`                                                                                                                                             |
| `CborError`     | the canonical encoder                | `FieldNotInOrdering`, `Unencodable`, `Malformed`                                                                                                                                                                                     |
| `CompressError` | the compression frame                | `IncompleteDeflateStream`, `Corrupt`                                                                                                                                                                                                 |
| `CrdtError`     | the document registry and update log | `DocumentBusy`, `Undecodable`, `NotApplicable`, `Storage`                                                                                                                                                                            |
| `ApiError`      | every HTTP call                      | `Transport`, `Storage`, `Unauthorized`, `DeviceRevoked`, `RateLimited`, `WritesDisabled`, `UpgradeRequired`, `BootstrapUnavailable`, `Status`, `MalformedResponse`, `InvalidClientIdentity`                                          |
| `AuthError`     | the session                          | `Api`, `SecureStore`, `Crypto`, `InvalidState`, `MalformedToken`, `RefreshBlocked`, `SessionExpired`, `NoSetupToken`                                                                                                                 |
| `LinkingError`  | device linking (T235)                | `InvalidLength`, `InvalidBase64`, `ScanMacInvalid`, `ConfirmMacInvalid`, `Crypto`, `Cbor`, `InvalidQrPayload`, `InvalidVaultTransfer`, `SessionExpired`, `NotScanned`, `AlreadyScanned`, `PollBudgetExhausted`, `Api`, `SecureStore` |

Three of these carry a distinction that a flattened error would lose, and each
one exists because collapsing it produces a specific wrong behaviour:

- **`CryptoError::OutOfMemory`** separates "Argon2id could not allocate 64 MiB"
  from "the phrase was wrong". libsodium answers both with `-1`, and on a
  memory-pressured phone the first is real. Reporting it as the second tells the
  user to re-type a phrase that was correct (research R3, spike S4).
- **`RecoveryError::UnknownWord` versus `BadChecksum`** separates "this word is
  not in the list" from "every word is real but the phrase is not one Memry
  issued". They call for different instructions.
- **`CompressError::IncompleteDeflateStream`** is an error rather than an empty
  result, because an empty result reaches the applier as a content wipe
  (chapter 04 §4.1).
- **`ApiError::Storage`** is the one arm of this enum that is not a server
  answer. `PushWave::pending` and `drain` return `ApiError`, so without it a
  failed local SQLite read crossed as `Transport { Failed { … } }` — the right
  state, and a lie: a shell could not tell "the server is unreachable" from
  "this device cannot read its own database", and those want different things
  said to the user.

- **`ApiError::BootstrapUnavailable`** is separate from `Status` because a `501`
  from `/sync/bootstrap` means the deployment has no bootstrap key configured
  (chapter 10 §10.12). Folded into a generic 5xx it would be retried forever and
  would send the next reader hunting for a client bug that does not exist.
- **`ApiError::WritesDisabled` versus `UpgradeRequired` versus `Unauthorized`**
  stay three variants because chapter 11 makes them three distinct client
  policies — read-only, blocked-pending-upgrade, and unentitled — that must
  never collapse into one "you cannot write" message.
- **`ApiError::Status` makes the shell re-derive retryability, and that is
  deliberate** (spec-defect 97). Everything without a distinct variant collapses
  into `Status { status, code }`, so a shell rendering it must split 5xx (and 408) from 4xx itself to avoid telling a user to retry something the server
  will refuse every time — which matters because a permanently-rejected record
  wedges the whole outbox, and "try again" then means "retry forever". The
  status code is carried precisely so the shell _can_ make that split; what the
  shell must not do is invent a policy beyond it, such as a retry schedule. The
  core owns retry; the shell owns only the sentence.
- **`AuthError::RefreshBlocked` versus `SessionExpired`** separates "the latch
  is holding, try later" from "this session is gone". Collapsing them either
  signs the user out on a transient refusal or spins forever on a dead session.

## Exported functions — band B1

Swift types shown as UniFFI maps them: `Vec<u8>` is `Data`, `String` is
`String`, a `Result<T, E>` is a `throws` function.

| Function                                        | Swift shape                       | Chapter   |
| ----------------------------------------------- | --------------------------------- | --------- |
| `validate_recovery_phrase(phrase)`              | `(String) throws -> String`       | 01 §1.3   |
| `derive_master_key(phrase, kdf_salt)`           | `(String, Data) throws -> Data`   | 01 §1.1   |
| `derive_vault_key(master_key)`                  | `(Data) throws -> Data`           | 01 §1.7   |
| `account_key_verifier(master_key)`              | `(Data) throws -> String`         | 01 §1.4.1 |
| `account_key_verifier_matches(local, server)`   | `(String, String) -> Bool`        | 01 §1.4.1 |
| `local_vault_key_verifier(vault_key, vault_id)` | `(Data, String) throws -> String` | 01 §1.4.2 |
| `local_device_id_hex(ed25519_public_key)`       | `(Data) throws -> String`         | 01 §1.5   |
| `compress_payload(payload)`                     | `(Data) -> Data`                  | 04 §4.1   |
| `decompress_payload(frame)`                     | `(Data) throws -> Data`           | 04 §4.1   |
| `core_version()`                                | `() -> String`                    | —         |

`account_key_verifier_matches` is exported rather than left to the shell for one
reason: it is the function a caller would otherwise write with `==` over decoded
bytes, which accepts every correct input and fails to reject some incorrect
ones.

## Exported objects — band B2

Two exist. Both are `#[uniffi::export]`ed objects with interior mutability,
because a UniFFI object crosses as a reference and the shell holds it for the
app's lifetime. Neither exposes a key.

| Object        | Methods                                                                                                                                                                                                                                                                                   | Chapter |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `RuntimeHost` | `new`, `on_background`, `on_foreground`, `on_expiring`, `phase`, `resume_settled`                                                                                                                                                                                                         | plan R5 |
| `AuthSession` | `new`, `state`, `mark_revoked`, `begin_provider_sign_in` are **synchronous**; `request_email_code`, `resend_email_code`, `verify_email_code`, `register_device`, `renew_setup_token`, `refresh`, `sign_out`, `key_material`, `vaults`, `complete_provider_sign_in` are **`async throws`** | 02      |

Two data enums cross with them: `AuthState`, the nine states of data-model
§C.1 — `SignedOut`, `AwaitingOtp`, `AwaitingProviderToken`, `SetupPending`,
`SetupExpired`, `Registered`, `Refreshing`, `SessionExpired`, `Revoked` — and
`AuthEvent`, the thirteen edges that drive it. `AppPhase` crosses with
`RuntimeHost`.

`RuntimeHost` also implements the `LifecycleObserver` seam in plain Rust, so
the shell supplies phase transitions rather than a whole observer.

**Which methods are async is contract, not an implementation detail**
(spec-defect 90). Research R15 says the core exposes synchronous blocking
functions, and that is true of every exported free function and of
`RuntimeHost` — but **seven of `AuthSession`'s nine methods suspend**. The
distinction decides how a shell calls them: a blocking call must be moved off
the main thread onto the shell's serial core queue, while an async one is
awaited directly, because pushing a suspending call through that queue parks a
queue thread on a semaphore and stalls every other core call behind a network
round trip. A table that did not say which was which left each caller to
discover it from the generated Swift, and to answer differently.

## Planned objects — band B3

The rest becomes object-oriented as state arrives. `Client`'s auth half is now
`AuthSession`; the remainder is named here so the shape is agreed before the
code exists:

| Object   | Owns                                                       | Phase 4 tasks it blocks      |
| -------- | ---------------------------------------------------------- | ---------------------------- |
| `Client` | account identity, tokens, device registration, the runtime | T148, T152, T153, T154, T159 |
| `Vault`  | the unlocked vault key, vault selection, vault metadata    | T155, T161, T162             |
| `Sync`   | the pass state machine, cursors, outbox, policy            | T158                         |
| `Notes`  | notes, folders, journals, templates, tags, properties      | T156, T156a, T157            |
| `Tasks`  | tasks, projects, task views                                | — (not in this feature)      |

Each will be a `#[uniffi::export]`ed object on the same terms as the two
above. None of them exposes a key.

**The blocking column is spec-defect 114, and it is the reason this table is
no longer only forward-looking.** Phase 4's task list was written against a
core surface that band B3 supplies, so seven of its tasks have no call site
that any amount of Swift can build. The specific missing capabilities, each
confirmed by `grep` over the generated bindings rather than inferred:

- ~~no method accepts a provider token~~ — **closed by T163**:
  `begin_provider_sign_in` and `complete_provider_sign_in` make
  `AuthState::AwaitingProviderToken` and `AuthEvent::ProviderSheetOpened`
  reachable for the first time;
- ~~no way to fetch `{kdf_salt, key_verifier}`~~ — **closed by T163**:
  `AuthSession::key_material`;
- **no device-linking surface at all** — `link`, `pair` and `sas` return zero
  hits, so T153 and T154 have nothing to drive. **This is the one that is
  still open, and no task covers it**: the checkpoint's Independent Test
  requires unlocking every vault by scanning the desktop's code on a phone
  cleared of all state, which is exactly T153 and T154;
- ~~no vault, note or folder API~~ — **read half closed by T164**:
  `Vault.open/id/notes` and `Notes.folders/list/read`. Writes and `Sync`
  (T158, T159) remain.

The shell must not close any of these gaps itself. Each needs an access token,
a `401`, and a refresh, and all three belong to the core — a shell that fetched
them would be a second protocol client the core cannot see, which is the same
rule the transport boundary already enforces.

**Current generated surface**: 10 exported functions, 14 protocols and 2
objects in `packages/swift/MemryCore/Sources/MemryCore/Generated`. The two
protocols added against the B1 count are `AuthSessionProtocol` and
`RuntimeHostProtocol`, which UniFFI emits for the two objects; the eight
foreign seams and their four companions are unchanged, so
`contracts/shell-seams.md` needs no edit.

## Records and enums that cross with band B3's account minimum

Added by T163. All are `uniffi::Record`/`uniffi::Enum` on the **existing**
`protocol::` structs rather than duplicates in `api/`, following the precedent
`protocol::auth::DevicePlatform` already set.

| Type                    | Shape                                        | Chapter   |
| ----------------------- | -------------------------------------------- | --------- |
| `KeyMaterial`           | `{ kdf_salt: String, key_verifier: String }` | 02 §2.1.1 |
| `VaultSummary`          | `{ id: String, name: Option<String> }`       | 05 §5.1   |
| `ProviderSignInOutcome` | the native-OAuth answer                      | 02 §2.13  |
| `AuthProvider`          | `google`                                     | 02 §2.13  |

The **error surfaces table above is unchanged** — none of these needed a new
variant. A provider refusal is `ApiError::Unauthorized` or `Status`, a missing
setup token is the existing `AuthError::NoSetupToken`, and a call made from the
wrong state is `InvalidState`.

`AuthProvider` is an enum rather than the state machine's free `String` because
the value becomes a path segment of `/auth/oauth/:provider/native`, and a
caller-supplied string in a path is a caller-supplied URL. A consequence worth
knowing: the core can therefore never reach §2.13's `400 AUTH_INVALID_PROVIDER`.

**Rule 1's verifier exception extends to `kdf_salt`.** It crosses as the base64
`String` of chapter 01 §1.1, for the same reason the two verifiers do — the
format _is_ the string, and handing Swift decoded bytes would make the wrong
comparison the easy one to write.

## An exported type's Rust module path is part of its ABI

**Normative, and it cost a revert to learn** (spec-defect 122). UniFFI folds a
type's module path into its metadata checksum. Moving an exported type between
Rust modules therefore rewrites the FFI checksum of **every method that
mentions it**, even when no signature changes at all — lifting `AuthState` into
a new module churned all eight `AuthSession` methods that return it and deleted
nine lines from the generated Swift, for what looked like tidying.

So: **moving an exported type is a breaking change, and is never done as part
of a refactor.** The check that catches it is cheap and should be run after any
change to the exported surface — regenerate, then diff the generated Swift
against its previous version and confirm **zero deleted lines**. A purely
additive change deletes nothing. Anything deleted means an existing binding
moved, and that is the moment to stop rather than to commit.

This matters more here than it would elsewhere, because **no gate catches a
stale or churned binding** — Phase 3 ended with one.

## Widening an exported protocol breaks every Swift conformance to it

Adding a method to an exported object widens the generated
`…Protocol`, and **every Swift type conforming to it stops compiling** — test
fakes included. T163's four additions broke `FakeAuthSession` and took the iOS
`Unit` target red until it was updated. This is not a defect; it is what a
protocol is. It is written down because the breakage surfaces as a Swift
compile error in a file the Rust author is not looking at, and in a worktree
where someone else may be mid-task.

When updating such a fake, the new method's default must **not** be a benign
success. A fake that behaves correctly is how this project shipped five bugs
behind a green suite in Phase 3; `FakeAuthSession`'s four new methods record the
call and then throw.

## The read slice of `Vault` and `Notes`

Landed by T164 over `memry_core::domain::reads`. **That module path is now ABI**
and must not move — see the module-path rule above.

| Method                                     | Errors         |
| ------------------------------------------ | -------------- |
| `Vault.open(vault_id:directory:) -> Vault` | `StorageError` |
| `vault.id() -> String`                     | —              |
| `vault.notes() -> Notes`                   | —              |
| `notes.folders() -> [FolderSummary]`       | `StorageError` |
| `notes.list() -> [NoteSummary]`            | `StorageError` |
| `notes.read(id:) -> NoteDetail?`           | `CrdtError`    |

Records: `FolderSummary`, `NoteSummary`, `NoteBody`, `NoteDetail`. **No new
error variant was needed.**

**Every method blocks. None is `async`.** They are local SQLite reads plus a
`yrs` apply; nothing touches the network. This is the first exported object
whose entire surface is synchronous **by design** rather than by accident, and
it is worth saying because the consequence is pleasant: defect 108 — an async
core call cannot be cancelled from Swift — cannot bite here at all, since a
blocking call never needed cancelling. `Vault.open` is the one that is not free,
because it runs migrations; its cost is a disk write, not a round trip, so it
stays synchronous and goes on the shell's serial core queue like the rest.

**Two objects rather than one**, because the split survives the write half:
everything that writes lands on `Notes`, and folded into `Vault` that becomes a
single object owning the database handle, the vault key and every content
mutation in the product — past the 600-line ceiling before the first journal
method. `AuthSession`'s reason for refusing a sibling does **not** transfer: a
second `TokenManager` is a chapter 02 §2.9 device revocation, whereas `Db` is
one connection behind one mutex and `Vault::notes()` hands out a clone.

**The read surface holds no vault key at all**, which is why it satisfies "none
of the B3 objects exposes a key" trivially: reading local projections and the
local update log needs no key, because decryption happened at pull time. The
write half will have to satisfy the same rule the hard way, and that is the
reason to keep `Vault` as the key's owner rather than letting it drift onto
`Notes`.

**Two things this surface deliberately does not do**, each an open spec defect
rather than an omission:

- **`folders()` is the `folder_config` projection and nothing else** — a folder
  holding notes but carrying no config record has no row (spec-defect 124,
  blocks T156).
- **`NoteBody.text` is `extract_text` output**, chapter 12 §12.1's only text
  operation — a preview, not a render. `Document::encode_state()` is **not**
  exported, so a shell cannot feed the editor bundle (spec-defect 125, blocks
  T157).
