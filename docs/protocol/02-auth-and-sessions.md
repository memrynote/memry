# 02 — Authentication and sessions

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

## 2.1 The route table

**Normative** (`apps/sync-server/src/routes/auth.ts`, mounted at `/auth`,
`apps/sync-server/src/index.ts:216`):

| Method | Path                             | Auth                              | Request / response schema                                        | Line    |
| ------ | -------------------------------- | --------------------------------- | ---------------------------------------------------------------- | ------- |
| POST   | `/auth/otp/request`              | none, IP rate limited             | `RequestOtpRequestSchema` / `RequestOtpResponseSchema`           | `:234`  |
| POST   | `/auth/otp/resend`               | none, IP rate limited             | `ResendOtpRequestSchema`                                         | `:239`  |
| POST   | `/auth/otp/verify`               | none, IP rate limited             | `VerifyOtpRequestSchema` / `VerifyOtpResponseSchema`             | `:272`  |
| GET    | `/auth/oauth/:provider`          | none                              | redirect to the provider                                         | `:316`  |
| POST   | `/auth/oauth/:provider/callback` | none                              | `OAuthCallbackSchema`                                            | `:353`  |
| POST   | `/auth/oauth/:provider/native`   | none                              | `NativeOAuthSchema`                                              | `:435`  |
| POST   | `/auth/setup-token/renew`        | proof of the committed device key | `RenewSetupTokenRequestSchema` / `RenewSetupTokenResponseSchema` | `:508`  |
| POST   | `/auth/devices`                  | setup token                       | `DeviceRegisterRequestSchema` / `DeviceRegisterResponseSchema`   | `:560`  |
| GET    | `/auth/recovery-info`            | setup token                       | `{ kdfSalt, keyVerifier }`                                       | `:681`  |
| GET    | `/auth/key-verifier`             | access token                      | `{ kdfSalt, keyVerifier }`                                       | `:703`  |
| GET    | `/auth/recovery`                 | none, IP rate limited             | `{ kdfSalt, keyVerifier }`, possibly dummy                       | `:746`  |
| POST   | `/auth/setup`                    | access token                      | `FirstDeviceSetupRequestSchema`                                  | `:771`  |
| GET    | `/auth/devices`                  | access token                      | device list                                                      | `:805`  |
| POST   | `/auth/refresh`                  | refresh token in the body         | `RefreshTokenRequestSchema` / `RefreshTokenResponseSchema`       | `:881`  |
| POST   | `/auth/logout`                   | access token                      | —                                                                | `:925`  |
| POST   | `/auth/email/change`             | access token                      | `EmailChangeRequestSchema`                                       | `:952`  |
| POST   | `/auth/email/change/verify`      | access token                      | `EmailChangeVerifySchema`                                        | `:982`  |
| POST   | `/auth/logout-all`               | access token                      | —                                                                | `:1000` |
| DELETE | `/auth/account`                  | access token                      | `DeleteAccountRequestSchema`                                     | `:1015` |

`/auth/checkout-token` (`:820`) and the `/auth/billing*` family (`:831`, `:842`,
`:863`, `:868`, `:874`) exist and are **out of scope** for this feature.

### 2.1.1 The request and response shapes this feature uses

**Normative.** The table above names schemas; naming a TypeScript symbol is not
a specification. A port that cannot open that file must still be able to
serialise a request and deserialise a response, so the shapes are written out
here. Every field is JSON; `?` marks optional, meaning **absent**, never `null`.

**`POST /auth/otp/request`** and **`POST /auth/otp/resend`**

Request: `email` (string, an email address).
Response: `success` (bool), `expiresIn?` (number, seconds), `message?` (string).

**`POST /auth/otp/verify`**

Request: `email` (string), `code` (string, exactly six digits, `/^\d{6}$/`),
`sessionNonce?` (string, non-empty — §2.6), `devicePublicKey?` (string, 1 to
128 characters — §2.5).

Response: `success` (bool), then all optional: `accessToken`, `refreshToken`,
`setupToken`, `userId` (strings), `isNewUser`, `needsSetup` (bools). The token
fields are optional **on the same response** because which ones arrive depends
on whether the account exists and whether it still needs setup; a reader must
branch on their presence rather than assume a shape.

**`POST /auth/devices`** — request in §2.3.

Response: `success` (bool), `deviceId?`, `accessToken?`, `refreshToken?`,
`error?` (strings).

**`POST /auth/setup-token/renew`** — see §2.5 for the signature construction.

Request: `setupToken` (string), `challengeNonce` (string, 1 to 128),
`challengeSignature` (string, 1 to 256).
Response: `success` (bool), `setupToken` (string, **required** here, unlike the
verify response).

**`GET /auth/devices`**

Response: `{ devices: [{ id, name, platform, signingPublicKey, revokedAt }] }`.
The device id field is spelled **`id`**, not `deviceId`. `signingPublicKey` is
the Ed25519 key committed at registration and is what chapter 01 §1.4.0's
signer lookup resolves. `revokedAt` is null for a live device.

**`GET /devices`**

Response: `{ devices: [{ id, name, platform, appVersion, lastSyncAt, createdAt, updatedAt }] }`
for the account's live devices. `appVersion` is the build the device last
opened a realtime socket with (chapter 09 §9.2); it was added later, so a
client MUST treat a missing `appVersion` as unknown, never as current.

**`POST /auth/refresh`**

Request: `refreshToken` (string).
Response: `accessToken` (string), `refreshToken` (string), `expiresIn`
(number, seconds) — all three **required**. This is the one auth response with
no optional fields, and §2.9's rotation is why: a refresh that returned no new
refresh token would strand the client.

**`GET /auth/recovery-info`**, **`GET /auth/key-verifier`**, **`GET /auth/recovery`**

Response: `kdfSalt` (string), `keyVerifier` (string), both required. §2.7
covers when the values are dummies.

**`POST /auth/setup`**

Request: `kdfSalt` (string), `keyVerifier` (string).

**`POST /auth/oauth/:provider/native`** (§2.4)

Request: `idToken` (string, up to 4096), `sessionNonce?`, `devicePublicKey?`.
Response: `success` (bool), `isNewUser?`, `needsSetup?` (bools),
`setupToken?` (string).

## 2.2 Access tokens

**Normative.** Access tokens are JWTs signed with **EdDSA** (Ed25519). Required
claims, all enforced (`apps/sync-server/src/lib/jwt-verify.ts:5-7`, `:30-45`):

| Claim       | Required value           |
| ----------- | ------------------------ |
| algorithm   | `EdDSA`                  |
| `iss`       | `memry-sync`             |
| `aud`       | `memry-client`           |
| `type`      | `access`                 |
| `sub`       | the user id, non-empty   |
| `device_id` | the device id, non-empty |
| `exp`       | present                  |

Any other algorithm, issuer, audience or `type` is rejected. Setup tokens
additionally carry `jti`, which the client reads back out of its own token
(`apps/desktop/src/main/sync/token-manager.ts:65-69`).

**JWT clock tolerance is zero** on every normal path: `jwtVerify` is called with
no `clockTolerance` and `jose` defaults to 0
(`apps/sync-server/src/lib/jwt-verify.ts:30-34`). **A device whose clock is
wrong by more than the token's remaining life fails every request.** The single
exception is setup-token **renewal**, which passes
`clockTolerance: SETUP_TOKEN_RENEWAL_WINDOW_SECONDS`
(`apps/sync-server/src/services/auth.ts:290`) and then bounds the result with the
signed `renewable_until` claim (`:298`).

A conforming client SHOULD detect and surface clock skew rather than presenting
a stream of unexplained 401s; chapter 05 §5.16 gives the skew threshold the
client uses against server time.

## 2.3 Device registration

**Normative.** `POST /auth/devices` request fields
(`packages/contracts/src/auth-api.ts:22-32`):

| Field                | Rule                                                 |
| -------------------- | ---------------------------------------------------- |
| `name`               | 1 to 255 characters                                  |
| `platform`           | `macos \| windows \| linux \| ios \| android \| web` |
| `osVersion`          | optional                                             |
| `appVersion`         | non-empty                                            |
| `authPublicKey`      | the Ed25519 public key, standard base64              |
| `challengeSignature` | Ed25519 detached, standard base64                    |
| `challengeNonce`     | non-empty                                            |
| `sessionNonce`       | optional; see §2.6                                   |
| `vaultId`            | optional, max 128, defaults to `default`             |

The server sanitises `name` (255), `platform` (32) and `vaultId` (128) and
rejects an empty result with `400 VALIDATION_ERROR`
(`apps/sync-server/src/routes/auth.ts:607-613`).

### 2.3.1 The challenge

**Normative.** The nonce is **client-generated**, not server-issued:
`crypto.randomUUID()` (`apps/desktop/src/main/sync/device-registration.ts:61`).
The signed bytes are the UTF-8 encoding of

```
`${challengeNonce}:${jti}`
```

where `jti` is the **setup token's** `jti` claim
(`apps/desktop/src/main/sync/device-registration.ts:62-63`; recomputed
server-side at `apps/sync-server/src/routes/auth.ts:620`). There is **no domain
separation prefix and no CBOR**. The signature is Ed25519 detached, standard
base64. A failed verification is `401 AUTH_INVALID_TOKEN`
(`apps/sync-server/src/routes/auth.ts:621-624`).

### 2.3.2 Domain separation — Q02.2

The same Ed25519 key signs both this challenge and every record envelope
(chapter 04). The challenge's signed message is a bare `nonce:jti` UTF-8 string;
a record envelope's signed message is canonical CBOR. There is no domain
separation prefix on either.

**Disposition of Q02.2: answered — no prefix is mandated for these two contexts,
and one is mandatory for any third.** The reason is that the signing device is
the only party that chooses either message: `challengeNonce` is minted locally
(`apps/desktop/src/main/sync/device-registration.ts:61`) and the CBOR payload is
assembled locally from the device's own item
(`packages/sync-client/src/push/record-encrypt.ts:59-84`), so no remote party can
steer this key into signing bytes it did not construct. Note that the nonce is
**not** constrained to a UUID by the contract — `challengeNonce` is
`z.string().min(1)` (`packages/contracts/src/auth-api.ts:29`) — so a conforming
client MUST generate it from a CSPRNG and MUST NOT accept one from a server.

Any **future** signing context for this key MUST carry an explicit domain
separation prefix, and introducing one is a format change under chapter 00 §0.8
obligation 3.

### 2.3.3 Single-use setup tokens, and the device cap

**Normative.** `POST /auth/devices` inserts the token's `jti` into
`consumed_setup_tokens` with `INSERT OR IGNORE`; a zero row count means the token
was already spent and the answer is `401 AUTH_INVALID_TOKEN`
(`apps/sync-server/src/routes/auth.ts:570-578`). The consumed record expires 300
seconds after consumption (`:573`).

A user may hold at most **50** active (non-revoked) devices; the 51st
registration is `409 VALIDATION_ERROR`
(`apps/sync-server/src/routes/auth.ts:586-593`).

The server-assigned device id is a `crypto.randomUUID()`
(`apps/sync-server/src/routes/auth.ts:626`). Registration is idempotent on
`(user_id, auth_public_key)`: a repeat registration with the same public key
updates the row and returns the existing id rather than creating a second device
(`apps/sync-server/src/routes/auth.ts:629-640`).

## 2.4 Native OAuth exists for the phone

**Normative.** `NativeOAuthSchema` takes an `idToken` of at most 4096 characters
with **no** authorization code and **no** redirect URI
(`packages/contracts/src/auth-api.ts:57-61`), because iOS has no 127.0.0.1
loopback for the desktop flow (`packages/contracts/src/auth-api.ts:50-56`). A
phone MUST use `POST /auth/oauth/:provider/native`, not the callback route.

## 2.5 `devicePublicKey` and setup token renewal

**Normative.** `devicePublicKey` MAY be committed at OTP verify
(`packages/contracts/src/auth-api.ts:15`), OAuth callback (`:47`) or native OAuth
(`:60`) time, capped at 128 characters. Committing it is what makes
`POST /auth/setup-token/renew` possible: renewal is authorised by **proof of
possession of the committed key**, not by possession of the expired token
(`packages/contracts/src/auth-api.ts:63-72`). Omitting it yields exactly one
non-renewable five-minute token
(`packages/contracts/src/auth-api.ts:11-14`).

A client whose user has to find a 24-word recovery phrase SHOULD commit the key:
finding the phrase routinely outlasts five minutes
(`apps/desktop/src/main/ipc/auth-device-handlers.ts:425-428`).

### 2.5.1 What renewal signs

**Normative.** Renewal reuses §2.3.1's construction exactly. The signed message
is

```
UTF-8(`${challengeNonce}:${jti}`)
```

where `jti` is the JWT id of the **setup token being presented**, and the
signature is Ed25519 detached over those bytes, standard base64, no prefix and
no CBOR — identical in every respect to the device-registration challenge. Only
the token whose `jti` is signed can be renewed, which is what stops a leaked
nonce from renewing an unrelated grant.

Two consequences a client must handle, neither of which follows from the
request shape alone:

1. **The renewed token carries a new `jti`.** A client that cached the old
   `jti` to sign its later `POST /auth/devices` challenge will fail that call.
   Re-read `jti` from the renewed token every time.
2. **Presenting a grant retires it.** The old token goes into the same
   single-use ledger §2.3.3 describes, so renewal is a replacement, not an
   extension, and the old token is dead the moment the new one is issued.

## 2.6 `sessionNonce` — Q02.1

**Normative.** `sessionNonce` is optional on `VerifyOtpRequestSchema`
(`packages/contracts/src/auth-api.ts:10`), `OAuthCallbackSchema` (`:46`),
`NativeOAuthSchema` (`:59`) and `DeviceRegisterRequestSchema` (`:30`). It is
minted by the **client**, carried into the setup token as a claim
(`apps/sync-server/src/routes/auth.ts:296`, `:408`, `:475`), preserved across
renewal (`:549`), and enforced on `POST /auth/devices` **only when the token
carries one**: a mismatch is `401 AUTH_INVALID_TOKEN`
(`apps/sync-server/src/routes/auth.ts:615-618`).

**What it defends.** It binds the device that redeemed a setup token to the
browser or sheet session that obtained it. Without it, a setup token intercepted
between the OAuth sheet and the device registration call can be redeemed by a
different device; with it, the attacker also needs the nonce the victim's client
generated locally and never transmitted before the token was issued.

**A conforming client SHOULD send it** on both the sign-in call and the
subsequent `POST /auth/devices`, and MUST send the same value on both. A client
that sends it on neither gets today's behaviour and loses the defence. A client
that sends it on the sign-in call and omits it on registration is **rejected**,
because the token then carries a nonce and `undefined !== nonce`.

**Disposition of Q02.1: answered** (this section).

## 2.7 The three recovery-data routes

**Normative.** `GET /auth/recovery-info` (setup token,
`apps/sync-server/src/routes/auth.ts:681-697`) and `GET /auth/key-verifier`
(access token, `:703`) return the identical `{ kdfSalt, keyVerifier }` payload
for two different session states. `/recovery-info` answers
`400 VALIDATION_ERROR` when the account has no key material yet
(`:689-691`).

`GET /auth/recovery` is the **unauthenticated** variant
(`apps/sync-server/src/routes/auth.ts:746`). It always runs both the real lookup
and a deterministic dummy computation and selects between them with one response
shape, so that wall-clock timing and JSON serialisation are identical for an
existing and a non-existing account
(`apps/sync-server/src/routes/auth.ts:756-766`, rationale at `:752-755`).

### 2.7.1 What a client may say to the user — Q02.3

**Normative.** Because an unknown email yields plausible dummy `kdfSalt` and
`keyVerifier`, **a wrong email and a wrong recovery phrase are indistinguishable
to the client**: both end in an account key verifier mismatch (chapter 01
§1.4.1). A conforming client MUST NOT claim to know which one was wrong. The
permitted message is a single combined statement — "that email and recovery
phrase do not match an account" — and the client MUST NOT offer a
"this email is not registered" branch on this path, because doing so
reintroduces exactly the account enumeration the dummy data exists to prevent.

A client that has an authenticated session SHOULD use `GET /auth/key-verifier`
instead, where the account is known and a mismatch does mean "wrong phrase".

**Disposition of Q02.3: answered** (this section).

## 2.8 `POST /auth/setup` is one-shot

**Normative.** `POST /auth/setup` carries `{ kdfSalt, keyVerifier }`
(`packages/contracts/src/auth-api.ts:34-37`) and is guarded by
`WHERE ... AND kdf_salt IS NULL`, so it can only succeed once per account; a
second call is `409 VALIDATION_ERROR`
(`apps/sync-server/src/routes/auth.ts:786-792`).

A device that joined by linking MUST NOT call it: it already received the
account's key material over the linking channel and re-posting would either fail
with 409 or, worse, overwrite nothing while looking successful. Desktop skips it
on that path (`apps/desktop/src/main/sync/linking-service.ts:492-512`).

## 2.9 Refresh tokens rotate, and reuse is a security event

**Normative.** Refresh token rows are stored as a hex SHA-256 of the token. On
`POST /auth/refresh` the server looks for an unrevoked, unexpired row for
`(token_hash, user_id, device_id)` (`apps/sync-server/src/services/auth.ts:176-181`).
If there is none it looks for a row revoked within the last
`ROTATION_GRACE_SECONDS = 10` (`apps/sync-server/src/services/auth.ts:79`,
`:184-189`) and, if found, returns the current active token — this is what makes
a double-submitted refresh safe.

**Outside that grace window, an unknown refresh token revokes every token for
that device** before answering `401 AUTH_INVALID_TOKEN`
(`apps/sync-server/src/services/auth.ts:199-204`).

**A client that retries a refresh naively locks itself out.** This is why the
client side treats a 401 on refresh as terminal after three attempts (§2.10).

## 2.10 Client-side token lifecycle

**Normative** (`apps/desktop/src/main/sync/token-manager.ts`):

| Constant                           | Value                                     | Meaning                                         | Line  |
| ---------------------------------- | ----------------------------------------- | ----------------------------------------------- | ----- |
| `ACCESS_TOKEN_EXPIRY_SECONDS`      | 900                                       | assumed lifetime when the server does not say   | `:14` |
| `EXPIRY_SAFETY_MARGIN_SECONDS`     | 60                                        | a token within 60 s of `exp` counts as expired  | `:18` |
| refresh schedule                   | `floor(expiresIn * (0.5 + rand * 0.2))` s | proactive refresh at 50 % to 70 % of life       | `:91` |
| `REFRESH_MAX_RETRIES`              | 3                                         | non-401 failures                                | `:15` |
| `REFRESH_BACKOFF_BASE_MS`          | 1000                                      | `base * 2^attempt`                              | `:16` |
| `FALLBACK_RETRY_THRESHOLD_S`       | 60                                        | one late retry if this much life remains        | `:17` |
| `REFRESH_REJECT_TERMINAL_ATTEMPTS` | 3                                         | after three 401s refresh is permanently blocked | `:34` |
| `REFRESH_REJECT_BACKOFF_MS`        | `[60_000, 300_000]`                       | backoff after the first and second 401          | `:35` |

**A 401 on refresh is never retried inline** and the rejection latches: the
window blocks all refresh traffic without touching the network, and after three
rejections the latch is permanent and the user must sign in again
(`apps/desktop/src/main/sync/token-manager.ts:20-35`, `:123-141`). The reason is
on record: roughly fifteen demand-driven callers each re-entered the refresh
path once the access token was permanently expired, producing 58 server requests
in 47 minutes from one install.

**Refresh MUST be single-flighted across concurrent callers**
(`apps/desktop/src/main/sync/token-manager.ts:216-222`). A conforming client that
does not single-flight reproduces the storm above.

### 2.10.1 What an ordinary authenticated request does on a 401

**Normative.** §2.10 specifies the proactive schedule and the rejection latch,
and motivates the latch with "roughly fifteen demand-driven callers" — which
implies a reactive path without ever defining it. Defined here.

A `401` on a request carrying an access token triggers **exactly one** refresh
and one replay of the original request:

- the refresh goes through the same single-flight as the proactive one, so
  fifteen concurrent 401s cost one refresh, not fifteen;
- the replay costs **no backoff** and does not consume a retry attempt, because
  the first call failed on a stale credential rather than a transient fault;
- if the replay also returns `401`, the request fails. There is no second
  refresh and no second replay: two 401s across a fresh token mean the session
  is gone, not that the timing was unlucky;
- if the refresh itself fails, the rejection latch of §2.10 applies and the
  original request fails with the latch's outcome.

A `401` never enters the §0.6.1 ladder, in either direction: it is not
retryable there, and the replay here is not an attempt there.

## 2.11 Server-side lifetimes and ceilings

**Normative.** A client schedules against these rather than guessing.

| Constant                             | Value       | Source                                      |
| ------------------------------------ | ----------- | ------------------------------------------- |
| `OTP_LENGTH`                         | 6           | `apps/sync-server/src/services/otp.ts:3`    |
| `OTP_EXPIRY_SECONDS`                 | 600         | `apps/sync-server/src/services/otp.ts:4`    |
| OTP `MAX_ATTEMPTS`                   | 5           | `apps/sync-server/src/services/otp.ts:5`    |
| OTP `MAX_EMAIL_REQUESTS` / window    | 3 per 600 s | `apps/sync-server/src/services/otp.ts:6-7`  |
| `ACCESS_TOKEN_EXPIRY`                | `15m`       | `apps/sync-server/src/services/auth.ts:8`   |
| `REFRESH_TOKEN_EXPIRY`               | `7d`        | `apps/sync-server/src/services/auth.ts:9`   |
| `SETUP_TOKEN_EXPIRY`                 | `5m`        | `apps/sync-server/src/services/auth.ts:217` |
| `SETUP_TOKEN_RENEWAL_WINDOW_SECONDS` | 86400       | `apps/sync-server/src/services/auth.ts:231` |
| `ROTATION_GRACE_SECONDS`             | 10          | `apps/sync-server/src/services/auth.ts:79`  |
| `MAX_ROTATION_ATTEMPTS`              | 3           | `apps/sync-server/src/services/auth.ts:80`  |
| `MAX_DEVICES_PER_USER`               | 50          | `apps/sync-server/src/routes/auth.ts:586`   |
| `OAUTH_STATE_EXPIRY`                 | `5m`        | `apps/sync-server/src/routes/auth.ts:171`   |

OTP codes are stored as a hex HMAC-SHA256 under `OTP_HMAC_KEY` and compared with
a timing-safe comparison; storing a new code marks every prior unused code for
that email as used (`apps/sync-server/src/services/otp.ts:26-58`).

## 2.12 Two platform enumerations exist

**Normative.** `DeviceRegisterRequestSchema.platform` is
`macos | windows | linux | ios | android | web`
(`packages/contracts/src/auth-api.ts:24`). `CLIENT_PLATFORMS`, used by the write
gate in chapter 11, is `ios | android | desktop`
(`packages/contracts/src/sync-api.ts:273`). **These are different lists.** A
phone registers as `ios` and identifies itself as `ios`, so they coincide for
this feature, but a client MUST NOT model them as one enum: a desktop registers
as `macos`, `windows` or `linux` and identifies itself as `desktop`.

## 2.13 Native OAuth, and why a shell cannot post it

**Normative.** Added to close spec-defects 116 and 117: this endpoint existed,
was the terminal step of an iOS task, and was described nowhere in this
document — so the one task that had to call it read `apps/sync-server` instead,
which is exactly the failure this log exists to prevent.

`POST /auth/oauth/:provider/native` is the mobile counterpart of the browser
callback. It skips the authorization-code exchange and picks the flow up at ID
token validation; everything after that — user lookup, entitlement, setup
token, analytics — is the same path the browser flow takes, deliberately, so
that two ways in do not become two account models.

|                                                |                                                  |
| ---------------------------------------------- | ------------------------------------------------ |
| Request                                        | `{ idToken, sessionNonce, devicePublicKey }`     |
| Response                                       | `{ success, isNewUser, needsSetup, setupToken }` |
| `needsSetup`                                   | true when the account has no `kdf_salt` yet      |
| Any provider but `google`                      | `400 AUTH_INVALID_PROVIDER`                      |
| `GOOGLE_IOS_CLIENT_ID` unset on the deployment | `501`                                            |

The `501` is **not** a fallback to the web OAuth client, and a client MUST NOT
treat it as one: validating an ID token against the wrong audience would accept
a token minted for a different app.

**Two of the three request fields are core-private, so the shell cannot
assemble this request.** `sessionNonce` is minted into the core's own pending
state; `devicePublicKey` derives from the device signing key held inside the
core's `SecureStore`; and the `setupToken` that comes back is signed **over
that nonce** and has to land in the core's token manager. "The app posts the ID
token" was therefore never a possible reading — the shell's half of native
OAuth ends when it holds an ID token, and a core method has to take it from
there. See spec-defect 114: no such method is exported today, which is why
iOS ships no Google button rather than a button that cannot finish.

Note for whoever next reads the route: its own comment says the app "signs in
with Google's own iOS SDK". **That is inaccurate** — research R14 forbids that
SDK on iOS, and the shell uses `ASWebAuthenticationSession` with PKCE. The
comment is not corrected here because `apps/sync-server` is out of scope for
this feature by Kaan's scope decision.

### 2.13.1 Where the client's OAuth client id lives

**Normative.** The iOS OAuth client id is read from **`MemryGoogleClientID` in
`Info.plist`**, and the redirect URI scheme is derived from it as the reversed
client id. It follows `MemrySyncEnvironment`'s discipline exactly
(spec-defect 110): **no default and no fallback.** An absent key is a
`notConfigured` failure, loud at launch, never a silent fall back to the web
client. Both keys must be present in `Info.plist` and in the release build
settings before any release or TestFlight build.

## 2.14 A client restores its session on cold launch, without a request

**Normative.** Added to close spec-defect 121, which was a real bug and not a
documentation gap: a client that starts with a refresh token on disk was
reporting itself signed out, so a registered user who quit and reopened the app
was asked to sign in again every single time. Nothing in this chapter or in
`data-model.md` §C.1 drew the edge that would have allowed anything else.

A client **MUST** restore from stored tokens at launch, and the restore **MUST
NOT** make a request. The restored state is a **claim**: its validity is decided
by the first `Auth::Session` call through §2.10's `401`-and-refresh path, which
is machinery the HTTP layer already owns. Refreshing at launch instead is
forbidden for a specific reason — §2.10's ladder honours a server-supplied
`Retry-After` with no ceiling (spec-defect 109), and the per-IP limiter's window
is 3600 s, so a refresh inside launch is a launch that can suspend for up to an
hour. On iOS it also cannot be interrupted, because an async core call is
uncancellable (spec-defect 108).

Three outcomes, and they are distinguished by **shape**, not by three spellings
of one state:

| On disk                        | Result                                          |
| ------------------------------ | ----------------------------------------------- |
| No refresh token               | signed out; no edge applied                     |
| A refresh token                | `Registered`, as a claim the server adjudicates |
| The secure store is **locked** | a **failure**, with the state left unchanged    |

The third row is the one that is easy to get wrong. Where the platform gates
secret storage on the device having been unlocked once since boot — on iOS the
five entries are `AfterFirstUnlockThisDeviceOnly` — a process that starts after
a reboot and before the first unlock reads **locked**, which is not "absent".
Reporting it as signed out reintroduces exactly the defect this section exists
to fix, and invites a live user to register a second device against their
account. It **MUST** surface as a retryable failure, so the client can call
restore again once protected data becomes available.

Restore is **idempotent**: it applies its edge only from the signed-out state
and otherwise returns the state it found. A launch signal is driven by the
process lifecycle rather than by a user, so it can legitimately arrive twice,
and a client that treated the second one as an error would teach its callers to
suppress it.

### 2.14.1 A cancelled provider sheet is abandoned client-side

**Normative**, closing spec-defect 123. §C.1 draws one transition out of the
awaiting-provider-token state for "cancelled, expired, or rejected", and only
**rejected** had an implementation — the server's refusal. **Cancellation is the
client's fact**: the user dismissed the native consent sheet and the server never
hears about it, so no response will ever arrive to move the state. A client that
cannot apply that edge itself strands the user in a state with no way out.

A client **MUST** be able to abandon a provider sign-in it started. This is the
**same** failure edge a server refusal takes — not a new state and not a new
event — and abandoning **MUST** clear the session nonce minted when the sheet
was opened, so a late callback carrying a spent nonce cannot be honoured.

Note the general lesson, which is why this is written out rather than left
implied: a transition that names several causes on one line is a transition
nobody checks has several call sites.
