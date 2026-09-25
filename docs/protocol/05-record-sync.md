# 05 — Record sync

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

The record feed carries **metadata** for every syncable item. Note and journal
**bodies** travel as CRDT updates (chapter 07). A client that declares
`note_body` (§5.3) also receives body rows in `GET /sync/changes`, on the same
cursor (§5.11.1, chapter 07 §7.17).

## 5.1 Routes

**Normative.** Every route below is served under both `/sync/*`
(`apps/sync-server/src/routes/sync.ts:559-565`) and `/sync/records/*`
(`apps/sync-server/src/routes/sync.ts:557`). **A new client uses the unprefixed
form** (chapter 00 §0.3.1).

| Method              | Path                                    | Query / body                                                                                                         |
| ------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GET                 | `/sync/status`                          | none; returns `SyncStatusSchema` including `clientPolicy` (`packages/contracts/src/sync-api.ts:473-478`)             |
| GET                 | `/sync/manifest`                        | optional `limit` and `cursor`; **a cursor without a limit is a 400** (`apps/sync-server/src/routes/sync.ts:327-331`) |
| GET                 | `/sync/changes`                         | optional `cursor`, optional `limit`, optional `inline=1` (§5.11.2) (`apps/sync-server/src/routes/sync.ts:344-397`)   |
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
resolution (`apps/sync-server/src/lib/sync-types.ts:54-68`):

| Header state                           | Resolved set                                                      |
| -------------------------------------- | ----------------------------------------------------------------- |
| **absent**                             | `LEGACY_RECORD_SYNC_ITEM_TYPES`, the frozen 15, no bodies (`:55`) |
| present, at least one entry recognised | the recognised entries, deduplicated, first-seen order (`:57-68`) |
| present, **nothing** recognised        | **the empty set**, serving zero rows                              |

The server resolves the header into a subscription of two parts: the record
types, and whether `note_body` was declared
(`apps/sync-server/src/lib/sync-types.ts:20-24`).

**`note_body` and `purged_tombstones` are the feed-only tokens**
(`FEED_ONLY_SYNC_TYPES`, chapter 00 §0.7). `purged_tombstones` (#2302) says the
client applies purged-tombstone markers; §5.12.3 has its rules. The rest of
this paragraph is about `note_body` (#2295). Declaring it adds note and journal body rows to
`GET /sync/changes` (§5.11.1) and nothing else: it is never a record type, so it
never reaches the manifest, `POST /sync/pull`, bootstrap, or the record rows of
`/sync/changes`. A header of only `note_body` is recognised and resolves to zero
record types plus bodies. Declaring it does not replay body rows below the
client's cursor, and body rows written before migration `0011` carry no cursor
and are never in the feed (chapter 07 §7.17). Desktop declares
`purged_tombstones` (#2302) on every authenticated request, and `note_body`
(#2297) only on the `GET /sync/changes` of a pull run that starts past cursor 0,
so a bootstrap keeps 500-row pages (`apps/desktop/src/main/sync/http-client.ts:23`,
chapter 07 §7.17.5). `packages/sync-client` still sends `RECORD_SYNC_ITEM_TYPES`,
which contains neither. The Rust core
appends `note_body` to its record declaration on the `GET /sync/changes` of its
feed pull only, and records the declaration it restarts on without it, so
declaring bodies does not re-read the record feed (chapter 07 §7.17.4, #2304).
A server older than #2295 ignores the unrecognised entry.

**Otherwise "recognised" means a member of the twenty-five record types**, being
the fifteen this feature subscribes to plus the ten it does not, both
enumerated in chapter 13 §13.1. `attachment` is in `SYNC_ITEM_TYPES` but is
**not** a record type (§13.8) and is therefore not recognised in this header:
declaring it is indistinguishable from declaring a typo. Anything outside those
twenty-five is dropped from the resolved set, silently and individually — an
unrecognised entry never fails the request and never invalidates the entries
beside it. This only bites a client that declares something outside the fixed
fifteen; a conforming client's header is recognised in full by construction.

The empty-set rule is deliberate: falling back to legacy would hand a
negotiating client 15 types it never asked for, which is the convergence loss
the feature exists to prevent
(`apps/sync-server/src/lib/sync-types.ts:21-26`). Entries are trimmed and
deduplicated because the header is unbounded client input (`:28-32`).

This feature's client declares **fifteen** types (chapter 13 §13.1); the
shipped TypeScript client declares all 25
(`packages/sync-client/src/pull/http.ts:74`).

### 5.3.1 The subset path — Q05.1

**Normative.** The server serves **only** the resolved set. `getChanges` takes
the resolved subscription (`apps/sync-server/src/routes/sync.ts:372-375`) and
filters on it, so **a subscribed-out type is never served in `items`**, and
body rows are served only when `note_body` was declared.

A client that receives a type it did not declare MUST treat it as a corrupt item
and record it, not apply it, and MUST NOT advance its cursor on that basis
alone; the page's cursor still advances (§5.14). This is a defensive rule about
a case the record feed cannot produce today, not a live path.

**FR-032's real risk is therefore not an unknown type; it is an unknown _field_
inside a known type.** That is chapter 13 §13.2, verbatim payload preservation,
and it is live on every type.

**Disposition of Q05.1: answered** (this section).

## 5.4 Push request

**Normative.** The request allows **1 to 100** items. Every type in
`RECORD_CLOCK_REQUIRED_ITEM_TYPES` MUST carry a `clock`, enforced by a
`superRefine` on `RecordPushItemSchema` (`packages/contracts/src/sync-api.ts`).
**`settings` is the only record type exempt** (chapter 00 §0.7).

`RecordPushItemSchema` omits `stateVector` (chapter 04 §4.6).

An attestable delete (a clock-required type with a clock and a `deletedAt`)
also carries `deleteAttestation` (chapter 04 §4.8.4, #2408). The server
verifies it per item like the record signature; a server that predates #2408
strips the unknown key, so the delete lands unattested.

**Those item requirements are enforced PER ITEM, never as a request.** The route
parses `RecordPushEnvelopeSchema` — the same 1..100 bound with the items left
unvalidated — and then runs `RecordPushItemSchema` on each item. Only the
envelope can fail the request with a 400; a bad item costs one `rejected[]`
entry with reason `SYNC_INVALID_ITEM` (§5.5) and the rest of the batch commits.

A push item whose `type` is not a record type cannot be named in `rejected[]`:
it is dropped unanswered while its neighbours commit, and the request is still
a 200. **`note_body` takes exactly this path** (#2295): it is negotiable on the
feed but never a push type, so it never reaches `sync_items`. The client marks
an id that got no verdict as failed.

A server that answers a bad item with a request-level 400 is **non-conforming**.
That verdict names no item, so a client cannot learn which queued row to retire:
it marks nothing, re-sends the identical batch every cycle, and the vault never
syncs again. One clock-less note did exactly that to a paid vault (#2320).

## 5.5 Push response

**Normative.** `{ accepted: string[], rejected: [{id, reason}], serverTime,
maxCursor }` (`packages/contracts/src/sync-api.ts:402-412`).

**`maxCursor` MUST NOT be used to advance the pull cursor.** It is the cursor
of this device's own highest accepted row. Peer rows at lower cursors may still
be unpulled, and every read is `server_cursor > ?`, so advancing to `maxCursor`
skips them for good (#2283). The pull cursor moves only as §5.11 says.

**The server assigns cursors inside the transaction that commits the rows**
(`apps/sync-server/src/services/cursor.ts`, #2282). A reader can therefore
never observe a cursor above a range whose rows have not committed yet, which is
what makes paging by `server_cursor > ?` lossless.

**A device that paged before that fix may hold a skipped range, and re-reads
the feed once** (#2382). The state has three values: absent (not started),
`pending:<cursor>` (the record cursor was reset from `<cursor>` and no pull has
delivered since) and `done`. A pending repair resumes from the stored cursor
and never resets again, so a page refused on every run cannot restart it
forever. A device with no cursor goes straight to `done`. `done` is recorded
only after a pull that delivered. Desktop keeps it in `cursorSkipRepair`
(`apps/desktop/src/main/sync/engine/full-sync-runner.ts`). The Rust core keeps
it in the `meta` row `sync.cursor_skip_repair`, writes the reset and `pending`
in one transaction, and records `done` after a run that was not refused and
reached `hasMore: false` (`crates/memry-core/src/sync/feed_restart.rs`,
#2304).

**Acks are per item id.** Two queued rows sharing an id cannot be told apart in a
mixed response, so **a client MUST collapse to one push item per id before
sending** (`apps/mobile/src/sync/outbox.ts:582-597`, rationale at `:584-589`).

Rejection reasons a client MUST handle:

| Reason                 | Meaning                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `SYNC_REPLAY_DETECTED` | §5.7; drop the queued row, the server is ahead                   |
| `SYNC_DELETE_WINS`     | §5.8; the id is tombstoned and this write did not see the delete |
| `SYNC_INVALID_ITEM`    | §5.4; the item cannot satisfy the schema — permanent, retire it  |

`SYNC_INVALID_ITEM` carries the failing issue after the code, so a client MAY
log the reason verbatim. The verdict is permanent — resending the same bytes
cannot change it — so a client SHOULD retire the row rather than spend its
retry budget on it.

An item too malformed to yield both an `id` and a known `type` appears in
neither `accepted` nor `rejected`. **A client MUST treat an id it sent and got
no verdict for as failed**, which is what retires such a row.

A delete, being last, correctly wins over a preceding update when rows collapse,
because the newest row carries the whole payload as it stood at enqueue time
(`apps/mobile/src/sync/outbox.ts:584-589`).

## 5.6 The push wave

**Normative** (`apps/desktop/src/main/sync/engine/sync-context.ts`):

| Constant                                | Value | Line   |
| --------------------------------------- | ----- | ------ |
| `PUSH_BATCH_SIZE`                       | 100   | `:146` |
| `MIN_PUSH_BATCH_SIZE`                   | 1     | `:151` |
| `PUSH_CEILING_RAISE_AFTER_CLEAN_PUSHES` | 3     | `:155` |
| `MAX_PUSH_ITERATIONS`                   | 50    | `:156` |

**A 5xx on a batch that can still be split is answered by halving it, not by
resending the same one**, and the reduced size becomes a ceiling
(`apps/desktop/src/main/sync/engine/push-coordinator.ts:279-289`). `retryOn5xx`
is therefore `false` for any batch larger than `MIN_PUSH_BATCH_SIZE` (`:244`,
`:265`).

The reason is on record: Cloudflare terminates an oversized `/sync/push` at the
edge with an empty 503 body before any handler runs, so there is **no per-item
verdict** and an identical resend fails identically
(`apps/desktop/src/main/sync/engine/push-coordinator.ts:270-278`). Without
halving, the run ends there and the same rows return next cycle forever — one
vault sat at 2914 pending rows for five days.

**A batch at `MIN_PUSH_BATCH_SIZE` is retried with backoff** (chapter 00
§0.6.1, `retryOn5xx: true`). It has no smaller shape, so halving cannot answer
its 5xx, and a one-item request is not the oversized-batch case the rule above
guards against; the 5xx is a transient server fault and the backoff ladder is
the only move left. Before #2293 the run ended on it instead.

**The ceiling is not permanent.** After `PUSH_CEILING_RAISE_AFTER_CLEAN_PUSHES`
consecutive full-size pushes that got a response, it doubles, up to
`PUSH_BATCH_SIZE`, where it is cleared. A vault that is still too big at the
doubled size pays one refused request per raise and halves again. Before
#2293 one transient 5xx pinned the ceiling for the life of the process.

**A per-item `STORAGE_QUOTA_EXCEEDED` refuses that item only.** The client
marks it failed and acks the rest of the response, and the run keeps
dequeuing: the server refuses only items that grow storage, so a delete or a
shrinking update still commits and is the way out of the quota.

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

**The rule does not expire.** A tombstone past `version_history_days` loses its
payload but keeps its row as a marker (§5.12.3), and the marker keeps
`deleted_at` and `clock`, so this check and §5.7 refuse a stale push from a
device that was offline past retention exactly as they refuse one against a
fresh tombstone (#2302). Before #2302 the cleanup hard-deleted the row, push
found no row, and the stale write came back as a create. Tombstones that cleanup
already hard-deleted are gone; nothing identifies them, so they stay
unprotected. The one exception is a `create` over a marker for a
recreatable type, which re-creates the item (§5.12.3).

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

A purged tombstone (§5.12.3) is applied under this same rule, through the same
delete path.

### A re-create seeds its clock from the tombstone (#2409)

**Normative (client).** When a client writes an id it holds no clock for (a
`create`, or the first write to a clockless row, whatever operation it is sent
as) and it knows a tombstone clock `T` for that id, the new clock MUST be
`increment(merge(local, T), device)`. An `update` of a row that already has a
clock MUST NOT absorb `T`: that row survived the delete, and merging would turn
a concurrent edit into one that dominates it. The rule is
`recreateBaseClock` (`packages/sync-core/src/record-sync.ts`) and
`recreate_base` (`crates/memry-core/src/sync/clock.rs`); chapter 06 §6.1.1
pins both with `recreate-clock.json`.

The re-create then happens strictly after the delete and passes this section
and §5.7 unchanged, inside retention and over a marker alike. A stale device's
unchanged pre-delete version is refused as `SYNC_REPLAY_DETECTED`; an edited one
is concurrent with the re-create, and every client resolves it as a merge,
never as a dominating apply. A client's own late tombstone no longer deletes its
re-create, because the re-create's clock is strictly after it.

`T` is the pointwise max of every delete clock the client has made or applied
for the id, including a delete it applied to no local row and one it skipped.
Notes and journals share one tombstone family. Desktop keeps `T` in
`sync_tombstone_clocks` (data migration `0061`) and mints every first clock of
a `RECREATABLE_AFTER_PURGE_ITEM_TYPES` type through `nextLocalClock`
(`packages/sync-client/src/tombstone-clocks.ts`); the Rust core keeps it in
`sync_tombstone_clocks` (core migration `0004`) and seeds journal and folder
re-creates in `crates/memry-core/src/domain/recreate.rs`. The core also skips a
clocked tombstone its live row strictly dominates (the client rule above); a
tombstone without a clock still applies unconditionally. A client with no `T`
for the id (a delete made before this rule, or one it never saw) mints exactly
the clock it minted before.

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

**Normative** (`apps/sync-server/src/services/sync.ts:34-43`):

| Constant                      | Value  | Line   |
| ----------------------------- | ------ | ------ |
| `MAX_ENCRYPTED_DATA_BYTES`    | 5 MiB  | `:34`  |
| `DEFAULT_CHANGES_LIMIT`       | 100    | `:35`  |
| `MAX_CHANGES_LIMIT`           | 500    | `:36`  |
| `MAX_NOTE_BODY_CHANGES_LIMIT` | 100    | `:39`  |
| `D1_MAX_BIND_PARAMS`          | 95     | `:42`  |
| `MAX_MANIFEST_PAGE_LIMIT`     | 1000   | `:43`  |
| `MAX_INLINE_CHANGES_LIMIT`    | 100    | `:971` |
| `INLINE_MAX_BLOB_BYTES`       | 64 KiB | `:973` |

The last two apply only to `GET /sync/changes?inline=1` (§5.11.2).

`POST /sync/pull` takes at most **100** ids
(`packages/contracts/src/sync-api.ts:414-416`).

### 5.10.1 `limit` above the ceiling — Q05.4

**Normative: clamped, never rejected.**
`effectiveLimit = Math.min(limit ?? DEFAULT_CHANGES_LIMIT, MAX_CHANGES_LIMIT)`,
and to 100 when the request asked `inline=1` (`MAX_INLINE_CHANGES_LIMIT`,
§5.11.2) or declared `note_body` (`MAX_NOTE_BODY_CHANGES_LIMIT`), because such
a page carries payload bytes (`apps/sync-server/src/services/sync.ts:1116-1123`).
The manifest clamps the same way against `MAX_MANIFEST_PAGE_LIMIT`
(`apps/sync-server/src/services/sync.ts:909`).

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

**A ref's own `serverCursor` (§5.11.1) MUST NOT advance the cursor either**
(`packages/contracts/src/sync-api.ts:491-493`). It names the row for the
latency trace (#2280); a client that advanced to it mid-page would claim the
rest of the page as applied. Only the page's `nextCursor`, after the page is
applied, moves the cursor
(`apps/desktop/src/main/sync/engine/pull-coordinator.ts`, `persistPageCursor`).

**The cursor commits with the page's last rows when nothing runs after them**
(#2294). "After apply" includes every step that has to finish for the page to
count as applied, not only the row writes. Desktop applies a page of up to 500
refs in slices of at most 100 ids (§5.10), one transaction per slice, and the
cursor never moves before the last slice:

- When no slice of the page left post-commit work, the last slice writes
  `nextCursor` as the last statement of its own transaction, so the cursor and
  the page's last rows commit together or not at all.
- Post-commit work is any of: a crypto or parse failure awaiting its by-id
  re-fetch, a note or journal whose CRDT body is fetched after the commit, a
  `noteBodies` entry that still has to land in the CRDT store (#2297, chapter 07
  §7.17.5), an item deferred for an end-of-run retry, or a page transaction that
  could not be opened (the connection was already inside another transaction). Then the
  cursor is written after the page, once that work has run, as a separate
  statement.
- Either way the cursor is not written when an abort stopped the item loop.

Before any cursor write, the last slice's transaction flags the page's notes as
holding unmerged remote CRDT state and persists that debt, so a crash can never
leave a note looking merged with the cursor past it (a snapshot push from a
merged-looking note prunes peer updates; chapter 07).

A crash at any point before the cursor commits leaves it on the previous page,
so the whole page is pulled again on restart. Re-pulling is idempotent: the
rows that already committed arrive with an equal clock and an identical payload
and are skipped (chapter 06 §6.5.2 P4). A crash after an in-transaction cursor
commit can only lose the note files (healed by the bulk-apply journal) and the
index rows of that slice (healed by the vault re-index on the next open). A page
with no refs has no transaction to join and stores its cursor alone.

**Rust core** (#2304). Each record applies in its own transaction, so the
cursor cannot join the page's last row. It is written after the page applied,
in the one transaction that lands the page's note bodies and records their
debts (chapter 07 §7.17.4), so no body is left behind a cursor. The
post-apply work a re-pull would not redo is the body pull of the page's notes
and journals: a skipped identical row is not re-applied, so it no longer marks
the note as touched. The page therefore records a durable body debt, one
`meta` row `sync.body_owed:<docId>` per note or journal record, **before** it
applies the page, and takes back only the debts it created for records it then
skipped. A debt is cleared only after a per-note pull of that document that
reached the server's head and stored everything, or when the document is
tombstoned (`crates/memry-core/src/sync/body_debt.rs`). A snapshot push refuses
a document that is still owed one (chapter 07 §7.13.2, §7.17.4). The body step
that works the debts off never blocks the push.

Because cursors are assigned in commit order (§5.5) and the cursor moves only
after apply, a client MAY drop a realtime wake whose `cursor` is at or below its
applied cursor (chapter 09 §9.11). The wake's cursor is only compared, never
stored as the device cursor.

**The same cursor covers note bodies** (#2295). A `noteBodies` entry's `cursor`
is on the same per-user sequence as a record's `serverCursor` and follows the
same rule: it orders the entry, it never advances the client cursor. A page is
one consistent read of every source it covers, and every item, tombstone and
body entry in it lies in `(cursor, nextCursor]`
(`apps/sync-server/src/services/change-feed.ts:57-79`). A client that declared
`note_body` MUST apply the page's bodies together with its records before
storing `nextCursor`.

## 5.11.1 The response shapes

**Normative.** The chapters describe these routes' _behaviour_ at length and
never wrote down what comes back, so a port had to read the TypeScript to
deserialise a single page. Written out here; `?` marks optional, meaning
absent, never `null`.

**A ref row** — the unit `items[]` carries on every record route:

| Field          | Type                                |
| -------------- | ----------------------------------- |
| `id`           | string                              |
| `type`         | `SyncItemType`                      |
| `version`      | non-negative integer                |
| `modifiedAt`   | non-negative integer, epoch seconds |
| `size`         | non-negative integer, bytes         |
| `stateVector?` | string                              |

A ref row is metadata only. It carries **no ciphertext**.

`modifiedAt` is **epoch seconds**, not milliseconds: it is the row's
`updated_at`, written as `Math.floor(Date.now() / 1000)`
(`apps/sync-server/src/services/sync.ts:634`, read back at `:944` and `:1013`).
This table said epoch ms until #2280 needed a millisecond commit time and found
the column could not supply one.

**A `/sync/changes` ref adds two optional fields** (#2280,
`RecordChangesItemRefSchema` in `packages/contracts/src/sync-api.ts:514`). The
manifest ref does not carry them.

| Field            | Type                                                           |
| ---------------- | -------------------------------------------------------------- |
| `serverCursor?`  | non-negative integer, the row's `server_cursor`                |
| `committedAtMs?` | non-negative integer, epoch ms of the push batch that wrote it |

Both are absent against a server that predates them. `committedAtMs` is also
absent for a row last written before migration `0010`, which has no commit time
and is not backfilled (`apps/sync-server/src/services/sync.ts:1077-1079`).
`serverCursor` is a trace key, never a pull cursor (§5.11). A client that does
not know the fields ignores them; one that does MUST treat either as optional.

**`POST /sync/pull`** — request `{ itemIds: string[] }`, **1 to 100**. The
field is `itemIds`, not `ids`.

Its response is `{ items: [...], purgedTombstones?: [...], blobMissing?: [...] }`,
and **the item is not the §4.8 push shape.** This asymmetry is the single costliest thing this chapter failed to
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

`purgedTombstones` (§5.12.3) and `blobMissing` (§5.12.4) are present only when
non-empty, so a page with neither is byte-identical to the pre-#2302 response.
`purgedTombstones` is only ever sent to a client that declared
`purged_tombstones` (§5.3).
They are siblings of `items`, never elements of it: a client that predates them
reads `items` alone and ignores the keys, while an unknown entry inside `items`
would be recorded as an invalid item. The response schema types both arrays as
`unknown[]`; a reader validates each entry on its own (§5.14)
(`RecordPullPurgedTombstoneSchema`, `RecordPullBlobMissingSchema` in
`packages/contracts/src/sync-api.ts`).

**`GET /sync/changes`** → `{ items: <changes ref>[], deleted: string[], hasMore: boolean, nextCursor: integer, serverTimeMs?: integer, inline?: <read item>[], noteBodies?: <body entry>[] }`.

The first four are **required**. `nextCursor` is an **integer, not a string** — a
port that types it as string-or-number will serialise the wrong thing back.
`deleted` stays a bare id array; the trace fields are on live refs only.

`noteBodies` is present, possibly empty, **iff** the request declared
`note_body` (§5.3); a client that did not declare it gets the response above
without the key, byte for byte. Absent on a request that declared it means the
server does not serve bodies in the feed. Entries are in cursor order
(`packages/contracts/src/sync-api.ts:557`). The page schema types the array
as `unknown[]`: a reader validates each entry with `NoteBodyChangeSchema` on its
own, so one bad entry costs that entry, never the page (§5.14). A body entry
is:

| Field            | Type                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| `op`             | `'update'` or `'snapshot'`; the set is frozen                        |
| `noteId`         | string, the CRDT document id (a note or a journal, chapter 07 §7.1)  |
| `cursor`         | positive integer, the row's `server_cursor`                          |
| `sequenceNum`    | integer, the document's sequence number (chapter 07 §7.4)            |
| `signerDeviceId` | string                                                               |
| `createdAt`      | non-negative integer, epoch seconds                                  |
| `size`           | non-negative integer, stored bytes                                   |
| `data?`          | `update` only: base64 packed envelope, as in chapter 07 §7.11        |
| `revision`       | `snapshot` only: the same token as `GET /sync/crdt/snapshot` returns |

An `update` entry without `data` was too large to inline; a `snapshot` entry is
always a ref. Chapter 07 §7.17 gives the fetch rules.

`serverTimeMs` is the server's epoch-ms time when it answered the page
(`apps/sync-server/src/routes/sync.ts:396`), optional because an older server
does not send it. It exists so a client can estimate its clock offset from the
request's round-trip midpoint for the latency trace. It is not an input to any
sync decision; §5.16 skew detection keeps using the seconds `serverTime`.

`inline` is present only when the request asked with `inline=1` (§5.11.2). Each
element is a `POST /sync/pull` read item.

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

## 5.11.2 Inline payloads on `/sync/changes` (#2292)

**Normative.** `GET /sync/changes?inline=1` returns the page's payloads with
its refs, so a device woken by one small change applies it after one request
instead of two (`apps/sync-server/src/services/sync.ts:1096`).

- **Opt-in.** Without the `inline` query the response has no `inline` key and
  is byte-for-byte the pre-inline response. `inline` is absent or `1`; any
  other value is `400 VALIDATION_ERROR`, never a silently ignored parameter
  (`apps/sync-server/src/routes/sync.ts:366-369`). A server that predates the
  query ignores it, and the reader sees a page with no `inline`.
- **Page clamp.** An inline page holds at most `MAX_INLINE_CHANGES_LIMIT` (100)
  rows, whatever `limit` asked (clamped, never rejected, §5.10.1). A client
  reads `hasMore` and `nextCursor` as for any page.
- **What `inline` holds.** Each element is exactly what `POST /sync/pull`
  returns for that row, byte for byte, tombstones included (with `deletedAt`).
  `items`, `deleted`, `hasMore` and `nextCursor` keep their meaning: `inline`
  never replaces the ref listing, and a reader that ignores it stays correct.
- **Size.** A row is inlined only when its stored object is at most
  `INLINE_MAX_BLOB_BYTES` (64 KiB), so a response stays near 6.5 MB.
- **Coverage is by id.** `POST /sync/pull` ids are untyped (§5.12.1), so the
  server puts an id in `inline` only when every row this page holds for that
  id is in `inline` (`apps/sync-server/src/services/sync.ts:981-986`). A row
  the server cannot read (missing blob, missing signer metadata, corrupt
  stored data) takes its whole id out of `inline`; the page still answers 200
  (`apps/sync-server/src/services/sync.ts:1006-1026`).
- **Reader.** The reader MUST pull, with `POST /sync/pull`, every page id
  (`items` ∪ `deleted`) that no `inline` element names, and only those
  (`apps/desktop/src/main/sync/engine/changes-page.ts:28`). It MUST NOT infer
  which ids were inlined from `size`. Inline and pulled items of a page are
  applied as one page: the same per-item validation (§5.14), the same apply
  order across both sources (§5.13), and `nextCursor` stored only after the
  whole page applied (§5.11). A remainder `/sync/pull` that is not a pull
  envelope refuses the page even when inline items exist (§5.14).
- **When to ask.** A client SHOULD ask only on the first page of an
  incremental pull, not during a first sync: an inline page carries a fifth of
  the refs of a 500-ref page, so asking on every page moves backlog load onto
  the `sync_changes` rate limit. Desktop asks on the first page of a pull
  outside a full sync, which is the socket wake and the periodic pull; startup,
  "Sync now" and a first sync are full syncs and do not ask
  (`apps/desktop/src/main/sync/engine/pull-coordinator.ts:292`). The Rust core
  asks on the first page of a pull that starts from a stored cursor, and not
  on a first sync or a pull from no cursor, both of which read backlog
  (`crates/memry-core/src/sync/pull.rs` `pull_first_page`, #2304).
- **With `note_body`.** A request may both ask `inline=1` and declare
  `note_body` (#2295, §5.3). The page is then one merged page of records and
  body rows, clamped to 100 rows, and it carries both `inline` and
  `noteBodies`. `inline` covers only record rows the page serves, read after
  the page is closed, so it never names a row past `nextCursor`; `noteBodies`
  is exactly what the same request without `inline` would return.

## 5.12 Tombstones

**Normative.** `GET /sync/changes` returns
`{ items, deleted, hasMore, nextCursor }`
(`packages/contracts/src/sync-api.ts:450-455`).

- The client **unions `deleted` ids into the `/sync/pull` request for the same
  page**, minus the ids an `inline` element already delivered (§5.11.2)
  (`packages/sync-client/src/pull/engine.ts:350`), because tombstones
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

- A page whose envelope is **not a pull envelope at all** MUST NOT advance the
  cursor; the run is refused (#2285). Such a body is a server contract
  regression, not a poisoned item: it is fixed on the server, and the page must
  still be there to re-pull when it is. Dropping it lost every item on the page.
  Desktop: `apps/desktop/src/main/sync/engine/pull-envelope.ts`; Rust core:
  `crates/memry-core/src/sync/pull.rs`, which applies nothing from the page.
  The shared pull engine (`packages/sync-client/src/pull/engine.ts:199-205`)
  still drops and advances.
- An item that fails its schema (the envelope schema, or the handler's payload
  schema) is recorded, not dropped: the cursor moves on, and the client
  re-fetches it by id after an app update (#2285).
- `purgedTombstones` and `blobMissing` entries are validated one by one, like
  items: a malformed entry is refused on its own and never costs its siblings or
  the page (#2302).
- **The breaker**: if a page yielded zero decoded items, produced at least one
  new corrupt item, and asked for at least one id, the cursor advances past the
  page but the run is **refused** so no success state is written
  (`packages/sync-client/src/pull/engine.ts:365-371`).

A conforming client MUST implement all of these behaviours. Advancing the cursor
without reporting the refusal loses data silently; refusing without advancing the
cursor on a poisoned page (the breaker) wedges the device on that page forever.
The non-envelope case is the exception because the fault is on the server.

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

### 5.12.3 Purged tombstones (#2302)

**Normative.** A tombstone's signed payload is kept for the user's
`version_history_days` (0 when the user has no entitlement row). After that the
server sheds the payload (the R2 object, `signature`, `content_hash`, and
`size_bytes`, which is refunded) but **keeps the row as a marker**: `deleted_at`,
`clock`, `server_cursor` and the `(type, id)` identity stay
(`apps/sync-server/src/services/cleanup.ts`, `cleanupExpiredTombstones`;
migration `0013_sync_items_tombstone_marker.sql`). The server never deletes a
`sync_items` row on retention.

- **A marker is visible only to a client that declares `purged_tombstones`**
  in `X-Memry-Sync-Types` (§5.3). For that client it appears in
  `GET /sync/changes` `deleted`, except on a request with `cursor = 0`: a fresh
  or reset device gains nothing from it and must not delete rows it restored
  locally. Every other client (older desktops, the shared sync-client, the Rust
  core) never sees a marker on the read side, exactly as when the old cleanup
  hard-deleted the row. The id is not in `deleted`, so no client applies it as
  an untyped §5.12.1 tombstone. A marker is excluded from the manifest for
  everyone.
- The marker is the row with `deleted_at` set and `blob_key = ''`.
  `payload_purged_at` only records when the payload was shed: a worker rolled
  back past #2302 can re-delete over a marker without clearing it, and that row
  holds a signed payload again, so it is served signed and shed again.
- The shed deletes each user's objects in one bulk R2 call and marks only rows
  whose object delete succeeded; a failed delete leaves them for the next tick.
  It sheds at most 200 rows for 20 users per tick, because the cron invocation
  shares its subrequest budget with pack backfill.
- It still refuses a stale push with `SYNC_DELETE_WINS` or `SYNC_REPLAY_DETECTED`
  (§5.7, §5.8), for every client, declared or not. A push whose clock happens strictly after the marker's re-creates
  the item as before, and reserves its full size.
- **Re-create after the purge.** A push with `operation: 'create'` over a
  marker is accepted as a new version, with a fresh size reservation and
  without the §5.7 and §5.8 checks, **only** for types whose id legitimately
  comes back after a delete (`apps/sync-server/src/services/sync.ts`,
  `RECREATABLE_AFTER_PURGE_ITEM_TYPES`), for one of two reasons:
  - the id is derived from user-visible data, so re-creating the thing
    re-creates the id: `journal` (`j<YYYY-MM-DD>`), `tag_definition` and
    `property_definition` (the name), `folder_config` (the path),
    `canvas_folder` (`cvf_<path>`), `bookmark` (`bmk_<type>_<id>`),
    `calendar_source`, `calendar_external_event` and `calendar_binding`
    (provider-derived ids);
  - the id is carried in a file the user can restore: a `note`'s id lives in
    its frontmatter, so restoring a deleted note file from a backup or the OS
    trash re-creates the same id.

  Such a create carries a fresh clock that the old tombstone's clock
  dominates, so without this rule the marker would refuse it forever and the
  item would never reach another device. Every other clock-required type mints
  random ids that live only in the database, so a same-id `create` over its
  marker can only be a stale resurrection and is refused. `update` and
  `delete` over a marker, and every push against a tombstone still inside
  retention, follow §5.7 and §5.8 unchanged. `settings` has no required clock
  and was never refused.

- `POST /sync/pull` returns it in `purgedTombstones` to a declaring client (and
  leaves it out for any other), never in `items`, and never reads R2 for it. A tombstone row whose blob is gone before it is marked is
  served the same way: a delete does not need its bytes.
- `?inline=1` never inlines a marker; its id is left to `POST /sync/pull`.

A purged tombstone entry has no record signature. It carries the deleting
device's delete attestation (chapter 04 §4.8.4, #2408) when there is one:

| Field                | Type                                                           |
| -------------------- | -------------------------------------------------------------- |
| `id`                 | string                                                         |
| `type`               | `RecordSyncItemType`                                           |
| `deletedAt`          | non-negative integer, as the deleting device pushed it         |
| `clock?`             | vector clock; absent for a legacy tombstone stored without one |
| `serverCursor`       | non-negative integer, the row's `server_cursor`                |
| `signerDeviceId?`    | string; the device that attested the delete                    |
| `deleteAttestation?` | base64; present together with `signerDeviceId`, or neither     |

The server serves the two attestation fields only together, only when the row
holds both, which it does only for a delete whose push carried a verified
attestation (migration `0015_sync_items_delete_attestation.sql`). They ride on
the `purged_tombstones` capability; no other token gates them.

A conforming client:

- MUST apply a purged tombstone only if this request named its id, its type is
  in `RECORD_CLOCK_REQUIRED_ITEM_TYPES`, and it carries a non-empty clock. Any
  other entry is refused and applies nothing: without a clock the handler guard
  cannot run and the delete would be unconditional.
- MUST apply an admitted entry only if its `deleteAttestation` verifies under
  the signing key of `signerDeviceId` over the entry's **own** `type`, `id`,
  `clock` and `deletedAt` (#2408). An entry with no attestation, half of one,
  a signer that a completed device-key lookup does not name, or a signature
  that does not verify is refused,
  logged and never applied; the cursor still advances. Every marker shed before
  #2408, and every delete an old client pushed, is such an entry: **it is
  always refused.** No local evidence can stand in for the signature, because
  the only clock to compare against is the one the server asserts.
- MUST NOT turn a failure to obtain the signer's key (no session token, a
  network error, an unreadable device list) into a refusal: the page fails and
  the cursor holds, so the entry is verified on a later pull. Once refused, the
  cursor has passed the marker and the delete is lost for this device.
- MUST compare `deletedAt` with local timestamps in one unit: it is served as
  pushed, seconds from the desktop and milliseconds from the Rust core.
- MUST NOT apply an admitted entry to a local row that has no clock or an empty
  clock: the handler guard would be skipped and the unsigned delete would be
  unconditional (a restored vault folder, a tag minted from note usage).
- For a `RECREATABLE_AFTER_PURGE_ITEM_TYPES` item, MUST NOT apply it while the
  item has a queued create or update, or when the local row was created or
  modified after the entry's `deletedAt`. That is a re-create or a restore,
  which the server accepts over the marker; deleting it first would lose it.
- SHOULD refuse an entry whose clock names a device id that appears neither in
  the local row's clock nor among the account's devices the client knows.
- SHOULD apply no purged tombstone during a pull run that started from cursor 0
  (a fresh or reset device), since only the first page of such a run comes from
  cursor 0.
- Otherwise MUST apply the entry exactly as it applies a signed tombstone with
  the same clock, under the §5.8 client rule: a local clock strictly after the
  tombstone keeps the item.
- MUST NOT delete a local row, or skip re-uploading it, because the server does
  not list it. Absence carries no clock, and every read path has legitimate
  absences (a partial manifest, a type the server does not serve, a lost blob,
  a tombstone purged before #2302).

Desktop: `apps/desktop/src/main/sync/engine/pull-envelope.ts` admits entries,
verifies each attestation (`apps/desktop/src/main/sync/delete-attestation.ts`,
keys from the local `sync_devices` cache, then `GET /auth/devices`), applies the
local refusals in `purged-tombstone-guard.ts`, and only then maps an attested
entry to the apply input a signed tombstone produces. It declares
`purged_tombstones`. A corrupt-item refetch counts an unattested entry as
`missing`, like an entry the envelope refused. The Rust core and the shared
sync-client do not declare it (#2304), so they never see a marker; an iOS device
that missed a delete keeps its copy locally, and the marker stops a push of it
from reaching the server. The Rust core produces attestations on every
attestable delete it pushes and carries the verifier
(`crates/memry-core/src/protocol/delete_attestation.rs`), but consumes no
purged tombstone: that would need a new delete path on iOS, and the §5.12.1
untyped-delete behaviour stays as documented there.

**Residual risks.**

- A client that does not apply the marker (an old desktop, iOS until #2304, or
  a current desktop that refused it locally) still holds the item. Its manifest
  repair re-uploads it as `create`, which the server accepts over the marker
  for a recreatable type: the item comes back. The current desktop re-uploads
  only after a pull that delivered in the same run, and the pull is what
  applies the marker. This matches the pre-#2302 behaviour for these types.
- A re-create from a client that does not seed its clock (§5.8, #2409) stores a
  fresh clock that the old tombstone's clock dominated. A device offline past
  retention with the old version and a higher clock can overwrite the
  re-created item on its next update. A seeding client's re-create happens
  strictly after the tombstone and does not have this problem; the remaining
  sources are older desktops and iOS builds, a client that never saw the
  tombstone (markers are not served from cursor 0), and rows re-created before
  the upgrade.
- **Resolved for the desktop (#2408):** a purged tombstone used to be asserted
  by the server alone, so a malicious one could name a known device with a
  dominating clock and delete any note, task or journal. The desktop now
  applies only a device-attested delete. The trust root is the same as the
  record signature's: a server that can inject a fake device into
  `GET /auth/devices` can still forge either.
- A delete attested by a device that was revoked before this client cached its
  key is refused (`signer_unknown`): `GET /auth/devices` lists active devices
  only. The item stays, as for any refused entry.
- Every marker shed before #2408, and every delete from an old client, is
  refused for ever. That is the pre-#2302 outcome for a device that missed the
  delete.
- Orphan repair trusts server absence: a parent the server serves as a refused
  purged tombstone counts as gone, exactly as a parent it omits, so the child is
  tombstoned. The attestation does not protect children of a parent the server
  claims is gone; a server that omits the parent achieves the same.

**Removing the re-create allowance.** A seeded create passes §5.7 and §5.8
without it, so the allowance only matters for the unseeded sources above. It
may be narrowed or removed only when both hold: `minWriteVersion` (chapter 11)
is past the first seeding release for desktop and for iOS, and a client that
holds no `T` for an id can learn the marker's clock (for example a per-item
rejection that carries it, followed by a re-seed and retry). Until then it
stays exactly as specified above.

### 5.12.4 Rows whose payload is lost (#2302)

**Normative.** When `POST /sync/pull` finds that a live row's R2 object is gone
while the row still points at it, it stamps `blob_missing_at` on the row and
returns `{ id, type, serverCursor }` in `blobMissing`. A 404 on a row that was
replaced after it was read is not a lost blob: the row is left out, as before,
and the replacement arrives at a later cursor. There is no background sweep:
the pull, which meets every lost blob a client actually needs, is what reports
it. Nothing deletes a row because of it. The next accepted push of the item
clears it, and nothing triggers that push automatically.

A conforming client records a `blobMissing` entry, applies nothing for it,
never treats it as a delete, keeps any local row, and advances the cursor
normally. Desktop holds it in the schema-invalid ledger as kind `blob_missing`,
so the manifest check does not count the item as server-only (which would reset
the cursor to 0 on every check), and re-fetches it by id on the corrupt-item
cooldown. Orphan repair tombstones a child only on a positive "gone" answer for
its parent (requested and no live row served, or its delete applied here); a
parent in `blobMissing`, on the re-fetch cooldown, or in the schema-invalid
ledger keeps its children.

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
