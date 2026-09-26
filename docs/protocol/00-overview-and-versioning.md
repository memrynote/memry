# 00 — Overview and versioning

**Status**: normative. **Feature**: 002-native-foundation-ios.
**Source of truth**: `packages/contracts` (spec.md Assumptions). Where this
chapter and a contract disagree, this chapter is wrong until amended.

This is chapter 00 of the Memry sync protocol specification. The specification
exists so that a second implementation — the Rust core this feature builds — can
be written without reading `apps/desktop`, `apps/sync-server` or
`packages/sync-client`.

## 0.1 How to read this specification

Two rules apply to every chapter and are restated here because they are the ones
a reader has to trust:

1. **Every normative sentence carries a `path:line` citation.** A sentence
   without one is background, not specification. When a citation has drifted,
   the surrounding identifier is the durable part; fix the line number in place.
2. **There is no negotiated wire protocol version.** No handshake, no
   `Accept-Version`, no server-advertised protocol number exists anywhere on the
   wire. Version skew is handled by exactly two mechanisms: the client identity
   header and its server-side floor (chapter 11), and per-format version bytes
   (§0.2). An implementer looking for a version negotiation will not find one,
   and MUST NOT invent one. This closes **Q00.3**.

Keywords MUST, MUST NOT, SHOULD, MAY are used in the RFC 2119 sense.

Chapters:

| #   | File                                  | Subject                                       |
| --- | ------------------------------------- | --------------------------------------------- |
| 00  | `00-overview-and-versioning.md`       | versions, routes, errors, transport           |
| 01  | `01-identity-and-keys.md`             | recovery phrase, key chain, device identity   |
| 02  | `02-auth-and-sessions.md`             | OTP, OAuth, device registration, tokens       |
| 03  | `03-device-linking.md`                | QR linking, X25519, SAS, the two MAC families |
| 04  | `04-record-envelope.md`               | compression, AEAD, canonical CBOR, signatures |
| 05  | `05-record-sync.md`                   | record routes, cursors, push wave, replay     |
| 06  | `06-vector-clocks-and-field-merge.md` | clock algebra, field merge, conflicts         |
| 07  | `07-crdt-updates.md`                  | note and journal bodies, snapshots, pruning   |
| 08  | `08-pack-container.md`                | the MPAK container, reader only               |
| 09  | `09-realtime.md`                      | the WebSocket                                 |
| 10  | `10-bootstrap-session.md`             | the elevated first-sync window                |
| 11  | `11-client-policy.md`                 | the client header, version floor, kill switch |
| 12  | `12-note-body-format.md`              | the Y.Doc, its roots, markdown ownership      |
| 13  | `13-payload-schemas.md`               | per-type payloads and verbatim preservation   |
| 14  | `14-attachments.md`                   | blobs, chunking, manifests                    |

## 0.2 The five independent version numbers

There are five version numbers in this protocol and **they do not move
together**. A client MUST treat each independently.

| Version                                        | Value               | Scope                                            | Citation                                                                |
| ---------------------------------------------- | ------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| `CRYPTO_VERSION`                               | `1`                 | the record envelope's declared crypto version    | `packages/contracts/src/crypto.ts:14`                                   |
| `PACK_VERSION`                                 | `1`                 | the MPAK container header and footer             | `packages/contracts/src/pack-format.ts:60`                              |
| `BRIDGE_PROTOCOL_VERSION`                      | `1`                 | the host↔editor-bundle bridge, not a wire format | `packages/contracts/src/webview-bridge.ts:22`                           |
| `providerAuthVersion` / `vaultTransferVersion` | literal `1`         | the two optional linking blocks                  | `packages/contracts/src/linking-api.ts:3`, `:36`, `:40`                 |
| signature payload "v1"                         | shape, not a number | the signed CBOR field set                        | `packages/contracts/src/crypto.ts:179-196` (`SignaturePayloadV1Schema`) |

`BRIDGE_PROTOCOL_VERSION` is listed for completeness and is **not** a wire
version: it versions the JSON bridge between a host application and its editor
bundle (chapter 12), which never crosses the network.

### 0.2.1 `CryptoVersion` is `1 | 2` and no `2` exists — Q00.1

`CryptoVersion` is typed `1 | 2` while `CRYPTO_VERSION` is `1`
(`packages/contracts/src/crypto.ts:13-14`). No producer of `2` exists anywhere in
the tree.

**Normative.** A conforming reader MUST reject `cryptoVersion !== 1` at parse
time, with two distinguishable failures:

- `cryptoVersion < 1` is invalid input
  (`packages/sync-client/src/pull/record-decrypt.ts:50-52`);
- any other value is "not supported, update the app"
  (`packages/sync-client/src/pull/record-decrypt.ts:53-55`).

Both are hard errors. Neither is a skip: an item that fails here MUST NOT be
treated as applied and MUST NOT advance a cursor past itself.

**Disposition of Q00.1: answered.** `2` is **reserved, not accepted**. A Rust
enum modelling this MUST NOT admit `2` as a constructible value; admitting it and
failing later is strictly worse than rejecting at parse, because the failure then
happens after the item has been routed. When a version 2 is defined, the format
change lands together with its chapter and its vectors (FR-008).

### 0.2.2 Pack version handling

A pack reader MUST reject any pack whose header byte 4 is not `PACK_VERSION`
(`packages/contracts/src/pack-format.ts:232`) and any pack whose footer version
byte is not `PACK_VERSION` (`packages/contracts/src/pack-format.ts:223`). Both
raise `unsupported pack version <n>`. A bad pack is treated as absent, never as
an error the user sees (chapter 08).

## 0.3 The route tree

Top-level mounts, verbatim from `apps/sync-server/src/index.ts:216-226`:

| Prefix               | Router                                        | Chapter        |
| -------------------- | --------------------------------------------- | -------------- |
| `/auth`              | auth                                          | 02             |
| `/auth/linking`      | linking                                       | 03             |
| `/devices`           | devices                                       | 02             |
| `/sync`              | sync                                          | 05, 07, 08, 09 |
| `/sync`              | blob (a **second** router on the same prefix) | 14             |
| `/sync/bootstrap`    | bootstrap                                     | 10             |
| `/telemetry`         | telemetry                                     | out of scope   |
| `/diagnostics`       | diagnostics                                   | out of scope   |
| `/feedback`          | feedback                                      | out of scope   |
| `/webhooks`          | webhooks                                      | out of scope   |
| `/calendar/channels` | calendar channels                             | out of scope   |

`GET /health` answers `{"status":"ok"}` unauthenticated
(`apps/sync-server/src/index.ts:214`).

Inside the sync router there are two sub-mounts, `/sync/records`
(`apps/sync-server/src/routes/sync.ts:557`) and `/sync/crdt`
(`apps/sync-server/src/routes/sync.ts:1146`).

### 0.3.1 The record handlers are mounted twice — Q00.2

The same five record handlers are reachable under two prefixes: once through the
`/sync/records` sub-mount (`apps/sync-server/src/routes/sync.ts:557`) and once
directly on `/sync` (`apps/sync-server/src/routes/sync.ts:559-565`).

**Normative.** The **unprefixed** form is canonical for a new client:
`GET /sync/status`, `GET /sync/manifest`, `GET /sync/changes`, `POST /sync/push`,
`POST /sync/pull`, `GET /sync/items/:id`, `GET /sync/packs`. The shipped
platform-free client uses the unprefixed form
(`packages/sync-client/src/pull/engine.ts:158`, `:191`). `/sync/records/*` is
**legacy**: it MUST continue to be served, and a new client MUST NOT use it.

**Disposition of Q00.2: answered** (this section).

## 0.4 The error envelope

**Normative.** The error envelope is

```json
{ "error": { "code": "SYNC_INVALID_SIGNATURE", "message": "…" } }
```

built by `formatErrorResponse` (`apps/sync-server/src/lib/errors.ts:113-120`).
Some fields ride **inside** the `error` object rather than beside it; the
`minVersion` on `CLIENT_UPGRADE_REQUIRED` is the one that matters (chapter 11).

**A client MUST also tolerate a bare-string form**, `{ "error": "some message" }`.
Several routes emit it directly — for example
`apps/sync-server/src/routes/sync.ts:94` and `:99` — and the reference client
handles both shapes (`packages/sync-client/src/pull/http.ts:107-114`): a string
`error` becomes the message with no code, an object `error` yields `code` and
`message`. A non-JSON body degrades to `HTTP <status>` as the message
(`packages/sync-client/src/pull/http.ts:106`, `:115-117`).

## 0.5 The error code table

The complete enum is `ErrorCodes` (`apps/sync-server/src/lib/errors.ts:10-97`).
The HTTP status is **not** attached to the code: `AppError` takes it per throw
site and defaults to 500 (`apps/sync-server/src/lib/errors.ts:101-111`). The
table below lists every code with the status or statuses actually produced,
read from every non-test throw site under `apps/sync-server/src`.

| Code                          | Status(es)                | Meaning to a client                                                                                                                                                              |
| ----------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_INVALID_TOKEN`          | 401                       | token unusable; re-authenticate. Also the answer to a spent setup token                                                                                                          |
| `AUTH_TOKEN_EXPIRED`          | 401                       | refresh                                                                                                                                                                          |
| `AUTH_DEVICE_REVOKED`         | 403, 409                  | terminal for this device                                                                                                                                                         |
| `AUTH_INVALID_OTP`            | 401                       | wrong code                                                                                                                                                                       |
| `AUTH_OTP_EXPIRED`            | 401                       | request a new code                                                                                                                                                               |
| `AUTH_OTP_MAX_ATTEMPTS`       | 401                       | request a new code                                                                                                                                                               |
| `AUTH_RATE_LIMITED`           | —                         | **no producer**; see §0.5.1                                                                                                                                                      |
| `AUTH_INVALID_PROVIDER`       | 400, 501                  | unknown OAuth provider, or provider not configured                                                                                                                               |
| `AUTH_DEVICE_NOT_FOUND`       | 401, 404                  | signer device unknown                                                                                                                                                            |
| `AUTH_TOKEN_ROTATION_FAILED`  | 500                       | retry the refresh once, then treat as terminal                                                                                                                                   |
| `LINKING_SESSION_NOT_FOUND`   | 404                       | bad or consumed session id                                                                                                                                                       |
| `LINKING_SESSION_EXPIRED`     | 410                       | restart from a new QR                                                                                                                                                            |
| `LINKING_INVALID_TRANSITION`  | 409                       | out-of-order linking call                                                                                                                                                        |
| `LINKING_DUPLICATE_SESSION`   | —                         | **no producer with an explicit status**                                                                                                                                          |
| `LINKING_CONCURRENT_ATTEMPT`  | 409                       | another device is mid-link                                                                                                                                                       |
| `LINKING_SECRET_INVALID`      | 403                       | wrong `linkingSecret` or wrong scan MAC                                                                                                                                          |
| `LINKING_IP_MISMATCH`         | 403                       | **no producer since #2184**; only an older server can still send it. See chapter 03 §3.11                                                                                        |
| `SYNC_ITEM_NOT_FOUND`         | 404                       |                                                                                                                                                                                  |
| `SYNC_VERSION_CONFLICT`       | —                         | **classified in telemetry only** (`apps/sync-server/src/services/sync-telemetry.ts:188`); no route returns it. See chapter 05, Q05.5                                             |
| `SYNC_INVALID_SIGNATURE`      | 403                       | the item's signature did not verify                                                                                                                                              |
| `SYNC_INVALID_CURSOR`         | 400                       | a non-integer or negative `cursor` on `/sync/manifest` or `/sync/changes` (`apps/sync-server/src/routes/sync.ts:173-181`, `:324`, `:349`)                                        |
| `SYNC_BATCH_TOO_LARGE`        | —                         | **no producer**                                                                                                                                                                  |
| `SYNC_INVALID_ITEM`           | per item                  | a **per-item rejection reason** in the push response, never an HTTP status: one item `RecordPushItemSchema` refuses (`apps/sync-server/src/routes/sync.ts`). See chapter 05 §5.4 |
| `SYNC_REPLAY_DETECTED`        | per item                  | a **per-item rejection reason** in the push response, never an HTTP status (`apps/sync-server/src/services/sync.ts:542`)                                                         |
| `SYNC_DELETE_WINS`            | per item                  | same (`apps/sync-server/src/services/sync.ts:554`)                                                                                                                               |
| `SYNC_VERSION_INCOMPATIBLE`   | 426 (WebSocket handshake) | `apps/sync-server/src/durable-objects/user-sync-state.ts:104`, `:115`                                                                                                            |
| `SYNC_PAYMENT_REQUIRED`       | 402                       | no active sync subscription                                                                                                                                                      |
| `SYNC_VAULT_LIMIT_EXCEEDED`   | 402                       |                                                                                                                                                                                  |
| `SYNC_VAULT_NOT_FOUND`        | 404                       |                                                                                                                                                                                  |
| `BOOTSTRAP_NOT_ELIGIBLE`      | 409                       | already synced this vault; fall back to steady state                                                                                                                             |
| `BOOTSTRAP_SESSION_LIMIT`     | 429                       | concurrent cap; fall back                                                                                                                                                        |
| `BOOTSTRAP_SESSION_INVALID`   | 401                       | fall back                                                                                                                                                                        |
| `BOOTSTRAP_IDENTITY_MISMATCH` | 403                       | fall back                                                                                                                                                                        |
| `BOOTSTRAP_SESSION_EXPIRED`   | 403                       | fall back                                                                                                                                                                        |
| `BOOTSTRAP_UNAVAILABLE`       | 501                       | deployment has no bootstrap key; fall back                                                                                                                                       |
| `CRYPTO_INVALID_PAYLOAD`      | 400                       | a length precondition failed before signature check                                                                                                                              |
| `CRYPTO_DECRYPTION_FAILED`    | —                         | **no producer**                                                                                                                                                                  |
| `CRYPTO_INVALID_VERSION`      | —                         | **no producer**                                                                                                                                                                  |
| `STORAGE_QUOTA_EXCEEDED`      | 413                       |                                                                                                                                                                                  |
| `STORAGE_FILE_TOO_LARGE`      | 413                       |                                                                                                                                                                                  |
| `STORAGE_BLOB_NOT_FOUND`      | 404                       |                                                                                                                                                                                  |
| `STORAGE_UPLOAD_FAILED`       | 500                       |                                                                                                                                                                                  |
| `STORAGE_UNAUTHORIZED`        | 403                       |                                                                                                                                                                                  |
| `STORAGE_VERSION_CONFLICT`    | 409                       |                                                                                                                                                                                  |
| `STORAGE_HASH_MISMATCH`       | —                         | **no producer**                                                                                                                                                                  |
| `STORAGE_PRESIGN_UNAVAILABLE` | 501                       | permanent; use the proxied blob path                                                                                                                                             |
| `UPLOAD_SESSION_NOT_FOUND`    | 404                       |                                                                                                                                                                                  |
| `UPLOAD_SESSION_EXPIRED`      | 410                       |                                                                                                                                                                                  |
| `UPLOAD_CHUNK_CONFLICT`       | 409                       |                                                                                                                                                                                  |
| `UPLOAD_INCOMPLETE`           | 400                       |                                                                                                                                                                                  |
| `ATTACHMENT_NOT_FOUND`        | 404                       |                                                                                                                                                                                  |
| `CLIENT_UPGRADE_REQUIRED`     | 426                       | chapter 11                                                                                                                                                                       |
| `PLATFORM_WRITES_DISABLED`    | 403                       | chapter 11                                                                                                                                                                       |
| `VALIDATION_ERROR`            | 400, 409, 413, 426        | generic; the status carries the meaning                                                                                                                                          |
| `VALIDATION_INVALID_EMAIL`    | 400                       |                                                                                                                                                                                  |
| `VALIDATION_BODY_TOO_LARGE`   | 413                       |                                                                                                                                                                                  |
| `INTERNAL_ERROR`              | 500, 502, 503             | retryable                                                                                                                                                                        |
| `NOT_FOUND`                   | 404                       |                                                                                                                                                                                  |
| `RATE_LIMITED`                | 429                       | carries `retry-after`                                                                                                                                                            |
| `PACK_ENQUEUE_RATE_LIMITED`   | 429                       | **never reaches a client** (`apps/sync-server/src/lib/errors.ts:89-92`)                                                                                                          |
| `WS_RATE_LIMITED`             | WebSocket `error` frame   | `apps/sync-server/src/durable-objects/user-sync-state.ts:296`                                                                                                                    |
| `WS_TOKEN_EXPIRED`            | WebSocket `error` frame   | `apps/sync-server/src/durable-objects/user-sync-state.ts:404`                                                                                                                    |
| `WS_INVALID_CONNECTION`       | —                         | **no producer**                                                                                                                                                                  |

### 0.5.1 Codes with no producer

`AUTH_RATE_LIMITED`, `SYNC_BATCH_TOO_LARGE`, `CRYPTO_DECRYPTION_FAILED`,
`CRYPTO_INVALID_VERSION`, `STORAGE_HASH_MISMATCH` and `WS_INVALID_CONNECTION`
are declared in `ErrorCodes` (`apps/sync-server/src/lib/errors.ts:10-97`) and are
emitted by nothing. `LINKING_DUPLICATE_SESSION` is declared and has no throw site
carrying an explicit status.

**Normative.** A client MUST accept any of these codes without crashing — the
enum is the server's, and a later server may start using one — and MUST NOT
build behaviour that depends on ever receiving one. A client MUST treat an
unrecognised code as "an error with this HTTP status", never as a parse failure.

## 0.6 Transport defaults

**Normative.** A conforming client:

- speaks JSON over HTTPS and sends `Content-Type: application/json` and
  `Accept: application/json` on every request
  (`packages/sync-client/src/pull/http.ts:70-76`);
- applies a per-request ceiling of **60 seconds**
  (`DEFAULT_REQUEST_TIMEOUT_MS = 60_000`,
  `packages/sync-client/src/pull/http.ts:39`) and MUST have one, because a socket
  frozen by an OS backgrounding the app otherwise never resolves and latches the
  engine's in-flight guard permanently
  (`packages/sync-client/src/pull/http.ts:32-38`);
- reads `retry-after` from a `429` response **in lowercase**
  (`packages/sync-client/src/pull/http.ts:98-100`);
- treats a timeout as a transient transport failure and an outer-caller abort as
  an abort (`packages/sync-client/src/pull/http.ts:89-93`).

The full per-request header set, including `X-Memry-Sync-Types`,
`x-memry-client` and `X-Memry-Vault-Id`, is chapter 05 §5.2.

### 0.6.1 The retry ladder

**Normative.** Chapters 03 §3.9, 05 §5.6 and 07 §7.10 each set knobs —
`maxRetries`, `baseDelayMs`, `retryOn429`, `retryOn5xx` — on a helper that no
chapter defined. This section defines it, so a second implementation is
configuring the same thing rather than inventing one.

**Delay.** `baseDelayMs * 2 ^ attempt`, where `attempt` is zero-based, so a
base of 2000 gives 2 s, 4 s, 8 s. **No jitter.** The client population is one
device per account rather than a fleet, so the thundering-herd problem jitter
solves does not arise, and a deterministic ladder is testable against a paused
clock. A client that adds jitter is not non-conforming, but it is not required
and MUST NOT be relied on by a server.

**`retry-after` overrides the ladder.** When a `429` carries the header (§0.6,
lowercase), its value replaces the computed delay for that attempt rather than
adding to it. Without the header the ladder applies.

**What retries by default**, before a chapter's knobs narrow it:

| Outcome                        | Retried                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `429`                          | yes, unless `retryOn429: false`                                                 |
| `500`, `502`, `503`            | yes, unless `retryOn5xx: false` — these are §0.5's `INTERNAL_ERROR` row         |
| any other 5xx, including `501` | **no** — a `501` is a deployment gap, not a transient fault (chapter 10 §10.12) |
| any 4xx other than `429`       | no                                                                              |
| a transport failure            | yes, **except** a TLS failure and a caller-initiated cancellation               |

A TLS failure is excluded because it is a configuration or interception
problem that a second attempt reproduces exactly; a cancellation is excluded
because retrying it defeats the caller that asked to stop.

**A `401` is not part of this ladder.** It is handled by chapter 02 §2.10.1,
outside the retry budget.

## 0.7 Item type lists

`packages/contracts/src/sync-api.ts` declares eight item-type lists. **The counts
below were recounted against the working tree**; the outline this chapter was
planned from states 25 for `SYNC_ITEM_TYPES`, which is wrong.

| List                               | Members | Citation                                     | Membership                                                      |
| ---------------------------------- | ------: | -------------------------------------------- | --------------------------------------------------------------- |
| `SYNC_ITEM_TYPES`                  |  **26** | `packages/contracts/src/sync-api.ts:7-34`    | every type the server knows                                     |
| `RECORD_SYNC_ITEM_TYPES`           |      25 | `packages/contracts/src/sync-api.ts:36-62`   | `SYNC_ITEM_TYPES` minus `attachment`                            |
| `RECORD_CLOCK_REQUIRED_ITEM_TYPES` |      24 | `packages/contracts/src/sync-api.ts:64-89`   | `RECORD_SYNC_ITEM_TYPES` minus `settings`                       |
| `CRDT_SYNC_ITEM_TYPES`             |       2 | `packages/contracts/src/sync-api.ts:101`     | `['note', 'journal']` — body types on the CRDT feed, chapter 07 |
| `LEGACY_RECORD_SYNC_ITEM_TYPES`    |      15 | `packages/contracts/src/sync-api.ts:115-131` | frozen forever; what a header-less client is served             |
| `ENCRYPTABLE_ITEM_TYPES`           |      25 | `packages/contracts/src/sync-api.ts:152-178` | `SYNC_ITEM_TYPES` minus `attachment`                            |
| `FEED_ONLY_SYNC_TYPES`             |       1 | `packages/contracts/src/sync-api.ts:145`     | `['note_body']`, negotiable, never a record type (#2295)        |
| `NEGOTIABLE_SYNC_TYPES`            |      26 | `packages/contracts/src/sync-api.ts:148`     | `RECORD_SYNC_ITEM_TYPES` plus `FEED_ONLY_SYNC_TYPES`            |

`SYNC_OPERATIONS` is `['create', 'update', 'delete']`
(`packages/contracts/src/sync-api.ts:150`).

`NEGOTIABLE_SYNC_TYPES` is what the server recognises in `X-Memry-Sync-Types`
(chapter 05 §5.3). A `FEED_ONLY_SYNC_TYPES` member is served only by
`GET /sync/changes` and never travels as a record envelope, so it is in neither
`RECORD_SYNC_ITEM_TYPES` nor `LEGACY_RECORD_SYNC_ITEM_TYPES`
(`packages/contracts/src/sync-api.ts:135-148`).

`LEGACY_RECORD_SYNC_ITEM_TYPES` is frozen and MUST NOT grow: it is what a
pre-negotiation binary is served, and adding a type to it reaches a client whose
enum rejects it, failing a whole page and advancing that device's cursor past
good data (`packages/contracts/src/sync-api.ts:103-114`).

This feature's client subscribes to **fifteen** types (chapter 13).

## 0.8 Cross-chapter obligations

Four obligations bind every chapter.

1. **Every normative sentence carries a `path:line` citation.** §0.1.
2. **Every open question is answered in its chapter or restated there as
   "undefined, do not rely on this".** Silently dropping one is how it becomes a
   divergence. The disposition of all 69 questions is tracked in
   `specs/002-native-foundation-ios/checklists/protocol-spec.md`.
3. **FR-008 is a test, not an intention.** A covered format change that does not
   also change this chapter set and the vectors MUST fail the build. The
   mechanism lives in
   `packages/contracts/src/__tests__/protocol-chapters.test.ts` and has two
   halves, both required. **Per-constant rows** import the production constant
   and assert the chapter's fact table still spells it, so a failure names the
   paragraph to fix. **A digest over the whole covered constant set** is recorded
   immediately below, so a change to something no row lists yet still forces an
   edit to this chapter — and a reviewer is then looking at the fact tables.

   ```
   protocol-constants-sha256: 14a15aa284287522b30f79b3aff1238f1cd5e3377efc1e4b37a28d7cbd55345d
   ```

   To update it: change the constant, run
   `pnpm --filter @memry/contracts test protocol-chapters`, and the failure
   message carries the new digest. Replacing the digest without re-reading the
   chapter it guards defeats the mechanism.

4. **Verbatim payload preservation is normative.** A client stores the decrypted
   payload exactly as received and pushes that stored string back, having parsed
   only a copy for its projections. Every payload schema in this specification is
   a **reader over a preserved string**, never the storage shape. Chapter 13
   §13.2 states the full obligation; it binds chapters 04, 05, 07 and 13.

## 0.9 Known defects tracked outside this specification

Nine issues were opened on 2026-09-13 while answering this specification's open
questions, all labelled `protocol-spec`. Where a chapter describes behaviour one
of them changes, the chapter states the current behaviour, cites the issue, and
marks what will change. **None of them is the Rust core's to work around.**

| Issue | Subject                                                                    | Chapter |
| ----- | -------------------------------------------------------------------------- | ------- |
| #2179 | `_offline` reaches the wire                                                | 06      |
| #2180 | the push-build / pull-apply race — **closed, not a divergence**            | 06      |
| #2181 | `compactYDoc` drops unknown Y.Doc roots                                    | 12      |
| #2182 | `cancelled` is a persisted linking status — **fixed, now in the contract** | 03      |
| #2183 | desktop strips unknown payload keys                                        | 13      |
| #2184 | relax `LINKING_IP_MISMATCH`                                                | 03      |
| #2185 | mandate a canonical value comparison                                       | 06      |
| #2186 | the journal CRDT constants — **fixed**                                     | 07      |
| #2187 | return `revision` from a snapshot push                                     | 07      |

#2180 was re-examined against the code and closed: the mirrored merge it
describes is real, but the merged row is re-queued and an equal clock applies
rather than skips, so both devices converge within a sync cycle (chapter 06
§6.6.2). The convergence properties it rests on are normative for the core.

Four decisions taken on 2026-09-13 are **not** re-litigated by any chapter:
relaxing `LINKING_IP_MISMATCH` (#2184), mandating a canonical value comparison
(#2185), correcting the CRDT item type constants (#2186), and guaranteeing
frontmatter bytes only on the unedited path (chapter 12, Q12.1 option B). Each
chapter writes to the decision and says where the decision and today's code
differ.
