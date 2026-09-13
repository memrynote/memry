# 03 — Device linking

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

Linking is how a device that has never seen the recovery phrase obtains the
account's master key. It is the path FR-020 and FR-021 depend on.

## 3.1 The five routes

**Normative** (`apps/sync-server/src/routes/linking.ts`, mounted at
`/auth/linking`, `apps/sync-server/src/index.ts:217`):

| Method | Path                               | Auth         | Caller                      | Line   |
| ------ | ---------------------------------- | ------------ | --------------------------- | ------ |
| POST   | `/auth/linking/initiate`           | access token | the already-unlocked device | `:82`  |
| POST   | `/auth/linking/scan`               | **none**     | the new device              | `:117` |
| GET    | `/auth/linking/session/:sessionId` | access token | the already-unlocked device | `:172` |
| POST   | `/auth/linking/approve`            | access token | the already-unlocked device | `:190` |
| POST   | `/auth/linking/complete`           | **none**     | the new device              | `:276` |

`scan` and `complete` are deliberately unauthenticated because the new device has
no session yet; the `linkingSecret` carried in the QR code is what authorises
them.

`sessionId` is validated as a **UUID** on the server
(`apps/sync-server/src/routes/linking.ts:51`, `:62`, `:77`) while the contract
only requires `min(1)` (`packages/contracts/src/linking-api.ts:20`, `:44`). **A
conforming client MUST treat it as a UUID.**

Rate limits are keyed by **`sessionId`, not by IP**
(`apps/sync-server/src/routes/linking.ts:30-45`), so a network change does not
affect the budget.

## 3.2 The state machine

**Normative.** `LINKING_SESSION_STATUSES` is
`pending → scanned → approved → completed`, with `expired`
(`packages/contracts/src/linking-api.ts:5-11`). `LINKING_INVALID_TRANSITION`
(409) is the answer to anything else
(`apps/sync-server/src/lib/errors.ts:24`).

**`expired` is computed, never persisted**: the predicate is
`expires_at < now` evaluated per request
(`apps/sync-server/src/services/linking.ts:100-107`).

**`cancelled` is a sixth, persisted status and it is missing from the contract.**
`initiate` cancels the caller's prior `pending` and `scanned` sessions with
`status = 'cancelled'` (`apps/sync-server/src/services/linking.ts:142-143`), but
`cancelled` appears in neither `LINKING_SESSION_STATUSES`
(`packages/contracts/src/linking-api.ts:5-11`) nor the Durable Object's
`SessionStatus` (`apps/sync-server/src/durable-objects/linking-session.ts:3`).
**A client that validates `GET /session/:id` against the contracts enum fails on
an ordinary response.** A conforming client MUST accept `cancelled` and treat it
as terminal. Tracked as **#2182**; the fix is additive and needs no migration.

## 3.3 `linkingSecret` — Q03.1

**Normative.** The server generates **32 CSPRNG bytes** and base64-encodes them
with the **standard** alphabet and padding, so the wire form is a 44-character
string carrying 256 bits of entropy
(`apps/sync-server/src/services/linking.ts:7`, `:134-137`). It is minted only by
`POST /auth/linking/initiate` (`apps/sync-server/src/routes/linking.ts:92-114`)
and embedded verbatim in the QR JSON
(`apps/desktop/src/main/sync/linking-service.ts:196-201`).

The server stores `linking_secret_hash = hex(SHA-256(utf8(base64 string)))`
(`apps/sync-server/src/services/linking.ts:49-52`, `:137`) and verifies by
re-hashing and constant-time comparing
(`apps/sync-server/src/services/linking.ts:171-172`).

**As an HMAC key, both sides use the decoded 32 raw bytes, not the string**
(`apps/sync-server/src/services/linking.ts:66-73`,
`apps/desktop/src/main/sync/linking-service.ts:127-134`).

**Core obligation.** Treat the value as opaque, echo it back byte-exact in
`POST /auth/linking/scan`, decode it with standard-alphabet base64 to obtain the
scan-channel HMAC key, and **reject a decoded length other than 32**. The server
schema is only `z.string().min(1)`
(`apps/sync-server/src/routes/linking.ts:54`), so the length check is the
client's.

**Disposition of Q03.1: answered** (this section).

## 3.4 Session TTL — Q03.3

**Normative.** **300 seconds**, server-chosen, absolute from `initiate`,
expressed as epoch **seconds**
(`apps/sync-server/src/services/linking.ts:6`, `:131-132`). Returned by
`initiate` (`apps/sync-server/src/routes/linking.ts:114`), stored in
`expires_at` (`apps/sync-server/src/services/linking.ts:149-160`), and mirrored
into the `LinkingSession` Durable Object whose alarm at `expiresAt * 1000`
deletes its storage
(`apps/sync-server/src/durable-objects/linking-session.ts:50`, `:85-87`).

**Neither `scan` nor `approve` extends it.** It covers the whole flow through
`complete`, and on desktop through the deferred vault picker
(`apps/desktop/src/main/sync/linking-service.ts:439`, `:561`).

Expiry is enforced by `assertNotExpired` on `scan`, `approve` and `complete`
(`apps/sync-server/src/services/linking.ts:103-107`, `:169`, `:252`, `:337`) with
the predicate `expires_at < now`, so **a request at exactly `expires_at` is still
accepted**. `GET /session/:sessionId` does **not** check expiry
(`apps/sync-server/src/routes/linking.ts:172-188`).

**Core obligation.** Use the server's `expiresAt`; do not hardcode 300. Desktop
polls `complete` every 3 s
(`apps/desktop/src/renderer/src/components/sync/linking-pending.tsx:7`) against a
30-requests-per-60-seconds per-session budget
(`apps/sync-server/src/routes/linking.ts:39-45`); a conforming client MUST stay
at or below that.

**Disposition of Q03.3: answered** (this section).

## 3.5 Key agreement

**Normative.** Raw X25519. `crypto_box_keypair()` for the ephemeral pair
(`apps/desktop/src/main/crypto/keys.ts:143-147`),
`crypto_scalarmult(mySecret, theirPublic)` for the shared secret, with explicit
32-byte length checks on both inputs
(`apps/desktop/src/main/crypto/keys.ts:155-162`).

**The raw scalarmult output is fed directly to the KDF.** There is no
`crypto_kx`, and the shared secret is not hashed first
(`apps/desktop/src/main/crypto/keys.ts:165-171`).

Three subkeys, 32 bytes each, from `crypto_kdf_derive_from_key` over the shared
secret (chapter 01 §1.2): encryption `memrylnk` id 5, MAC `memrymac` id 6, SAS
`memrysas` id 7 (`apps/desktop/src/main/crypto/keys.ts:165-171`).

## 3.6 The short verification code (SAS)

**Normative** (`apps/desktop/src/main/crypto/keys.ts:173-183`):

```
sasKey = crypto_kdf_derive_from_key(32, 7, "memrysas", sharedSecret)
h      = crypto_generichash(4, sasKey, key = null)        // BLAKE2b, 4 bytes
u32    = (h[0]<<24) | (h[1]<<16) | (h[2]<<8) | h[3]       // big-endian, unsigned
code   = u32 % 1_000_000, zero-padded to 6 decimal digits
```

It is **six decimal digits, not words**. Both sides compute it independently from
the raw scalarmult output
(`apps/desktop/src/main/sync/linking-service.ts:279`, `:781`).

**The modular bias MUST be reproduced, not corrected.** `2^32 mod 10^6 =
4_967_296`, so codes below that value are marginally more likely; the code
carries about 19.9 bits. A Rust implementation that substitutes rejection
sampling produces a **different code** and breaks linking against desktop.

## 3.7 Two MAC families — Q03.5

**Normative.** The split is real and follows one rule: **anything the server
verifies uses WebCrypto HMAC-SHA-256; anything only devices verify uses
libsodium `crypto_auth`, which is HMAC-SHA512-256.** Both produce 32-byte tags
compared in constant time (server
`apps/sync-server/src/services/otp.ts:42-48`, devices
`apps/desktop/src/main/crypto/index.ts:68-73`).

| Channel | Messages                                                                                                          | Key                                            | Algorithm                                                                                  | Verified by                                                                   |
| ------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| scan    | `scanProof` (`LINKING_PROOF` ordering), `scanConfirm` (`SCAN_CONFIRM` ordering)                                   | the **decoded 32-byte `linkingSecret`**        | WebCrypto HMAC-SHA-256 (`apps/desktop/src/main/sync/linking-service.ts:121-159`)           | the **server** (`apps/sync-server/src/services/linking.ts:60-98`, `:181-204`) |
| confirm | `newDeviceConfirm` (`LINKING_PROOF`), `keyConfirm` (`KEY_CONFIRM`), `providerAuthConfirm`, `vaultTransferConfirm` | `macKey = KDF(sharedSecret, "memrymac", id 6)` | libsodium `crypto_auth` = HMAC-SHA512-256 (`apps/desktop/src/main/crypto/keys.ts:189-229`) | **the peer device only**                                                      |

**`LINKING_PROOF` is used by both families**, over the same CBOR bytes, with
different keys and different algorithms, and both tags are posted in the same
`scan` body (`apps/desktop/src/main/sync/linking-service.ts:254`, `:256-261`).
This is the single most missable fact in the chapter.

CBOR orderings (`packages/contracts/src/cbor-ordering.ts:15-19`):

| Name                     | Fields                                               |
| ------------------------ | ---------------------------------------------------- |
| `LINKING_PROOF`          | `sessionId`, `devicePublicKey`                       |
| `SCAN_CONFIRM`           | `sessionId`, `initiatorPublicKey`, `devicePublicKey` |
| `KEY_CONFIRM`            | `sessionId`, `encryptedMasterKey`                    |
| `PROVIDER_AUTH_CONFIRM`  | `sessionId`, `encryptedProviderAuth`                 |
| `VAULT_TRANSFER_CONFIRM` | `sessionId`, `encryptedVaultTransfer`                |

**In every case the MAC'd value is the base64 _string_ of the ciphertext, not the
raw bytes** (`apps/desktop/src/main/crypto/keys.ts:198-205`). These lists are
allowlists, not byte orders; the encoder decides the order (chapter 04 §4.7).

**Why the split, inferred and not documented anywhere.** `git log -S
computeScanProof` lands in a single squash commit and no design document
mentions it. The evident cause is environmental: the sync server is a Cloudflare
Worker with no libsodium dependency, and `crypto.subtle` offers HMAC-SHA-256 but
not HMAC-SHA512-256. **This paragraph is inference, not a cited fact**; the
citations above establish only that the split exists.

**Core obligation.** Two MAC primitives are required and MUST NOT be unified.
For the confirm channel, `crypto_auth` is HMAC with **SHA-512 truncated to 32
bytes**, which is **not** SHA-512/256 — that uses a different IV. A Rust
implementation that reaches for a SHA-512/256 crate produces wrong tags.

**Disposition of Q03.5: answered** (this section).

## 3.8 The QR payload

**Normative.** `JSON.stringify({ sessionId, ephemeralPublicKey, linkingSecret,
expiresAt })` (`apps/desktop/src/main/sync/linking-service.ts:196-201`).
`expiresAt` is epoch **seconds**, and the scanner refuses an expired session
**before doing any crypto**
(`apps/desktop/src/main/sync/linking-service.ts:112`, `:236`).

## 3.9 Ordering is mandatory on both sides

**Normative.**

- The approving device verifies `newDeviceConfirm` **before it touches the master
  key** (`apps/desktop/src/main/sync/linking-service.ts:668-673`).
- The new device verifies `keyConfirm` **before it decrypts the master key**
  (`apps/desktop/src/main/sync/linking-service.ts:348-355`).

Comparisons are constant time
(`apps/desktop/src/main/crypto/index.ts:68-73`). A failure MUST wipe the shared
secret and both subkeys and clear the pending session.

The master key is transported as XChaCha20-Poly1305 under the linking encryption
key with **no associated data**
(`apps/desktop/src/main/crypto/encryption.ts:113-118`), as `encryptedMasterKey`
plus `encryptedKeyNonce`, both standard base64.

`POST /auth/linking/complete` is polled with
`{ maxRetries: 3, baseDelayMs: 2000, retryOn429: false }`, because the poll
cadence is itself the retry
(`apps/desktop/src/main/sync/linking-service.ts:333`).

After completion the new device fetches `GET /auth/recovery-info` and registers
with `skipSetup`, so it never re-posts `kdfSalt` or `keyVerifier`
(`apps/desktop/src/main/sync/linking-service.ts:492-512`; chapter 02 §2.8).

## 3.10 The two optional encrypted blocks — Q03.4

**Normative.** Both blocks travel through the server as opaque base64. The
server stores them only when all four of that block's fields are present
(`apps/sync-server/src/routes/linking.ts:220-241`) and returns them on
`complete` (`apps/sync-server/src/routes/linking.ts:296-309`). Both version
fields are `z.literal(1)` (`packages/contracts/src/linking-api.ts:3`, `:36`,
`:40`).

| Block                    | Plaintext                                                                                                                                         | AAD                                                              | MAC                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| master key               | the 32-byte master key                                                                                                                            | **none** (`apps/desktop/src/main/crypto/encryption.ts:113-118`)  | `KEY_CONFIRM`                                                            |
| `encryptedProviderAuth`  | `{version:1, providers:[{provider:'google', accountId, refreshToken}]}` (`apps/desktop/src/main/calendar/google/provider-auth-transfer.ts:11-20`) | `google-provider-auth-transfer-v1:<sessionId>` (`:10`, `:38-39`) | `PROVIDER_AUTH_CONFIRM` over `(sessionId, base64 ciphertext)` (`:79-81`) |
| `encryptedVaultTransfer` | `{version:1, vaults:[{vaultUuid, itemCount?, createdAt?}]}` (`apps/desktop/src/main/sync/vault-transfer.ts:8-20`)                                 | `vault-transfer-v1:<sessionId>` (`:9`, `:37-38`)                 | `VAULT_TRANSFER_CONFIRM` (`:76-78`)                                      |

**The AAD asymmetry is real**: the master key block carries **no** AAD; the two
optional blocks each carry one. All three rows MUST be implemented as written.

**Consumption rules**, from the desktop receiver
(`apps/desktop/src/main/sync/linking-service.ts:371-425`):

- **Provider auth is soft-fail.** Present and undecryptable: warn and continue
  (`:387-394`). Absent: nothing happens. **A client MAY ignore the block
  entirely**; the only effect is that Google Calendar is not pre-connected. The
  refresh tokens transited the server as ciphertext either way, so ignoring them
  costs nothing.
- **Vault transfer is hard-fail.** Present and failing its MAC or its decrypt:
  the link MUST fail and the session state MUST be cleared (`:414-424`). Absent:
  the client proceeds with an empty vault list (`:427`). Desktop auto-adopts a
  single vault and shows a picker for two or more (`:428-454`).

**Core obligation.** Implement vault-transfer verify-and-decrypt; it is what
FR-021's first-vault default is built on. Provider auth is optional. Note the
vault list is a copy of `GET /sync/vaults`
(`apps/desktop/src/main/sync/linking-service.ts:702-707`), so a client MAY fetch
it after registration instead; the one thing the transfer adds is the
initiator's **current** vault as the first entry when the server list is empty
(`apps/desktop/src/main/sync/vault-transfer.ts:41-46`).

The "scans while already linked" case is **not** here: it lives in
`LINKING_CONCURRENT_ATTEMPT` on `complete`
(`apps/sync-server/src/services/linking.ts:366-372`) and in `initiate`
cancelling prior sessions (`:142-143`).

**Disposition of Q03.4: answered** (this section).

## 3.11 `LINKING_IP_MISMATCH` — Q03.2

### 3.11.1 Current behaviour

The scanner's IP is recorded on `POST /auth/linking/scan` from
`cf-connecting-ip` (`apps/sync-server/src/routes/linking.ts:126`,
`apps/sync-server/src/services/linking.ts:209`) and enforced **only** on
`POST /auth/linking/complete`: reject `403 LINKING_IP_MISMATCH` when
`scanner_ip && callerIp && scanner_ip !== callerIp`
(`apps/sync-server/src/services/linking.ts:339-345`). `initiate`,
`session/:sessionId` and `approve` are **not** IP-bound; they are access-token
authenticated.

The check is skipped when either side is null, so it is inert in local
development where `cf-connecting-ip` is absent. It runs **before** the status
transition (`apps/sync-server/src/services/linking.ts:337-339` precedes `:348`),
so a rejected `complete` does not consume the approved session.

**Why this matters for FR-020.** A phone that scans on Wi-Fi and polls
`complete` on cellular receives 403 on every poll. The desktop poll loop treats
any non-409, non-429 error as terminal, clears the pending completion and zeroes
`encKey` and `macKey`
(`apps/desktop/src/main/sync/linking-service.ts:468-481`), and the renderer stops
polling
(`apps/desktop/src/renderer/src/components/sync/linking-pending.tsx:62-66`, `:73-75`).
Recovery is a full restart from a new QR. Phones change interface far more often
than desktops do, and CGNAT or IPv6 privacy rotation changes the IP with no
interface change at all.

### 3.11.2 The rule this specification states

**Decision, 2026-09-13 — the binding is relaxed. This is the normative rule.**
Enforcement is removed from `complete`; `scanner_ip` continues to be recorded for
audit. A conforming server MUST NOT reject `complete` on an IP change. The
rationale: the 256-bit `linkingSecret` is QR-only, and the X25519 `keyConfirm`
MAC already binds `complete` to the scanner, so an attacker who reaches
`complete` without the shared secret receives a ciphertext they cannot open. The
check was defence-in-depth worth a few bits against a real, recurring FR-020
failure.

Change site `apps/sync-server/src/services/linking.ts:339-345` and its test
`apps/sync-server/src/services/linking.test.ts:961-984`. Tracked as **#2184**.
**This chapter states the relaxed rule; §3.11.1 records the historical
behaviour.**

### 3.11.3 Client obligation until the relaxation ships

**Normative.** On `LINKING_IP_MISMATCH` a client MUST zero the linking subkeys
and MUST NOT retry. It SHOULD watch for a network path change between `scan` and
`complete` and prompt the user to rescan rather than burning polls.

**Disposition of Q03.2: answered (decision: relax the binding, #2184).**

## 3.12 Linking error codes

**Normative** (`apps/sync-server/src/lib/errors.ts:22-28`; statuses from chapter
00 §0.5):

| Code                         | Status | Meaning to the user                                    |
| ---------------------------- | ------ | ------------------------------------------------------ |
| `LINKING_SESSION_NOT_FOUND`  | 404    | the QR is not for this account, or the session is gone |
| `LINKING_SESSION_EXPIRED`    | 410    | the 300 s window elapsed; start again from a new QR    |
| `LINKING_INVALID_TRANSITION` | 409    | the call arrived out of order; keep polling or restart |
| `LINKING_DUPLICATE_SESSION`  | —      | declared, no throw site with an explicit status        |
| `LINKING_CONCURRENT_ATTEMPT` | 409    | another device is mid-link on this account             |
| `LINKING_SECRET_INVALID`     | 403    | wrong `linkingSecret`, or a scan-channel MAC failed    |
| `LINKING_IP_MISMATCH`        | 403    | historical only; see §3.11 and #2184                   |
