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

| Enum            | Raised by                  | Variants                                                                                                                  |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `CryptoError`   | primitives and derivations | `InvalidLength`, `InvalidParameter`, `DecryptionFailed`, `EncryptionFailed`, `OutOfMemory`, `InvalidBase64`, `InvalidHex` |
| `RecoveryError` | the recovery-phrase path   | `UnknownWord`, `BadChecksum`, `WrongWordCount`, `NonAscii`, `VerifierMismatch`, `Crypto`                                  |
| `CborError`     | the canonical encoder      | `FieldNotInOrdering`, `Unencodable`, `Malformed`                                                                          |
| `CompressError` | the compression frame      | `IncompleteDeflateStream`, `Corrupt`                                                                                      |

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

## Planned objects — bands B2 and B3

The surface becomes object-oriented once there is state to hold. Five objects,
named here so the shape is agreed before the code exists:

| Object   | Owns                                                       |
| -------- | ---------------------------------------------------------- |
| `Client` | account identity, tokens, device registration, the runtime |
| `Vault`  | the unlocked vault key, vault selection, vault metadata    |
| `Sync`   | the pass state machine, cursors, outbox, policy            |
| `Notes`  | notes, folders, journals, templates, tags, properties      |
| `Tasks`  | tasks, projects, task views                                |

Each is a `#[uniffi::export]`ed object with interior mutability, because a
UniFFI object crosses as a reference and the shell holds it for the app's
lifetime. None of them exposes a key.
