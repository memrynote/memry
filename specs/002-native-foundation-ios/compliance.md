# Export compliance, and the App Store Connect answers

**Feature**: 002-native-foundation-ios | **Task**: T049 | **Date**: 2026-09-13
**Consumed by**: T217 (`ITSAppUsesNonExemptEncryption` in
`apps/ios/Memry/Resources/Info.plist`) and the App Store Connect submission form.

This file settles the export-compliance wording now rather than during submission
week, so the answers are reviewed with the protocol in front of us instead of
under a release deadline.

## 1. The premise of T049 is wrong, and that is the first finding

T049 says to "read the existing desktop App Store filing". **There is no desktop
App Store filing.** The desktop app is not distributed through the Mac App Store:

- `apps/desktop/config/electron-builder.yml` has **no `mas` target**. The macOS
  build is a notarized Developer-ID app (`mac.notarize: true`, `:62`), and the
  other targets are `nsis` and `zip` for Windows (`:41-43`) and `AppImage` and
  `deb` for Linux (`:68-70`).
- There is no `mas` or `appStore` key in any of the four electron-builder
  configs under `apps/desktop/config/`.
- macOS entitlements (`apps/desktop/config/entitlements.mac.plist`) are hardened
  runtime entitlements — JIT, unsigned executable memory, library validation,
  camera, microphone, file access, network — not App Sandbox entitlements. A Mac
  App Store build requires `com.apple.security.app-sandbox`, which is absent.

**Consequence.** Direct Developer-ID distribution has **no App Store Connect
export-compliance questionnaire at all**. The questionnaire is part of App Store
Connect submission, which this product has never done. So there is no prior
wording to copy, and iOS will be the **first** filing.

**This file is therefore the source, not a transcription of one.** Anyone
tempted to "check it against the desktop filing" should stop here: there is
nothing to check against.

## 2. What ships, cryptographically

| Where                                 | Primitive                                | Implementation                                       |
| ------------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| key derivation from a recovery phrase | PBKDF2-HMAC-SHA512, 2048 iterations      | BIP39 (`docs/protocol/01-identity-and-keys.md` §1.1) |
| master key derivation                 | Argon2id, opslimit 3, memlimit 64 MiB    | libsodium `crypto_pwhash`                            |
| subkey derivation                     | BLAKE2b via `crypto_kdf_derive_from_key` | libsodium                                            |
| record and body encryption            | XChaCha20-Poly1305-IETF                  | libsodium                                            |
| signatures                            | Ed25519                                  | libsodium                                            |
| device linking                        | X25519, HMAC-SHA-256, HMAC-SHA512-256    | libsodium + WebCrypto                                |
| transport                             | TLS                                      | the platform                                         |

**All of it is standard, published, and implemented by libsodium**; none of it is
proprietary, and none of it is modified. The Rust core statically links
libsodium; see §5.

## 3. The answers

### 3.1 `Info.plist`

```xml
<key>ITSAppUsesNonExemptEncryption</key>
<true/>
```

**`YES`, not `NO`.** The app uses encryption that is **not** limited to the
exemptions Apple lists (authentication only, copy protection, or encryption
provided solely by the operating system). Memry encrypts user content
end-to-end with its own keys, which is exactly the case the exemption does not
cover.

Declaring `YES` in `Info.plist` is what removes the per-build prompt in App Store
Connect and TestFlight. **Setting it to `NO` here would be a false declaration**,
not a shortcut.

### 3.2 App Store Connect questionnaire

| Question                                                                                                             | Answer     | Why                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Does your app use encryption?                                                                                        | **Yes**    | §2                                                                                                                                |
| Does your app qualify for any of the exemptions in Category 5, Part 2 of the U.S. Export Administration Regulations? | **Yes**    | The app uses only standard published algorithms and is mass-market software; it qualifies under the 5D992.c mass-market provision |
| Does your app implement any proprietary or non-standard encryption algorithms?                                       | **No**     | §2; every primitive is libsodium's implementation of a published algorithm                                                        |
| Is your app designed to use cryptography or does it contain or incorporate cryptography?                             | **Yes**    |                                                                                                                                   |
| Does your app qualify for the exemption provided in Category 5 Part 2 note 4?                                        | **No**     | Note 4 covers encryption ancillary to the primary function. Encrypting the user's notes is the primary function                   |
| Have you submitted a year-end self-classification report?                                                            | **See §4** |                                                                                                                                   |
| Does your app implement encryption in a way that requires a CCATS?                                                   | **No**     | §4                                                                                                                                |
| Is your app available in France?                                                                                     | **See §6** |                                                                                                                                   |

**Classification: ECCN 5D992.c**, mass-market encryption software.

## 4. CCATS and self-classification

**No CCATS is required.** A Commodity Classification Automated Tracking System
request is needed for items that exceed the mass-market thresholds or use
non-standard cryptography. Memry uses only industry-standard published algorithms
in an off-the-shelf library, which is the mass-market case.

**An annual self-classification report is required.** Software classified
5D992.c is exported under License Exception ENC, and ENC obliges an **annual
self-classification report to BIS and the ENC Encryption Request Coordinator, due
by 1 February each year, covering the preceding calendar year.**

**Obligation, and the thing that is easiest to forget:** the first report is due
by **1 February of the year following the first calendar year in which the iOS
app is publicly available**. TestFlight distribution to external testers counts
as export. A calendar reminder for this belongs with whoever owns the Apple
Developer account, not in this repository.

## 5. What the Rust core's statically linked libsodium changes

**Nothing, for classification.** The relevant facts:

- Linking libsodium **statically rather than dynamically does not change the
  ECCN**. What matters is which algorithms the shipped binary can perform, and
  that set is identical: the desktop app already ships the same algorithms
  through `libsodium-wrappers-sumo`
  (`apps/desktop/package.json:110`, `packages/contracts/package.json:84`), which
  is the same libsodium compiled to WebAssembly.
- The answer to "does your app contain or incorporate cryptography" was already
  **yes** on every platform. A statically linked copy does not make it more
  **yes**.
- There is **no additional filing, no separate registration, and no change to the
  self-classification** because of static linking.

**What it does change is §7, the privacy manifest**, because a statically linked
core's symbol imports land in the app's own symbol table.

## 6. France

France requires a declaration for the import and supply of cryptographic means.
Apple's questionnaire asks whether the app is available in France specifically
because of this.

**Decision: answer honestly for whatever availability is chosen at submission
time.** If France is in the availability list, the French declaration (ANSSI,
_déclaration de fourniture d'un moyen de cryptologie_) is required, and it is a
declaration rather than an authorisation for mass-market software using standard
algorithms.

**This is not a reason to exclude France**; it is a form. Recorded here so it is
not discovered during submission week.

## 7. Adjacent compliance items, cross-referenced not restated

These are **not** export compliance and are tracked elsewhere; listed so this
file is the one place someone preparing a submission has to start.

| Item                                                                                                                                                                                                                  | Where                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `PrivacyInfo.xcprivacy` required-reason APIs (FileTimestamp C617.1, UserDefaults CA92.1, DiskSpace E174.1, SystemBootTime 35F9.1), and the statically linked core's `stat`/`mach_absolute_time` counting as the app's | `research.md` §R18        |
| The `nm -u` CI check over the built binary for required-reason symbols from `rusqlite`'s bundled SQLite (`_fstat`, `_statfs`, `_fstatvfs`, `_lstat`)                                                                  | `research.md` §R18        |
| Nutrition labels: telemetry as Data Not Linked to You, tracking No; synced note payloads as Other User Content, App Functionality, Linked, beside a statement that the service cannot read them                       | `research.md` §R18        |
| Guideline 3.1.3(b), in-app purchase of a web-purchased plan                                                                                                                                                           | out of scope; feature 003 |
| Guideline 5.1.1(v), in-app account deletion                                                                                                                                                                           | `spec.md`                 |

## 8. Checklist for submission week

- [ ] `ITSAppUsesNonExemptEncryption` is `<true/>` in
      `apps/ios/Memry/Resources/Info.plist` (T217).
- [ ] The App Store Connect questionnaire is answered as §3.2.
- [ ] Availability list checked against §6; the French declaration filed if
      France is included.
- [ ] A calendar reminder exists for the 1 February self-classification report
      (§4), owned by the Apple Developer account holder.
- [ ] §5 re-read if the core ever links a cryptographic library other than
      libsodium, or implements a primitive itself. Either would reopen the
      classification.

**None of the above is legal advice.** It is the reasoned position this project
files under, with the facts it rests on written down so a reviewer can check
them.
