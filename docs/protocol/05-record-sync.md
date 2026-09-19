# 05 — Record sync

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

The record feed carries **metadata** for every syncable item. Note and journal
**bodies** do not travel here; they travel as CRDT updates (chapter 07).

## 5.1 Routes

**Normative.** Every route below is served under both `/sync/*`
(`apps/sync-server/src/routes/sync.ts:559-565`) and `/sync/records/*`
(`apps/sync-server/src/routes/sync.ts:557`). **A new client uses the unprefixed
form** (chapter 00 §0.3.1).

| Method              | Path                                    | Query / body                                                                                                         |
| ------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GET                 | `/sync/status`                          | none; returns `SyncStatusSchema` including `clientPolicy` (`packages/contracts/src/sync-api.ts:473-478`)             |
| GET                 | `/sync/manifest`                        | optional `limit` and `cursor`; **a cursor without a limit is a 400** (`apps/sync-server/src/routes/sync.ts:327-331`) |
| GET                 | `/sync/changes`                         | optional `cursor`, optional `limit` (`apps/sync-server/src/routes/sync.ts:344-357`)                                  |
| POST                | `/sync/push`                            | `RecordPushRequestSchema`, 1 to 100 items                                                                            |
| POST                | `/sync/pull`                            | `PullRequestSchema`, 1 to 100 item ids                                                                               |
| GET                 | `/sync/items/:id`                       | one item                                                                                                             |
| GET                 | `/sync/packs`                           | keyset `cursor` (chapter 08)                                                                                         |
| GET / POST / DELETE | `/sync/vaults`, `/sync/vaults/:vaultId` | the vault registry (`apps/sync-server/src/routes/sync.ts:79`, `:116`, `:140`)                                        |
| GET                 | `/sync/storage`                         | quota (`apps/sync-server/src/routes/sync.ts:280`)                                                                    |

## 5.2 Headers on every request

**Normative** (`packages/sync-client/src/pull/http.ts:70-77`):

| Header               | Value                                                    | Note                                              |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| `Authorization`      | `Bearer <accessToken>`                                   |                                                   |
| `Content-Type`       | `application/json`                                       |                                                   |
| `Accept`             | `application/json`                                       |                                                   |
| `X-Memry-Sync-Types` | comma-separated, **no spaces**                           | `packages/sync-client/src/pull/http.ts:18`, `:74` |
| `x-memry-client`     | `<platform>/<semver>[+build]`, **lowercase header name** | chapter 11                                        |
| `X-Memry-Vault-Id`   | the vault uuid, when one is selected                     | `packages/sync-client/src/pull/http.ts:19`, `:77` |

`X-Memry-Bootstrap-Token` is added only during a bootstrap session (chapter 10).

Note the casing asymmetry: `X-Memry-Sync-Types` and `X-Memry-Vault-Id` are
TitleCase constants; `x-memry-client` is lowercase
(`apps/sync-server/src/lib/client-identity.ts:8`). HTTP header names are
case-insensitive, so this is cosmetic, but a client that string-matches its own
constants must match the right spelling.

## 5.3 Type negotiation

**Normative.** Negotiation is a **header, not a query parameter**. Server
resolution (`apps/sync-server/src/lib/sync-types.ts:34-45`):

| Header state                           | Resolved set                                                      |
| -------------------------------------- | ----------------------------------------------------------------- |
| **absent**                             | `LEGACY_RECORD_SYNC_ITEM_TYPES`, the frozen 15 (`:35`)            |
| present, at least one entry recognised | the recognised entries, deduplicated, first-seen order (`:37-45`) |
| present, **nothing** recognised        | **the empty set**, serving zero rows                              |

**"Recognised" means a member of the twenty-five record types**, being the
thirteen this feature subscribes to plus the twelve it does not, both enumerated
in chapter 13 §13.1. `attachment` is in `SYNC_ITEM_TYPES` but is **not** a record
type (§13.8) and is therefore not recognised in this header: declaring it is
indistinguishable from declaring a typo. Anything outside those twenty-five is
dropped from the resolved set, silently and individually — an unrecognised entry
never fails the request and never invalidates the entries beside it. This only
bites a client that declares something outside the fixed thirteen; a conforming
client's header is recognised in full by construction.

The empty-set rule is deliberate: falling back to legacy would hand a
negotiating client 15 types it never asked for, which is the convergence loss
the feature exists to prevent
(`apps/sync-server/src/lib/sync-types.ts:21-26`). Entries are trimmed and
deduplicated because the header is unbounded client input (`:28-32`).

This feature's client declares **thirteen** types (chapter 13 §13.1); the
shipped TypeScript client declares all 25
(`packages/sync-client/src/pull/http.ts:74`).

### 5.3.1 The subset path — Q05.1

**Normative.** The server serves **only** the resolved set. `getChanges` takes
the resolved `syncTypes` (`apps/sync-server/src/routes/sync.ts:357`) and filters
on it, so **a subscribed-out type is never served in `items`**.

A client that receives a type it did not declare MUST treat it as a corrupt item
and record it, not apply it, and MUST NOT advance its cursor on that basis
alone; the page's cursor still advances (§5.14). This is a defensive rule about
a case the record feed cannot produce today, not a live path.

**FR-032's real risk is therefore not an unknown type; it is an unknown _field_
inside a known type.** That is chapter 13 §13.2, verbatim payload preservation,
and it is live on every type.

**Disposition of Q05.1: answered** (this section).

## 5.4 Push request

**Normative.** `RecordPushRequestSchema` allows **1 to 100** items
(`packages/contracts/src/sync-api.ts:398-400`). Every type in
`RECORD_CLOCK_REQUIRED_ITEM_TYPES` MUST carry a `clock`, enforced by a
`superRefine` (`packages/contracts/src/sync-api.ts:388-396`). **`settings` is the
only record type exempt** (chapter 00 §0.7).

`RecordPushItemSchema` omits `stateVector` (chapter 04 §4.6).

## 5.5 Push response

**Normative.** `{ accepted: string[], rejected: [{id, reason}], serverTime,
maxCursor }` (`packages/contracts/src/sync-api.ts:402-412`).

**Acks are per item id.** Two queued rows sharing an id cannot be told apart in a
mixed response, so **a client MUST collapse to one push item per id before
sending** (`apps/mobile/src/sync/outbox.ts:582-597`, rationale at `:584-589`).

Rejection reasons a client MUST handle:

| Reason                 | Meaning                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `SYNC_REPLAY_DETECTED` | §5.7; drop the queued row, the server is ahead                   |
| `SYNC_DELETE_WINS`     | §5.8; the id is tombstoned and this write did not see the delete |

A delete, being last, correctly wins over a preceding update when rows collapse,
because the newest row carries the whole payload as it stood at enqueue time
(`apps/mobile/src/sync/outbox.ts:584-589`).

## 5.6 The push wave

**Normative** (`apps/desktop/src/main/sync/engine/sync-context.ts`):

| Constant              | Value | Line   |
| --------------------- | ----- | ------ |
| `PUSH_BATCH_SIZE`     | 100   | `:126` |
| `MIN_PUSH_BATCH_SIZE` | 1     | `:131` |
| `MAX_PUSH_ITERATIONS` | 50    | `:132` |

**A 5xx on `/sync/push` is answered by halving the batch, not by resending the
same one**, and the reduced size becomes a ceiling for the rest of the run
(`apps/desktop/src/main/sync/engine/push-coordinator.ts:258-269`). `retryOn5xx`
is therefore `false` for this call (`:243-245`).

The reason is on record: Cloudflare terminates an oversized `/sync/push` at the
edge with an empty 503 body before any handler runs, so there is **no per-item
verdict** and an identical resend fails identically
(`apps/desktop/src/main/sync/engine/push-coordinator.ts:250-257`). Without
halving, the run ends there and the same rows return next cycle forever — one
vault sat at 2914 pending rows for five days.

## 5.7 Replay detection is a clock dominance rule, not a timestamp window

**Normative** (`apps/sync-server/src/services/sync.ts:179-190`). An incoming push
is a **replay** when a row already exists **and**:

- the incoming item carries no clock at all (`:180`), **or**
- no device key in the incoming clock exceeds the stored value for that key
  (`:183-187`).

Replays are rejected **per item** with reason `SYNC_REPLAY_DETECTED`; they do not
fail the batch (`apps/sync-server/src/services/sync.ts:542`).

**The check is skipped entirely for types outside
`RECORD_CLOCK_REQUIRED_ITEM_TYPES`**
(`apps/sync-server/src/services/sync.ts:215-221`), so a `settings` push is never
a replay.

## 5.8 Delete wins over a concurrent write

**Normative** (`apps/sync-server/src/services/sync.ts:234-245`). A non-`delete`
push against an id whose stored row has `deleted_at` set is rejected with
`SYNC_DELETE_WINS` **unless the incoming clock happens strictly after the stored
one** — dominating every component and exceeding at least one
(`apps/sync-server/src/services/sync.ts:193-202`).

The reason is on record
(`apps/sync-server/src/services/sync.ts:224-233`): `detectReplay` passes as soon
as **one** component is ahead, which a device that edited the item before it saw
the delete always satisfies, so without this rule the next write clears the
tombstone and the item returns to every device's manifest. Types without a
required clock, and legacy tombstones stored without one, keep the permissive
behaviour (`:242-243`).

**A conforming client MUST treat `SYNC_DELETE_WINS` as terminal for that queued
row** and MUST NOT retry it; the correct recovery is to pull the tombstone and
apply the delete locally.

### Client-side rule (same predicate, other direction)

**A conforming client MUST apply a pulled tombstone unless its local clock
happens strictly after that tombstone** — the mirror of the server predicate
above (`packages/sync-client/src/item-handlers/base-handler.ts`,
`resolveDeleteClock`). A local clock merely _concurrent_ with the tombstone MUST
NOT keep the item.

A client that also skipped the delete on a concurrent clock never converged: its
upsert is rejected with `SYNC_DELETE_WINS` on every push and its pull left the
item alive, so that one device kept a ghost copy of an item deleted on every
other device. The local edit is dropped; delete-wins is the protocol's
resolution for that conflict on both sides.

## 5.9 Content hash and the stored blob — Q05.3

**The same four fields are canonicalised twice, differently, and a client may
assume neither.**

### A. The R2 object and `contentHash` — JSON, server-side

**Normative.** `serializePayload` builds `{dataNonce, encryptedData,
encryptedKey, keyNonce}` and applies
`JSON.stringify(payload, Object.keys(payload).sort())`
(`apps/sync-server/src/services/sync.ts:261-269`). Plain JavaScript string sort
gives

```
dataNonce, encryptedData, encryptedKey, keyNonce
```

The bytes are
`{"dataNonce":"…","encryptedData":"…","encryptedKey":"…","keyNonce":"…"}` — no
whitespace, UTF-8. That exact string is the R2 object, and
`contentHash = lowercase hex SHA-256` of those same bytes
(`apps/sync-server/src/services/sync.ts:247-259`).

The server re-parses the object on pull and returns the four fields as `blob`, so
**a client never sees the canonical JSON** — only the four fields.

### B. The signature — canonical CBOR, client-side

**Normative.** `encodeCbor(signaturePayload, CBOR_FIELD_ORDER.SYNC_ITEM)`
(chapter 04 §4.7). Restricted to the four blob fields, the **encoded** order is

```
keyNonce(8), dataNonce(9), encryptedKey(12), encryptedData(13)
```

— length-first then bytewise, which is a **different order from A**.

**Core obligation.** B is mandatory for every push and every verify. A is needed
only by a client that computes a `contentHash` or a blob key, which no client
does today; it is stated so a future pack or manifest consumer is not surprised.
Use a CBOR encoder with RFC 8949 **§4.2.3** length-first ordering; an
insertion-order default (for example `ciborium`'s) is wrong. All current keys are
under 24 bytes, so §4.2.1 happens to agree on this set, but the rule is §4.2.3
because that is what the code implements.

**Disposition of Q05.3: answered** (this section).

## 5.10 Server-side size and page limits

**Normative** (`apps/sync-server/src/services/sync.ts:30-36`):

| Constant                   | Value | Line  |
| -------------------------- | ----- | ----- |
| `MAX_ENCRYPTED_DATA_BYTES` | 5 MiB | `:30` |
| `DEFAULT_CHANGES_LIMIT`    | 100   | `:31` |
| `MAX_CHANGES_LIMIT`        | 500   | `:32` |
| `D1_MAX_BIND_PARAMS`       | 95    | `:35` |
| `MAX_MANIFEST_PAGE_LIMIT`  | 1000  | `:36` |

`POST /sync/pull` takes at most **100** ids
(`packages/contracts/src/sync-api.ts:414-416`).

### 5.10.1 `limit` above the ceiling — Q05.4

**Normative: clamped, never rejected.**
`effectiveLimit = Math.min(limit ?? DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT)`
(`apps/sync-server/src/services/sync.ts:984`), and the manifest clamps the same
way against `MAX_MANIFEST_PAGE_LIMIT`
(`apps/sync-server/src/services/sync.ts:919`).

A `limit` that is **not a positive integer** is a different case and is rejected
`400 VALIDATION_ERROR` (`apps/sync-server/src/routes/sync.ts:319-321`, `:353-355`);
a `cursor` that is not a non-negative integer is `400 SYNC_INVALID_CURSOR`
(`:323-325`, `:348-350`). `logQueryValidationFailure` throws — its return type is
`never` (`apps/sync-server/src/routes/sync.ts:173-181`) — so none of these is a
silently ignored parameter.

**A client MUST NOT infer its page size from what it asked for.** It MUST read
the returned page and `nextCursor`.

**Disposition of Q05.4: answered** (this section).

### 5.10.2 Which `PULL_PAGE_LIMIT` — Q05.6

Desktop requests 500 (`apps/desktop/src/main/sync/engine/sync-context.ts:139`);
the platform-free engine requests 100
(`packages/sync-client/src/pull/engine.ts:60`).

**Normative: a new client SHOULD request `limit=500`**, the server's ceiling
(§5.10). Both values are conforming — the limit is clamped, not validated against
a client class — but 500 is five times fewer round trips against the same
rate-limit budget, and the first-sync arithmetic in chapter 10 §10.6 assumes it.
The platform-free engine's 100 is a conservative default, not a requirement.

**Disposition of Q05.6: answered** (this section).

## 5.11 Cursors

**Normative.** There is **one global record cursor per device**, a decimal string
of the server's `server_cursor`, advanced to `nextCursor` **only after the page's
items were applied** (`packages/sync-client/src/pull/engine.ts:25-26`, `:358`).

A client MUST NOT advance the cursor before applying, and MUST NOT keep a
per-type cursor: the feed is one ordered stream.

## 5.11.1 The response shapes

**Normative.** The chapters describe these routes' _behaviour_ at length and
never wrote down what comes back, so a port had to read the TypeScript to
deserialise a single page. Written out here; `?` marks optional, meaning
absent, never `null`.

**A ref row** — the unit `items[]` carries on every record route:

| Field          | Type                           |
| -------------- | ------------------------------ |
| `id`           | string                         |
| `type`         | `SyncItemType`                 |
| `version`      | non-negative integer           |
| `modifiedAt`   | non-negative integer, epoch ms |
| `size`         | non-negative integer, bytes    |
| `stateVector?` | string                         |

A ref row is metadata only. It carries **no ciphertext**.

**`POST /sync/pull`** — request `{ itemIds: string[] }`, **1 to 100**. The
field is `itemIds`, not `ids`.

Its response is `{ items: [...] }`, and **the item is not the §4.8 push
shape.** This asymmetry is the single costliest thing this chapter failed to
say: a port that assumes one envelope reads five hundred items in a row as
malformed, which is exactly what happened on the first staging run.

|                                                          | write (`POST /sync/push`)  | read (`POST /sync/pull`) |
| -------------------------------------------------------- | -------------------------- | ------------------------ |
| `encryptedKey`, `keyNonce`, `encryptedData`, `dataNonce` | **flat**, at the top level | **nested** under `blob`  |
| `id`, `type`, `operation`, `signature`, `signerDeviceId` | top level                  | top level                |
| `clock`, `deletedAt`, `cryptoVersion`                    | top level, optional        | top level, optional      |
| `stateVector`                                            | omitted (§4.6)             | omitted                  |

So a read item is
`{ id, type, operation, signature, signerDeviceId, cryptoVersion?, clock?, deletedAt?, blob: { encryptedKey, keyNonce, encryptedData, dataNonce } }`.
The four ciphertext fields are identical in both spellings; only their nesting
differs. A conforming reader accepts the nested form, and `record-envelope.json`
pins the flat one because the vectors are written from the writer's side.

**`GET /sync/changes`** → `{ items: <ref row>[], deleted: string[], hasMore: boolean, nextCursor: integer }`.

All four are **required**. `nextCursor` is an **integer, not a string** — a
port that types it as string-or-number will serialise the wrong thing back.

**`GET /sync/manifest`** → `{ items: <ref row>[], serverTime: integer, nextCursor?: integer }`.

Here `nextCursor` **is** optional: it appears only on a paginated call
(`?limit=N`) that has more rows, and is absent on the final page and on the
param-less everything-at-once call.

**`POST /sync/push`** — request `{ items: <push item>[] }`, **1 to 100 items**;
fewer than one or more than a hundred is rejected before anything is applied.
The push item is chapter 04 §4.8's shape minus `stateVector` (§4.6).

Response: `{ accepted: string[], rejected: [{ id, reason }], serverTime: integer, maxCursor: integer }`.

`rejected` is per item, so a partially accepted batch is normal and a client
must read it rather than infer success from the status code.

**`GET /sync/vaults`** → `{ vaults: [{ vaultUuid, itemCount, createdAt, encryptedName, nameNonce }] }`.

**The id field is `vaultUuid`**, not `id` and not `vaultId`. `encryptedName`
and `nameNonce` are exactly that — the server never sees a vault's name — and
`createdAt`, `encryptedName` and `nameNonce` may each be null.

A reader that cannot find the id field MUST report a malformed response rather
than skip the row: skipping turns a field-name mismatch into "this account has
no vaults" against an account holding four, which is the same failure FR-032
names for a zero-row first page. The envelope is an object with a
`vaults` key, not a bare array; a reader that accepts only an array fails on
every account. This route is account-scoped and sits **above** the vault
middleware, so it takes no `X-Memry-Vault-Id`.

## 5.12 Tombstones

**Normative.** `GET /sync/changes` returns
`{ items, deleted, hasMore, nextCursor }`
(`packages/contracts/src/sync-api.ts:450-455`).

- The client **unions `deleted` ids into the `/sync/pull` request for the same
  page** (`packages/sync-client/src/pull/engine.ts:350`), because tombstones
  arrive as **full signed items** and a set `deletedAt` is the delete signal
  (`packages/sync-client/src/pull/engine.ts:27-28`).
- **A present `deletedAt` overrides the declared `operation`**
  (`packages/sync-client/src/pull/engine.ts:229`).
- Tombstone bodies are **never decoded** (`packages/sync-client/src/pull/engine.ts:230-240`).
- An id in `deleted` with no ref row has **no type on the wire**; the client
  marks any existing row deleted and otherwise records a bare tombstone
  (`packages/sync-client/src/pull/engine.ts:415-418`).

### 5.12.1 Untyped `deleted` ids and a subset subscriber — Q05.2

**Normative.** A subset subscriber cannot tell what type a bare tombstone is for,
and **it does not need to**: the id space is `(type, id)` for bookkeeping
(§5.15), but a delete is idempotent and a delete for an id the client has never
seen is a no-op. A conforming client MUST record a bare tombstone for an unknown
id — so that a later pull of that id does not resurrect it locally — and MUST NOT
treat it as an error or as a reason to stop the page.

A client MUST NOT attempt to infer the type from the id shape: chapter 13 §13.6
records that `tag_definition` ids are tag names and `folder_config` ids are
folder paths, so id shapes are not disjoint across types.

**Disposition of Q05.2: answered** (this section).

## 5.13 Apply order

**Normative.** `PULL_APPLY_ORDER` assigns a rank and **everything unlisted
defaults to rank 1** (`packages/sync-client/src/pull/engine.ts:40-55`):

| Rank | Types                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| 0    | `project`, `folder_config`, `tag_definition`, `filter`, `settings`, `calendar_source`, `agent_conversation` |
| 1    | everything not listed                                                                                       |
| 2    | `task`, `agent_message`, `calendar_event`, `calendar_external_event`                                        |
| 3    | `calendar_binding`                                                                                          |

**The sort MUST be stable within a rank**
(`packages/sync-client/src/pull/engine.ts:57-58` uses a comparator that returns 0
for equal ranks over a copied array).

## 5.14 Failure isolation

**Normative.** Schema validation is **per item, not per page**: one malformed
item is recorded corrupt and skipped, never allowed to poison its 99 page-mates
(`packages/sync-client/src/pull/engine.ts:172-179`, `:208-226`). The reason is on
record: a whole-page `safeParse` drops the page, and on a first sync that wedges
every item sharing a chunk with one bad row.

- A page whose envelope is **not a pull envelope at all** is dropped and the
  cursor advances past it
  (`packages/sync-client/src/pull/engine.ts:199-205`, `:358`).
- **The breaker**: if a page yielded zero decoded items, produced at least one
  new corrupt item, and asked for at least one id, the cursor advances past the
  page but the run is **refused** so no success state is written
  (`packages/sync-client/src/pull/engine.ts:365-371`).

A conforming client MUST implement all three behaviours. Advancing the cursor
without reporting the refusal loses data silently; refusing without advancing the
cursor wedges the device on one poisoned page forever.

### 5.12.2 How a bare tombstone is stored

**Normative.** §5.12.1 establishes that a `deleted[]` entry is an **id with no
type**, while every other piece of client bookkeeping is keyed `(type, id)`.
The two were never reconciled, which left "where does this row go" unanswered.

A bare tombstone is recorded **keyed by id alone**, in a set consulted by id
before any apply. It is not stored as a row of the typed projection it might
have belonged to, because the type is exactly what the server did not send and
guessing it would resurrect the item under the wrong one.

The ordering matters and is the reason the rule exists: the tombstone check runs
**before** an apply, so an item that arrives on a later page — a re-delivery, or
a stale write from a device that had not seen the delete — does not resurrect
locally. A client that recorded the tombstone only against a typed row it
already had would lose the guarantee for any id it had never seen.

## 5.15 The manifest, and the absence of a digest

**Normative.** `RecordSyncManifestSchema` carries `nextCursor` **only** on a
paginated response that has more rows; it is absent on the final page and on
every parameter-less legacy call
(`packages/contracts/src/sync-api.ts:439-448`).

**There is no integrity digest on the manifest.** The only integrity machinery on
this path is the per-item signature (chapter 04 §4.8) and, for packs, the pack's
own digests (chapter 08).

**The sync bookkeeping key is `(type, id)` and never `id` alone.** Some ids are
not UUIDs: `tag_definition` ids are tag names and `folder_config` ids are folder
paths (chapter 13 §13.6). An id-only key made a project and a tag both named
`inbox` share one entry and corrupt each other's state
(`apps/desktop/src/main/sync/engine/sync-context.ts:118-124`).

## 5.16 Clock skew

**Normative.** `CLOCK_SKEW_THRESHOLD_SECONDS = 300`
(`apps/desktop/src/main/sync/engine/sync-context.ts:133`), compared against the
`serverTime` every push response and `GET /sync/status` returns
(`packages/contracts/src/sync-api.ts:410`, `:466`).

Because JWT clock tolerance is **zero** (chapter 02 §2.2), a device more than a
token lifetime out of true fails every authenticated request with a 401 that
looks like a dead session. **A conforming client MUST compare its own clock
against `serverTime` and, when the difference exceeds 300 seconds, surface "this
device's clock is wrong" rather than "you have been signed out", and MUST NOT
consume its refresh-rejection budget (chapter 02 §2.10) chasing it.**

## 5.17 `ConflictResponseSchema` — Q05.5

`ConflictResponseSchema` (`packages/contracts/src/sync-api.ts:480-489`) and
`SYNC_VERSION_CONFLICT` (`apps/sync-server/src/lib/errors.ts:31`) both exist.
**No route returns either**: the only reference to the code outside the enum is a
telemetry classification branch
(`apps/sync-server/src/services/sync-telemetry.ts:188`), and no client reads the
schema.

**Normative — this is a dead path.** Conflicts are resolved by the clock rules of
§5.7 and §5.8 on the server, and by chapter 06 on the client; there is no
server-mediated conflict response. A conforming client MUST NOT implement a
handler for it, and MUST tolerate the code arriving (chapter 00 §0.5.1).

**Disposition of Q05.5: answered** (this section).
