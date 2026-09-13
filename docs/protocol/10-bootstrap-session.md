# 10 — The bootstrap session

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

## 10.1 What it is, and what it is not

**Normative.** A bootstrap session is an **elevated-throughput window** a fresh
device opens while it pulls an entire vault for the first time
(`packages/contracts/src/bootstrap-api.ts:3-5`).

**It only ever widens server rate ceilings. A missing, expired or forged token
degrades to steady-state behaviour byte for byte and can never fail an unrelated
request** (`packages/contracts/src/bootstrap-api.ts:11-14`).

It is **not** required (§10.6), carries **no** data the ordinary endpoints do
not, and changes **nothing** about the pull shape.

## 10.2 Routes

**Normative** (`apps/sync-server/src/routes/bootstrap.ts`, mounted at
`/sync/bootstrap`, `apps/sync-server/src/index.ts:221`):

| Method | Path                    | Purpose             | Line   |
| ------ | ----------------------- | ------------------- | ------ |
| POST   | `/sync/bootstrap`       | open                | `:86`  |
| POST   | `/sync/bootstrap/renew` | extend              | `:154` |
| POST   | `/sync/bootstrap/close` | end; **idempotent** | `:173` |

All three sit behind auth, the client gate (chapter 11), the paid gate and the
sync-types middleware (`apps/sync-server/src/routes/bootstrap.ts:35-38`), and
share one rate limiter of **30 requests per 60 s**, device-keyed
(`apps/sync-server/src/routes/bootstrap.ts:45-46`).

## 10.3 The header

**Normative.** `X-Memry-Bootstrap-Token`
(`packages/contracts/src/bootstrap-api.ts:18`), carrying the `token` from the
open response **verbatim**, added to elevated requests only
(`packages/contracts/src/bootstrap-api.ts:21-22`).

**Old servers ignore it and old clients never send it**
(`packages/contracts/src/bootstrap-api.ts:8-10`), which is what makes the whole
feature additive.

## 10.4 The open response

**Normative** (`packages/contracts/src/bootstrap-api.ts:45-74`):

```
{ session: { token, expiresAt, ttlSeconds },
  manifest: { items: [{id, type, version, modifiedAt, size}], nextCursor?, serverTime },
  tailCursor,
  attachments?: { chunkHashes: string[], nextChunkCursor? },
  packs: [] }
```

| Field                         | Rule                                                                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.expiresAt`           | epoch seconds at which the token stops being honoured (`:23-24`)                                                                                                                                                                 |
| `session.ttlSeconds`          | mirrors `exp - iat`, for renewal scheduling (`:25-26`)                                                                                                                                                                           |
| `manifest`                    | **the first page** of the paginated manifest service, at `MAX_MANIFEST_PAGE_LIMIT`, **never the whole vault** (`:34-35`; `apps/sync-server/src/routes/bootstrap.ts:99-102`)                                                      |
| `tailCursor`                  | the current `MAX(server_cursor)`, so the client knows when its pull has caught up (`:35-36`; `apps/sync-server/src/routes/bootstrap.ts:104-108`, absent rows give `0` at `:148`)                                                 |
| `packs`                       | **reserved; always present, always empty** until the pack pipeline lands (`:37-38`; `apps/sync-server/src/routes/bootstrap.ts:150`)                                                                                              |
| `attachments`                 | **informational only**, absent entirely on deployments that cannot presign (`:39-43`); `chunkHashes` is a first keyset page of at most `CHUNK_HASH_PAGE_LIMIT = 512` (`apps/sync-server/src/routes/bootstrap.ts:51`, `:126-130`) |
| `attachments.nextChunkCursor` | **names where a continuation page would start; no continuation endpoint exists** (`:64-70`)                                                                                                                                      |

**A client MUST NOT treat `attachments.chunkHashes` as a complete inventory**,
and MUST NOT treat `packs: []` as meaning the vault has no packs — use
`GET /sync/packs` (chapter 08 §8.9).

## 10.5 Errors, and the fallback rule

**Normative** (`apps/sync-server/src/lib/errors.ts:42-56`; statuses from chapter
00 §0.5):

| Code                          | Status | Meaning                                                                                                        |
| ----------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `BOOTSTRAP_NOT_ELIGIBLE`      | 409    | this device already synced this vault                                                                          |
| `BOOTSTRAP_SESSION_LIMIT`     | 429    | the per-user concurrent cap                                                                                    |
| `BOOTSTRAP_SESSION_INVALID`   | 401    | expired, forged or revoked token                                                                               |
| `BOOTSTRAP_IDENTITY_MISMATCH` | 403    | a valid token presented by another authenticated context; renewal and close require the session's own identity |
| `BOOTSTRAP_SESSION_EXPIRED`   | 403    | the absolute maximum lifetime is spent                                                                         |
| `BOOTSTRAP_UNAVAILABLE`       | 501    | the deployment has no HMAC key configured (`apps/sync-server/src/routes/bootstrap.ts:53-64`)                   |

**The fallback rule, normative and absolute: a client treats _any_ open failure —
including a `404` from a server that does not mount these routes — as "no
bootstrap" and falls back silently to steady-state pacing**
(`apps/sync-server/src/routes/bootstrap.ts:28-30`). It MUST NOT surface any of
these to the user, MUST NOT retry beyond its ordinary transport retry, and MUST
NOT block the first sync on one.

## 10.6 Is a session required — Q10.1

**Normative — it is an optimisation and is never required.**

Desktop opens one only on a fresh device and swallows every failure
(`apps/desktop/src/main/sync/engine/full-sync-runner.ts:504-520`). The
platform-free engine and the frozen Expo app never call it at all, so today's
shipped phone first-sync is already steady-state.

**The only consequence of never calling it is unelevated pull ceilings** (§10.7).

### 10.6.1 SC-007 arithmetic without a session

A 10 000-item vault, steady state:

- the refs pass runs `GET /sync/changes`. At the platform-free engine's
  `PULL_PAGE_LIMIT = 100` (`packages/sync-client/src/pull/engine.ts:60`) that is
  100 calls at 60/min ≈ **1.7 minutes for refs alone**. At the server's permitted
  `limit ≤ 500` (chapter 05 §5.10) it is **20 calls**, well under a minute.
- metadata pull is 100 ids per call at 120/min, under a minute.
- a full body sweep of 10 000 notes is roughly **17 minutes unelevated** against
  **3.3 minutes elevated**.

**Core obligation.** Meet FR-028 and SC-007 by **windowing** — refs, then recent
metadata, then recent bodies — and by raising `/sync/changes` to `limit=500`, not
by the session. A client SHOULD still open one, as desktop does: it is one cheap
call with a silent fallback. A `501` on a staging deployment means "no bootstrap
configured", not a client bug.

**Disposition of Q10.1: answered (an optimisation, never required).**

## 10.7 Elevation multipliers

**Normative** (`apps/sync-server/src/services/bootstrap-session.ts:242-249`).
**A bucket not in this map is never elevated**, and the limiter clamps with
`Math.max(multiplier, 1)` and treats a non-finite value as no elevation, so
**elevation can only ever widen** (`apps/sync-server/src/middleware/rate-limit.ts:88-91`).

| Bucket            | Steady state                                            | Elevated      | Key    |
| ----------------- | ------------------------------------------------------- | ------------- | ------ |
| `sync_changes`    | 60/min (`apps/sync-server/src/routes/sync.ts:219-220`)  | ×3 = 180/min  | user   |
| `sync_pull`       | 120/min (`apps/sync-server/src/routes/sync.ts:226-227`) | ×3 = 360/min  | user   |
| `sync_manifest`   | 30/min (`apps/sync-server/src/routes/sync.ts:239-240`)  | ×3 = 90/min   | user   |
| `crdt_pull`       | 600/min (`apps/sync-server/src/routes/sync.ts:605-606`) | ×5 = 3000/min | device |
| `crdt_batch_pull` | 30/min (`apps/sync-server/src/routes/sync.ts:616-617`)  | ×5 = 150/min  | device |
| `blob_download`   | 600/min (`apps/sync-server/src/routes/blob.ts:94-95`)   | ×5 = 3000/min | device |

**`sync_push` is not elevated** (`apps/sync-server/src/routes/sync.ts:213-214`,
60/min): every elevated bucket is pull-only
(`apps/sync-server/src/services/bootstrap-session.ts:274`).

Overrun is `429 RATE_LIMITED` with a `Retry-After` header
(`apps/sync-server/src/middleware/rate-limit.ts:104-112`), which a conforming
client retries (chapter 00 §0.6). The limiter also echoes `X-RateLimit-Limit`
(`apps/sync-server/src/middleware/rate-limit.ts:115`).

## 10.8 The token is stateless

**Normative.** Wire format
(`apps/sync-server/src/services/bootstrap-session.ts:138-140`):

```
base64url(JSON payload) "." base64url(HMAC-SHA256(secret, encodedPayload))
```

where base64url means standard base64 with `+`→`-`, `/`→`_`, and padding
stripped (`apps/sync-server/src/services/bootstrap-session.ts:94`).

Claims (`apps/sync-server/src/services/bootstrap-session.ts:129-137`):
`{ v: 1, userId, deviceId, vaultId, jti, iat, exp }`. The payload is built
field by field rather than spread, because `BootstrapSession` carries `expiresAt`
while the wire payload carries `exp`, and a spread would mint tokens with no
`exp` (`:126-128`).

Verification is a constant-time HMAC compare plus claim-shape and expiry checks,
and **returns null on any failure rather than throwing**
(`apps/sync-server/src/services/bootstrap-session.ts:160-205`). Identity is
re-bound to the **current request's** authenticated context, so a token replayed
from another device or vault elevates nothing
(`apps/sync-server/src/services/bootstrap-session.ts:251-260`, `:267-268`).

Renewal reuses the same `jti` and only extends `expires_at`
(`apps/sync-server/src/services/bootstrap-session.ts:454-458`).

**Accepted residual, on record**: because elevation is stateless — it reads only
the signature and `exp`, never the ledger — **a token whose session was
explicitly closed keeps elevating from its own device until its `exp`, at most 60
minutes** (`apps/sync-server/src/services/bootstrap-session.ts:270-276`). It is
hard-bounded by the TTL, cannot be extended or moved, and every elevated bucket
is pull-only.

## 10.9 Eligibility and the concurrency cap

**Normative.** Eligibility is "**this device has never completed a pull for this
vault**": no `device_sync_state` row, or a NULL or zero `last_cursor_seen`
(`apps/sync-server/src/services/bootstrap-session.ts:297-313`). `updateDeviceCursor`
only writes when a changes page actually delivered items, so an absent row is a
genuinely never-pulled device (`:309-311`).

The concurrency cap, `MAX_CONCURRENT_BOOTSTRAP_SESSIONS = 2`
(`apps/sync-server/src/services/bootstrap-session.ts:39`), is enforced
**atomically inside a single INSERT with a COUNT subquery**
(`:359-378`): `changes === 0` means the WHERE refused and the user is at cap
(`:379-380`). There is no check-then-take interleaving point.

## 10.10 Constants

**Normative:**

| Constant                                 | Value                     | Source                                                  |
| ---------------------------------------- | ------------------------- | ------------------------------------------------------- |
| `BOOTSTRAP_SESSION_TTL_SECONDS`          | 3600                      | `apps/sync-server/src/services/bootstrap-session.ts:37` |
| `MAX_CONCURRENT_BOOTSTRAP_SESSIONS`      | 2                         | `:39`                                                   |
| `BOOTSTRAP_RENEW_LEAD_SECONDS`           | 300                       | `:41`                                                   |
| `MAX_BOOTSTRAP_SESSION_LIFETIME_SECONDS` | 21600 (6 hours)           | `:53`                                                   |
| `CHUNK_HASH_PAGE_LIMIT`                  | 512                       | `apps/sync-server/src/routes/bootstrap.ts:51`           |
| session endpoint rate limit              | 30 per 60 s, device-keyed | `apps/sync-server/src/routes/bootstrap.ts:45-46`        |

## 10.11 A first sync longer than six hours — Q10.2

**Normative.** A session's token lives 1 hour and is renewable, but the session's
**absolute** lifetime is 6 hours
(`apps/sync-server/src/services/bootstrap-session.ts:53`). A first sync that runs
past 6 hours therefore falls back to steady-state pacing **mid-run**, with the
renewal answering `403 BOOTSTRAP_SESSION_EXPIRED` (§10.5).

**A conforming client MUST handle the transition as an ordinary rate change, not
as an error.** Concretely:

1. renew proactively at `BOOTSTRAP_RENEW_LEAD_SECONDS = 300` before `expiresAt`;
2. on **any** renewal failure, drop the `X-Memry-Bootstrap-Token` header and
   continue at steady-state pacing — §10.5's fallback rule applies to renewal
   exactly as it applies to open;
3. **MUST NOT** attempt to open a second session: the window is one-shot per
   device per vault by design (§10.9), so an expired session cannot be replaced.

**FR-028's progress reporting MUST survive the transition.** Progress is measured
against `tailCursor` and the client's own cursor (§10.4), neither of which the
session affects, so the only observable change is that the remaining work takes
longer. A client MUST NOT reset, restart, or report failure at this point.

**Disposition of Q10.2: answered** (this section).

## 10.12 `BOOTSTRAP_SESSION_HMAC_KEY` per deployment — Q10.3

**Normative.** The secret is optional per deployment. Without it every bootstrap
route answers `501 BOOTSTRAP_UNAVAILABLE`
(`apps/sync-server/src/routes/bootstrap.ts:53-64`), and the elevation seam
returns null everywhere, so an unconfigured deployment behaves exactly as it did
before the feature existed
(`apps/sync-server/src/services/bootstrap-session.ts:19-22`).

**A `501` on staging is a deployment configuration fact, not a client bug**, and
a client MUST NOT report it as one. **Whether any particular deployment has the
key configured is a deployment question and is outside this specification**: it
cannot be read from the source tree, because the value is a Worker secret. The
G4 headless round trip must confirm it against the running staging deployment
before treating an elevated timing figure as meaningful; until it does, treat
staging as unelevated and size FR-028 against the steady-state arithmetic of
§10.6.1, which is conforming either way.

**Disposition of Q10.3: answered (behaviour specified; the deployment's
configuration is verified operationally, not from source).**
