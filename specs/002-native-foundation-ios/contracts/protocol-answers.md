# Contract: answers to the outline's open questions

**Feature**: 002-native-foundation-ios | **Date**: 2026-09-13 |
**Source**: [protocol-spec-outline.md](./protocol-spec-outline.md) |
**Checklist**: [../checklists/protocol-spec.md](../checklists/protocol-spec.md)

This file closes the open questions the outline raises. It is **not** the
specification: `docs/protocol/00..14` is. It is the research record the chapter
author copies from, so that writing a chapter is transcription plus citation
checking rather than a fresh reading of `apps/desktop`, `apps/sync-server` and
`packages/sync-client`.

## How to use this file

- Writing a chapter (T020 to T034): find the question's section here, transcribe
  the **Normative** block into the chapter, keep the citations.
- Implementing the Rust core: the **Core obligation** block is what binds you.
  Nothing outside a **Normative** or **Core obligation** block is binding.
- A **Decision** block records a choice made on 2026-09-13 that changes behaviour
  or freezes an accident. Each names its issue. Do not re-litigate one without
  reopening its issue.
- A **Defect** block is a bug in this repository found while answering. It is
  tracked as a GitHub issue and is **not** the Rust core's problem to work around.

The nine issues opened on 2026-09-13 all carry the `protocol-spec` label:
**#2179** `_offline` on the wire, **#2180** the push/pull merge race, **#2181**
`compactYDoc` dropping roots, **#2182** the `cancelled` linking status, **#2183**
desktop stripping unknown payload keys, **#2184** relaxing `LINKING_IP_MISMATCH`,
**#2185** the canonical value comparison, **#2186** the journal CRDT constants,
**#2187** returning `revision` from a snapshot push.

All line numbers were read against the working tree at `a54b69f1f` on 2026-09-13.
Line numbers drift; the surrounding identifier is the durable part. Where this
file and the outline disagree, **this file is correct** — see
[Errata against the outline](#errata-against-the-outline).

---

## Q01.2 — recovery phrase normalisation

**Normative.** Before `validateMnemonic` and before `mnemonicToSeed`, a client
MUST, in order: NFKD-normalise; trim leading and trailing whitespace; collapse
every run of whitespace to one U+0020; lowercase; reject unless the result is a
valid 24-word English BIP39 mnemonic with a correct checksum. `mnemonicToSeed`
MUST run with an empty passphrase, i.e. PBKDF2-HMAC-SHA512, c=2048, dkLen=64,
salt the literal ASCII `mnemonic`. Seed derivation MUST NOT run on a phrase that
failed validation.

The BIP39 library layer already applies NFKD on both platforms and nothing else:
`bip39@3.1.0` `normalize(str) = str.normalize('NFKD')`, and `@scure/bip39@2.3.0`
matches. Memry's application layer supplies the other four steps:
`apps/desktop/src/renderer/src/components/sync/recovery-phrase-input.tsx:59`
(`phrase.trim().toLowerCase().replace(/\s+/g, ' ')`) and
`apps/mobile/src/lib/vault-unlock.ts:41`
(`recoveryPhrase.trim().toLowerCase().split(/\s+/).join(' ')`).
Validation gates derivation on both: desktop
`apps/desktop/src/main/ipc/auth-device-handlers.ts:421` precedes `:445`; mobile
`vault-unlock.ts:42` precedes `:51`.

**Mandating this changes no existing phrase.** Every master key in existence was
derived from a canonical phrase: at creation the seed comes from
`generateMnemonic(256)` output (`apps/desktop/src/main/crypto/recovery.ts:11-12`),
canonical by construction; at recovery both clients canonicalise first. The
English wordlist is lowercase ASCII, so all four extra steps are the identity on
a canonical phrase. The outline's stated worry cannot occur in shipped code,
because the case-sensitive, single-space `validateMnemonic` rejects a
non-canonical phrase before any seed exists.

**Core obligation.** Implement the five steps in the Rust core, not the Swift
shell, so the desktop renderer and the phone agree byte for byte. Two traps:

- JS `\s` is Unicode `White_Space` **plus U+FEFF**; Rust `char::is_whitespace` is
  `White_Space` without it. Strip U+FEFF explicitly or define the class as
  "`White_Space` or U+FEFF".
- Lowercase ASCII only, then reject any non-ASCII byte. A Unicode lowercase pass
  invites locale surprises and cannot help: no non-ASCII phrase survives
  validation anyway.

Right-words-wrong-order (FR-027) needs no extra handling: the BIP39 checksum
catches a reordering with probability 255/256, and the remaining 1/256 reaches
Argon2id and fails the account key verifier
(`auth-device-handlers.ts:450`, `vault-unlock.ts:55`). Nothing is persisted before
the verifier passes on either platform.

**Recommended repo change** (not required for correctness, not filed): move
the canonicalisation into `apps/desktop/src/main/crypto/recovery.ts:18-25` so it
lives at the crypto boundary rather than in a React component, and export one
`canonicalizeRecoveryPhrase` from `packages/contracts` that the renderer, mobile
and the core's vectors all share. Behaviourally a no-op.

---

## Q01.3 — does a phone store the master key or the vault key

**Normative.** A conforming client stores the 32-byte **master key**, one per
account, in device secure storage, and MUST NOT persist the vault key. The vault
key is derived on demand and held in memory only.

Desktop does this: `KEYCHAIN_ENTRIES.MASTER_KEY`
(`packages/contracts/src/crypto.ts:71`), written at
`apps/desktop/src/main/sync/device-registration.ts:147` and
`apps/desktop/src/main/crypto/vault-key-state.ts:101`; the vault key is derived
per use and zeroed (`apps/desktop/src/main/crypto/keys.ts:123-137`,
`vault-key-state.ts:109-124`, `vault-directory.ts:42-49`). The native iOS spec
already agrees (`../data-model.md:591`, `:616`).

The master key, not the vault key, is what the phone needs: approving another
device's link (`apps/desktop/src/main/sync/linking-service.ts:677-684`),
recomputing the account key verifier to detect a mismatch
(`apps/desktop/src/main/sync/key-verification.ts:112-121`,
`vault-key-state.ts:39-58`), and binding the local vault key verifier
(`vault-key-state.ts:32-40`). A vault-key-only client can do none of these and
cannot re-derive anything if a new subkey id is ever introduced (Q01.1).

Deriving the vault key costs one BLAKE2b KDF call, not Argon2id, so there is no
performance argument for caching it on disk.

**Defect (documentation, not code).** The frozen Expo app stores the vault key
per vault (`apps/mobile/src/lib/secure-store.ts:28`, `:57-59`) and discards the
master key (`apps/mobile/src/lib/vault-unlock.ts:58-63`), matching
`specs/001-mobile-app/data-model.md:76`. It is unreleased and superseded; chapter
01 MUST record it as non-conforming rather than as a second reference.

---

## Q01.4 — one vault key per account

**Normative.** `vaultKey := crypto_kdf_derive_from_key(32, 1, "memryvlt",
masterKey)`. No vault id, and no other per-vault input, enters the derivation. A
conforming client MUST NOT mix `vaultId` into the vault key. `vaultId` MAY be
mixed into a **local** verifier only. Separation between vaults is server routing
plus item ids, nothing else.

Every derivation site passes the same fixed context:
`apps/desktop/src/main/crypto/keys.ts:20`, `:40`, `:130`;
`vault-key-state.ts:39`, `:109`; `vault-directory.ts:46`; mobile
`vault-unlock.ts:58`. One `MASTER_KEY` entry exists per account
(`packages/contracts/src/crypto.ts:71`). The only place a `vaultId` touches key
material is the local vault key verifier, a keyed hash _of_ the vault key with
the vault id in the message (`vault-key-state.ts:16-20`), which never leaves the
device. Routing is by `vaultId` header and parameter
(`apps/sync-server/src/routes/sync.ts:262-266`, `:357`, `:129-133`); the vault
transfer block carries `vaultUuid`s and no key material
(`apps/desktop/src/main/sync/vault-transfer.ts:11-20`); item keys are wrapped
with the vault key and no vault id AAD
(`packages/sync-client/src/push/record-encrypt.ts:52`).

**Core obligation, security-critical.** Because all vaults share one key, a
ciphertext from vault A decrypts cleanly under vault B. **The core MUST NOT rely
on decryption failure to detect a mis-routed record.** Vault association is a
routing fact carried outside the ciphertext and MUST be checked explicitly.

FR-021 therefore holds with no extra key exchange: a phone holding the master key
can open any vault on the account; choosing one is `GET /sync/vaults`
(`apps/sync-server/src/routes/sync.ts:79`) plus routing. `../data-model.md:598-600`
resolves to "no per-vault keychain entry".

---

## Q03.1 — `linkingSecret` shape

**Normative.** The server generates 32 CSPRNG bytes and base64-encodes them with
the standard alphabet and padding, so the wire form is a 44-character string
carrying 256 bits of entropy
(`apps/sync-server/src/services/linking.ts:7`, `:134-136`). It is minted only by
`POST /auth/linking/initiate` (`apps/sync-server/src/routes/linking.ts:92-114`)
and embedded verbatim in the QR JSON
(`apps/desktop/src/main/sync/linking-service.ts:196-201`).

The server stores `linking_secret_hash = hex(SHA-256(utf8(base64 string)))`
(`services/linking.ts:49-53`, `:137`, `:152`) and verifies by re-hashing and
constant-time comparing (`:171-179`, `apps/sync-server/src/services/otp.ts:42-48`).

As an **HMAC key** both sides use the **decoded 32 raw bytes**, not the string
(`services/linking.ts:66-73`, `linking-service.ts:127-134`).

**Core obligation.** Treat the value as opaque, echo it back byte-exact in
`POST /auth/linking/scan`, decode it with standard-alphabet base64 to get the
scan-channel HMAC key, and reject a decoded length other than 32. The server
schema is only `z.string().min(1)` (`routes/linking.ts:54`), so the length check
is the client's.

---

## Q03.2 — `LINKING_IP_MISMATCH`

**Normative (current behaviour).** The scanner's IP is recorded on
`POST /auth/linking/scan` from `cf-connecting-ip`
(`apps/sync-server/src/routes/linking.ts:126`, `:136`;
`services/linking.ts:206-213`) and enforced **only** on
`POST /auth/linking/complete`
(`routes/linking.ts:284`; `services/linking.ts:339-345`: reject 403 when
`scanner_ip && callerIp && scanner_ip !== callerIp`). `initiate`, `session/:id`
and `approve` are not IP-bound; they are access-token authenticated. The check is
skipped when either side is null, so it is off in local dev where
`cf-connecting-ip` is absent. It runs before the status transition (`:339`
precedes `:348`), so a rejected `complete` does not consume the approved session.

**Why this matters for FR-020.** A phone that scans on Wi-Fi and polls `complete`
on cellular gets 403 on every poll. The desktop poll loop treats any non-409,
non-429 error as terminal, clears the pending completion and zeroes
`encKey`/`macKey` (`linking-service.ts:468-481`), and the renderer stops polling
(`apps/desktop/src/renderer/src/components/sync/linking-pending.tsx:62-77`).
Recovery is a full restart from a new QR. Phones change interface far more often
than desktops, and CGNAT or IPv6 privacy rotation changes the IP with no
interface change at all.

**Decision, 2026-09-13 — relax the binding.** Enforcement is removed from
`complete`; `scanner_ip` continues to be recorded for audit. Rationale: the
256-bit `linkingSecret` is QR-only and the X25519 `keyConfirm` MAC already binds
`complete` to the scanner, so an attacker who reaches `complete` without the
shared secret receives a ciphertext they cannot open. The check is
defence-in-depth worth a few bits against a real, recurring FR-020 failure.
Change site `apps/sync-server/src/services/linking.ts:339-345` and test
`services/linking.test.ts:961-984`. Tracked as **#2184**; chapter 03 states
the relaxed rule and notes the historical behaviour.

**Core obligation, until the relaxation ships.** On `LINKING_IP_MISMATCH` the
client MUST zero the linking subkeys and MUST NOT retry; it SHOULD watch for a
path change (`NWPathMonitor`) between scan and complete and prompt to rescan
rather than burning polls. Rate limiting is keyed by `sessionId`, not IP
(`routes/linking.ts:17-44`), so an IP change does not affect the budget.

---

## Q03.3 — linking session TTL

**Normative.** 300 seconds, server-chosen, absolute from `initiate`, expressed as
epoch **seconds** (`apps/sync-server/src/services/linking.ts:6`, `:131-132`).
Returned by `initiate` (`routes/linking.ts:114`), stored in `expires_at`
(`:152`), mirrored into the `LinkingSession` Durable Object whose alarm at
`expiresAt * 1000` deletes DO storage
(`apps/sync-server/src/durable-objects/linking-session.ts:46-50`, `:85-87`).
Neither `scan` nor `approve` extends it. It covers the whole flow through
`complete`, and on desktop through the deferred vault picker
(`linking-service.ts:439`, `:561`).

Expiry is enforced by `assertNotExpired` on `scan`, `approve` and `complete` with
the predicate `expires_at < now` (`services/linking.ts:100-107`, `:169`, `:252`,
`:337`), so a request at exactly `expires_at` is still accepted.
`GET /session/:id` does not check expiry (`routes/linking.ts:172-188`).

**Core obligation.** Use the server's `expiresAt`; do not hardcode 300. Desktop
polls `complete` every 3 s (`linking-pending.tsx:7`) against a 30-requests-per-60-
seconds per-session budget (`routes/linking.ts:39-44`); a phone MUST stay at or
below that.

**Defect — `cancelled` is a persisted status missing from the contract.**
`initiate` cancels the user's prior pending and scanned sessions with
`status = 'cancelled'` (`services/linking.ts:142-145`), but `cancelled` appears
in neither `LINKING_SESSION_STATUSES`
(`packages/contracts/src/linking-api.ts:5-11`) nor the DO's `SessionStatus`
(`durable-objects/linking-session.ts:3`). A client that validates
`GET /session/:id` against the contracts enum fails on a perfectly ordinary
response. Additive fix, no migration. Tracked as **#2182**. Note also that
the server validates `sessionId` as `.uuid()` (`routes/linking.ts:51`, `:77`)
while contracts only require `min(1)` (`linking-api.ts:20`, `:44`); the chapter
states UUID. `expired` is computed, never persisted.

---

## Q03.4 — the two optional encrypted blocks

**Normative.** Both blocks travel through the server as opaque base64; the server
stores them only when all four linking fields are present
(`apps/sync-server/src/routes/linking.ts:220-241`;
`services/linking.ts:262-293`) and returns them on `complete`
(`routes/linking.ts:296-309`). Both version fields are `z.literal(1)`
(`packages/contracts/src/linking-api.ts:3`, `:36`, `:40`).

| block                    | plaintext                                                                                                                                                  | AAD                                                                     | MAC ordering                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| master key               | 32-byte master key                                                                                                                                         | **none** (`apps/desktop/src/main/crypto/encryption.ts:113-118`)         | `KEY_CONFIRM`                                                                               |
| `encryptedProviderAuth`  | `{version:1, providers:[{provider:'google', accountId, refreshToken}]}` (`apps/desktop/src/main/calendar/google/provider-auth-transfer.ts:9-21`, `:41-67`) | `google-provider-auth-transfer-v1:<sessionId>` (`:10`, `:38-39`, `:77`) | `PROVIDER_AUTH_CONFIRM` over `(sessionId, base64 ciphertext)` (`:79-81`, `keys.ts:207-217`) |
| `encryptedVaultTransfer` | `{version:1, vaults:[{vaultUuid, itemCount?, createdAt?}]}` (`apps/desktop/src/main/sync/vault-transfer.ts:8-20`)                                          | `vault-transfer-v1:<sessionId>` (`:9`, `:37-38`, `:74`)                 | `VAULT_TRANSFER_CONFIRM` (`:76-78`, `keys.ts:219-229`)                                      |

The AAD asymmetry is real and chapter 03 MUST state all three rows: the master
key block uses no AAD, the two optional blocks do.

**Normative consumption rules**, from the desktop receiver
(`apps/desktop/src/main/sync/linking-service.ts:371-425`):

- **Provider auth is soft-fail.** Present and undecryptable: warn and continue
  (`:387-394`). Absent: nothing. A client MAY ignore the block entirely; the only
  effect is that Google Calendar is not pre-connected. The refresh tokens already
  transited the server as ciphertext either way, so ignoring them costs nothing.
- **Vault transfer is hard-fail.** Present and failing MAC or decrypt: the link
  MUST fail and the session state MUST be cleared (`:414-424`). Absent: the client
  proceeds with an empty vault list (`:427`, `:456-464`). Desktop auto-adopts a
  single vault and shows a picker for two or more (`:428-454`).

**Core obligation.** Implement vault-transfer verify-and-decrypt; it is what
FR-021's first-vault default is built on. Provider auth is optional. Note the
list is a copy of `GET /sync/vaults` (`linking-service.ts:702-707`), so a client
MAY fetch it after registration instead — the one thing the transfer adds is the
initiator's _current_ vault as the first entry when the server list is empty
(`vault-transfer.ts:41-46`). The "scans while already linked" case lives in
`LINKING_CONCURRENT_ATTEMPT` on `complete` (`services/linking.ts:366-372`) and in
`initiate` cancelling prior sessions (`:142-145`), not here.

---

## Q03.5 — two MAC algorithms, and the SAS

**Normative.** The split is real and follows one rule: **anything the server
verifies uses WebCrypto HMAC-SHA-256; anything only devices verify uses libsodium
`crypto_auth`, which is HMAC-SHA512-256.** Both produce 32-byte tags compared in
constant time (server `services/otp.ts:42-48`, devices
`apps/desktop/src/main/crypto/index.ts:68-73`).

| channel | messages                                                                                                          | key                                            | algorithm                                                                 | verified by                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| scan    | `scanProof` (`LINKING_PROOF`), `scanConfirm` (`SCAN_CONFIRM`)                                                     | decoded 32-byte `linkingSecret`                | WebCrypto HMAC-SHA-256 (`linking-service.ts:121-159`)                     | server (`services/linking.ts:60-98`, `:181-204`) |
| confirm | `newDeviceConfirm` (`LINKING_PROOF`), `keyConfirm` (`KEY_CONFIRM`), `providerAuthConfirm`, `vaultTransferConfirm` | `macKey = KDF(sharedSecret, "memrymac", id 6)` | libsodium `crypto_auth` = HMAC-SHA512-256 (`keys.ts:165-171`, `:189-229`) | the peer device only                             |

`LINKING_PROOF` ordering is used by **both** families over the same CBOR bytes
with different keys and algorithms, and both are posted in the same `scan` body
(`linking-service.ts:254`, `:256-260`, `:268-277`).

**Rationale, inferred and not documented anywhere.** `git log -S computeScanProof`
lands in a single squash commit and no design doc mentions it. The evident cause
is environmental: the sync server is a Cloudflare Worker with no libsodium
dependency (`apps/sync-server/package.json` carries only `hono`), and
`crypto.subtle` offers HMAC-SHA-256 but not HMAC-SHA512-256. Chapter 03 states
the rule with the "inferred" qualifier rather than asserting intent.

**SAS derivation, normative** (`apps/desktop/src/main/crypto/keys.ts:173-183`):

```
sasKey = crypto_kdf_derive_from_key(32, 7, "memrysas", sharedSecret)
h      = crypto_generichash(4, sasKey, key = null)          // BLAKE2b, 4 bytes
u32    = (h[0]<<24) | (h[1]<<16) | (h[2]<<8) | h[3]         // big-endian, unsigned
code   = u32 % 1_000_000, zero-padded to 6 decimal digits
```

Both sides compute it from the raw scalarmult output
(`linking-service.ts:279`, `:777-781`). About 19.9 bits. `2^32 mod 10^6 =
4_967_296`, so codes below that are marginally more likely. **This bias MUST be
reproduced, not corrected**; a Rust core that substitutes rejection sampling
produces a different code and breaks linking.

**Core obligation.** Two MAC primitives are required and MUST NOT be unified:
RustCrypto `hmac` + `sha2` for the scan channel, and libsodium's `crypto_auth`
for the confirm channel — HMAC with SHA-512 truncated to 32 bytes, **not**
SHA-512/256, which uses a different IV.

**Vector gap.** `packages/contracts/scripts/gen-crypto-vectors.ts` emits KDF, AEAD
and Ed25519 cases only. T064 MUST also cover `scanProof`, `scanConfirm`,
`keyConfirm` and the SAS, or the two MAC families reach Rust unpinned.

---

## Q04.1 — the packed CRDT header

**Normative.** 160 bytes, signature at offset 96. All fields are opaque byte
runs: no integers, so no endianness.

| offset | length | field                                                |
| ------ | ------ | ---------------------------------------------------- |
| 0      | 24     | `dataNonce`, the XChaCha20 nonce of the ciphertext   |
| 24     | 24     | `keyNonce`, the nonce of the wrapped file key        |
| 48     | 48     | `wrappedKey`, a 32-byte file key plus a 16-byte tag  |
| 96     | 64     | Ed25519 detached signature                           |
| 160    | rest   | ciphertext: compressed Yjs update, AEAD tag included |

`HEADER_LEN = NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN + SIGNATURE_LEN =
24+24+48+64` (`apps/desktop/src/main/sync/crdt-encrypt.ts:11-14`; twin at
`packages/sync-client/src/pull/record-decrypt.ts:103-106`). Written at
`crdt-encrypt.ts:32-36`, `:40`; read at `:59-62`, `:71-74`. Minimum accepted
length is 161 (`crdt-encrypt.ts:54`, `record-decrypt.ts:122`).

Signed message is `UTF-8(noteId) ‖ packed[0..96) ‖ packed[160..)`
(`crdt-encrypt.ts:85-94`, `record-decrypt.ts:129-135`), computed while the
signature slot is still zero-filled (`:31` allocates zeroed, `:38-40`). AEAD
associated data is the `noteId` bytes (`:27`, `:78`).

**Core obligation.** `HEADER = 160`, `SIG_OFF = 96`, reject `len < 161`, verify
the signature before unwrapping the key.

**Stale comments to fix** (T039; note the outline's line numbers have drifted):

| file                                                 | outline says   | actual               | correction                                                                                     |
| ---------------------------------------------------- | -------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/sync/crdt-encrypt.ts`         | `:38`          | `:35`                | `signature slot at offset 72` → `offset 96 (NONCE_LEN + NONCE_LEN + WRAPPED_KEY_LEN)`          |
| `packages/sync-client/src/pull/record-decrypt.ts`    | `:72-74`       | same                 | the "CBOR encodes the nested object's own key order" claim is **false**; see below             |
| `packages/sync-client/src/push/record-encrypt.ts`    | `:74-76`       | same                 | same                                                                                           |
| `apps/desktop/src/main/crypto/cbor.test.ts`          | `:67`          | `:68`                | `RFC 8949 §4.2.1` → `§4.2.3 (length-first, then bytewise)`                                     |
| `docs/ideas/2026-09-12-native-ios-rust-core-plan.md` | `:42` says 168 | **already says 160** | T039's "correct the 168-byte figure" clause is itself stale; `168` survives only in `tasks.md` |

The nested-key-order claim (Q04.8): cborg's default `mapSorter` sorts **every**
map including nested ones, length-first then bytewise. Verified empirically —
`metadata: {stateVector, clock}` encodes as `clock, stateVector` in any insertion
order, and `clock: {zz, a}` encodes as `a, zz`. What actually matters, and what
the replacement comment should say, is that a key must be **absent** rather than
`undefined` when neither side has it, because an empty map is a different byte
string from no key at all.

---

## Q05.3 — the same four fields, canonicalised twice

**Normative.** `encryptedKey`, `keyNonce`, `encryptedData` and `dataNonce` are
serialised twice with different orderings and different encodings. Both are
normative and **a client may assume neither**.

**A. R2 object and `contentHash`, JSON, server-side.** `serializePayload` builds
`{dataNonce, encryptedData, encryptedKey, keyNonce}` and applies
`JSON.stringify(payload, Object.keys(payload).sort())`
(`apps/sync-server/src/services/sync.ts:247-269` — the outline's `:211-233` has
drifted). Plain JS string sort gives
`dataNonce, encryptedData, encryptedKey, keyNonce`. The bytes are
`{"dataNonce":"…","encryptedData":"…","encryptedKey":"…","keyNonce":"…"}`, no
whitespace, UTF-8. That string is the R2 object (`:559`, `:620`) and
`contentHash = hex(SHA-256(string))` (`:247-259`, `:560-565`), which feeds the
blob key (`:574`) and `size_bytes` (`:576`). The server re-parses the object on
pull and returns it as `blob` (`:296-298`, `:348`), so a client never sees the
canonical JSON — only the four fields.

**B. Signature, CBOR, client-side.** `encodeCbor(signaturePayload,
CBOR_FIELD_ORDER.SYNC_ITEM)` (`packages/sync-client/src/push/record-encrypt.ts:84`,
`pull/record-decrypt.ts:82`; encoder at `pull/cbor.ts:9-30`, desktop twin
`apps/desktop/src/main/crypto/cbor.ts:7-28`). `CBOR_FIELD_ORDER.SYNC_ITEM`
(`packages/contracts/src/cbor-ordering.ts:2-13`) is an **allowlist, not an
ordering**: cborg's default `mapSorter` decides the order. The ten keys encode as
`id, type, keyNonce, metadata, dataNonce, deletedAt, operation, encryptedKey,
cryptoVersion, encryptedData` — length-first, then bytewise. Restricted to the
four blob fields that is `keyNonce(8), dataNonce(9), encryptedKey(12),
encryptedData(13)`. Nested `metadata` becomes `clock, stateVector`, and clock
device ids sort the same way. `undefined` values are skipped
(`cbor.ts:13`, `:24`); a key outside the allowlist throws (`:14-19`). Values are
the base64 **strings**, not raw bytes (`record-encrypt.ts:54-67`).

**Core obligation.** B is mandatory for every push and every verify. A is needed
only if the core ever computes `contentHash` or a blob key, which it does not
today — chapter 05 still states it so a future pack or manifest consumer is not
surprised. Use a CBOR encoder with RFC 8949 §4.2.3 length-first ordering;
`ciborium`'s insertion-order default is wrong. All current keys are under 24
bytes, so §4.2.1 happens to agree, but the chapter names §4.2.3 because that is
what the code implements. cborg also defaults `float64: false`; no floats appear
in the signed set today (Q04.7).

---

## Q06.1 and Q06.2 — the complete winner-selection rule

### The rule

For each field `f` in the type's field list, in list order
(`packages/sync-client/src/field-merge.ts:90`; lists at `:11-27`, `:29-39`):

1. `L = localFieldClocks[f] ?? {}`, `R = remoteFieldClocks[f] ?? {}` (`:91-92`).
   A missing field clock is the empty clock.
2. `tL = Σ values(L)`, `tR = Σ values(R)`, summing **every** key including
   `_offline` (`:47-51`). No key is filtered.
3. `cmp = compare(L, R)` (`:93`, `vector-clock.ts:22-41`). Computed, but used
   **only** for the conflict flag — never for the winner.
4. `differ = canonical(vL) != canonical(vR)` (`:100`; see Q06.3).
5. Winner:
   - `tR > tL` → `vR` (`:102-103`)
   - `tL > tR` → `vL` (`:104-105`)
   - `tL == tR` → `vL` iff `'_offline' ∈ keys(L)` **and** `'_offline' ∉ keys(R)`
     **and** `differ` (`:107-110`); otherwise `vR` (`:111-112`).
     **Key presence, not tick value**: `{_offline: 0}` counts as present.
6. Conflict flag, only inside the tie branch: `cmp === 'concurrent' && differ`
   (`:114-124`). The record carries `mergedClock = merge(L, R)`.
7. `mergedFieldClocks[f] = merge(L, R)` unconditionally (`:127`, pointwise max at
   `vector-clock.ts:14-20`).
8. `merged[f] = winner` even when the winner is `undefined`; the caller's spread
   then leaves the column untouched
   (`apps/desktop/src/main/sync/item-handlers/task-handler.ts:170-171`, `:178-180`).

Document-level gate before any of this:
`resolveClockConflict(existing.clock, remoteClock)`
(`packages/sync-client/src/item-handlers/types.ts:58-68`) — `null` local → apply;
`after` → skip; `concurrent` → merge; `before` or `equal` → apply remote
wholesale with its field clocks stored verbatim
(`task-handler.ts:146-150`, `:244`, `:269-270`).

### Worked examples

| #   | L                  | R                  | tL  | tR  | vL  | vR        | winner                                     | conflict     | mergedFC               |
| --- | ------------------ | ------------------ | --- | --- | --- | --------- | ------------------------------------------ | ------------ | ---------------------- |
| 1   | `{A:2,B:1}`        | `{C:5}`            | 3   | 5   | x   | y         | remote y                                   | no           | `{A:2,B:1,C:5}`        |
| 2   | `{A:1}`            | `{B:1}`            | 1   | 1   | x   | y         | remote y                                   | **yes**      | `{A:1,B:1}`            |
| 3   | `{A:3,B:1}`        | `{A:3,B:1}`        | 4   | 4   | x   | y         | remote y                                   | no (`equal`) | `{A:3,B:1}`            |
| 4   | `{A:1,_offline:1}` | `{B:2}`            | 2   | 2   | x   | y         | **local x**                                | yes          | `{A:1,B:2,_offline:1}` |
| 5   | `{A:1,_offline:1}` | `{B:1,_offline:1}` | 2   | 2   | x   | y         | remote y                                   | yes          | `{A:1,B:1,_offline:1}` |
| 6   | `{A:1,_offline:1}` | `{B:2}`            | 2   | 2   | x   | x         | remote x (needs `differ`)                  | no           | as 4                   |
| 7   | `{}`               | `{}`               | 0   | 0   | x   | y         | remote y                                   | no (`equal`) | `{}`                   |
| 8   | `{A:4}`            | `{A:1,B:1,C:1}`    | 4   | 3   | x   | y         | **local x** though `compare` is concurrent | no           | `{A:4,B:1,C:1}`        |
| 9   | `{A:2}`            | `{A:1}`            | 2   | 1   | x   | y         | local x                                    | no           | `{A:2}`                |
| 10  | `{A:1}`            | `{A:2}`            | 1   | 2   | x   | undefined | remote; column untouched by the spread     | no           | `{A:2}`                |

Rows 1 and 8 are the cases where the sum overrides causality. Row 1 is pinned by
`packages/sync-client/src/field-merge.test.ts:120-141`, row 4 by
`apps/desktop/src/main/sync/item-handlers/task-handler.test.ts:81-124`, row 3 by
`field-merge.test.ts:107-118`.

### Q06.1 — is the outcome evaluator-dependent

**No, and the asymmetric `_offline` test is the part that saves it.** Two devices
X and Y holding `(Cx, vx)` and `(Cy, vy)`; X evaluates `W(Cx, Cy)`, Y evaluates
`W(Cy, Cx)`:

| case | totals               | `_offline` in | X picks       | Y picks       | converge |
| ---- | -------------------- | ------------- | ------------- | ------------- | -------- |
| 1    | `tx ≠ ty`            | any           | larger total  | larger total  | yes      |
| 2    | `tx = ty`, `vx = vy` | any           | same          | same          | yes      |
| 3a   | `tx = ty`, differ    | X only        | `vx` (rule 3) | `vx` (rule 4) | **yes**  |
| 3b   | `tx = ty`, differ    | Y only        | `vy` (rule 4) | `vy` (rule 3) | **yes**  |
| 3c   | `tx = ty`, differ    | neither       | `vy`          | `vx`          | **no**   |
| 3d   | `tx = ty`, differ    | both          | `vy`          | `vx`          | **no**   |

From either seat, rule 3 means "the side carrying `_offline` wins", which is why
3a and 3b agree. The branch that flips with the seat is the plain "remote wins"
default at `:111-112`.

**3c and 3d do not diverge in production, and the reason is not `mergeFields`.**
Three facts carry it:

- **P1 — one row per item; any push with one component ahead is accepted.**
  `apps/sync-server/src/services/sync.ts:668-686`
  (`ON CONFLICT … DO UPDATE SET … clock = excluded.clock`), `:575`
  (`version = existing.version + 1`), and `detectReplay` at `:179-190`, which
  rejects only when no incoming component exceeds the stored one. A concurrent
  push overwrites the row, so the earlier concurrent payload stops existing.
- **P2 — a queued push is rebuilt from the live row at dequeue.**
  `apps/desktop/src/main/sync/engine/push-coordinator.ts:598-641`
  (`resolvePushPayload` → `buildPushPayload`), `task-handler.ts:367-379`
  (`{...task}` from the current row), same for projects
  (`project-handler.ts:340`).
- **P3 — a merge apply re-queues the merged row under the union clock.** The
  handler stores the union and enqueues nothing (`task-handler.ts:178-186`,
  union at `field-merge.ts:127` and `types.ts:66`), but the pull coordinator
  re-queues every `'conflict'` return
  (`apps/desktop/src/main/sync/engine/conflict-report.ts:56-61`, called from
  `pull-coordinator.ts:861-864`, `:559-562`, `:648-651`, `:942`) and an enqueue
  requests a push (`apps/desktop/src/main/sync/runtime.ts:949`). P2 rebuilds
  that row from the merged state, and the union clock is one component ahead of
  the stored row, so `detectReplay` accepts it.
- **P4 — an EQUAL incoming clock applies the remote row rather than skipping
  it.** `types.ts:67`. Settles two devices whose P3 re-pushes collide: the first
  is accepted, the second is refused `SYNC_REPLAY_DETECTED` and marked done
  (`push-coordinator.ts:299-305`), and the refused device takes the accepted row
  on the next pull.

In the ordinary interleavings P1 to P3 leave at most **one** device running
`mergeFields` on a given concurrent pair; the other sees its own row (`equal` →
apply) or a strictly dominating one (`before` → apply). Trace with ancestor
`{X:1,Y:1}`, X edits `title` → `{X:2,Y:1}`, Y edits `title` → `{X:1,Y:2}`, both
totals 3:

| interleaving                   | server row               | X ends                                       | Y ends                    | merger |
| ------------------------------ | ------------------------ | -------------------------------------------- | ------------------------- | ------ |
| X push, Y push, both pull      | `(vy, {X:1,Y:2})`        | merge, tie, remote → `vy`, clock `{X:2,Y:2}` | own row, `equal` → `vy`   | X      |
| X push, Y pull, Y push, X pull | `(vx, {X:2,Y:2})` via P2 | `before` → `vx`                              | merge, tie, remote → `vx` | Y      |

Both converge. Which value survives is "last pusher wins", not a property of the
merge rule. A third device pulls the single latest row and behaves identically.

**Normative for chapter 06.** FR-002 is satisfied by **P1 + P2 + P3 + P4**, not
by `mergeFields`. State it that way: the merge rule alone does not converge, and
a client that breaks any of the four reintroduces divergence.

**Core obligation — this is the load-bearing one.** A Rust outbox that freezes
the push payload at enqueue time reintroduces the 3c divergence **deterministically,
not as a race**. The core MUST rebuild the payload from the live row at send time
(P2), MUST re-queue a merged item so the union-clocked row is pushed (P3), MUST
apply — never skip — a remote row whose clock is EQUAL to the local one (P4), and
MUST implement rule 3's asymmetric key-presence test exactly — a "symmetric"
rewrite breaks 3a and 3b against desktop.

**Re-examined 2026-09-19 — the push-build / pull-apply race is NOT a divergence
(#2180, closed).** The original defect block claimed that a push payload built
before the local `applyUpsert` commits and sent after the peer's row lands leaves
X on `vy`, Y on `vx` and neither re-pushing. Two of its premises were wrong.
First, P3 as written above: a `'conflict'` return **is** re-queued by the pull
coordinator, so both mirrored devices push the merged row under the union clock;
the first push is accepted, the second is refused as a replay, and P4 then hands
the refused device the accepted value. Second, on desktop the two phases cannot
interleave at all outside the 15-minute stale-lock watchdog: push and pull take
the same engine sync lock (`push-coordinator.ts:70`, `pull-coordinator.ts:133`,
`engine.ts:630-643`, `:686-697`), held across the whole `POST /sync/push`. What
survives is cosmetic: both devices write a `superseded` activity row with the
same id (`apps/desktop/src/main/tasks/activity-log.ts:385`) and opposite
`winningValue`, and one overwrites the other, so an activity entry can name a
value the convergence step discarded. Chapter 06 §6.6.2 states the converging
sequence; pinned by `conflict-report.test.ts` and
`packages/sync-client/src/item-handlers/types.test.ts`.

**Defect — `_offline` reaches the wire.** This is what makes case 3d reachable at
all. `recoverDirtyItems` routes `syncedAt IS NULL` rows to `enqueueCreate`, not
`enqueueRecoveredUpdate`
(`apps/desktop/src/main/sync/dirty-recovery.ts:49-56`, `:63-67`), and rebinding
runs only from `recoverPendingChange`, which only `enqueueRecoveredUpdate` calls
(`packages/sync-core/src/record-sync.ts:114-142`;
`packages/sync-client/src/task-sync.ts:129-160`). `applyLocalChange` increments
the real device id but never strips `_offline` (`record-sync.ts:146-172`,
`:208-216`), and `seedUnclocked` only touches `clock IS NULL` rows
(`task-handler.ts:385-386`) so an offline-created task with `{_offline:1}` is not
seeded (`offline-clock.ts:111-123`). The server filters nothing — zero hits for
`_offline` under `apps/sync-server/src`. Path: use the app with no account,
create and edit a task, then sign in; the first recovery ships
`clock={_offline:2, A:1}`. The existing test covers only the `syncedAt`-set path
(`dirty-recovery.test.ts:166-200`). The hazard is already named in a code comment
for notes at `offline-clock.ts:330-337`. A peer that later rebinds its own
`_offline` also folds the **remote's** `_offline` ticks into its own device id
(`offline-clock.ts:39-47`). Tracked as **#2179**.

**Core obligation.** Never emit `_offline` on the wire. On inbound, treat it as an
ordinary key with no special case, exactly as `vector-clock.ts` does, so clocks
stay comparable with desktop's.

**Normative for Q06.2.** The tick sum is a proxy for edit count, not causality; a
device with more edits wins a concurrent pair. Chapter 06 states this plainly and
freezes it. The core MUST use the sum (i64 accumulate, key order irrelevant),
never `compare`, for the winner; MUST iterate the field list in order because
`conflictedFields` is consumed in order by activity logging; and MUST treat a
missing field clock as `{}`.

---

## Q06.3 — value equality

**Current behaviour.** `JSON.stringify(a) !== JSON.stringify(b)` on the raw JS
values (`packages/sync-client/src/field-merge.ts:100`). Reproducing that in Rust
means reproducing ECMAScript `JSON.stringify` byte for byte: `undefined` vs
`null` differ (`"null" !== undefined`) while `undefined` vs `undefined` compare
equal; object key order is significant, in ES own-property order (integer-like
keys ascending first, then string keys in insertion order); nested `undefined`
omits a key in an object but becomes `null` in an array; `NaN` and `±Infinity`
become `null`; `-0` becomes `0`; numbers use JS shortest-round-trip formatting
with `1e+21` exponent form that `serde_json` does not produce; lone surrogates
escape as `\uXXXX`.

Only one field in scope carries an object: `repeatConfig` in
`TASK_SYNCABLE_FIELDS` (`packages/contracts/src/sync-payloads.ts:36`,
`packages/db-schema/src/schema/tasks.ts:26`). `PROJECT_SYNCABLE_FIELDS` has none;
everything else is string, number, boolean or null. Key order comes from whoever
last wrote the row, so two devices that build `repeatConfig` from the UI with
different insertion orders compare as differing **forever**, even when
semantically identical.

**Decision, 2026-09-13 — mandate a canonical comparison.** The predicate becomes:
recursively sort object keys, compare with `serde_json`-style number formatting,
and keep `null` distinct from absent. `field-merge.ts:100` changes to match, with
tests pinning `{a:1,b:2}` vs `{b:2,a:1}` as **equal** and `null` vs `undefined` as
**differing**. Rationale: emulating ES `JSON.stringify` is the single most likely
Rust divergence and buys nothing but false-positive conflicts.

**Blast radius, exhaustive.** `differ` flips true → false only for pairs that are
JSON-equal modulo key order and number formatting.

- Winner rules 1 and 2 do not read `differ`: unaffected.
- Rule 3 requires `differ` to hand the win to local; for an order-only difference
  both sides hold the same value, so only the stored serialisation changes —
  remote's key order persists instead of local's. No semantic change.
- The conflict flag (`:114`) stops firing for such pairs, so there are fewer
  `'conflict'` returns (`task-handler.ts:242`) and fewer `superseded` activity
  rows (`activity-log.ts:369-401`). **This is the only user-visible effect, and it
  removes false positives.**
- Nothing on the wire changes; the clock union is untouched.

Tracked as **#2185**. Chapter 06 states the canonical form, not `JSON.stringify`.

---

## Q06.4 — a concurrent pair with unequal totals

**Normative.** A field is reported as conflicted **iff** the field-clock totals
are equal, `compare(L,R)` is `concurrent`, and the serialised values differ. A
concurrent pair with unequal totals is resolved by the larger total and is not a
conflict; an edit is lost with nothing surfaced.

Confirmed: the conflict block sits inside the tie branch
(`field-merge.ts:106-125`, with `if (isConcurrent && valsDiffer)` at `:114`
nested under the `else` of `:102`/`:104`). `hadConflicts` stays false, the handler
returns `'applied'` rather than `'conflict'` (`task-handler.ts:242`), and
`recordTaskSuperseded` is never called (`:228-236` iterates `result.conflicts`).
Pinned by `field-merge.test.ts:120-141`.

**Decision — freeze.** Chapter 06 states the rule and notes the user-visible loss.
Changing it would rewrite desktop's activity log and break the pinning test for a
notice nobody asked for.

**Core obligation.** The core MUST NOT report it. A core that surfaced it would
write `superseded` rows desktop never writes, and those rows sync as
`task_activity` items to every device.

---

## Q07.1 — the journal question

**Normative.** A journal body is a collaborative document in the **same CRDT feed
as notes**. Its document id is the journal record's `id`. Desktop mints that id as
`j<YYYY-MM-DD>` when it creates a day, but an existing canonical row's id wins
(`apps/desktop/src/main/journal/create-entry.ts:39-47`:
`canonical?.id ?? cached?.id ?? generateJournalId(date)`). **A client MUST use the
id carried by the `journal` record and MUST NOT derive the document id from the
date when a record exists.** The CRDT wire carries no item type at all; the server
does not distinguish notes from journals.

Runtime evidence: journals are `note_metadata` rows on the note clock path
(`packages/sync-client/src/offline-clock.ts:325-329`); id minting at
`apps/desktop/src/main/lib/id.ts:20`,
`apps/desktop/src/main/database/queries/notes/journal-queries.ts:50-52`,
`apps/desktop/src/main/vault/journal.ts:134`, with the pattern asserted as the
app's only deterministic id
(`apps/desktop/src/main/sync/crdt-legacy-partition.ts:12-16`, `:23-32`); the Y.Doc
opens under that id (`apps/desktop/src/main/journal/runtime-effects.ts:23-33`);
pull routes `journal` records into the CRDT body feed
(`apps/desktop/src/main/sync/engine/pull-coordinator.ts:563-575`, `:859-871`;
`packages/sync-client/src/pull/engine.ts:305`); `journalHandler` defers concurrent
body merges to the CRDT
(`apps/desktop/src/main/sync/item-handlers/journal-handler.ts:57-64`) and purges
the Y.Doc on remote delete (`:175-181`); the server's `NoteIdSchema` is
`^[a-zA-Z0-9_-]+$` max 128 (`apps/sync-server/src/routes/sync.ts:571-574`), which
`j2026-08-13` satisfies, and the CRDT service treats `note_id` as opaque.

**Decision — correct the constants; do not scope them.** `CRDT_SYNC_ITEM_TYPES`
(`packages/contracts/src/sync-api.ts:91`) and `CrdtSyncItemType` (`:163`) are
referenced only by tests. `EncryptedCrdtItemSchema` and `EncryptedCrdtItem`
(`packages/contracts/src/crypto.ts:139-150`, `:192-203`) are referenced only by
`crypto.test.ts:220-252` and declare `encryptedSnapshot`, `snapshotNonce` and
`stateVector`, which match nothing on the wire — a pre-packed-envelope relic.
"Record-envelope-scoped only" would be a false statement: the record envelope's
type set is `ENCRYPTABLE_ITEM_TYPES` (`crypto.ts:179`), which already contains
`journal` (`sync-api.ts:135`). Fix: `sync-api.ts:91` → `['note', 'journal']`;
update `sync-api.test.ts:89-91`; delete the dead `EncryptedCrdtItem` pair, or widen
its `type` and flip `crypto.test.ts:227-233` to reject `'task'` instead of
`'journal'`. Run `pnpm ipc:check` and the contracts suite. Tests that must stay
green: `packages/contracts/src/{sync-api,sync-payloads,crypto}.test.ts`;
`apps/desktop/src/main/sync/crdt-legacy-partition.test.ts:72`, `:81`;
`engine/pull-coordinator.test.ts`; `engine/pull-apply-order.test.ts`;
`engine-pull.test.ts`; the journal-handler tests;
`packages/sync-client/src/pull/engine.test.ts`;
`apps/sync-server/src/routes/sync.test.ts:1467-1818`;
`apps/sync-server/src/__tests__/crdt-snapshot-batch.test.ts`. Tracked as **#2186**.

**Core obligation.** T101, T102 and T128 can treat journals as documents with no
pending decision. `doc_id` is the record id; never derive it from a date.

---

## Q07.2 — the client snapshot obligation

**Normative — the server never requires a snapshot.** There is no threshold
anywhere in `apps/sync-server/src/services/crdt.ts`; a snapshot exists only
because a client wrote one (`storeSnapshot` `:322-360`). The revision is refreshed
on every write (`:331-336`), the watermark is stable once present (`:344-348`),
and pruning removes `sequence_num <= watermark` (`:700-728`). The route order is
store, prune, broadcast (`apps/sync-server/src/routes/sync.ts:874-936`).

**Normative — the gate (MUST).** A snapshot is destructive: it prunes **every**
device's rows at or below the watermark (`apps/desktop/src/main/sync/runtime.ts:636-664`).
A client MAY push `POST /sync/crdt/snapshot` or its batch form for a document only
when all of:

1. it has merged all server state for that document — the last pull completed
   with no stopped-at-gap and no unresolvable signer
   (`packages/sync-client/src/pull/crdt-pull.ts:225-237`;
   desktop's guard is `hasUnmergedRemoteCrdtState`,
   `apps/desktop/src/main/sync/engine.ts:459-463`, true for any note whose session
   ended holding debt);
2. the document is neither local-only (`crdt-provider.ts:559`, `:865-868`) nor
   purged (`:654`);
3. the state is non-empty (`:876-879`).

Otherwise the client MUST NOT use the snapshot endpoint; it MAY push the same full
state to `POST /sync/crdt/updates`, which prunes nothing
(`runtime.ts:674-681`; batch at `:731`). Pinned by
`apps/sync-server/src/__tests__/crdt-snapshot-batch.test.ts:188` and
`crdt-snapshot-endpoint-seam.test.ts:594-703`. The payload is
`Y.encodeStateAsUpdate(doc)` in the same packed envelope (`runtime.ts:634`).

**Normative — the cadence (SHOULD).** Desktop's de facto policy, which a phone
should follow so a heavily edited note's log does not grow unboundedly:

| trigger                         | rule                                                         | source                                                                                                      |
| ------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| after its own incremental batch | 30 s quiet, 120 s cap from the first request                 | `packages/sync-client/src/crdt-snapshot-scheduler.ts:9`, `:16`, `:61-65`; requested at `runtime.ts:585-591` |
| document close                  | when `pendingSnapshotBytes > 0` and not local-only           | `crdt-provider.ts:559-565`; debt is bytes of non-network-origin updates, `:1249-1252`                       |
| shutdown                        | `pushAllSnapshots` for documents holding debt                | `crdt-provider.ts:809-823`                                                                                  |
| local compaction                | encoded size over 1 MiB, no editor open, 60 s check interval | `crdt-provider.ts:47-49`, `:1385-1400`, `:1442-1470`                                                        |
| oversized incremental           | the snapshot is the compaction point                         | `runtime.ts:578-585`                                                                                        |

**There is no MUST-snapshot.** Correctness never depends on one.

**`yjs_snapshots` and the core.** The platform-free engine pushes no snapshots
(`crdt-pull.ts:16-18`) and writes the table only through
`store.saveSnapshot(noteId, bytes, serverSequenceNum, revision)`
(`crdt-pull.ts:189-194`; `packages/sync-client/src/pull/store.ts:60-65`). Under
today's scope **every row is server-originated**; the table never holds a
server-bound row the core wrote. T119 changes that, and at that point
`server_revision` is undefined at write time, because the push response returns
`{ sequenceNum }` and **not** the revision
(`apps/sync-server/src/routes/sync.ts:947`). Two options: return `revision` from
the snapshot routes (additive, old clients ignore it), or store NULL and lean on
the `sequenceNum > cursor` guard (`crdt-pull.ts:155-166`), which already prevents
a self re-download. Tracked as **#2187**.

---

## Q10.1 — is a bootstrap session required

**Normative — an optimisation, never required.** A missing or invalid token
"degrades to today's steady-state behavior byte-for-byte — it can never fail an
unrelated request" (`packages/contracts/src/bootstrap-api.ts:7-14`); any open
failure falls back silently (`apps/sync-server/src/routes/bootstrap.ts:28-30`);
every error code — `BOOTSTRAP_NOT_ELIGIBLE` 409, `SESSION_LIMIT` 429,
`SESSION_INVALID`, `IDENTITY_MISMATCH` 403, `SESSION_EXPIRED`, `UNAVAILABLE` 501 —
is documented as "client falls back to steady-state pacing"
(`apps/sync-server/src/lib/errors.ts:42-56`; the 501 at
`routes/bootstrap.ts:53-64`). Desktop opens one only on a fresh device and
swallows every failure
(`apps/desktop/src/main/sync/engine/full-sync-runner.ts:504-520`,
`bootstrap-session.ts:79-146`). The platform-free engine and the Expo app never
call it, so today's shipped phone first-sync is already steady-state.

**The only consequence of never calling it is unelevated pull ceilings**
(`apps/sync-server/src/services/bootstrap-session.ts:242-249`):

| limiter           | steady state | elevated | key    |
| ----------------- | ------------ | -------- | ------ |
| `sync_changes`    | 60/min       | 180/min  | user   |
| `sync_pull`       | 120/min      | 360/min  | user   |
| `sync_manifest`   | 30/min       | 90/min   | user   |
| `crdt_pull`       | 600/min      | 3000/min | device |
| `crdt_batch_pull` | 30/min       | 150/min  | device |
| `blob_download`   | 600/min      | 3000/min | device |

Overrun is `429 RATE_LIMITED` with `Retry-After`
(`apps/sync-server/src/middleware/rate-limit.ts:75-81`, `:110-112`), which the
client retries (`packages/sync-client/src/retry.ts:100`, `:117-118`). Nothing else
differs: same endpoints, same pull shape, same manifest — the open response's
manifest is just page 1 of the paginated service
(`routes/bootstrap.ts:98-102`), `packs` is empty and `attachments` informational
(`:139-150`, `bootstrap-api.ts:34-43`).

**SC-007 arithmetic, 10,000 items, steady state.** The refs pass runs
`GET /sync/changes` at `PULL_PAGE_LIMIT = 100`
(`packages/sync-client/src/pull/engine.ts:60`, `:159-160`) → 100 calls at 60/min
≈ 1.7 minutes for refs alone; the server permits `limit ≤ 500`
(`apps/sync-server/src/services/sync.ts:32`), which cuts that to 20 calls.
Metadata pull is 100 ids per call at 120/min, under a minute. A full body sweep of
10,000 notes is about 17 minutes unelevated against 3.3 minutes elevated.

**Core obligation.** Meet FR-028 and SC-007 by **windowing** — refs, then recent
metadata, then recent bodies (T122) — and by raising `/sync/changes` to
`limit=500`, not by the session. The core SHOULD still open one, as desktop does:
it is one cheap call with a silent fallback (`bootstrap-session.ts:26-28`). A 501
on staging means "no bootstrap configured", not a client bug; confirm Q10.3
separately.

---

## Q12.1 — frontmatter key ordering

**Decision, 2026-09-13 — option B: the only guarantee is the verbatim path.**

**Normative.** A frontmatter block that the CRDT tag array, remote tags and remote
properties all left alone is re-emitted byte for byte
(`packages/app-core/src/markdown.ts:86-88`). When any of those alters it, the
block is regenerated and **clients MUST NOT depend on key order, quoting style,
comment survival, or scalar spelling.** A non-desktop client MUST NOT emit YAML at
all.

The regenerated order is a composition of JS semantics and js-yaml 3.15.1
defaults, not a policy: `stringifyFrontmatterBlock` drops `undefined`, emits `''`
for zero keys, and hands the object to `matter.stringify`
(`markdown.ts:117-119`); gray-matter 4.0.3 does `Object.assign({}, file.data,
data)` and calls `yaml.safeDump`; js-yaml 3.15.1 defaults are `sortKeys = false`,
`lineWidth = 80`, `noCompatMode = false`. Per path:

- CRDT write-back: `{ ...existing }` then `merged.tags = yjsTags`
  (`apps/desktop/src/main/sync/crdt-writeback.ts:950-955`) — existing keys hold
  position, `tags` is appended only if absent. Journal `{ ...existing, date }`
  (`:966`) behaves the same.
- Remote tags: assignment or `delete` in place
  (`apps/desktop/src/main/sync/item-handlers/note-handler.ts:357-361`, `:404-408`).
- Remote properties: `replacePropertiesOnRoot` normalises, deletes every property
  key, then re-adds them in the **record's** order
  (`apps/desktop/src/main/vault/frontmatter.ts:414-434`, `:438-449`, `:452-461`).
  **Editing one property moves every property to the end of the block.**
- New file: `serializeNote` → `normalizePropertiesToRoot` → `writeMarkdownNote`
  (`frontmatter.ts:186-188`, `markdown.ts:131-140`); a remote create builds
  `{tags?, aliases?, properties?}` in that literal order
  (`note-handler.ts:601-607`).

**Value re-spelling is part of the same loss.** `parseNote` uses js-yaml
`safeLoad`, so `date: 2026-07-05` becomes a `Date` (acknowledged at
`crdt-writeback.ts:983`) and the dumper re-emits it as `toISOString()`, i.e.
`2026-07-05T00:00:00.000Z`. Any frontmatter edit rewrites every bare date.
Comments, quoting style and blank lines survive only on the verbatim path
(`markdown.ts:17-19`).

**Rationale for B.** A real ordering policy would change bytes for every existing
user on their next tag edit, which the mandatory-backward-compatibility rule
forbids without a migration story; the phone never emits YAML, so an ordering spec
would bind exactly one implementation and conform nothing; and Obsidian, the
emitter's stated model, is also insertion-order.

**Repo change in the same PR as chapter 12** (T038): delete the "Interim …
spec 05 owns the real one" sentence at `packages/app-core/src/markdown.ts:110-111`
— `specs/` holds only `001-mobile-app` and `002-native-foundation-ios`, so it
points at nothing — and replace it with a docstring stating insertion order plus
js-yaml defaults and pointing at `docs/protocol/12-note-body-format.md`.
Recommended alongside: a test in `markdown.test.ts` pinning `tags` appended last
and a bare date re-emitted as ISO, so "no guarantee" is at least a _known_
behaviour. No ordering or quoting test exists today.

**Open, out of chapter scope.** Whether desktop should stop coercing bare dates at
all. It is a silent value rewrite on every frontmatter edit; flagged as a desktop
issue, not a protocol question.

---

## Q12.2 — who converts markdown

**Normative.** Markdown-to-document and document-to-markdown both run **inside the
editor bundle**. The Rust core never parses and never serialises BlockNote
markdown; `extract_text` is its only text operation
(`../data-model.md:296`, `:307-310`; vectors at
[conformance-vectors.md](./conformance-vectors.md):741-770).

Two corrections to the outline's existing answer:

1. **The mechanism is `doc-load.seedMarkdown`, not a `seed-from-markdown`
   message.** The optional `seedMarkdown` field on `doc-load`
   (`packages/contracts/src/webview-bridge.ts:41-60`) is applied by the guest only
   when the document is empty (`packages/editor-web/src/main.ts:446-453`); the
   reverse is `export-markdown` (`webview-bridge.ts:224-228`, handled at
   `main.ts:234-238`). `seed-from-markdown` is a planned rename that appears in
   the outline, `../data-model.md:305` and `../tasks.md:104` but not in
   production.
2. **"The WebView" is wrong for desktop.** Desktop's conversion runs in the
   **Electron main process** over a headless BlockNote
   (`apps/desktop/src/main/sync/blocknote-converter.ts:143`, `:193`, `:217`). The
   chapter should say "the editor bundle: a WebView on mobile, a headless editor
   in Electron main on desktop".

**The guest does not run desktop's pipeline, and the chapter must say so.** The
guest calls BlockNote's `tryParseMarkdownToBlocks` (`main.ts:448`) and
`blocksToMarkdownLossy` (`main.ts:238`) and nothing else: no frontmatter split, no
critic-markup strip, no link-reference strip, no inline-colour masking, no source
record. Desktop additionally runs `prepareFragmentSeed` → `applyFragmentSeed`
(`blocknote-converter.ts:462-475`) and `recordMarkdownSourceInYDoc`
(`:477-491`, `:517-541`) inbound, and `blocksToMarkdownPreserving` +
`restoreLinkReferences` (`:236-238`) + `restoreMarkdownSource` (`:161`) +
`serializeCriticMarkup` (`crdt-writeback.ts:459-466`) outbound. Block and inline
_specs_ are shared (`packages/editor-web/src/blocks.ts:20-27`), so the block
grammar matches; the out-of-band layer does not.

**FR-041 holds structurally, with three carve-outs the chapter MUST state.** The
structural argument: the phone never writes a vault file, desktop is the only
writer, and it writes from the Y.Doc (`crdt-writeback.ts:459-466`, `:552-560`).
`restoreMarkdownSource` returns the source untouched when `ours === base`
(`packages/shared/src/markdown-source.ts:68`),
`serializeParsedMarkdownNote` re-emits the raw frontmatter block and the body
verbatim when unedited (`markdown.ts:86-88`, `:90-92`), and `writebackExisting`
skips the write entirely when the bytes match (`crdt-writeback.ts:563-566`).

- **Carve-out A — phone markdown does reach disk on create and duplicate.**
  Desktop's note record push carries `content` only on `create`
  (`note-handler-sync-helpers.ts:50-56`), and mobile's `createNote` is "the ONE
  operation that carries the body in the record payload"
  (`apps/mobile/src/features/notes/note-ops.ts:221-223`). `duplicateNote` sets
  `content` from the guest's `blocksToMarkdownLossy` output
  (`apps/mobile/src/app/(vault)/(tabs)/notes/[id].tsx:897-899`,
  `note-ops.ts:361`), and desktop writes a new remote note's file as
  `serializeNote(frontmatter, data.content)` (`note-handler.ts:598-609`). So the
  outline's sentence "a client that cannot serialise markdown cannot write a vault
  file" is false as stated; the invariant must be scoped to **existing** notes and
  the create-time `content` path named explicitly.
- **Carve-out B — a phone tag or property edit rewrites frontmatter**
  (`note-handler.ts:353-371`, `:400-420`). See Q12.1.
- **Carve-out C — a non-empty `criticMarkupMarks` disables source restoration**
  (`blocknote-converter.ts:158`), so a note carrying suggestions is never
  byte-identical after any write-back, on any client.

**Q12.3 and Q12.4 do not collapse to nothing.** The three-way merge
(`markdown-source.ts:88-136`), the ours-wins conflict rule (`:127-131`), the
alignment key (`:215-221`) and `MAX_EDIT_DISTANCE = 2000` (`:200`) run only in
desktop main's `yDocToMarkdown`. The guest and the core never call them. They stay
normative **as desktop write-back behaviour**, which a non-desktop client relies on
but need not reproduce. `MAX_EDIT_DISTANCE` is one writer's implementation budget,
not a protocol constant.

**Core obligation.** The core MUST NOT parse or serialise markdown. The iOS shell
MUST route note creation, duplication and template application through the editor
bundle, and MUST know that the `content` it puts in a create record becomes vault
bytes verbatim on desktop. Prefer sending `content: ''` on create unless seeding
from a template, and prefer copying the Y.Doc on duplicate
(`apps/mobile/src/editor/clone-y-subtree.ts:12-18` already establishes "the host
copies, it never builds"), using `content` only as a fallback.

**Open.** Whether the guest's `blocksToMarkdownLossy` output — no colour masking,
no link-ref restore, no critic serialisation — is acceptable as create-time
`content`. No test pins the guest serialiser against
`packages/editor-schema/src/conformance.ts`; the corpus is asserted only by the two
desktop suites. Either add the corpus to the editor-web suite, or state normatively
that create-time `content` is best-effort and the Y.Doc pushed alongside is
authoritative.

---

## Q12.5 — the Y.Doc roots

**Normative, and stronger than the question assumes: a conforming client MUST
preserve every root present in the update stream, including roots this
specification does not name.** FR-033 says unrecognised fields are preserved and
never stripped; a Y.Doc root is such a field.

**A note document has seven roots, not eight.** `probe` never lives on a note
document: it is set on a throwaway `Y.Doc`
(`apps/desktop/src/main/sync/crdt-persistence.ts:229-231`,
`crdt-preflight-child.ts:142`) under `PERSISTENCE_PROBE_KEY` and cleared
(`crdt-persistence.ts:256-259`). Remove it from the outline's fact 2 table.

| root                       | type                     | writer                                                                                        | reader                                                | consequence of dropping                                                                                                                                             |
| -------------------------- | ------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prosemirror`              | XmlFragment              | editor bundle via y-prosemirror; desktop seed `blocknote-converter.ts:193`, `crdt-feed.ts:69` | everything                                            | the body is lost                                                                                                                                                    |
| `meta`                     | Map (`title`, `date`)    | `crdt-provider.ts:1163-1165`, `:1184-1186`                                                    | `crdt-writeback.ts:684-685`, `:706`                   | a phone-created note materialises as `Untitled` with the wrong `createdAt`                                                                                          |
| `tags`                     | Array\<string\>          | `crdt-provider.ts:1167-1170`, `crdt-feed.ts:93-99`                                            | `crdt-writeback.ts:993-1001` → `:950-955`             | desktop keeps the file's tags while the array is empty (`yjsTags.length > 0` guard, `:952`), so a drop is **silent divergence** until a later record push overrides |
| `markdownSource`           | Map (`record: {source}`) | `markdown-source.ts:159-167` via `blocknote-converter.ts:517-541`, `crdt-feed.ts:80`          | `blocknote-converter.ts:156`, `:161`                  | foreign-vault bytes are re-spelled to house style on the next write-back: a `git diff` across the user's file, violating FR-041's "change only the edited region"   |
| `linkReferenceDefinitions` | Array                    | `link-references.ts:176-179` via `blocknote-converter.ts:470-471`                             | `:237-238`                                            | reference-link definitions are deleted and `[docs][d]` is inlined                                                                                                   |
| `linkReferenceUsages`      | Array                    | same                                                                                          | same                                                  | same                                                                                                                                                                |
| `criticMarkupMarks`        | Array                    | `critic-markup/yjs.ts:34-45` via `blocknote-converter.ts:469`; renderer `ContentArea.tsx:602` | `crdt-writeback.ts:466`, `blocknote-converter.ts:158` | **every suggestion and comment is deleted from the file on the next write-back, and source restoration flips back on, so the body is additionally re-spelled**      |

`criticMarkupMarks` therefore confirms the premise: dropping it violates FR-033
and destroys user data.

**Core obligation — the mechanism, not just the rule.** Yjs materialises a root
that arrives in an update but was never requested by name as a bare
`AbstractType` placeholder, upgrading it only when `getMap`/`getArray` is later
called. The only safe way to preserve unknown roots is to **never rebuild state
through typed accessors**: snapshot with a full-state encode
(`Y.encodeStateAsUpdate` / `yrs` `encode_state_as_update_v1`) and never assemble a
document by copying named roots. Mobile already does this
(`apps/mobile/src/editor/doc-manager.ts:410`, `:427`), as do desktop's ordinary
persist paths (`crdt-provider.ts:433`, `:444`, `:560`, `:712`, `:820`, `:876`,
`:1127`).

The core reads `prosemirror` for `extract_text` and MUST NOT delete or normalise
other roots as a side effect. It MUST NOT write `criticMarkupMarks`,
`linkReference*` or `markdownSource` — byte-offset marks and source records are
desktop-derived and a phone that touches them corrupts them. It MAY write `meta`
and `tags` with `crdt-provider.ts:1163-1170` semantics: set-if-absent on create,
whole-array replace on a tag edit (`crdt-feed.ts:96-99`). The critic-markup reader
drops any element failing shape validation — `id`, `kind`, `visibleText`, finite
`start <= end` (`critic-markup/yjs.ts:55-66`) — so a client that rewrites elements
MUST keep that shape exactly.

**Vector requirement.** The `markdown-roundtrip` out-of-band sub-class
([conformance-vectors.md](./conformance-vectors.md):732-737) MUST include a
**foreign root** case: a root name no client knows, asserted to survive a decode
and full-state re-encode. That is what pins "including unnamed roots".

**Not roots.** Inline colours `MEMRYICO<n>:` / `:MEMRYICC;`
(`packages/shared/src/inline-colors.ts:74-76`), block markers
(`block-markers.ts:28`, `:62`; `block-colors.ts:11`, `:79`) and date mentions
(`date-mention.ts:32`, `:103`) are **in-fragment encodings** carried inside
`prosemirror`, with no preservation duty beyond the fragment itself. The outline's
fact 8 table conflates them with sibling roots; chapter 12 must split the two.

**Defect — `compactYDoc` drops unknown roots.** `compactYDoc` iterates
`doc.share` and copies only `Y.XmlFragment`, `Y.Map`, `Y.Array` and `Y.Text`;
anything else is logged and **skipped**
(`packages/sync-client/src/crdt-compact-utils.ts:14-30`). `initDocStructure` types
only `prosemirror`, `meta`, `tags` and `criticMarkupMarks`
(`crdt-provider.ts:1039-1044`), so `markdownSource` and the two `linkReference*`
roots are typed only once a seed or a `yDocToMarkdown` touches them. Compaction
fires via `setImmediate` when the encoded document passes 1 MiB with no editor open
(`:1387-1395`, threshold `:48`) and its output replaces both the pushed snapshot
and local persistence (`:1458`, `:1479-1486`), while write-back is debounced 500 ms
(`crdt-writeback.ts:69`). A document opened editor-less from persistence and
compacted before its first write-back drops those three roots **for every device**,
and any future root is dropped unconditionally. There is no test for
`compactYDoc`. Tracked as **#2181**.

**Open.** The `meta` map's key set: only `title` and `date` are ever written or
read, and nothing forbids others. Chapter 12 should say "two keys defined, others
reserved and MUST be preserved". Also cross-reference chapters 06 and 13 for the
unresolved two-writer case where the document's `tags` and the record payload's
`tags` disagree — write-back trusts the document (`crdt-writeback.ts:952`) and the
note handler trusts the record (`note-handler.ts:357-361`), with no tiebreak.

---

## Q13.2 — verbatim payload preservation

**Normative.** A conforming client MUST:

1. persist the decrypted payload bytes exactly as received;
2. treat every payload schema as a **reader over a copy**, never as the storage
   shape;
3. on a local edit, parse a copy, merge the changed keys into it, serialise that
   merged object with unknown keys intact, and push the result;
4. never re-serialise a projection row as the payload;
5. record a payload that fails its schema as corrupt or unapplied, rather than
   skipping it and advancing the cursor.

The platform-free engine already establishes 1 and 2: it decrypts to
`payloadJson: new TextDecoder().decode(content)`
(`packages/sync-client/src/pull/engine.ts:257-282`) and parses only a throwaway
copy for `fileType` (`:307-308`), with the contract stated at
`packages/sync-client/src/pull/store.ts:5-10`, `:17`. The Expo app obeys it:
raw string into `sync_items.payload`
(`apps/mobile/src/db/pull-store.ts:128-136`, `:163`), projections from a parsed
copy (`:207`), push of the whole stored object with only changed keys mutated
(`apps/mobile/src/sync/outbox.ts:66-71`).

**Defect — desktop violates this today.** `apply-item.ts:84-95` parses then runs
`handler.schema.parse(parsed)`; every handler schema is a plain `z.object`
(`packages/contracts/src/sync-payloads.ts` — no `passthrough`, `loose` or
`catchall` anywhere), and Zod strips unknown keys at every level. The parsed data
is projected into columns
(`apps/desktop/src/main/sync/item-handlers/task-handler.ts:272-288`) and pushed
back by re-serialising the projection row (`:373-378`); the verbatim string is
kept nowhere. `task-handler.ts:278-284` already documents exactly this loss for
`linkedCanvasIds`. Separately, an item whose payload fails `parse` is marked
`'skipped'` with the cursor advanced (`apply-item.ts:96-110`). Chapter 13 MUST
record desktop as the **non**-reference for this obligation. Tracked as **#2183**.

The wire envelope is a different matter and is harmless: `RecordPullItemResponseSchema`
(`engine.ts:209`) and `EncryptedItemPayloadSchema`
(`packages/contracts/src/sync-api.ts:311-316`) strip unknown **envelope** keys, not
payload keys, and the signature covers only the ten allowlisted keys.

**Core obligation.** Store `sync_items.payload` verbatim as `TEXT` or `BLOB`.
Project through `serde_json::Value` or `#[serde(flatten)] extra: Map<String,
Value>`. A plain `#[derive(Deserialize)]` struct reproduces desktop's bug exactly.
This is T104, T130 and T135.

---

## Errata against the outline

Fix these in `protocol-spec-outline.md` when the chapters are written; each is
wrong today and will propagate into a chapter if copied.

| outline location           | what is wrong                                        | correct                                                                   |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `:118-122`                 | "Memry adds no normalisation of its own"             | the renderer and mobile both normalise; see Q01.2                         |
| `:432-436`                 | the linking state machine omits `cancelled`          | `cancelled` is persisted; `expired` is computed                           |
| `:495-497` (fact 10)       | AAD is stated for the master key block only          | the two optional blocks each carry AAD; the master key block carries none |
| Q04.1 row                  | `crdt-encrypt.ts:38`                                 | `:35`                                                                     |
| Q04.8 row                  | `cbor.test.ts:67`                                    | `:68`                                                                     |
| Q05.3 row                  | `sync.ts:211-233`                                    | `:247-269`                                                                |
| Q12.2 answer, `:1804-1830` | "`seed-from-markdown` message", "the WebView"        | `doc-load.seedMarkdown`; "the editor bundle"                              |
| fact 2 table, `:1670-1685` | eight roots including `probe`; `meta` anchor         | seven roots; `meta` reader at `crdt-writeback.ts:684`                     |
| fact 8 table               | in-fragment encodings listed alongside sibling roots | split the two categories                                                  |

And in [../tasks.md](../tasks.md):

| task | what is wrong                                             | correct                                                              |
| ---- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| T039 | "correct the 168-byte figure in `docs/ideas/…plan.md:42`" | that file already says 160; `168` survives only in `tasks.md:101`    |
| T042 | "`seed-from-markdown`"                                    | `doc-load.seedMarkdown`; add the create-time `content` path          |
| T044 | "eight … Y.Doc roots"                                     | seven; add the full-state-encode rule                                |
| T064 | device-linking vectors                                    | must also cover `scanProof`, `scanConfirm`, `keyConfirm` and the SAS |
