# Contract: Outline of `docs/protocol/`

**Feature**: 002-native-foundation-ios | **Date**: 2026-09-12 | **Spec**: [spec.md](../spec.md)

This is the chapter plan for the written protocol specification required by FR-001
through FR-004. It is not the specification. It says what each chapter is called,
which source files it is derived from, which facts it must state normatively, and
which questions the spec author has to answer before the chapter can be called
done.

Rules the spec author inherits:

- `packages/contracts` is the schema source of truth (spec.md Assumptions). Where a
  chapter and a contract disagree, the chapter is wrong until amended.
- Every normative fact carries a `path:line` citation to the implementation it was
  read from, so a later reader can check it and a later change can find it.
- Where this outline says a fact was not verified, the spec author must verify it
  rather than copy the uncertainty forward.
- Facts below were read on 2026-09-12 against the working tree at commit
  `5c7d0027f`. Line numbers drift; the surrounding identifier is the durable part.

Chapter files live at `docs/protocol/<nn>-<slug>.md`. Fifteen chapters, `00`
through `14`.

---

## 00-overview-and-versioning.md

### Derived from

| Source | What it supplies |
|---|---|
| `packages/contracts/src/crypto.ts:13-14` | `CryptoVersion`, `CRYPTO_VERSION` |
| `packages/contracts/src/pack-format.ts:58-60` | `PACK_MAGIC`, `PACK_VERSION` |
| `packages/contracts/src/webview-bridge.ts:22` | `BRIDGE_PROTOCOL_VERSION` |
| `packages/contracts/src/linking-api.ts:3` | `ProviderAuthVersionSchema` |
| `apps/sync-server/src/index.ts:216-226` | route mount table |
| `apps/sync-server/src/lib/errors.ts:10-96` | the complete error code enum |
| `packages/sync-client/src/pull/http.ts:98-121` | how a client reads an error body |

### Normative facts this chapter must state

1. There are five independent version numbers and they do not move together.
   `CRYPTO_VERSION = 1` (typed `1 | 2`, so a v2 is anticipated but does not exist),
   `PACK_VERSION = 1`, `BRIDGE_PROTOCOL_VERSION = 1`, the linking
   `providerAuthVersion` / `vaultTransferVersion` literal `1`, and the signature
   payload shape named "v1" in `SignaturePayloadV1Schema`
   (`packages/contracts/src/crypto.ts:205-222`).
2. Crypto version handling on read: `cryptoVersion < 1` is "invalid", any value
   other than `1` is "not supported, update the app". Both are hard errors, not
   skips (`packages/sync-client/src/pull/record-decrypt.ts:50-55`).
3. Pack version handling: a reader rejects any pack whose header byte 4 or footer
   version byte is not `PACK_VERSION`
   (`packages/contracts/src/pack-format.ts:222-223`, `:232`).
4. The route tree, verbatim from `apps/sync-server/src/index.ts:216-226`:
   `/auth`, `/auth/linking`, `/devices`, `/sync` (two routers mounted on the same
   prefix: the sync router and the blob router), `/sync/bootstrap`, `/telemetry`,
   `/diagnostics`, `/feedback`, `/webhooks`, `/calendar/channels`. Inside the sync
   router, `/records` and `/crdt` are sub-mounts
   (`apps/sync-server/src/routes/sync.ts:557`, `:1146`), and the record handlers are
   mounted twice, once under `/sync/records/*` and once directly under `/sync/*`
   (`apps/sync-server/src/routes/sync.ts:549-565`).
5. The error envelope is `{ "error": { "code": string, "message": string, ... } }`.
   A client must also tolerate `{ "error": string }`, because
   `packages/sync-client/src/pull/http.ts:107-114` handles both shapes and some
   routes emit the bare string form (for example
   `apps/sync-server/src/routes/sync.ts:94`, `:99`).
6. The full `ErrorCodes` table (`apps/sync-server/src/lib/errors.ts:10-96`) with each
   code's HTTP status, reproduced as a table so an implementer can switch on codes
   without reading the server.
7. Transport defaults a conforming client must adopt: JSON over HTTPS, `Accept:
   application/json`, a 60 second per-request ceiling
   (`packages/sync-client/src/pull/http.ts:39`), and `429` carrying `retry-after`
   read in lowercase (`packages/sync-client/src/pull/http.ts:98-100`).
8. The 25 member `SYNC_ITEM_TYPES` list (`packages/contracts/src/sync-api.ts:7-34`)
   and its four subsets: `RECORD_SYNC_ITEM_TYPES` (25),
   `RECORD_CLOCK_REQUIRED_ITEM_TYPES` (24, `settings` excluded),
   `LEGACY_RECORD_SYNC_ITEM_TYPES` (15, frozen), `CRDT_SYNC_ITEM_TYPES` (1),
   `ENCRYPTABLE_ITEM_TYPES` (25, `attachment` excluded).

### Open questions

- **Q00.1** `CryptoVersion` is `1 | 2` but no v2 exists anywhere in the tree. Does
  the chapter declare v2 reserved, or delete the union? A Rust enum that accepts 2
  and then fails at use is worse than one that rejects it at parse.
- **Q00.2** The record handlers are mounted at two prefixes. Which is canonical for
  a new client, `/sync/push` or `/sync/records/push`? The shipped TypeScript client
  uses the unprefixed form (`packages/sync-client/src/pull/engine.ts:158`, `:191`).
  The chapter must name one and say the other is legacy.
- **Q00.3** There is no negotiated protocol version on the wire at all. Version
  skew is handled entirely by the client header floor (chapter 11) and by
  per-format version bytes. State that explicitly so no implementer looks for a
  handshake that does not exist.

---

## 01-identity-and-keys.md

### Derived from

| Source | What it supplies |
|---|---|
| `apps/desktop/src/main/crypto/recovery.ts:11-55` | recovery phrase, seed, verifier comparison |
| `apps/desktop/src/main/crypto/keys.ts:19-183` | KDF map, Argon2id call, device id, signing key, linking keys |
| `apps/desktop/src/main/crypto/vault-key-state.ts:14-26` | the local vault key verifier |
| `packages/contracts/src/crypto.ts:20-76` | context constants, algorithm params, keychain entries |
| `apps/desktop/src/main/lib/id.ts:13-49` | note, journal, general id formats |
| `apps/desktop/src/main/crypto/keychain-account.ts:17-32` | keychain account suffixing |

### Normative facts this chapter must state

1. The key chain, in order, with the exact libsodium call at each step:

   | Step | Input | Function | Parameters | Output |
   |---|---|---|---|---|
   | Phrase to seed | 24 word BIP39 mnemonic | `bip39.mnemonicToSeed` (`recovery.ts:12`) | PBKDF2-HMAC-SHA512, 2048 iterations, salt is the ASCII string `mnemonic` with no passphrase appended | 64 bytes |
   | Seed to master key | 64 byte seed | `crypto_pwhash` (`keys.ts:49`) | `ALG_ARGON2ID13`, opslimit 3, memlimit 67108864, 16 byte salt | 32 bytes |
   | Master key to subkey | 32 byte master key | `crypto_kdf_derive_from_key` (`keys.ts:40`) | see the context table below | 32 bytes |

2. The KDF context table, verbatim from `apps/desktop/src/main/crypto/keys.ts:19-27`.
   Note the two level naming: the logical context string is a lookup key, and the
   eight byte value fed to libsodium is the `ctx` column.

   | Logical context | libsodium `ctx` | subkey id | length | Used for |
   |---|---|---|---|---|
   | `memry-vault-key-v1` | `memryvlt` | 1 | 32 | vault key |
   | `memry-signing-key-v1` | `memrysgn` | 2 | 32 | no caller found |
   | `memry-verify-key-v1` | `memryvrf` | 3 | 32 | no caller found |
   | `memry-key-verifier-v1` | `memrykve` | 4 | 32 | account key verifier |
   | `memry-linking-enc-v1` | `memrylnk` | 5 | 32 | linking transport key |
   | `memry-linking-mac-v1` | `memrymac` | 6 | 32 | linking MAC key |
   | `memry-linking-sas-v1` | `memrysas` | 7 | 32 | short verification code |

   The same seven rows are hard coded a second time in
   `packages/contracts/scripts/gen-crypto-vectors.ts:28-34` and committed as vectors
   in `packages/contracts/test-vectors/crypto-vectors.json` under
   `kdfDeriveFromKey`. `packages/contracts/src/crypto.ts:20-23` only names two of the
   seven, and `packages/contracts/src/crypto.ts:55-59` names three more.

3. BIP39 specifics: `bip39@3.1.0`, `generateMnemonic(256)` so 256 bits of entropy
   and 24 English words (`recovery.ts:11`); checksum is `ENT/32 = 8` bits taken from
   the leading bits of `sha256(entropy)`; normalisation is NFKD only, with no case
   folding and no whitespace collapsing, and the split is on a single ASCII space.
   Memry adds no normalisation of its own; the IPC schema is only
   `z.string().min(1)` (`packages/contracts/src/ipc-devices.ts:167-169`).

4. Argon2id parallelism is never passed. libsodium's `crypto_pwhash` uses
   parallelism 1 internally, and that is the canonical value for this protocol
   (`packages/contracts/src/crypto.ts:25-27`).

5. `kdfSalt` is 16 random bytes (`keys.ts:119-121`) transported as base64 with the
   standard alphabet and padding (`sodium.base64_variants.ORIGINAL`, `keys.ts:65`).

6. There are two distinct verifiers and the chapter must keep them apart:
   - **Account key verifier**, server visible. It is literally
     `base64(crypto_kdf_derive_from_key(32, 4, 'memrykve', masterKey))`, with no hash
     wrapper (`keys.ts:110-117`). Served by `GET /auth/recovery-info` and
     `GET /auth/key-verifier`. Compared constant time over the base64 strings
     re-encoded as UTF-8, not over the decoded bytes (`recovery.ts:48-55`).
   - **Local vault key verifier**, never leaves the device. Keyed BLAKE2b-256 with
     the vault key as the key and the message
     `memry/vault-key-verifier/v1/<vaultId>`, base64 encoded, stored in the local
     settings table under `vault.crypto.verifier.v1`
     (`apps/desktop/src/main/crypto/vault-key-state.ts:14-26`, `:194-202`).

7. Device identity has two forms:
   - Locally derived: `to_hex(crypto_generichash(16, ed25519PublicKey, null))`,
     32 lowercase hex characters (`keys.ts:81`). Pinned as `ed25519.deviceIdHex` in
     `packages/contracts/test-vectors/crypto-vectors.json`.
   - Server assigned: the `deviceId` returned by `POST /auth/devices`, which is what
     goes on the wire as `signerDeviceId`
     (`apps/desktop/src/main/sync/device-registration.ts:84`, `:189`).
   The chapter must say which one a conforming client stores and sends. The answer
   from the implementation is the server assigned one.

8. The device signing key is a **random** Ed25519 pair from `crypto_sign_keypair()`
   (`keys.ts:80`), not derived from the master key or the seed. Lengths from
   `packages/contracts/src/crypto.ts:40-45`: seed 32, public 32, secret 64,
   signature 64. The public key travels as base64 in `authPublicKey`.

9. Secret storage is the five `KEYCHAIN_ENTRIES`
   (`packages/contracts/src/crypto.ts:70-76`), all under service `com.memry.sync`
   with accounts `master-key`, `device-signing-key`, `access-token`,
   `refresh-token`, `setup-token`. Values are stored as base64 strings; tokens are
   UTF-8 encoded first (`apps/desktop/src/main/sync/token-manager.ts:49-63`). Desktop
   appends a `-<device>` suffix in development
   (`apps/desktop/src/main/crypto/keychain-account.ts:26-32`); that suffix is a
   development affordance and is not part of the protocol.

10. Identifier formats (`apps/desktop/src/main/lib/id.ts:13-49`):

    | Kind | Format | Validator |
    |---|---|---|
    | Note id | 12 characters from `0-9a-z` | `/^[0-9a-z]{12}$/` |
    | Journal id | `j` followed by `YYYY-MM-DD` | `/^j\d{4}-\d{2}-\d{2}$/` |
    | General id (tasks, projects, ...) | 21 character nanoid | `/^[A-Za-z0-9_-]{21}$/` |

    The server is looser: `NoteIdSchema` is `/^[a-zA-Z0-9_-]+$/` capped at 128
    characters (`apps/sync-server/src/routes/sync.ts:571-574`). Journal ids are the
    only deterministically generated ids in the product, which is why a legacy CRDT
    store can hold one journal document per day merged across vaults
    (`apps/desktop/src/main/sync/crdt-legacy-partition.ts:19-32`).

### Open questions

- **Q01.1** `memry-signing-key-v1` (id 2) and `memry-verify-key-v1` (id 3) have no
  caller anywhere in the tree, yet they occupy subkey ids and are committed as
  vectors. Are they reserved, dead, or used by something not read? A Rust core that
  omits them is fine today and wrong the moment someone uses id 2 for something
  else.
- **Q01.2** Recovery phrase entry is unnormalised. Two devices that disagree on
  whitespace or case produce different seeds and therefore different master keys.
  Does the chapter mandate a normalisation (trim, collapse internal whitespace,
  lowercase) that both implementations apply before `mnemonicToSeed`, and if so
  does that change behaviour for any phrase a user already has? FR-027 and the
  spec's "right words in the wrong order" edge case both live here.
- **Q01.3** The chapter must state whether a phone stores the master key, the vault
  key, or both. Desktop stores the master key in the keychain and derives the vault
  key on demand (`keys.ts:123-137`); `specs/001-mobile-app/data-model.md:76` says
  mobile stored the unwrapped vault key. These are different threat models.
- **Q01.4** Multi vault: the master key is per account, the vault key is derived
  from it with a fixed context and no vault id mixed in (`keys.ts:129`). So every
  vault on an account shares one vault key, and vault separation is by `vaultId`
  routing only, not by key. Confirm and state, because FR-021 depends on it.

---

## 02-auth-and-sessions.md

### Derived from

| Source | What it supplies |
|---|---|
| `apps/sync-server/src/routes/auth.ts:234-1015` | every auth route |
| `packages/contracts/src/auth-api.ts` | request and response schemas |
| `apps/sync-server/src/lib/jwt-verify.ts:5-47` | token claims and verification |
| `apps/desktop/src/main/sync/token-manager.ts:14-237` | client side token lifecycle |
| `apps/desktop/src/main/sync/device-registration.ts:51-236` | registration and challenge |

### Normative facts this chapter must state

1. The route table, with method, path, auth requirement, and body schema:

   | Method | Path | Auth | Body / response |
   |---|---|---|---|
   | POST | `/auth/otp/request` | none, IP rate limited | `RequestOtpRequestSchema` / `RequestOtpResponseSchema` |
   | POST | `/auth/otp/resend` | none, IP rate limited | `ResendOtpRequestSchema` |
   | POST | `/auth/otp/verify` | none, IP rate limited | `VerifyOtpRequestSchema` / `VerifyOtpResponseSchema` |
   | GET | `/auth/oauth/:provider` | none | redirect to provider |
   | POST | `/auth/oauth/:provider/callback` | none | `OAuthCallbackSchema` / `OAuthCallbackResponseSchema` |
   | POST | `/auth/oauth/:provider/native` | none | `NativeOAuthSchema` |
   | POST | `/auth/setup-token/renew` | proof of device key | `RenewSetupTokenRequestSchema` / `RenewSetupTokenResponseSchema` |
   | POST | `/auth/devices` | setup token | `DeviceRegisterRequestSchema` / `DeviceRegisterResponseSchema` |
   | GET | `/auth/recovery-info` | setup token | `RecoveryDataResponseSchema` |
   | GET | `/auth/key-verifier` | access token | `RecoveryDataResponseSchema` |
   | GET | `/auth/recovery` | none, IP rate limited | `RecoveryDataResponseSchema` |
   | POST | `/auth/setup` | access token | `FirstDeviceSetupRequestSchema` |
   | GET | `/auth/devices` | access token | device list |
   | POST | `/auth/refresh` | refresh token in body | `RefreshTokenRequestSchema` / `RefreshTokenResponseSchema` |
   | POST | `/auth/logout` | access token | |
   | POST | `/auth/logout-all` | access token | |
   | POST | `/auth/email/change` | access token | `EmailChangeRequestSchema` |
   | POST | `/auth/email/change/verify` | access token | `EmailChangeVerifySchema` |
   | DELETE | `/auth/account` | access token | `DeleteAccountRequestSchema` |
   | GET/POST | `/auth/checkout-token`, `/auth/billing*` | access token | out of scope for this feature |

   Line anchors: `apps/sync-server/src/routes/auth.ts:234, 239, 272, 316, 353, 435,
   508, 560, 681, 703, 746, 771, 805, 881, 925, 952, 982, 1000, 1015`.

2. Access tokens are JWTs signed with **EdDSA** (Ed25519). Required claims:
   `iss = "memry-sync"`, `aud = "memry-client"`, `type = "access"`, `sub` is the
   user id, `device_id` is the device id, plus `exp`. Any other algorithm, issuer,
   audience, or `type` is rejected (`apps/sync-server/src/lib/jwt-verify.ts:5-47`).
   Setup tokens additionally carry `jti`, which the client reads back out
   (`apps/desktop/src/main/sync/token-manager.ts:65-69`).

3. Device registration challenge. The nonce is **client generated**
   (`crypto.randomUUID()`, `device-registration.ts:61`), not server issued. The
   signed bytes are the UTF-8 encoding of `` `${challengeNonce}:${jti}` `` where
   `jti` is the setup token's `jti` claim (`device-registration.ts:63-64`, server
   side `apps/sync-server/src/routes/auth.ts:620`). There is no domain separation
   prefix and no CBOR. The signature is Ed25519 detached, base64 with the standard
   alphabet.

4. Setup tokens are single use. `POST /auth/devices` inserts the `jti` into
   `consumed_setup_tokens` with `INSERT OR IGNORE`, and a zero row count means the
   token was already spent, answered `401 AUTH_INVALID_TOKEN`
   (`apps/sync-server/src/routes/auth.ts:570-578`). Their record expires 300 seconds
   after consumption (`:573`).

5. A user may hold at most 50 active devices; the 51st registration is
   `409 VALIDATION_ERROR` (`apps/sync-server/src/routes/auth.ts:586-593`).

6. `POST /auth/devices` request fields (`packages/contracts/src/auth-api.ts:22-32`):
   `name` (1 to 255), `platform` in `macos | windows | linux | ios | android | web`,
   `osVersion?`, `appVersion`, `authPublicKey`, `challengeSignature`,
   `challengeNonce`, `sessionNonce?`, `vaultId?` (max 128, defaults to `default`).
   The server sanitises `name`, `platform` and `vaultId` and rejects empties
   (`apps/sync-server/src/routes/auth.ts:607-613`), and enforces
   `sessionNonce` equality against the token's claim when the token carries one
   (`:616-618`).

7. Google native sign in exists specifically for the phone: `NativeOAuthSchema`
   takes an `idToken` of at most 4096 characters, with no authorization code and no
   redirect URI, because iOS has no loopback for the desktop flow
   (`packages/contracts/src/auth-api.ts:50-61`).

8. `devicePublicKey` may be committed at OTP verify or OAuth callback time
   (`packages/contracts/src/auth-api.ts:15`, `:47`, `:60`). Committing it is what
   makes `POST /auth/setup-token/renew` possible: renewal is authorised by proof of
   possession of the committed key, not by possession of the expired token
   (`packages/contracts/src/auth-api.ts:63-72`). Omitting it yields one
   non-renewable five minute token.

9. `GET /auth/recovery-info` (setup token) and `GET /auth/key-verifier` (access
   token) return the identical `{ kdfSalt, keyVerifier }` payload for two different
   session states (`apps/sync-server/src/routes/auth.ts:681-745`).
   `GET /auth/recovery` is the unauthenticated variant and returns deterministic
   **dummy** salt and verifier for an unknown email so the endpoint cannot be used
   to enumerate accounts (`apps/sync-server/src/routes/auth.ts:787-800`). A client
   that cannot distinguish real from dummy will fail unlock rather than error, and
   the chapter must say so.

10. Client side token lifecycle
    (`apps/desktop/src/main/sync/token-manager.ts:14-237`):

    | Constant | Value | Meaning |
    |---|---|---|
    | `ACCESS_TOKEN_EXPIRY_SECONDS` | 900 | assumed lifetime when the server does not say |
    | `EXPIRY_SAFETY_MARGIN_SECONDS` | 60 | a token within 60s of `exp` counts as expired |
    | refresh schedule | `floor(expiresIn * (0.5 + rand*0.2))` seconds | proactive refresh between 50% and 70% of life |
    | `REFRESH_MAX_RETRIES` | 3 | non-401 failures |
    | `REFRESH_BACKOFF_BASE_MS` | 1000 | `base * 2^attempt` |
    | `FALLBACK_RETRY_THRESHOLD_S` | 60 | one late retry if this much life remains |
    | `REFRESH_REJECT_TERMINAL_ATTEMPTS` | 3 | after three 401s, refresh is permanently blocked |
    | `REFRESH_REJECT_BACKOFF_MS` | `[60_000, 300_000]` | backoff after the first and second 401 |

    A 401 on refresh is never retried inline. Refresh is single flighted across
    concurrent callers (`:216-223`).

11. `POST /auth/setup` carries `{ kdfSalt, keyVerifier }`
    (`packages/contracts/src/auth-api.ts:34-37`), is a one-time write answered `409`
    if already done (`apps/sync-server/src/routes/auth.ts:792`), and is skipped on
    the linking path (`apps/desktop/src/main/sync/linking-service.ts:492-512`).

12. **Server side lifetimes and ceilings**, which a client must schedule against
    rather than guess:

    | Constant | Value | Source |
    |---|---|---|
    | `OTP_LENGTH` | 6 | `apps/sync-server/src/services/otp.ts:3-7` |
    | `OTP_EXPIRY_SECONDS` | 600 | same |
    | OTP `MAX_ATTEMPTS` | 5 | same |
    | OTP `MAX_EMAIL_REQUESTS` / window | 3 per 600 s | same |
    | `ACCESS_TOKEN_EXPIRY` | `15m` | `apps/sync-server/src/services/auth.ts:8` |
    | `REFRESH_TOKEN_EXPIRY` | `7d` | `apps/sync-server/src/services/auth.ts:9` |
    | `SETUP_TOKEN_EXPIRY` | `5m` | `apps/sync-server/src/services/auth.ts:217` |
    | `SETUP_TOKEN_RENEWAL_WINDOW_SECONDS` | 86400 | `apps/sync-server/src/services/auth.ts:231` |
    | `ROTATION_GRACE_SECONDS` | 10 | `apps/sync-server/src/services/auth.ts:79` |
    | `MAX_ROTATION_ATTEMPTS` | 3 | `apps/sync-server/src/services/auth.ts:80` |
    | `MAX_DEVICES_PER_USER` | 50 | `apps/sync-server/src/routes/auth.ts:586` |
    | `OAUTH_STATE_EXPIRY` | `5m` | `apps/sync-server/src/routes/auth.ts:171` |

    OTP codes are stored as a hex HMAC-SHA256 under `OTP_HMAC_KEY` and compared with
    `timingSafeEqual`; storing a new code marks every prior unused code for that
    email as used (`apps/sync-server/src/services/otp.ts:26-58`).

13. **Refresh tokens rotate on every use and reuse is a security event.** Rows are
    stored as a hex SHA-256 of the token. A refresh token presented outside the 10
    second rotation grace, and not matching a known row, **revokes every token for
    that device** before answering `401 AUTH_INVALID_TOKEN`
    (`apps/sync-server/src/services/auth.ts:186-204`). A client that retries a
    refresh naively will lock itself out, which is exactly why the client side
    treats a 401 on refresh as terminal after three attempts (fact 10).

14. **JWT clock tolerance is zero** on every normal path: `jwt-verify.ts` passes no
    `clockTolerance` and `jose` defaults to 0
    (`apps/sync-server/src/lib/jwt-verify.ts:30-34`). The single exception is setup
    token **renewal**, which passes `clockTolerance: 86400` and then bounds the
    result with the signed `renewable_until` claim
    (`apps/sync-server/src/services/auth.ts:290`, `:310`). A phone with a skewed
    clock therefore fails every request, and the chapter must say so because
    "the device clock is wrong" is one of the spec's edge cases.

15. **Two platform enumerations exist and they are not the same list.**
    `DeviceRegisterRequestSchema.platform` is
    `macos | windows | linux | ios | android | web`
    (`packages/contracts/src/auth-api.ts:24`), while `CLIENT_PLATFORMS` for the write
    gate is `ios | android | desktop`
    (`packages/contracts/src/sync-api.ts:263`). A device registers as `ios` and
    identifies itself as `ios`, so they coincide for the phone, but the chapter must
    not present them as one enum.

### Open questions

- **Q02.1** `sessionNonce` appears on four request schemas and is optional
  everywhere. The server enforces equality only when the token carries one
  (`apps/sync-server/src/routes/auth.ts:615-618`). What generates it, what attack
  does it stop, and is a phone required to send it? Answer before a Rust client
  omits it and loses a defence nobody documented.
- **Q02.2** The device registration challenge signs `nonce:jti` with no domain
  separation. Nothing stops that string from colliding with another signing context
  for the same key, which is the same key used for record signatures. Is that
  acceptable, or does the chapter mandate a prefix for future versions? Record it
  either way.
- **Q02.3** `GET /auth/recovery` returning plausible dummy data means an incorrect
  email and an incorrect phrase are indistinguishable to the client. FR-027 wants a
  clear error. State what the client is allowed to say.

---

## 03-device-linking.md

### Derived from

| Source | What it supplies |
|---|---|
| `apps/sync-server/src/routes/linking.ts:82-276` | the five routes |
| `packages/contracts/src/linking-api.ts` | request and response schemas, statuses |
| `apps/desktop/src/main/crypto/keys.ts:143-229` | X25519, KDF, SAS, MACs |
| `apps/desktop/src/main/sync/linking-service.ts:63-512, 654-732` | the flow and its ordering |
| `packages/contracts/src/cbor-ordering.ts:15-19` | the four confirm orderings |

### Normative facts this chapter must state

1. The five routes and their auth (`apps/sync-server/src/routes/linking.ts`):

   | Method | Path | Auth | Who calls it |
   |---|---|---|---|
   | POST | `/auth/linking/initiate` | access token | the already unlocked device |
   | POST | `/auth/linking/scan` | none | the new device |
   | GET | `/auth/linking/session/:sessionId` | access token | the already unlocked device |
   | POST | `/auth/linking/approve` | access token | the already unlocked device |
   | POST | `/auth/linking/complete` | none | the new device |

   Lines `:82`, `:117`, `:172`, `:190`, `:276`. `scan` and `complete` are
   deliberately unauthenticated because the new device has no session yet; the
   `linkingSecret` from the QR code is what authorises them.

2. Session statuses form the state machine
   (`packages/contracts/src/linking-api.ts:5-11`):
   `pending -> scanned -> approved -> completed`, with `expired` as an absorbing
   state. `LINKING_INVALID_TRANSITION` is the error for anything else
   (`apps/sync-server/src/lib/errors.ts:24`).

3. Key agreement is raw X25519. `crypto_box_keypair()` for the ephemeral pair
   (`keys.ts:143-147`), `crypto_scalarmult(mySecret, theirPublic)` for the shared
   secret, with explicit 32 byte length checks on both inputs (`keys.ts:149-163`).
   The raw scalarmult output is fed directly to the KDF; there is no `crypto_kx` and
   no hash of the shared secret first.

4. Three subkeys are derived from the shared secret with
   `crypto_kdf_derive_from_key`, length 32 each: encryption (`memrylnk`, id 5), MAC
   (`memrymac`, id 6), SAS (`memrysas`, id 7) (`keys.ts:165-171`, `:19-27`).

5. The short verification code is **six decimal digits**, derived as
   `crypto_generichash(4, sasKey, null)` read as a big-endian `uint32`, reduced
   `% 1000000`, zero padded to six characters (`keys.ts:173-183`). Both devices
   compute it independently (`linking-service.ts:279`, `:781`). It is digits, not
   words.

6. Four confirmation MACs use `crypto_auth`, which is HMAC-SHA512-256 producing 32
   bytes, keyed by the linking MAC key, over canonical CBOR in a fixed field order
   (`keys.ts:189-229`, orderings at `packages/contracts/src/cbor-ordering.ts:15-19`):

   | MAC | CBOR ordering | Fields |
   |---|---|---|
   | linking proof | `LINKING_PROOF` | `sessionId`, `devicePublicKey` |
   | key confirm | `KEY_CONFIRM` | `sessionId`, `encryptedMasterKey` |
   | provider auth confirm | `PROVIDER_AUTH_CONFIRM` | `sessionId`, `encryptedProviderAuth` |
   | vault transfer confirm | `VAULT_TRANSFER_CONFIRM` | `sessionId`, `encryptedVaultTransfer` |

   In every case the value MAC'd is the **base64 string** of the ciphertext, not the
   raw bytes.

7. A second, separate MAC family guards the scan channel. These use WebCrypto
   **HMAC-SHA-256** keyed by the server issued `linkingSecret`, not by the derived
   MAC key: `scanProof` over `LINKING_PROOF` and `scanConfirm` over `SCAN_CONFIRM`
   (`sessionId`, `initiatorPublicKey`, `devicePublicKey`)
   (`apps/desktop/src/main/sync/linking-service.ts:121-159`,
   `packages/contracts/src/cbor-ordering.ts:16`). `LINKING_PROOF` is therefore used
   on both families with different keys and different MAC algorithms. The chapter
   must make that impossible to miss.

8. The QR payload is `JSON.stringify({ sessionId, ephemeralPublicKey, linkingSecret,
   expiresAt })` (`linking-service.ts:181-205`). `expiresAt` is epoch **seconds**,
   and the scanner refuses an expired session before doing any crypto (`:112`).

9. Ordering is mandatory on both sides. The approving device verifies
   `newDeviceConfirm` before it touches the master key (`:654-682`); the new device
   verifies `keyConfirm` before it decrypts the master key (`:344-357`). Comparisons
   are constant time (`apps/desktop/src/main/crypto/index.ts:68-73`). Failure wipes
   the shared secret and both subkeys and clears the pending session.

10. The master key is transported as XChaCha20-Poly1305 under the linking encryption
    key with **no associated data** (`apps/desktop/src/main/crypto/encryption.ts:113-118`),
    as `encryptedMasterKey` plus `encryptedKeyNonce`, both base64.

11. `POST /auth/linking/complete` is polled with `{ maxRetries: 3, baseDelayMs: 2000,
    retryOn429: false }`, because the poll cadence is itself the retry
    (`linking-service.ts:313-334`).

12. After completion the new device fetches `GET /auth/recovery-info` and registers
    with `skipSetup = true`, so it never re-posts `kdfSalt` or `keyVerifier`
    (`linking-service.ts:492-512`).

13. Linking error codes and what each means to a user
    (`apps/sync-server/src/lib/errors.ts:22-28`): `LINKING_SESSION_NOT_FOUND`,
    `LINKING_SESSION_EXPIRED`, `LINKING_INVALID_TRANSITION`,
    `LINKING_DUPLICATE_SESSION`, `LINKING_CONCURRENT_ATTEMPT`,
    `LINKING_SECRET_INVALID`, `LINKING_IP_MISMATCH`.

### Open questions

- **Q03.1** The `linkingSecret` format, length, and entropy are server side and were
  not read. A phone must generate nothing here, but the chapter still has to say
  what it is so an implementer knows it is opaque and how long a buffer to size.
- **Q03.2** `LINKING_IP_MISMATCH` implies the server binds a session to an IP.
  Which requests are bound, and what happens on a phone that moves from Wi-Fi to
  cellular mid-flow? This is a real failure mode for FR-020.
- **Q03.3** The session TTL is `expiresAt` from `initiate`, but the value is server
  chosen and was not read. State it.
- **Q03.4** The optional `encryptedProviderAuth` and `encryptedVaultTransfer` blocks
  each carry their own version literal `1`
  (`packages/contracts/src/linking-api.ts:3`, `:36`, `:40`). What are they, is a
  phone required to consume them, and what happens if it ignores them? The spec's
  "scans while already linked" edge case may live here.
- **Q03.5** The scan channel uses HMAC-SHA-256 while the confirm channel uses
  HMAC-SHA512-256. Is that intentional? Record the reason or record that there is
  none.

---

## 04-record-envelope.md

### Derived from

| Source | What it supplies |
|---|---|
| `packages/sync-client/src/push/record-encrypt.ts:36-107` | the write side |
| `packages/sync-client/src/pull/record-decrypt.ts:42-154` | the read side, both envelopes |
| `apps/desktop/src/main/sync/encrypt.ts:35-109` | desktop's write side, the reference |
| `apps/desktop/src/main/sync/crdt-encrypt.ts:11-94` | the packed CRDT layout |
| `packages/sync-client/src/compress.ts` | the compression frame |
| `packages/sync-client/src/pull/cbor.ts`, `apps/desktop/src/main/crypto/cbor.ts` | canonical CBOR |
| `apps/sync-server/src/services/sync.ts:96-167` | what the server re-derives and verifies |

### Normative facts this chapter must state

1. **Compression frame.** One leading byte, then the payload
   (`packages/sync-client/src/compress.ts:50-55`).

   | Flag | Name | Payload from offset 1 |
   |---|---|---|
   | `0x00` | stored | the plaintext verbatim |
   | `0x01` | zlib | a **zlib-wrapped DEFLATE stream, RFC 1950**, as produced by `pako.deflate` |

   The `0x01` payload therefore begins with the zlib header bytes `78 9c` at default
   compression level, verified empirically against the `pako` in this workspace. It
   is **not** gzip (`1f 8b 08`) and **not** headerless raw DEFLATE (RFC 1951). A Rust
   implementation must use a zlib wrapper, for example `flate2::ZlibEncoder`, and not
   `DeflateEncoder`. The only gzip in the product is unrelated: the embedded editor
   bundle asset, packed with `node:zlib` `gzipSync` and unpacked with `pako.ungzip`
   (`apps/mobile/scripts/build-editor-web.mjs:28`, `:144`,
   `apps/mobile/src/editor/editor-web-asset.ts:24`). That asset never touches this
   frame and the chapter must say so, because confusing the two produces a client
   that cannot read any note body.

   Writer rules: a payload strictly under 64 bytes is always stored
   (`packages/sync-client/src/compress.ts:7-9`), and a compressed result whose length
   is greater than or equal to the input is discarded in favour of stored (`:12-14`).
   Both rules are load bearing for byte identity, because a writer that compresses
   a 60 byte payload produces a different envelope than the reference for the same
   input.

   Reader rules: a reader treats **any** flag other than `0x01` as stored (`:47`);
   there is no unknown-flag rejection. An empty input is returned as-is (`:20`). A
   `0x01` frame whose stream is truncated must be a **hard error**, never an empty
   decode: `pako.inflate` returns `undefined` rather than throwing for a stream that
   never reaches `Z_STREAM_END`, and handing that back under a `Uint8Array` return
   type turns a truncated body into a successful decrypt of an empty item, which the
   applier writes as a content wipe (`:26-44`).

2. The compression byte lives **inside** the ciphertext, in both the record and the
   CRDT path. There is no envelope level compression field. Order on write is
   compress then encrypt (`push/record-encrypt.ts:50-51`,
   `apps/desktop/src/main/sync/encrypt.ts:47-48`); on read, decrypt then decompress
   (`pull/record-decrypt.ts:96-97`, `:149-150`).

3. **AEAD.** XChaCha20-Poly1305-IETF with a 24 byte nonce generated by
   `randombytes_buf`, a 32 byte key, and a 16 byte Poly1305 tag appended to the
   ciphertext (`packages/contracts/src/crypto.ts:34-38`,
   `apps/desktop/src/main/crypto/encryption.ts:6-16`, `:33-39`). The nonce is random
   per operation and is never a counter. Record content is encrypted with **no**
   associated data (`apps/desktop/src/main/sync/encrypt.ts:48`).

4. **Key wrap.** Every item gets a fresh random 32 byte file key
   (`apps/desktop/src/main/crypto/primitives.ts:4-6`) which is AEAD encrypted under
   the vault key with its own nonce and **no** associated data
   (`apps/desktop/src/main/crypto/encryption.ts:87-93`). Wrapped length is therefore
   exactly 48 bytes.

5. **Base64 variant.** Standard alphabet with `+` and `/`, with `=` padding
   (`sodium.base64_variants.ORIGINAL`). Not URL-safe. The dependency free reference
   implementation is `packages/sync-client/src/pull/base64.ts:1-30`; it emits
   padding and strips it on decode, and throws `invalid base64 input` on a
   non-alphabet character.

6. **Record envelope fields** on the wire (`packages/contracts/src/sync-api.ts:215-228`):
   `id`, `type`, `operation`, `encryptedKey`, `keyNonce`, `encryptedData`,
   `dataNonce`, `signature`, `signerDeviceId`, and optional `clock`, `stateVector`,
   `deletedAt`. Every blob field is base64. `clock`, `stateVector` and `deletedAt`
   keys are **omitted entirely** when absent, never sent as `null`
   (`push/record-encrypt.ts:88-101`).

7. **Canonical CBOR. `CBOR_FIELD_ORDER` is an allowlist, not the byte order.**
   This is the single most misread fact in the codebase and the chapter must open
   with it. The encoder is `cborg`'s `encode` applied to a JavaScript `Map` built by
   walking the declared field list (`packages/sync-client/src/pull/cbor.ts:9-30`,
   `apps/desktop/src/main/crypto/cbor.ts:7-28`). What the field list does:
   - **inclusion**: a key is encoded only when it is present in the input and its
     value is not `undefined`. `null` is a value and is encoded as `f6`;
   - **rejection**: a defined key that is not in the list is a hard throw, never a
     silent exclusion, with the message `CBOR encoding rejected: fields not in
     ordering would be excluded: <keys>. Update CBOR_FIELD_ORDER.`

   What the field list does **not** do is determine the output byte order. `cborg`
   canonicalises map keys itself, **length first then bytewise**, which is RFC 8949
   **§4.2.3**, "Length-First Map Key Ordering". It is **not** §4.2.1: the core
   deterministic encoding in §4.2.1 is plain bytewise and is a different order. The
   chapter must cite §4.2.3 and say why the distinction matters, because a Rust crate
   advertising "canonical" usually means §4.2.1. `cborg` also sorts **recursively**,
   including for plain nested objects. The behaviour is asserted in the
   implementation's own test (`apps/desktop/src/main/crypto/cbor.test.ts:67-70`),
   whose comment cites §4.2.1 and is wrong about the section number while right about
   the behaviour; correcting it is part of A2. Confirmed empirically against the
   `cborg` in this workspace:

   | Input | Encoded key order |
   |---|---|
   | `SYNC_ITEM` field list order | `id`, `type`, `metadata`, `operation`, `cryptoVersion`, ... (lengths 2, 4, 8, 9, 13) |
   | `{ stateVector, clock }` | `clock`, `stateVector` (lengths 5, 11) |
   | `{ d1: 1, aa: 2 }` | `aa`, `d1` (equal length, bytewise) |
   | `{ aa: 1, z: 2 }` | `z`, `aa`, encoding to `a2 61 7a 02 61 61 01` |

   The last row is the case where length-first and plain lexicographic order
   disagree, and it is why the chapter must state the rule rather than the field
   list. Input insertion order has no effect on the bytes
   (`apps/desktop/src/main/crypto/cbor.test.ts:73-98` asserts exactly that for
   `TOMBSTONE`).

   Consequence the chapter must call out: the "clock first, then stateVector"
   construction discipline in both implementations
   (`pull/record-decrypt.ts:72-80`, `push/record-encrypt.ts:74-82`) and its
   accompanying comments claiming "CBOR encodes the nested object's own key order"
   are **wrong about the mechanism**. The bytes are identical either way because
   `clock` is shorter than `stateVector`. The discipline is harmless, the comment is
   misleading, and a second implementer who believes the comment will build an
   insertion-order encoder that diverges the first time two same-length keys appear.

8. **Scalar encoding rules** a second implementation must match, verified
   empirically against this workspace's `cborg`:

   | Value | Bytes | Rule |
   |---|---|---|
   | `1` | `01` | shortest-form unsigned integer |
   | `1000000` | `1a 000f4240` | shortest form, 4 byte argument |
   | `-1` | `20` | shortest-form negative integer |
   | `1.5` | `f9 3e00` | **narrowed to float16** when exactly representable |
   | `0.1` | `fb 3fb999999999999a` | float64 when narrowing is lossy |
   | `Uint8Array([1,2,3])` | `43 010203` | major type 2, byte string, not an array of ints |
   | `null` | `f6` | |
   | `true` | `f5` | |

   Float narrowing is the trap: a Rust encoder that always emits float64 produces a
   different signature for the same input. Today no signed field is a non-integral
   number, so the trap is latent rather than live, but see Q04.7.

9. **`CBOR_FIELD_ORDER.SYNC_ITEM`** as an allowlist, verbatim
   (`packages/contracts/src/cbor-ordering.ts:2-13`):
   `id, type, operation, cryptoVersion, encryptedKey, keyNonce, encryptedData,
   dataNonce, deletedAt, metadata`. The same file holds seven more lists, each an
   allowlist for its own payload (`:14-25`).

10. **Signature payload v1.** Assemble the field set, drop absent keys, encode as
   canonical CBOR per fact 7, sign Ed25519 detached, base64 the 64 byte signature
   (`push/record-encrypt.ts:59-84`, `apps/desktop/src/main/sync/encrypt.ts:59-85`,
   schema `packages/contracts/src/crypto.ts:205-222`). The signed values are the
   **base64 strings**, not the raw ciphertext bytes. `deletedAt` is included only
   when defined; `metadata` only when `clock` or `stateVector` exists.
   `cryptoVersion` is the literal `1` on the write side.

11. **Two divergences the chapter must resolve, not paper over:**
    - The read side defaults a missing `operation` to `'update'`
      (`pull/record-decrypt.ts:60`). The server uses `item.operation` directly and
      the push schema makes it required
      (`apps/sync-server/src/services/sync.ts:142`,
      `packages/contracts/src/sync-api.ts:354`).
    - The server signs with `cryptoVersion: CRYPTO_VERSION`, a hardcoded 1, rather
      than the version the item declared
      (`apps/sync-server/src/services/sync.ts:143`).

12. **Server side validation before signature check**
    (`apps/sync-server/src/services/sync.ts:96-125`): decoded `encryptedKey` must be
    at least `KEY_LENGTH + TAG_LENGTH = 48` bytes, decoded `encryptedData` at most
    `MAX_ENCRYPTED_DATA_BYTES = 5 * 1024 * 1024`, decoded `signature` exactly 64
    bytes. Violations are `400 CRYPTO_INVALID_PAYLOAD`. A revoked signer device is
    `403 AUTH_DEVICE_REVOKED`; an unknown one is `404 AUTH_DEVICE_NOT_FOUND`; a bad
    signature is `403 SYNC_INVALID_SIGNATURE`
    (`apps/sync-server/src/services/sync.ts:132-166`).

13. **Packed CRDT update envelope.** Total header 160 bytes, no multi-byte integers,
    so endianness does not apply (`pull/record-decrypt.ts:103-106`,
    `apps/desktop/src/main/sync/crdt-encrypt.ts:11-14`):

    | Offset | Length | Field |
    |---|---|---|
    | 0 | 24 | data nonce |
    | 24 | 24 | key nonce |
    | 48 | 48 | wrapped file key |
    | 96 | 64 | Ed25519 signature |
    | 160 | rest | ciphertext |

    Minimum accepted length is 161 bytes (`pull/record-decrypt.ts:122-124`).

14. **CRDT signed message.** `UTF-8(noteId) || packed[0..96) || packed[160..end)`.
    The 64 byte signature slot is excised, and on write the signature is computed
    while that slot is still zero filled (`pull/record-decrypt.ts:129-135`,
    `apps/desktop/src/main/sync/crdt-encrypt.ts:85-94`). The note id is therefore
    **authenticated**, not merely associated: a packet made for one note fails as a
    signature error when read as another
    (`packages/sync-client/src/push/roundtrip.test.ts:173-188`).

15. **CRDT AAD.** The AEAD associated data for the content is the UTF-8 encoding of
    the note id (`apps/desktop/src/main/sync/crdt-encrypt.ts:22`, `:27`, `:78`). The
    key unwrap uses no AAD. The provider interface types AAD as a `string` because
    the mobile binding accepts only strings, with `''` meaning libsodium NULL
    (`packages/sync-client/src/pull/crypto-provider.ts:10-13`, `:24`).

16. **Order of operations on read**, in both envelopes: verify signature first, then
    unwrap the file key, then decrypt, then decompress, then zero the file key
    (`pull/record-decrypt.ts:82-100`, `:137-153`).

17. **Vault name envelope** (small but on the wire): XChaCha20-Poly1305 under the
    **vault key** with AAD `vault-name-v1:<vaultUuid>`, fields `encryptedName` and
    `nameNonce`, both base64
    (`apps/desktop/src/main/sync/vault-name-crypto.ts:5-23`,
    `apps/desktop/src/main/sync/vault-directory.ts:42-50`). Decrypt failure returns
    `null` rather than throwing (`vault-name-crypto.ts:25-37`).

### Open questions

- **Q04.1** A stale comment at `apps/desktop/src/main/sync/crdt-encrypt.ts:38` says
  the signature sits at offset 72 when it sits at 96. The chapter must state 160 and
  96, and the comment must be corrected in A2. The decision record already says 160,
  so there is nothing to correct there.
- **Q04.2** `EncryptedCrdtItem` (`packages/contracts/src/crypto.ts:139-150`) declares
  `encryptedSnapshot`, `snapshotNonce` and `stateVector` and has no producer
  anywhere. Snapshots ship as the same packed blob as updates
  (`apps/desktop/src/main/sync/crdt-snapshot-batch.ts:137`,
  `apps/desktop/src/main/sync/runtime.ts:634`). Is the type dead, or a v2 shape? A
  Rust type derived from the contract would be wrong.
- **Q04.3** `SignaturePayloadV1Schema` allows `metadata.fieldClocks`
  (`packages/contracts/src/crypto.ts:217`) but no writer ever sets it, and
  `CBOR_FIELD_ORDER` has no entry for it, so it is neither included nor rejected by
  the allowlist because the allowlist only applies to the top level. Since nested
  keys are sorted by the encoder rather than by a list, adding it would not break
  ordering, but it would change the signed bytes for every item that carries it.
  Forbid it or state that a reader must accept it.
- **Q04.7** Nothing in the signed field set is a non-integral number today:
  `deletedAt` is epoch milliseconds and every clock tick is an integer, and the push
  schema constrains both with `z.number().int()`
  (`packages/contracts/src/sync-api.ts:361-363`). But
  `SignaturePayloadV1Schema.deletedAt` is a bare `z.number().optional()` with **no**
  `.int()` (`packages/contracts/src/crypto.ts:214`), so the signature schema admits a
  fractional value that would encode as a float and hit the float16 narrowing rule.
  Either tighten the schema to `.int()` or specify float encoding normatively. Same
  question for `EncryptedItem.signedAt` (`packages/contracts/src/crypto.ts:134`).
- **Q04.8** The in-code comments at `pull/record-decrypt.ts:72-74` and
  `push/record-encrypt.ts:74-76` state that CBOR encodes a nested object's own key
  order. It does not; the encoder sorts. The comments are wrong and should be fixed
  in the same change that lands the chapter, so the next reader is not misled the
  way this outline's first draft was.
- **Q04.4** `EncryptedItem.signedAt` exists in the type
  (`packages/contracts/src/crypto.ts:134`) and in `SignatureMetadata`
  (`packages/contracts/src/sync-api.ts:618-623`) but is not in the signed CBOR, is
  not in `PushItem`, and no replay window uses it. Declare it unused or remove it.
- **Q04.5** The server rewrites `cryptoVersion` to 1 when verifying. If a client
  ever sends 2, verification silently checks the wrong bytes. State the intended
  behaviour.
- **Q04.6** `CBOR_FIELD_ORDER.TOMBSTONE` (`cbor-ordering.ts:14`) has no producer.
  Tombstones travel as ordinary signed records with `deletedAt` set. Dead, or
  reserved?

---

## 05-record-sync.md

### Derived from

| Source | What it supplies |
|---|---|
| `apps/sync-server/src/routes/sync.ts:79-565` | routes, query params, page limits |
| `apps/sync-server/src/services/sync.ts:30-233, 470-540` | replay, content hash, blob payload, limits |
| `apps/sync-server/src/lib/sync-types.ts:34-46` | type negotiation |
| `packages/contracts/src/sync-api.ts` | every request and response schema |
| `packages/sync-client/src/pull/engine.ts` | the client's pull loop, apply order, breaker |
| `packages/sync-client/src/pull/http.ts:18-121` | headers and error mapping |
| `apps/desktop/src/main/sync/engine/sync-context.ts:126-140`, `engine/push-coordinator.ts:132-263` | the push wave |

### Normative facts this chapter must state

1. **Routes**, under both `/sync/*` and `/sync/records/*`
   (`apps/sync-server/src/routes/sync.ts:549-565`):

   | Method | Path | Query / body |
   |---|---|---|
   | GET | `/sync/status` | none; returns `SyncStatusSchema` including `clientPolicy` |
   | GET | `/sync/manifest` | optional `limit` (capped at 1000) and `cursor`; a cursor without a limit is malformed |
   | GET | `/sync/changes` | `cursor`, optional `limit` |
   | POST | `/sync/push` | `RecordPushRequestSchema`, 1 to 100 items |
   | POST | `/sync/pull` | `PullRequestSchema`, 1 to 100 item ids |
   | GET | `/sync/items/:id` | single item |
   | GET | `/sync/packs` | keyset `cursor` |
   | GET | `/sync/vaults`, POST `/sync/vaults`, DELETE `/sync/vaults/:vaultId` | vault registry, auth only, above the paid gate |
   | GET | `/sync/storage` | quota |

2. **Headers on every request** (`packages/sync-client/src/pull/http.ts:70-77`):
   `Authorization: Bearer <accessToken>`, `Content-Type: application/json`,
   `Accept: application/json`, `X-Memry-Sync-Types`, `x-memry-client` (lowercase in
   the constant), and `X-Memry-Vault-Id` when a vault is selected. The bootstrap
   header `X-Memry-Bootstrap-Token` is added only during a bootstrap session
   (chapter 10).

3. **Type negotiation** is a header, not a query parameter. The value is a comma
   separated list with no spaces (`packages/sync-client/src/pull/http.ts:74`). Server
   resolution (`apps/sync-server/src/lib/sync-types.ts:34-46`):

   | Header state | Resolved set |
   |---|---|
   | absent | `LEGACY_RECORD_SYNC_ITEM_TYPES`, the frozen 15 |
   | present, at least one entry recognised | the recognised entries, deduplicated, first-seen order |
   | present, nothing recognised | **the empty set**, serving zero rows |

   The empty-set rule is deliberate: falling back to legacy would hand a
   negotiating client 15 types it never asked for, which is the convergence loss the
   feature exists to prevent (`apps/sync-server/src/lib/sync-types.ts:20-27`).
   `LEGACY_RECORD_SYNC_ITEM_TYPES` is frozen forever
   (`packages/contracts/src/sync-api.ts:93-121`).

4. **Push request.** `RecordPushRequestSchema` allows 1 to 100 items
   (`packages/contracts/src/sync-api.ts:388-390`). Every type in
   `RECORD_CLOCK_REQUIRED_ITEM_TYPES` must carry a `clock`, enforced by a
   `superRefine` (`:378-386`); `settings` is the only record type exempt.

5. **Push response** is `{ accepted: string[], rejected: [{id, reason}],
   serverTime, maxCursor }` (`packages/contracts/src/sync-api.ts:392-402`). Acks are
   per item id. Two queued rows sharing an id cannot be told apart in a mixed
   response, so a client must collapse to one push item per id before sending
   (`apps/mobile/src/sync/outbox.ts:582-597`).

6. **The push wave** (`apps/desktop/src/main/sync/engine/sync-context.ts:126-132`,
   `engine/push-coordinator.ts:132-263`):

   | Constant | Value |
   |---|---|
   | `PUSH_BATCH_SIZE` | 100 |
   | `MIN_PUSH_BATCH_SIZE` | 1 |
   | `MAX_PUSH_ITERATIONS` | 50 |

   A 5xx on `/sync/push` is answered by **halving the batch**, not by resending the
   same one, and the reduced size becomes a ceiling for the rest of the run. The
   reason is on record: Cloudflare terminates an oversized `/sync/push` at the edge
   with an empty 503 body before any handler runs, so there is no per-item verdict
   and an identical resend fails identically
   (`engine/push-coordinator.ts:242-263`). `retryOn5xx` is therefore `false` for
   this call (`:236-238`).

7. **Replay detection is a vector clock dominance rule, not a timestamp window**
   (`apps/sync-server/src/services/sync.ts:178-209`). Verbatim:
   an incoming push is a replay when a row already exists and either the incoming
   item carries no clock at all, or no device key in the incoming clock exceeds the
   stored value for that key. Replays are rejected per item with reason
   `SYNC_REPLAY_DETECTED`; they do not fail the batch
   (`apps/sync-server/src/services/sync.ts:505-508`). The check is skipped entirely
   for types outside `RECORD_CLOCK_REQUIRED_ITEM_TYPES` (`:194-208`).

8. **Content hash and stored blob.** The R2 object is exactly
   `JSON.stringify({dataNonce, encryptedData, encryptedKey, keyNonce}, sortedKeys)`
   as UTF-8 text (`apps/sync-server/src/services/sync.ts:225-233`), and
   `contentHash` is the lowercase hex SHA-256 of those same bytes (`:211-223`). This
   is what chapter 08 means when it says a record pack entry holds the exact JSON
   text bytes a push stored.

9. **Server side size and page limits** (`apps/sync-server/src/services/sync.ts:30-36`):
   `MAX_ENCRYPTED_DATA_BYTES = 5 MiB`, `MAX_CHANGES_LIMIT = 500`,
   `MAX_MANIFEST_PAGE_LIMIT = 1000`, `D1_MAX_BIND_PARAMS = 95`.
   Client side: `POST /sync/pull` takes at most 100 ids
   (`packages/contracts/src/sync-api.ts:405`); desktop requests
   `PULL_PAGE_LIMIT = 500` changes per page
   (`apps/desktop/src/main/sync/engine/sync-context.ts:139`) while the platform-free
   engine uses 100 (`packages/sync-client/src/pull/engine.ts:60-61`).

10. **Per item ceiling.** `SYNC_ITEM_MAX_ENCRYPT_BYTES = 5 MiB` and
    `SYNC_ITEM_ENCRYPT_OVERHEAD = 1.37`, so `NOTE_SYNC_MAX_BYTES = 3 826 919` bytes
    of payload and a warning at 80 percent, 3 061 535 bytes
    (`packages/sync-client/src/note-size.ts:16-31`). The check runs before any crypto
    and raises a non-retryable `ItemTooLargeError`
    (`packagesting/sync-client/src/push/record-encrypt.ts:40-46`).

11. **Cursors.** One global record cursor per device, a decimal string of the
    server's `server_cursor`, advanced to `nextCursor` **only after** the page's
    items were applied (`packages/sync-client/src/pull/engine.ts:24-27`, `:358`).

12. **Tombstones.** `GET /sync/changes` returns `{items, deleted, hasMore,
    nextCursor}`. The client unions `deleted` ids into the `/sync/pull` request for
    the same page, because tombstones arrive as full signed items and a set
    `deletedAt` is the delete signal (`pull/engine.ts:28-29`, `:350`). A present
    `deletedAt` overrides the declared `operation` (`:229`), and tombstone bodies are
    never decoded (`:230-240`). An id in `deleted` with no ref row has no type on the
    wire and is recorded as a bare tombstone (`:416-419`).

13. **Apply order.** `PULL_APPLY_ORDER` assigns a rank to some types and everything
    unlisted defaults to rank 1 (`pull/engine.ts:40-58`): rank 0 for `project`,
    `folder_config`, `tag_definition`, `filter`, `settings`, `calendar_source`,
    `agent_conversation`; rank 2 for `task`, `agent_message`, `calendar_event`,
    `calendar_external_event`; rank 3 for `calendar_binding`. The sort is stable
    within a rank.

14. **Failure isolation.** Schema validation is per item, not per page: one
    malformed item is recorded corrupt and skipped, never allowed to poison its 99
    page mates (`pull/engine.ts:173-177`, `:208-226`). A page whose envelope is not a
    pull envelope is dropped and the cursor advances past it (`:199-205`, `:356-362`).
    The breaker: if a page yielded zero decoded items, produced at least one new
    corrupt item, and asked for at least one id, the cursor advances past it but the
    run is refused so no success state is written (`:364-373`).

15. **Manifest.** `RecordSyncManifestSchema` carries `nextCursor` only on a paginated
    response that has more rows; it is absent on the final page and on every
    parameterless legacy call (`packages/contracts/src/sync-api.ts:429-438`). There
    is **no integrity digest on the manifest**; the only integrity machinery on this
    path is the per item signature and, for packs, the pack's own digests.

16. **Clock skew.** `CLOCK_SKEW_THRESHOLD_SECONDS = 300`
    (`apps/desktop/src/main/sync/engine/sync-context.ts:133`). The chapter must say
    what the client does when the server time differs by more than this.

### Open questions

- **Q05.1** The shipped TypeScript client always declares the full 25 type list
  (`packages/sync-client/src/pull/http.ts:74`), so the subset path FR-032 describes
  has never run in production. The phone will declare 13. The chapter must state
  what a server does with a subscribed-out type, and what a client does if one
  arrives anyway. The current answer appears to be "the server never serves it", in
  which case FR-032's "must not advance the cursor past unprocessed items" is about
  a case the record feed cannot produce. Confirm, because if true, FR-032 needs
  restating against the real risk, which is an unknown **field** inside a known
  type.
- **Q05.2** The `deleted` array on `GET /sync/changes` is untyped strings. A client
  subscribing to a subset cannot tell whether a tombstone is for a type it wants.
  What is it supposed to do?
- **Q05.3** The same four blob fields are canonicalised **twice, differently**. The
  stored R2 object and `contentHash` use `JSON.stringify(payload,
  Object.keys(payload).sort())`, which is JavaScript's default lexicographic string
  sort giving `dataNonce, encryptedData, encryptedKey, keyNonce`
  (`apps/sync-server/src/services/sync.ts:211-233`). The signature uses canonical
  CBOR, which sorts length first then bytewise, giving `keyNonce, dataNonce,
  encryptedKey, encryptedData`. A Rust implementation must reproduce both and must
  not assume one sort. State both explicitly; this is the kind of near-miss that
  passes a unit test and fails on real data.
- **Q05.4** `MAX_CHANGES_LIMIT` is 500 but the contract does not state what the
  server does with `limit=1000`. Clamp or reject?
- **Q05.5** `ConflictResponseSchema` (`packages/contracts/src/sync-api.ts:470-479`)
  and `SYNC_VERSION_CONFLICT` exist. Which route returns them? No client reads them.
  Dead path or a real one a phone must handle?
- **Q05.6** The desktop engine and the platform-free engine disagree on
  `PULL_PAGE_LIMIT` (500 vs 100). Which is normative for a new client?

---

## 06-vector-clocks-and-field-merge.md

This chapter is the one FR-002 names explicitly and the one where an ambiguity
costs a user their edit. It must be written so that two implementations given the
same inputs produce the same winner and the same conflict set, with no appeal to
"whatever the TypeScript does".

### Derived from

| Source | What it supplies |
|---|---|
| `packages/sync-client/src/vector-clock.ts` | the whole clock algebra, 43 lines |
| `packages/sync-client/src/field-merge.ts:11-137` | field lists, `clockTotal`, the merge |
| `packages/sync-client/src/offline-clock.ts:31-101` | `_offline` minting and rebinding |
| `packages/sync-client/src/item-handlers/types.ts:53-68` | the document level resolver |
| `packages/contracts/src/sync-api.ts:166-173` | `VectorClock`, `OFFLINE_CLOCK_DEVICE_ID` |
| `packages/contracts/src/settings-sync.ts:78-108` | dotted-path field clocks |

### Normative facts this chapter must state

1. A vector clock is a map from device id to a non-negative integer. A missing key
   reads as 0. `increment` adds exactly 1 and is non-mutating. `merge` is the
   pointwise maximum and is commutative
   (`packages/sync-client/src/vector-clock.ts:7-20`).

2. `compare(a, b)` returns one of `equal`, `before`, `after`, `concurrent`, computed
   over the union of both key sets. `before` means a happened-before b; `after` means
   a dominates b. The loop short-circuits to `concurrent` as soon as both directions
   are seen (`vector-clock.ts:22-41`).

3. `_offline` is a reserved pseudo device id, the literal string `_offline`
   (`packages/contracts/src/sync-api.ts:173`). The clock algebra gives it no special
   treatment; it is an ordinary key in `increment`, `merge` and `compare`. It is
   special only in the merge tie-break (fact 6) and in rebinding (fact 7).

4. **`clockTotal` is the plain sum of every tick in the clock, `_offline` included**
   (`field-merge.ts:47-51`).

5. **The complete winner-selection order for a field**, from
   `packages/sync-client/src/field-merge.ts:102-125`. Evaluate in this order and
   stop at the first match:

   | # | Condition | Winner |
   |---|---|---|
   | 1 | `clockTotal(remoteFC) > clockTotal(localFC)` | remote |
   | 2 | `clockTotal(localFC) > clockTotal(remoteFC)` | local |
   | 3 | totals equal, `'_offline'` is a key of `localFC`, `'_offline'` is **not** a key of `remoteFC`, and the values differ | local |
   | 4 | otherwise | **remote** |

   Three things a specification must say out loud:
   - The winner is chosen by **sum of ticks**, not by `compare`. `compare`'s result
     is not consulted for winner selection at all.
   - The `_offline` tie-break is a **key presence** test (`'_offline' in clock`), not
     a tick value test, and it is **asymmetric**: there is no branch for "remote has
     `_offline` and local does not".
   - Remote is the default winner on every tie.

6. **The conflict condition is narrower than the winner condition.** A field is
   reported conflicted only when **all three** hold
   (`field-merge.ts:114-124`): the totals are equal, `compare(localFC, remoteFC)`
   is `concurrent`, and the values differ. A genuinely concurrent pair whose totals
   happen to differ is resolved silently by rule 1 or 2 and is **never** reported.

7. **Value equality is `JSON.stringify(a) !== JSON.stringify(b)`**
   (`field-merge.ts:100`). That is key-order sensitive for objects and does not
   normalise number formatting. A second implementation must reproduce this exactly
   or two devices will disagree about whether a field changed. This is the single
   most likely place for a Rust and TypeScript divergence in the whole protocol.

8. **The merged field clock is the union, unconditionally**, on every field
   regardless of which branch won (`field-merge.ts:127`). Merge is commutative, which
   is what lets two devices mint a matching activity-log id for the same conflict and
   collapse two mirror-image rows into one (`field-merge.ts:53-60`).

9. **Field lists.** `TASK_SYNCABLE_FIELDS`, 15 entries in order
   (`field-merge.ts:11-27`): `title, description, projectId, statusId, parentId,
   priority, position, dueDate, dueTime, startDate, repeatConfig, repeatFrom,
   sourceNoteId, completedAt, archivedAt`. `PROJECT_SYNCABLE_FIELDS`, 9 entries
   (`:29-39`): `name, description, color, icon, position, isInbox, archivedAt,
   modifiedAt, homeNoteId`. A field absent from the list is not merged at all.
   `initAllFieldClocks` seeds every listed field with a copy of the document clock
   (`:41-45`).

10. **`_offline` minting and rebinding.** While the sync runtime is down, edits tick
    `_offline` instead of a device id (`offline-clock.ts:97`, `:112`). When the device
    later has an id, `rebindClockDevice` **deletes** the `_offline` key and **adds**
    its tick count to the target device's existing tick
    (`offline-clock.ts:39-47`), and the same transformation runs over every field
    clock (`:49-84`). The chapter must state that rebinding happens before the first
    push and that a clock containing `_offline` must never reach the server.

11. **The document level resolver** is a different algorithm from the field level
    one and both are live (`packages/sync-client/src/item-handlers/types.ts:53-68`):
    no local clock means apply; `compare(local, remote) === 'after'` means skip;
    `concurrent` means merge the clocks and apply; `before` and `equal` both mean
    apply. So remote wins on `equal` here too. Per-type routing to one or the other
    is chapter 13's job.

12. **Settings use a third shape.** Field clocks are keyed by dotted path at
    arbitrary depth, for example `general.theme`,
    `journal.weekdayTemplates.3`, `sidebar.sortModes.collections`
    (`packages/contracts/src/settings-sync.ts:78-93`,
    `packages/sync-client/src/settings-sync-keys.ts:12-15`). The whole settings blob
    is one sync item with `itemId = 'synced_settings'`
    (`packages/sync-client/src/settings-sync.ts:195-196`). Some sub-objects are
    deliberately single-clocked as a unit (`sidebar.sectionOrder`,
    `sidebar.navCollapsed`) and the reasons are recorded in the schema comments.

### Open questions

- **Q06.1** The asymmetric `_offline` tie-break means the outcome depends on which
  side is called "local". Two devices each applying the other's payload will each
  see themselves as local. Construct the case where they disagree and either prove
  it cannot happen or specify the fix. This is FR-002's "both pick the same winner"
  requirement and it is not obviously satisfied today.
- **Q06.2** `clockTotal` sums across devices, so a device that ticked 5 times beats
  two devices that ticked twice each, regardless of causality. Is that intended?
  It is not a standard vector clock rule and it is written nowhere.
- **Q06.3** `JSON.stringify` equality: specify the canonical form a Rust
  implementation must produce. Property insertion order for objects coming out of a
  JSON payload is document order, which is stable, but a Rust struct round-trip is
  not. Consider mandating a defined canonical comparison instead and measuring the
  behaviour change.
- **Q06.4** A concurrent pair with unequal totals is resolved without being
  reported. Users therefore lose an edit with no conflict surfaced. Is that a bug
  the spec should freeze, or a bug the spec should fix? Freezing it is the
  compatible choice; fixing it changes desktop behaviour.
- **Q06.5** Which types use field-level merge and which use document-level? Only
  `task` and `project` have field lists, and `settings` has its own. State the rest
  explicitly rather than by the absence of a list.
- **Q06.6** Clock growth: nothing prunes a vector clock. A vault with 50 devices
  over years carries 50 keys per item and per field. Is there a pruning rule, and
  if not, record that as a known unbounded growth.

---

## 07-crdt-updates.md

### Derived from

| Source | What it supplies |
|---|---|
| `apps/sync-server/src/routes/sync.ts:571-1146` | the six CRDT routes and their schemas |
| `apps/sync-server/src/services/crdt.ts:86-146, 310-360, 690-770` | sequence, revision, snapshot, pruning |
| `packages/sync-client/src/pull/crdt-pull.ts` | the client read algorithm |
| `apps/desktop/src/main/sync/crdt-encrypt.ts` | the packed envelope (chapter 04) |

### Normative facts this chapter must state

1. **Routes** (`apps/sync-server/src/routes/sync.ts:1139-1144`), all under `/sync/crdt`:

   | Method | Path | Purpose |
   |---|---|---|
   | POST | `/sync/crdt/updates` | append updates for one note |
   | GET | `/sync/crdt/updates` | pull updates for one note, `note_id`, `since`, `limit` |
   | POST | `/sync/crdt/updates/batch` | pull updates for up to 100 notes |
   | POST | `/sync/crdt/snapshot` | write one snapshot |
   | POST | `/sync/crdt/snapshot/batch` | write up to 50 snapshots |
   | GET | `/sync/crdt/snapshot/:noteId` | read the snapshot |

2. **Limits**:

   | Limit | Value | Source |
   |---|---|---|
   | `MAX_UPDATE_BYTES` | 5 MiB decoded, per individual update | `routes/sync.ts:145` |
   | updates per push | 100, each base64 string capped at `MAX_UPDATE_BYTES * 2` | `routes/sync.ts:642` |
   | notes per batch pull | 1 to 100, duplicate note ids rejected | `routes/sync.ts:631-636` |
   | updates per note in a batch pull | `limit`, 1 to 100, default 100 | `routes/sync.ts:637` |
   | updates per single-note pull | `min(limit, 500)` | `routes/sync.ts:781` |
   | snapshots per batch push | 1 to 50, duplicates rejected | `routes/sync.ts:660-673` |
   | client batch size | `CRDT_BATCH_MAX_NOTES = 100`, `CRDT_UPDATES_PAGE_LIMIT = 100` | `pull/crdt-pull.ts:26-27` |

   The 50 note snapshot batch size is chosen because a snapshot is up to 5 MB
   decoded, roughly 6.7 MB of base64, and a full batch is the largest request the
   Worker body limit and subrequest budget take (`routes/sync.ts:650-658`).

3. **Sequence numbers.** The server assigns them; the client never proposes one.
   A new update takes `COALESCE(MAX(sequence_num), 0) + 1` over the **union** of
   `crdt_updates` and `crdt_snapshots` for that note, so a snapshot consumes a
   sequence number in the same space (`apps/sync-server/src/services/crdt.ts:139-146`,
   `:99-104`). `POST /sync/crdt/updates` answers `{ sequences: number[] }`
   (`routes/sync.ts:748`).

4. **Snapshot revision.** A fresh `crypto.randomUUID()` on **every** snapshot write,
   insert and conflict alike, and never conditional on whether the bytes changed. A
   revision that fails to move when the blob moves leaves a client skipping a
   snapshot it needed, with a stale body forever
   (`apps/sync-server/src/services/crdt.ts:331-336`). Rows written before `revision`
   existed carry `''` and are coalesced to a synthetic
   `legacy:<id>:<created_at>:<size_bytes>` so an old snapshot is not re-downloaded
   forever (`:77-89`).

5. **Snapshot watermark stability.** Once a snapshot exists for a note, its
   `sequence_num` **stays put** across subsequent snapshot writes: the upsert
   reuses `existingSnapshot.sequence_num` rather than the current maximum. The reason
   is on record: client uploaded snapshots carry no causal metadata proving they
   already contain every server update above the prior watermark, so keeping the
   watermark stable keeps later incrementals pullable
   (`apps/sync-server/src/services/crdt.ts:339-348`).

6. **Pruning is server side.** `DELETE FROM crdt_updates WHERE ... AND sequence_num
   <= <snapshot sequence_num>` (`apps/sync-server/src/services/crdt.ts:700-726`), with
   a batch form that runs every SUM ahead of every DELETE inside one D1 transaction
   (`:730-770`). The client does no pruning of the server's log.

7. **The client's baseline rule**, which exists precisely because of pruning
   (`packages/sync-client/src/pull/crdt-pull.ts:155-166`): fetch the snapshot first
   when the cursor is 0, or when the server advertises a snapshot whose
   `sequenceNum` is ahead of the cursor **and** whose `revision` differs from the
   locally stored one. Otherwise pull incrementals from `since = cursor`.

8. **Incremental application rules** (`pull/crdt-pull.ts:225-250`):
   - an update whose `sequenceNum <= cursor` is skipped as a replay;
   - each accepted update is decrypted and persisted, and the watermark is advanced
     and written **per update**, not per page;
   - on an unresolvable signer the note's pull **stops at that update** and the
     watermark is not advanced past it, so a later pass retries. Desktop advances
     past it instead and owes the note a re-pull; the platform-free engine
     deliberately chose the safer side (`pull/crdt-pull.ts:20-24`, `:227-237`).

9. **Retry policy** for every CRDT request: `maxRetries: 3`, `baseDelayMs: 2000`,
   `retryOn429: false` (`pull/crdt-pull.ts:69-77`).

10. **Wire shapes** (`pull/crdt-pull.ts:29-46`):
    an update entry is `{sequenceNum, data, createdAt, signerDeviceId}` where `data`
    is base64 of the packed envelope; the batch response is
    `{notes: Record<noteId, {updates, hasMore}>, snapshotMeta?: Record<noteId,
    {sequenceNum, revision, signerDeviceId}>}`; the snapshot response is
    `{snapshot, sequenceNum, signerDeviceId, revision?}` with `snapshot` null when
    absent. A note absent from `snapshotMeta` has no server snapshot at all
    (`apps/sync-server/src/services/crdt.ts:291`).

11. **Snapshots use the identical packed envelope as updates** (chapter 04, fact 12).
    There is no separate snapshot envelope
    (`apps/desktop/src/main/sync/crdt-snapshot-batch.ts:137`,
    `apps/desktop/src/main/sync/runtime.ts:634`).

12. **Note bodies never travel in the record feed.** An update push carries
    `content: null` in the record payload, so the CRDT feed is the only way a device
    sees a body edit (`packages/sync-client/src/pull/crdt-pull.ts:9-11`).

13. **There is no server side snapshot creation threshold.** No update count, byte
    total, or age triggers server side compaction anywhere in
    `apps/sync-server/src/services/crdt.ts`. A snapshot exists only because a client
    pushed one, and pruning only happens once one does. A client that never pushes a
    snapshot causes unbounded growth of that note's update log, which is a real cost
    for a phone that edits a lot and snapshots never.

14. **Route ordering is load bearing**: store, then prune, then broadcast, never
    broadcast between store and prune
    (`apps/sync-server/src/routes/sync.ts:896-936`, rationale at `:905-918`).

15. **CRDT rate limits** are per device, not per account, because body sync is
    device-local work (`apps/sync-server/src/routes/sync.ts:576-621`):
    `crdt_push` 300 per 60 s, `crdt_pull` 600 per 60 s, `crdt_batch_pull` 30 per
    60 s. The per-request body ceiling for `/sync/*` is 8 MiB
    (`apps/sync-server/src/index.ts:56-62`), which is what actually bounds a
    100-update push.

### Open questions

- **Q07.1 (the journal question, and the one FR-003 names).**
  `CRDT_SYNC_ITEM_TYPES = ['note']` (`packages/contracts/src/sync-api.ts:91`) and
  `EncryptedCrdtItemSchema.type` is `z.literal('note')`
  (`packages/contracts/src/crypto.ts:194`). But the pull coordinator routes **both**
  `note` and `journal` into the CRDT body feed
  (`packages/sync-client/src/pull/engine.ts:305`), the feed's own header says
  "Note/journal bodies never travel in the record feed"
  (`packages/sync-client/src/pull/crdt-pull.ts:9-11`), journal ids are real Y.Doc
  names of the form `j2026-08-13`
  (`apps/desktop/src/main/sync/crdt-legacy-partition.ts:19-32`), and
  `apps/desktop/src/main/lib/id.ts:20` generates them. The constant is wrong or the
  routing is. The chapter must state, normatively, that a journal body is a
  collaborative document keyed by `j<YYYY-MM-DD>`, and the constant must be
  corrected or explicitly documented as "CRDT item types for the record envelope's
  purposes only". No implementation may infer this at runtime.
- **Q07.2** `POST /sync/crdt/snapshot` accepts any snapshot from any device and the
  server cannot verify it contains the prior updates. The watermark stability rule
  (fact 5) is the mitigation, and there is no server side threshold (fact 13), so
  the entire compaction policy is a client decision that is written nowhere. State
  the client's obligation: when may a phone push a snapshot, and when must it? The
  platform-free engine explicitly does not push snapshots at all
  (`pull/crdt-pull.ts:16-18`), so the phone needs a rule before it starts.
- **Q07.3** There is no server side signature verification on CRDT updates, only on
  records. The update is signed and the client verifies, but a malicious server can
  drop or reorder updates. Is that in the threat model? Say so.
- **Q07.4** When a note is deleted, what happens to its `crdt_updates` and
  `crdt_snapshots`? Not read. A phone must know whether to delete its local Y.Doc.
- **Q07.5** `GET /sync/crdt/updates` caps at `min(limit, 500)` while the batch form
  caps at 100. Why the difference, and which should a new client use?
- **Q07.6** `snapshotMeta.signerDeviceId` is advertised but the baseline decision
  ignores it (`pull/crdt-pull.ts:161-166`). What is it for?

---

## 08-pack-container.md

### Derived from

`packages/contracts/src/pack-format.ts` in full, plus
`packages/contracts/src/sync-api.ts:488-551` for the listing endpoint.

### Normative facts this chapter must state

1. The exact layout, all integers **big-endian**, transcribed from the module
   docstring (`pack-format.ts:16-56`) and verified against the reader
   (`:213-268`):

   | Region | Offset | Size | Field |
   |---|---|---|---|
   | header | 0 | 4 | magic, ASCII `MPAK` |
   | header | 4 | 1 | format version, `PACK_VERSION = 1` |
   | header | 5 | 1 | reserved, 0 |
   | header | 6 | 2 | flags uint16, currently 0 |
   | payload | 8 | sum of entry lengths | opaque ciphertext, no padding or separators |
   | index | `indexOffset` | `entryCount` records | see below |
   | footer | end minus 53 | 32 | SHA-256 of the whole payload region |
   | footer | | 8 | `entryCount` uint64 |
   | footer | | 8 | `indexOffset` uint64, absolute file offset |
   | footer | | 4 | magic `MPAK` |
   | footer | | 1 | version echo |

   `PACK_HEADER_SIZE = 8`, `PACK_FOOTER_SIZE = 53` (`pack-format.ts:62-70`).

2. One index record, in order (`pack-format.ts:242-266`): `kind` uint8,
   `idLen` uint16 then `idBytes` UTF-8, `keyLen` uint16 then `keyBytes` UTF-8,
   `sortKey` int64, `metaLen` uint16 then `metaBytes` UTF-8 JSON or empty,
   `offset` uint64 relative to the start of the payload region, `length` uint64,
   `sha256` 32 bytes over that entry's payload bytes.

3. `PackKindCode`: `record = 0`, `crdt_snapshot = 1`, `crdt_update = 2`
   (`pack-format.ts:94-98`). An unknown code is a hard error, not a skip (`:248-249`).

4. Identity semantics: for records the identity is `type:id`; for CRDT kinds it is
   the note id (`pack-format.ts:31-32`). `sortKey` is `server_cursor` for records and
   `created_at` in epoch seconds for CRDT kinds (`:35-36`). Snapshot entries carry
   `{sequenceNum, revision}` in `metaBytes`, which is the freshness token a client
   compares against `snapshotMeta` before trusting the bytes (`:37-40`).

5. Reader obligations: reject on header magic or version mismatch (`:228-233`),
   footer magic or version mismatch (`:222-223`), payload digest mismatch
   (`:297-300`), or any per-entry digest mismatch (`:307-316`). A bad pack is treated
   as absent and the client falls back to the item-granular endpoints; source blobs
   are never derived and never vanish (`:52-55`).

6. Memory bounds are structural, not advisory
   (`pack-format.ts:72-92`): `PACK_MAX_INDEX_ENTRY_BYTES = 4096`,
   `PACK_MAX_ENTRIES = 4096`, `PACK_MAX_INDEX_BYTES` their product. These exist
   because `indexOffset` and each entry's `length` are attacker or corruption
   controlled and size the reader's allocations.

7. Immutability: a pack is never modified after its single PUT. New data goes into
   new packs, stale entries stay as dead bytes forever, and the whole thing is a
   derived cache (`pack-format.ts:52-55`).

8. Listing: `GET /sync/packs` returns `PackListResponseSchema`
   (`packages/contracts/src/sync-api.ts:538-547`). `byteSize` is the payload region
   only and is explicitly **not** a file length, so a reader must not range-request
   against it (`:526-531`). `url` is a presigned GET present only when the
   deployment opted into presigned transfers, with `expiresAt` in epoch seconds;
   absent means "use the item-granular endpoints" (`:507-511`). `nextCursor` is an
   opaque keyset token and packs arrive newest first (`:541-546`).

9. Coverage is not total. Records tile their cursor axis completely; snapshot
   coverage can under-cover same-second writes, and holes inside a range from
   replaced or deleted items are dead bytes. Membership is verified against the
   pack's own index block, never assumed (`packages/contracts/src/sync-api.ts:512-517`).

### Open questions

- **Q08.1** `crdt_update = 2` is defined but reserved: updates live in D1 and have no
  R2 small-object GET floor to kill
  (`packages/contracts/src/sync-api.ts:492-497`). Will a reader ever see kind 2?
  If not, say a conforming reader may reject it.
- **Q08.2** The writer lives server side and is not in `packages/contracts`. Is a
  client ever a pack writer? If never, say so, and the Rust core only needs a
  reader.
- **Q08.3** `flags` is a uint16 fixed at 0. Reserved for what? A reader that rejects
  a non-zero flags word is safer than one that ignores it. Pick.
- **Q08.4** Packs are optional. A conforming client that never fetches a pack is
  still correct, just slower. State that plainly so a Rust v1 can defer chapter 08
  without being non-conforming.

---

## 09-realtime.md

### Derived from

`packages/contracts/src/sync-socket.ts` in full, plus
`apps/sync-server/src/durable-objects/user-sync-state.ts:22-355`.

### Normative facts this chapter must state

1. **Handshake is headers only, never a query parameter and never a subprotocol**
   (`packages/contracts/src/sync-socket.ts:10-14`). `GET /sync/ws` with
   `Authorization: Bearer <accessToken>`, `X-App-Version: <semver>` which is
   mandatory, and `X-Memry-Vault-Id: <uuid>`. A socket without the vault id connects
   and then hears nothing, because every broadcast is filtered by the socket's
   attached vault (`user-sync-state.ts:149`, `:189`).

2. **Handshake failures** (`user-sync-state.ts:90-135`): invalid token is `401
   AUTH_INVALID_TOKEN`; a missing `X-App-Version` is `426 SYNC_VERSION_INCOMPATIBLE`;
   a version below `MIN_APP_VERSION` is `426 SYNC_VERSION_INCOMPATIBLE` with
   `minVersion` in the error object; a revoked or unknown device is `403
   AUTH_DEVICE_REVOKED`.

3. **One socket per device.** An existing socket tagged `device:<deviceId>` is closed
   with code 4001 when a new one connects (`user-sync-state.ts:137-141`).

4. **Message envelope** is `{ "type": string, "payload"?: object }` serialised as
   JSON (`user-sync-state.ts:184`, `:237`, schema at
   `packages/contracts/src/sync-socket.ts:51-57`). `type` is deliberately a plain
   string, not an enum, so a newer server can add a type without an older client
   treating the frame as corrupt; unknown names parse and are ignored (`:52-55`).

5. **Message types the server can send**
   (`packages/contracts/src/sync-socket.ts:18-27`): `changes_available`,
   `crdt_updated`, `calendar_changes_available`, `heartbeat`, `auth_ok`, `error`,
   `linking_request`, `linking_approved`. Payload shapes for the four a client acts
   on are at `:59-68`: `changes_available {cursor?, vaultId?}`,
   `crdt_updated {vaultId?, noteId}`, `auth_ok {exp?}`,
   `error {code?, message?}`.

6. **Keepalive must be exactly the string `ping`, answered `pong`.** The Durable
   Object registers `new WebSocketRequestResponsePair('ping','pong')`, so Cloudflare
   answers that one payload without waking the object or spending the socket's
   inbound rate-limit budget. Any other keepalive text is a real message that costs a
   wake on every beat (`packages/contracts/src/sync-socket.ts:31-40`).

7. **Re-authentication in place**: the client sends
   `{"type":"auth","payload":{"token":"..."}}` and the server answers
   `auth_ok` with the new `exp`
   (`packages/contracts/src/sync-socket.ts:86-89`, `user-sync-state.ts:355`).

8. **Close codes** (`packages/contracts/src/sync-socket.ts:42-49`,
   `user-sync-state.ts:22-26`): 4001 replaced, 4003 token expired, 4008 rate limited,
   4004 device revoked, 4009 version incompatible. **4004 and 4009 are terminal for
   the session**; the others are reconnectable.

9. **Frame parsing rules a conforming client must adopt**
   (`packages/contracts/src/sync-socket.ts:70-84`, `:95-130`): `null` is returned only
   when the frame is not a message envelope at all, which is the only case worth
   logging. Everything else, including the keepalive answer, an unhandled type, and a
   known type whose payload is missing what it needs, collapses to a single `ignored`
   outcome. An unrecognised frame must never reach a throw.

10. **Broadcasts are advisory.** `changes_available` carries an optional cursor; the
    client still runs its normal pull. A device is excluded from its own broadcast by
    `excludeDeviceId` (`user-sync-state.ts:188`).

### Open questions

- **Q09.1** There is no server push infrastructure for a backgrounded phone
  (spec.md Out of Scope). Does a conforming phone client open this socket at all, or
  is it foreground only? State the expectation so battery budget work has a target.
- **Q09.2** `heartbeat` is in the type list but has no payload schema and no handler.
  Server-initiated keepalive, or dead?
- **Q09.3** `calendar_changes_available`, `linking_request` and `linking_approved`
  have no payload schema in the contract. Linking on a phone needs at least the
  latter two. Specify them.
- **Q09.4** Reconnect policy, backoff, and what a client does between 4003 and a
  successful refresh are not specified anywhere. Write them.

---

## 10-bootstrap-session.md

### Derived from

`packages/contracts/src/bootstrap-api.ts` in full, plus
`apps/sync-server/src/routes/bootstrap.ts:33-180` and
`apps/sync-server/src/lib/errors.ts:41-55`.

### Normative facts this chapter must state

1. A bootstrap session is an elevated-throughput window a fresh device opens while
   it pulls an entire vault for the first time
   (`packages/contracts/src/bootstrap-api.ts:3-6`). It only ever **widens** server
   rate ceilings. A missing, expired or forged token degrades to steady-state
   behaviour byte for byte and can never fail an unrelated request (`:11-14`).

2. Routes, all under `/sync/bootstrap`, all behind auth, the client gate, the paid
   gate and the sync-types middleware (`apps/sync-server/src/routes/bootstrap.ts:35-38`):
   `POST /` to open, `POST /renew`, `POST /close` which is idempotent
   (`:86`, `:154`, `:173`).

3. The header is `X-Memry-Bootstrap-Token`, sent verbatim on elevated requests
   (`packages/contracts/src/bootstrap-api.ts:18`, `:22`).

4. The open response (`packages/contracts/src/bootstrap-api.ts:45-74`) is
   `{session: {token, expiresAt, ttlSeconds}, manifest: {items, nextCursor?,
   serverTime}, tailCursor, attachments?, packs}`. `manifest` is the **first page**
   of the paginated manifest, never the whole vault. `tailCursor` is the current
   `MAX(server_cursor)` so the client knows when its pull has caught up. `packs` is
   reserved and always present, always empty until the pack pipeline lands.
   `attachments.chunkHashes` is informational only and its `nextChunkCursor` names
   where a continuation page would start, with no continuation endpoint shipping yet.

5. Error codes and their meanings (`apps/sync-server/src/lib/errors.ts:41-55`):
   `BOOTSTRAP_NOT_ELIGIBLE` is a typed 409 meaning the device already synced this
   vault; `BOOTSTRAP_SESSION_LIMIT` is the per-user concurrent cap answering 429;
   `BOOTSTRAP_SESSION_INVALID` covers expired, forged or revoked tokens;
   `BOOTSTRAP_IDENTITY_MISMATCH` is the 403 for a valid token presented by another
   authenticated context, since renewal and close require the session's own
   identity; `BOOTSTRAP_SESSION_EXPIRED` is the typed end of life once the absolute
   maximum session lifetime is spent; `BOOTSTRAP_UNAVAILABLE` is a 501 when the
   deployment has no HMAC key configured
   (`apps/sync-server/src/routes/bootstrap.ts:53-64`).

6. Compatibility: old servers never mount these routes and answer 404. A new client
   treats **any** open failure, including 404, as "no bootstrap" and falls back
   silently to steady-state pacing (`apps/sync-server/src/routes/bootstrap.ts:28-31`).

7. **Constants** (`apps/sync-server/src/services/bootstrap-session.ts`):

   | Constant | Value | Line |
   |---|---|---|
   | `BOOTSTRAP_SESSION_TTL_SECONDS` | 3600 | `:37` |
   | `MAX_CONCURRENT_BOOTSTRAP_SESSIONS` | 2 | `:39` |
   | `BOOTSTRAP_RENEW_LEAD_SECONDS` | 300 | `:41` |
   | `MAX_BOOTSTRAP_SESSION_LIFETIME_SECONDS` | 21600 (6 hours) | `:53` |
   | `CHUNK_HASH_PAGE_LIMIT` | 512 | `routes/bootstrap.ts:51` |
   | session endpoint rate limit | 30 per 60 s, device keyed | `routes/bootstrap.ts:43-48` |

8. **Elevation multipliers**, which are the whole point of the session
   (`apps/sync-server/src/services/bootstrap-session.ts:242-249`):
   `crdt_pull` 5x, `crdt_batch_pull` 5x, `blob_download` 5x, `sync_pull` 3x,
   `sync_changes` 3x, `sync_manifest` 3x. A bucket not in this map is never
   elevated. The limiter clamps the multiplier with `Math.max(m, 1)` and treats a
   non-finite value as no elevation, so elevation can only ever widen
   (`apps/sync-server/src/middleware/rate-limit.ts:88-91`).

9. **The token is stateless.** Wire format is
   `base64url(JSON payload) . base64url(HMAC-SHA256(secret, encodedPayload))`, with
   base64url meaning standard base64 with `+` to `-`, `/` to `_`, and padding
   stripped. Claims are `{v: 1, userId, deviceId, vaultId, jti, iat, exp}`
   (`apps/sync-server/src/services/bootstrap-session.ts:62-71`, `:87-92`, `:121-141`).
   Verification is a constant-time HMAC compare plus claim shape and expiry checks,
   and returns null on any failure rather than throwing (`:160-205`). Renewal reuses
   the same `jti` and only extends `expires_at` (`:454-458`). There is a documented
   accepted residual: because elevation is stateless, a token whose session was
   explicitly closed keeps elevating from its own device until its `exp`, at most 60
   minutes (`:270-276`).

10. **Eligibility** is "this device has never synced this vault", meaning no
    `device_sync_state` row or a null or zero `last_cursor_seen`
    (`apps/sync-server/src/services/bootstrap-session.ts:297-313`). The concurrency
    cap is enforced atomically inside a single INSERT with a COUNT subquery
    (`:359-378`).

### Open questions

- **Q10.1** Is a bootstrap session required for FR-028 and SC-007 (a 10,000 item
  vault browsable within 2 minutes), or an optimisation? If required, chapter 10
  stops being optional for the Rust core. Note that a bootstrap session is
  one-shot per device per vault by design, so it cannot be used to recover from a
  later full resync.
- **Q10.2** With a 1 hour TTL, a 6 hour absolute lifetime and a 5 minute renewal
  lead, a first sync that exceeds 6 hours falls back to steady-state pacing
  mid-run. What is the client supposed to do, and does FR-028's progress reporting
  need to survive that transition?
- **Q10.3** `BOOTSTRAP_SESSION_HMAC_KEY` is optional per deployment. Confirm that
  staging has it, because the FR-011 headless round trip runs against staging and a
  501 there would look like a client bug.

---

## 11-client-policy.md

### Derived from

| Source | What it supplies |
|---|---|
| `apps/sync-server/src/lib/client-identity.ts:8-82` | header grammar, parsing, version comparison |
| `apps/sync-server/src/middleware/client-gate.ts:9-66` | the gate |
| `packages/contracts/src/sync-api.ts:262-287` | `ClientPolicy`, `SyncStatus` |
| `packages/sync-client/src/pull/client-header.ts` | the client side builder |
| `specs/001-mobile-app/contracts/sync-protocol-additions.md:11-85` | the reviewed contract text |

### Normative facts this chapter must state

1. **Header name** is `x-memry-client`, lowercase in both constants
   (`apps/sync-server/src/lib/client-identity.ts:8`,
   `packages/sync-client/src/pull/client-header.ts:3`). Note it is the only sync
   header written lowercase; `X-Memry-Sync-Types` and `X-Memry-Vault-Id` are
   TitleCase.

2. **Grammar**: `<platform>/<major>.<minor>.<patch>[+<build>]`, matched by
   `/^([a-z]+)\/(\d+)\.(\d+)\.(\d+)(?:\+([0-9A-Za-z.-]+))?$/`
   (`apps/sync-server/src/lib/client-identity.ts:26`). Platform must be one of
   `ios`, `android`, `desktop` (`packages/contracts/src/sync-api.ts:263`). The
   `+build` suffix is recorded and never compared. **Pre-release identifiers are
   rejected on purpose**: the floor comparison is a numeric triple compare, so
   accepting `1.0.0-beta.1` would let a beta satisfy a floor its release does not
   (`client-identity.ts:20-25`).

3. **Absent and malformed are the same case: treated as absent.** A parser bug must
   never be able to lock a paying user out of their own vault
   (`apps/sync-server/src/lib/client-identity.ts:31-36`, `:44-53`). No header means
   legacy desktop and full access, and that branch must stay free of database work
   (`middleware/client-gate.ts:36-38`).

4. **Reads are never gated.** `GET`, `HEAD` and `OPTIONS` bypass both the version
   floor and the kill switch, so a device dropped to read-only can still open every
   note it owns (`apps/sync-server/src/middleware/client-gate.ts:9-13`, `:34`).

5. **The kill switch is evaluated before the version floor.** When writes are off for
   a platform, `CLIENT_UPGRADE_REQUIRED` would send users chasing an update that
   cannot help them (`specs/001-mobile-app/contracts/sync-protocol-additions.md:46-49`,
   implemented at `middleware/client-gate.ts:44-54`).

6. **Responses**:

   | Condition | Status | Body |
   |---|---|---|
   | kill switch on for this platform | 403 | `{error:{code:"PLATFORM_WRITES_DISABLED", message}}` |
   | client version below the floor | 426 | `{error:{code:"CLIENT_UPGRADE_REQUIRED", message, minVersion}}` |

   `minVersion` rides **inside** the error object, not at the top level
   (`apps/sync-server/src/middleware/client-gate.ts:22-25`, `:56-65`).

7. **Policy is discoverable without attempting a write.** `GET /sync/status` echoes
   `clientPolicy: {platform, writesEnabled, minWriteVersion?}` when the request
   identified itself, and omits it entirely for a legacy desktop
   (`packages/contracts/src/sync-api.ts:266-287`,
   `packages/sync-client/src/pull/engine.ts:454-466`).

8. **An unreadable policy degrades to allow.** An absent row, a NULL floor, or an
   unparseable floor all resolve to allow, never to a lockout
   (`specs/001-mobile-app/contracts/sync-protocol-additions.md:49-52`).

9. **Client obligation on either code**: enter explicit read-only mode with a plain
   explanation and an update path, **park** the outbox so queued writes are
   preserved and no attempt accrues backoff, poll the policy on foreground and on
   interval, and resume automatically when clear
   (`specs/001-mobile-app/contracts/sync-protocol-additions.md:56-59`, reference
   implementation `apps/mobile/src/sync/outbox.ts:259`, `:364-369`, `:706-733`).

10. **Write attribution**: the server stamps `client_platform` and `client_version`
    from the header on `sync_items`, `crdt_updates` and `crdt_snapshots`, NULL
    meaning a pre-header client. Only the semver triple is persisted; the `+build`
    suffix is parsed and dropped because build numbers are not orderable across
    release branches. Attribution records the **latest** writer, not the creator
    (`specs/001-mobile-app/contracts/sync-protocol-additions.md:71-85`).

11. The WebSocket has its own, separate version gate using `X-App-Version` against
    `MIN_APP_VERSION`, answering 426 `SYNC_VERSION_INCOMPATIBLE`
    (`apps/sync-server/src/durable-objects/user-sync-state.ts:99-122`). It is not the
    same mechanism as `x-memry-client` and the chapter must not conflate them.

### Open questions

- **Q11.1** Two version gates coexist: `x-memry-client` plus `client_policies` on
  HTTP writes, and `X-App-Version` plus `MIN_APP_VERSION` on the WebSocket. A phone
  must satisfy both with two different version strings. Is that intended? Which one
  does the read-only UI react to?
- **Q11.2** The client policy is only echoed on `GET /sync/status`. What is the poll
  interval a conforming client should use, and is there a push channel for a flipped
  switch (the socket's `error` frame)? FR-035 and the beta gate in FR-070 depend on
  the switch taking effect without a restart.
- **Q11.3** Attribution keeps only the latest writer. After a desktop rewrite the row
  is no longer mobile-originated, so a targeted rollback window is bounded by how
  fast desktops touch rows. Record that limitation where an incident responder will
  read it.

---

## 12-note-body-format.md

This is the chapter the decision record calls the single hard constraint. It has to
be precise enough that a body written by a Rust client and read by desktop is
byte-identical, which is FR-041 and SC-010.

### Derived from

| Source | What it supplies |
|---|---|
| `packages/contracts/src/ipc-crdt.ts:57`, `packages/contracts/src/webview-bridge.ts:35` | the fragment name |
| `packages/app-core/src/markdown.ts` | frontmatter split, parse, serialise |
| `packages/shared/src/markdown-source.ts` | the three-way merge and byte-identity rules |
| `packages/editor-schema/src/blocks/markdown.ts` | block grammar |
| `packages/editor-schema/src/inline/*.ts`, `packages/shared/src/date-mention.ts` | inline grammar |
| `packages/shared/src/{inline-colors,block-markers,block-colors,link-references}.ts`, `packages/shared/src/critic-markup/` | the out-of-band encodings |
| `packages/editor-schema/src/conformance.ts` | the existing corpus |

### Normative facts this chapter must state

1. **The body fragment is an `XmlFragment` named `prosemirror`**, declared twice with
   the same value: `CRDT_FRAGMENT_NAME` (`packages/contracts/src/ipc-crdt.ts:57`, pinned
   by `packages/contracts/src/ipc-crdt.test.ts:38`) and `BRIDGE_FRAGMENT_NAME`
   (`packages/contracts/src/webview-bridge.ts:35`). Its layout is what y-prosemirror
   gives a BlockNote document.

2. **The other Y.Doc roots on the same note document**, all production:

   | Root | Yjs type | Owner |
   |---|---|---|
   | `prosemirror` | XmlFragment | the body |
   | `meta` | Map | `apps/desktop/src/main/sync/crdt-writeback.ts:666` |
   | `tags` | Array | `apps/desktop/src/main/sync/crdt-feed.ts:93` |
   | `markdownSource` | Map | `packages/shared/src/markdown-source.ts:142` |
   | `linkReferenceDefinitions` | Array | `packages/shared/src/link-references.ts:158` |
   | `linkReferenceUsages` | Array | `packages/shared/src/link-references.ts:159` |
   | `criticMarkupMarks` | Array | `packages/shared/src/critic-markup/yjs.ts:9` |
   | `probe` | Map | persistence probes only, `crdt-persistence.ts:230` |

   A client that replays only `prosemirror` loses tags, link references, suggestion
   marks and the preserved source.

3. **Document ids are bare.** Desktop keys every Y.Doc by the bare note id, with no
   namespace prefix (`apps/desktop/src/main/sync/crdt-provider.ts:1106`, `:1347`).
   Journal documents are keyed `j<YYYY-MM-DD>`. The two-namespace update log
   (`<docId>` for server sequence numbers, `local.<docId>` for local ones) is a
   **storage** convention invented by the mobile client
   (`apps/mobile/src/editor/session.ts:27`, `:35-40`), not a protocol fact. Chapter 12
   should say so and hand it to `data-model.md`.

4. **Frontmatter** (`packages/app-core/src/markdown.ts`):
   - `splitFrontmatterBlock` slices the block by hand with `---` delimiters so that
     `block + body === raw` holds byte exactly (`:10-39`). A BOM is included in the
     block. Delimiters are compared after stripping a trailing `\r`, so CRLF files
     parse. **An unclosed block is not frontmatter** and the whole file is body
     (`:39`).
   - `parseMarkdownNote` records `eol` (`\r\n` if the file contains one, else `\n`),
     `hadTrailingNewline`, and never trims the body (`:51-62`).
   - **Preservation rule**: unless the frontmatter was edited, the original raw block
     is re-emitted **verbatim**, which is what preserves comments, key order,
     quoting, CR bytes and the BOM (`:86-88`). If the body is unchanged it too is
     emitted verbatim (`:90-92`).
   - On the edited path, `stringifyFrontmatterBlock` drops `undefined` values, emits
     `''` for zero keys, and delegates to `matter.stringify`, then strips the
     trailing newline and re-appends exactly one `eol` so an edited save cannot
     accrete a blank line (`:113-124`). **Key order is JavaScript object insertion
     order and quoting is whatever js-yaml chooses. There is no explicit ordering or
     quoting policy**, and the function's own docstring calls itself interim
     (`:110-111`).
   - New files are written LF only with a single trailing newline, and user content
     never flows through `matter.stringify` (`:131-133`).

5. **Preserved source text.** `packages/shared/src/markdown-source.ts` is how a note
   the user did not edit comes back byte identical:
   - `restoreMarkdownSource(canonicalNow, source, canonicalize)` returns `source`
     **untouched** when the canonical form is unchanged (`:68`).
   - Trailing newlines are trimmed on both sides before comparison because an open
     editor keeps an empty trailing paragraph (`:62-67`).
   - A merge is never trusted unproven: the merged text is re-parsed and written only
     if it canonicalises back to the same canonical form; otherwise the house style
     wins (`:70-72`).
   - The three-way merge itself (`:88-136`): line diffs of the source and the
     canonical form against a common base, both computed with
     `markdownAlignmentKey` (`:215-221`, strips heading, bullet and quote markers,
     strips `_` and `*`, collapses whitespace), hunks sorted by base position,
     adjacent hunks with no stable base line between them coalesced into one region,
     then per region: ours-only wins ours, theirs-only wins theirs, and a genuine
     both-sides conflict resolves to **ours**, the house style. `MAX_EDIT_DISTANCE =
     2000` aborts the whole merge with `null` (`:200`, `:97-100`).
   - Channel: Y.Map root `markdownSource` (`:142`), one key holding `{source}`. The
     write is skipped when the value is already identical, so no spurious Y update
     (`:165`). Recording is budgeted at
     `MARKDOWN_SOURCE_SNAPSHOT_BUDGET_BYTES = floor(NOTE_SYNC_MAX_BYTES / 2)`
     (`apps/desktop/src/main/sync/blocknote-converter.ts:505`).

6. **Block grammar** (`packages/editor-schema/src/blocks/markdown.ts`), the forms
   that are not plain CommonMark:

   | Block | On-disk form | Anchor |
   |---|---|---|
   | callout | `> [!info\|warning\|error\|success]` alone on its line, then one `> ` per non-empty content line | `:26`, `:45-50` |
   | structured quote | one `> ` per line, a bare `>` for each blank line between the quote's own blocks | `:165-170` |
   | youtube embed | `![embed](videoUrl)` | `:307`, regex `:304` |
   | bookmark | `![bookmark](url)` | `:311`, regex `:305` |
   | file | `<!-- file:{...} --> `, an HTML comment with JSON props | `:358`, `:383`, regex `:349` |
   | toggle | `<details data-memry-toggle>` / `<summary>...</summary>` / blank / body / blank / `</details>`; `open` variant adds ` open` | `:487-519`, constants `:439`, `:446`, `:447` |

   Claiming rules matter as much as the forms. A callout marker regex is strict:
   `> [!note]` and `> [!info] A title` are deliberately not claimed (`:32-36`), a
   run abutting more quote lines is refused whole (`:93`), and a run is claimed only
   **by proof**, meaning the body re-serialises byte for byte (`:145-151`).
   Structured quotes refuse a `>text` line (`:220-221`) and only claim a run that is
   separated or nested (`:226`). The file marker's JSON key order is fixed as
   `url, name, size, mimeType`, then `width` and `height` only when greater than
   zero and `align` only when set and not `left`, so legacy markers stay byte
   identical (`:384-399`), and the comment terminator escape replaces only the `>`
   in `-->` and `--!>` with `>` so a filename containing `--` keeps its bytes
   (`:373-375`).

7. **Inline grammar**:

   | Inline type | On-disk form | Anchor |
   |---|---|---|
   | `wikiLink` | `[[target]]`, or `[[target\|alias]]` when the alias differs | `packages/editor-schema/src/inline/wiki-link.ts:131-133` |
   | `hashTag` | `#tag` as a bare span's text | `inline/hash-tag.ts:38-42` |
   | `dateMention` | `((date:<payload>))`, payload alphabet `[A-Za-z0-9,;_-]` | `packages/shared/src/date-mention.ts:32`, `:103` |
   | `linkMention` | `((mention:<encoded url>))` | `inline/link-mention.ts:25`, `:50` |
   | `inlineImage` | `![alt](src)`, width carried in the alt as `alt\|300` with a purely numeric tail | `inline/inline-image.ts:84-92`, `:112` |
   | `inlineCheckbox` | `<input type=checkbox>` DOM, table cells only | `inline/inline-checkbox.ts:79`, `:107-112` |

   `linkMention` encodes seven characters beyond `encodeURIComponent`
   (`! ' ( ) * ~ _`) so the token alphabet closes to `[A-Za-z0-9.%-]`, with a wider
   legacy acceptance union (`inline/link-mention.ts:39-48`, `:66`). `wikiLink` style
   marks nest outer to inner as `bold, italic, underline, strike, code`
   (`inline/wiki-link.ts:150-157`); `underline` is chip-only and reaches disk
   through the inline colour span masking instead.

8. **The five out-of-band encodings** named in spec.md FR-005, with their
   implementations:

   | Encoding | Where it lives | Anchor |
   |---|---|---|
   | inline colours | `MEMRYICO<n>:` / `:MEMRYICC;` tokens masking `<span style=...>` | `packages/shared/src/inline-colors.ts:74`, `:310-311` |
   | block markers | `<!-- align:... -->`, `<!-- table-layout:{...} -->`, `<!-- colors:{...} -->`, `<!-- table-colors:{...} -->` | `packages/shared/src/block-markers.ts:28`, `:62`, `:141`; `block-colors.ts:11`, `:79` |
   | suggestion marks | CriticMarkup, Y.Array root `criticMarkupMarks` | `packages/shared/src/critic-markup/parser.ts:153`, `yjs.ts:9` |
   | link references | stripped from the body, Y.Array roots `linkReferenceDefinitions` and `linkReferenceUsages` | `packages/shared/src/link-references.ts:65`, `:118`, `:158-159` |
   | preserved source | Y.Map root `markdownSource` | `packages/shared/src/markdown-source.ts:142` |

9. **The registry FR-040 enumerates** must be stated here and cross-linked to the
   editor schema, so a build-time check can fail when the registry grows a type the
   requirement does not name. The registration invariant that every spec is
   registered under its own `config.type` is enforced at
   `packages/editor-schema/src/spec-keys.ts:59`.

10. **Markdown conversion belongs to the WebView bundle, in both directions. This
    answers Q12.2 and the chapter must state it as a normative division of labour.**

    | Direction | Who | How |
    |---|---|---|
    | document to markdown | the WebView bundle, BlockNote plus `@memry/editor-schema` | the existing `export-markdown` bridge message |
    | markdown to document | the WebView bundle, same code | a new `seed-from-markdown` bridge message, used on note creation and on template application |
    | document to plain text | the core | `extract_text(doc)`, a plain-text walk of the `prosemirror` `XmlFragment` that keeps headings and list markers, drops everything else, and claims no markdown fidelity. It feeds FTS `content` and previews, nothing else |

    A conforming non-desktop client therefore needs **no markdown grammar and no
    BlockNote block model**. What it does need is exact preservation of the Y.Doc
    roots in fact 2 across an apply-then-encode cycle, which is what the round-trip
    corpus and its out-of-band-encodings group assert.

    The consequence for FR-041: byte identity holds structurally, because a client
    that cannot serialise markdown cannot write a vault file, and desktop stays the
    only writer.

    There is no exception for **frontmatter**: a create-time `content` payload is
    handed to the bundle verbatim through `seed-from-markdown`, and the bundle splits
    the frontmatter block per fact 4 before it parses the body. A non-desktop core
    therefore does no markdown handling at all, frontmatter included, and a new
    note's tags and properties come from the note record payload.

11. **The cross-shell digest SC-010 compares is defined here, not left to each
    harness.**

    | Item | Digest |
    |---|---|
    | a note | SHA-256 over the UTF-8 bytes of `title + "\n" + extract_text(doc)` |
    | a task or journal record | SHA-256 over the canonical JSON of that record's syncable fields |

    Both shells compute it the same way: the core in
    `crates/memry-core/src/crdt/digest.rs`, desktop in
    `packages/contracts/scripts/digest.ts` over a TypeScript `extract_text` port.
    `extract_text` is specified by the `text-extract.json` vector class
    ([conformance-vectors.md](./conformance-vectors.md) §11.2), so the two ports are
    pinned to the same output before any digest is compared and a mismatch means the
    content differs rather than the extractors differing.

### Open questions

- **Q12.1** Frontmatter key ordering on the edited path is JavaScript insertion
  order with js-yaml quoting, and `stringifyFrontmatterBlock` calls itself interim
  ("spec 05 owns the real one", `packages/app-core/src/markdown.ts:110-111`). FR-001
  requires the chapter to state frontmatter key ordering. Either the chapter
  specifies the real ordering and both implementations adopt it, or it states that
  the only guarantee is the unedited verbatim path and that any frontmatter edit
  may reorder keys. Pick one; today there is no answer.
- **Q12.2 ANSWERED. The WebView owns both directions; the core owns neither.** See
  fact 10 below. Nothing here is open; the entry stays so a reader who arrives from
  another chapter's cross-reference finds the answer rather than the question.
- **Q12.3** The three-way merge resolves a genuine conflict in favour of the house
  style (`markdown-source.ts:127-131`), which means a user's hand-written formatting
  loses. Correct, and is a second implementation required to reproduce the Myers
  diff and the alignment key exactly? If yes, that is a substantial vector class.
  If the core never merges (because the WebView owns conversion), say so and the
  chapter shrinks a lot. Fact 10 takes that branch: the core never merges, so what
  remains open is only whether desktop's own behaviour is normative for desktop.
- **Q12.4** `MAX_EDIT_DISTANCE = 2000` aborts the merge and falls back to house
  style. That is a silent, size-dependent behaviour change. State it as normative or
  as an implementation budget.
- **Q12.5** Chapter 12 must state which of the eight Y.Doc roots a conforming client
  is **required** to preserve versus merely allowed to ignore. A client that drops
  `criticMarkupMarks` on a round trip violates FR-033.
- **Q12.6** `inlineImage` and `inlineCheckbox` are claimed only inside `td` and `th`
  (`inline/inline-image.ts:107-109`). What is the encoding outside a table? Not read.

---

## 13-payload-schemas.md

One section per item type this feature subscribes to. spec.md Assumptions fixes the
list at thirteen: `note`, `journal`, `folder_config`, `custom_icon`,
`tag_definition`, `tag_category`, `property_definition`, `template`, `task`,
`project`, `task_activity`, `reminder`, `settings`.

### Derived from

`packages/contracts/src/sync-payloads.ts` for twelve of them and
`packages/contracts/src/settings-sync.ts` for `settings`.

### Normative facts this chapter must state

1. **The forward-tolerance convention, stated once and applied to every type.**
   Almost every field on almost every payload is optional on purpose: a payload
   written by a newer client must still parse on an older one, so a missing or
   renamed field degrades to a skip rather than a whole-page parse failure that
   advances the cursor past good data
   (`packages/contracts/src/sync-payloads.ts:173-181`).

2. **The absent-versus-null distinction**, which is load bearing and is stated in
   three separate schema comments: `undefined` (key absent) means the sender does not
   know the field and the local value must be kept; `null` is an explicit clear.
   Receiving handlers must gate on key presence, not on `?? existing`
   (`packages/contracts/src/sync-payloads.ts:124-126`, `:300-302`, `:390-395`).

3. **The `SyncTimestampSchema` union.** `createdAt` and `modifiedAt` on `note` and
   `journal` accept **either a string or a number** and normalise a number through
   `new Date(value).toISOString()`
   (`packages/contracts/src/sync-payloads.ts:21-23`). This exists because the React
   Native client wrote `Date.now()` where the schema said string, every note a phone
   edited failed `safeParse` on desktop, and the applier skipped the item and
   advanced the cursor without retry. Six notes in one staging vault were in that
   state before it was noticed (`:6-20`). The union is permanent because the rows are
   on disk and on the server. This is the single most important cautionary fact in
   the whole specification and it belongs in chapter 13 verbatim.

4. **Per type, the exact field list and the fields with non-obvious semantics.**
   A table per type with field name, type, optionality, and any special rule. The
   ones that carry a rule:

   | Type | Field | Rule |
   |---|---|---|
   | `note` | `content` | nullable; a CRDT update push carries `content: null` |
   | `note` | `fileType` | `markdown \| pdf \| image \| audio \| video`; binary types have no CRDT body |
   | `note` | `properties` | free-form record; values only, not definitions |
   | `journal` | `date` | optional **only** so a delete tombstone can omit it; a create or update without it is rejected by an explicit guard in the handler, not by the schema (`:274-281`) |
   | `task` | `repeatConfig` | `z.unknown()`, opaque |
   | `task` | `fieldClocks` | present; `task` is one of two field-merged types |
   | `project` | `statuses`, `links` | nested arrays with their own schemas (`:216-236`) |
   | `task_activity` | all | append-only and immutable, hence no `fieldClocks` and no `modifiedAt`; `oldValue`/`newValue` are JSON-encoded scalars and always `null` for `description` because the body can be note-sized (`:77-84`) |
   | `template` | `properties` | must stay an array or `applyTemplate` throws at note-creation time (`:102-105`) |
   | `tag_definition` | `colorAuthored` | absent means "cannot tell" and the receiver honours the colour; only a sender that knows the field can say `false` (`:293-296`) |
   | `tag_definition` | `views` | `undefined` keeps the local value, `null` is an explicit clear (`:300-302`) |
   | `property_definition` | `options` | opaque JSON **text**, deliberately not re-declared, so a newer client's per-option field is not parsed away on a round trip (`:307-321`) |
   | `custom_icon` | `data` | base64 image bytes carried inline, because a normalised icon is a few KB and this keeps every device's icon directory self-healing (`:348-354`) |
   | `folder_config` | `icon` | `z.string().nullable()`, the only non-optional field on the type |
   | `reminder` | `triggeredAt` | **deliberately absent from the payload**: each device shows its own notification, so a synced value would suppress it on a device that never displayed it. Dismiss and snooze state does sync (`:146-153`) |
   | `settings` | whole payload | `{settings, fieldClocks}` where `fieldClocks` is keyed by dotted path (`packages/contracts/src/settings-sync.ts:113-116`) |

5. **Which merge algorithm each type uses.** `task` and `project` carry
   `fieldClocks` and use field-level merge; `settings` uses dotted-path field clocks
   with its own key space; every other subscribed type carries only `clock` and uses
   the document-level resolver
   (`packages/sync-client/src/item-handlers/types.ts:53-68`). `settings` is the one
   record type exempt from the clock requirement
   (`packages/contracts/src/sync-api.ts:64-89`).

6. **Item id conventions per type.** Some are not UUIDs: `tag_definition` ids are
   tag names, `folder_config` ids are folder paths, and the sync bookkeeping key must
   therefore be `(type, id)` and never id alone. An id-only key made a project and a
   tag both named `inbox` share one entry and corrupt each other's state on
   2026-07-18 (`apps/desktop/src/main/sync/engine/sync-context.ts:118-124`).
   `settings` has exactly one item, `synced_settings`
   (`packages/sync-client/src/settings-sync.ts:195-196`).

7. **The twelve types that are served but not subscribed to** in this feature:
   `attachment`, `inbox`, `filter`, `calendar_event`, `calendar_source`,
   `calendar_binding`, `calendar_external_event`, `agent_conversation`,
   `agent_message`, `canvas`, `canvas_folder`, `bookmark`, `home_page`. The chapter
   states that a conforming client omits them from `X-Memry-Sync-Types` and never
   sees them, and cross-references chapter 05 for what happens if one arrives.

### Open questions

- **Q13.1** The `settings` payload merges rather than replaces, and a client must
  round-trip groups it does not model without stripping them
  (`specs/001-mobile-app/data-model.md:164-167`). The `SyncedSettingsSchema` is a
  closed Zod object, so an unknown group is stripped on parse. Where is the verbatim
  copy kept? If nowhere, FR-033 is already violated by desktop and the chapter must
  say what the correct behaviour is.
- **Q13.2** Every payload schema is a Zod object, which strips unknown keys by
  default. The only stated verbatim-preservation obligation is on the pull store
  (`packages/sync-client/src/pull/store.ts:5-10`), which requires the shell to keep
  the decrypted payload string untouched and only ever parse a copy. Chapter 13 must
  make that obligation normative rather than a store comment, because it is the
  whole of FR-033.
- **Q13.3** Is `home_page` really out of scope? It is in `RECORD_SYNC_ITEM_TYPES` and
  spec.md excludes Home. Confirm that not subscribing to it cannot orphan anything.
- **Q13.4** `task_activity` is append-only and unbounded. `task-activity-retention.ts`
  exists in `packages/sync-client`. What retention does a phone apply, and does
  deleting local rows re-pull them forever?

---

## 14-attachments.md

Scope marker: this chapter is written as **read-only and deferred**. spec.md puts
attachments at "Partial": `file`, `audio` and `video` blocks render their existing
metadata in place, downloading their bytes is deferred, uploading any attachment
from the phone is deferred, and inline images are the exception with lazy download
on unmetered connections. The chapter exists so the format is written down now and
so a later feature does not re-derive it.

### Derived from

| Source | What it supplies |
|---|---|
| `packages/contracts/src/blob-api.ts` | every request and response schema |
| `apps/sync-server/src/routes/blob.ts:150-838` | the routes |
| `apps/desktop/src/main/sync/attachments.ts:44, 220-243, 447-522, 808-810, 1363-1364` | chunking, framing, hashing |
| `packages/sync-client/src/push/attachment-manifest.ts` | the manifest envelope |

### Normative facts this chapter must state

1. **Chunking.** Plaintext is split into fixed 8 MiB chunks, with the final chunk
   short (`apps/desktop/src/main/sync/attachments.ts:44`, `:220-243`). At most 128
   chunks per upload session (`packages/contracts/src/blob-api.ts:17`, `:32`), so the
   effective per-file ceiling is 1 GiB before plan limits.

2. **Per-chunk framing.** Each chunk on the wire is `nonce(24) || ciphertext`, built
   explicitly (`apps/desktop/src/main/sync/attachments.ts:463-466`) and unpacked the
   same way on read (`:808-810`). All chunks share one file key.

3. **Addressing.** A chunk's R2 identity is the lowercase hex SHA-256 of its framed
   ciphertext bytes, matched by `/^[a-f0-9]{64}$/`
   (`packages/contracts/src/blob-api.ts:10`). The object key is derived server side
   from the caller's user and vault scope, so clients never submit key material
   (`:5-8`). The plaintext chunk hash is a separate value used for the
   integrity check after decrypt
   (`packages/sync-client/src/push/attachment-manifest.ts:17-24`).

4. **Manifest contents** (`packages/sync-client/src/push/attachment-manifest.ts:26-36`):
   `id`, `filename`, `mimeType`, `size`, `checksum` (SHA-256 of the whole plaintext
   file), `chunks` (each `{index, hash, encryptedHash, size}`), `chunkSize`,
   `createdAt`.

5. **Manifest envelope and signature.** The manifest is `JSON.stringify`'d, UTF-8
   encoded, AEAD encrypted under a fresh file key with no AAD, the file key is wrapped
   under the vault key, and the four fields `encryptedManifest`, `manifestNonce`,
   `encryptedFileKey`, `keyNonce` are signed as canonical CBOR in
   `CBOR_FIELD_ORDER.ATTACHMENT_MANIFEST` order
   (`packages/sync-client/src/push/attachment-manifest.ts:47-72`,
   `packages/contracts/src/cbor-ordering.ts:20-25`). The threat model is on record:
   the manifest is the only thing that names the file, since chunks in R2 are opaque
   ciphertext addressed by hash, so the signature is what stops a server-side swap
   from redirecting a note's picture at somebody else's bytes (`:10-14`). Verification
   happens **before** unwrap and decrypt (`:104-109`).

6. **Routes** (`apps/sync-server/src/routes/blob.ts`):

   | Method | Path |
   |---|---|
   | GET, DELETE | `/sync/blob/:blob_key` |
   | POST | `/sync/attachments/upload/initiate` |
   | PUT | `/sync/attachments/upload/:session_id/chunk/:chunk_index` |
   | POST | `/sync/attachments/upload/:session_id/complete` |
   | GET, DELETE | `/sync/attachments/upload/:session_id` |
   | POST | `/sync/attachments/dereference` |
   | POST | `/sync/attachments/presign-batch` |
   | HEAD, GET | `/sync/attachments/chunks/:chunk_hash` |
   | GET, PUT | `/sync/attachments/:attachment_id/manifest` |

7. **Two transfer paths.** Proxied through the Worker, or direct to R2 with
   presigned URLs. Every presign field is optional on both request and response
   schemas, so an old client never sends them and a server without the presign
   secrets never returns them, and both shapes stay wire compatible
   (`packages/contracts/src/blob-api.ts:52-58`). `STORAGE_PRESIGN_UNAVAILABLE` is the
   typed, permanent signal to fall back
   (`apps/sync-server/src/lib/errors.ts:68-70`). Presign batch caps: 1024 hashes for
   download (`blob-api.ts:62`), 128 for upload (`:32`), 4096 for dereference (`:49`).

8. **Quota is reserved against ciphertext size**, not plaintext, because every chunk
   carries a nonce and a tag (`packages/contracts/src/blob-api.ts:18-24`).

9. **The `attachment` type is in `SYNC_ITEM_TYPES` but not in
   `ENCRYPTABLE_ITEM_TYPES` or `RECORD_SYNC_ITEM_TYPES`**
   (`packages/contracts/src/sync-api.ts:12` versus `:36-62`, `:127-153`). Attachments
   do not travel as record envelopes at all.

### Open questions

- **Q14.1** Inline images are in scope for this feature (FR-045) but the block types
  that reference them are not. Which routes does a read-only, inline-image-only
  client actually need? Minimally `presign-batch` plus `chunks/:chunk_hash` plus the
  manifest GET. Confirm and state, so the Rust core implements three routes rather
  than eleven.
- **Q14.2** What connects a `note` payload's `attachmentReferences` to a manifest?
  The mapping from a body's image reference to an attachment id was not read.
- **Q14.3** Chunk dereferencing is how bytes are garbage collected. A read-only
  client never dereferences. Confirm that never calling it is safe and does not leak
  quota.
- **Q14.4** `CHUNK_SIZE` is a desktop constant, not a contract constant. The manifest
  carries `chunkSize` per file, so a reader does not need it, but a writer does. If
  the phone never writes, this is moot; record that.

---

## Cross-chapter obligations

Four things must be true of `docs/protocol/` as a whole, and should be stated in
`00-overview-and-versioning.md` and enforced by review:

1. **Every normative fact carries a citation.** A chapter sentence with no
   `path:line` is a claim, not a specification.
2. **Every open question above is either answered in the chapter or restated in the
   chapter as an explicit "undefined, do not rely on this".** Silently dropping one
   is how it becomes a divergence.
3. **FR-008 is a test, not an intention.** Chapter 00 must name the mechanism that
   fails the suite when a covered format changes without the chapter and its vectors
   changing. The candidate mechanism is a digest of the chapter's fact tables
   checked against the constants they were derived from, in the same test that
   verifies the vectors. Design that in `conformance-vectors.md`.
4. **Verbatim payload preservation is normative, not an implementation note.** Q13.2
   binds every chapter: a client stores the decrypted payload exactly as received and
   pushes that stored string back, having parsed only a copy for its projections. A
   Zod object strips unknown keys, and a Rust struct does the same on
   deserialise-then-reserialise, so any chapter that describes a payload must say
   that the schema is a **reader** over a preserved string and never the storage
   shape. This is what FR-033 and SC-014 mean in practice, and it is asserted by the
   `payload-schemas.json` vector class.
