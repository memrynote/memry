# Vault Packs

A pack is an immutable byte container holding many already-encrypted blobs plus a trailing index.
It exists for one reason: a fresh device establishing every note body used to spend two
`crdt_pull` GETs per note — one baseline, one incrementals page — against a 600/min bucket, so a
cold vault's first sync was dominated by small-object round trips rather than by bytes. A
`crdt_snapshot` pack carries hundreds of those baselines in one transfer, and the CRDT sweep that
follows finds those notes already seeded and issues zero `GET /sync/crdt/snapshot/:noteId` for
them.

Packs are written by the sync server (`apps/sync-server/src/services/pack-compaction.ts`), read by
the desktop client (`apps/desktop/src/main/sync/packs/`), and the layout they share lives in
`packages/contracts/src/pack-format.ts` — the only package both halves depend on, since the
architecture check forbids the desktop app importing from `apps/sync-server`.

## Packs Are a Derived Cache

This is the load-bearing property of the whole pipeline, and every other rule below follows from
it: **individual blobs remain the source of truth.** Compaction deletes nothing, invalidates
nothing, rewrites nothing, and is never charged against quota. A pack that is corrupt, missing,
stale, unreachable or simply never built costs a client one fallback branch — the item-granular
endpoints it would have used anyway.

The server never decrypts anything it packs. Payload bytes are copied verbatim from their source
R2 objects: for `crdt_snapshot`, the exact encrypted body a snapshot push stored. The server can
concatenate ciphertext and hash it; it cannot read a byte of it.

Replaced and deleted items are simply dead bytes inside old packs. A pack is written once and
never modified. The one exception is deleting a note or journal: the server then drops the whole
set of `crdt_snapshot` packs for the vault and rebuilds it (see below).

## `MPAK` v1 Layout

All integers are big-endian. Header 8 bytes, footer `PACK_FOOTER_SIZE` = 53 bytes.

| Region             | Bytes                | Contents                                                                              |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------- |
| **Header**         | 8                    | magic `MPAK` (4) · version uint8 · reserved (0) · flags uint16 (0 today)              |
| **Payload region** | sum of entry lengths | Opaque ciphertext, concatenated in index order, no padding or separators              |
| **Index block**    | `entryCount` records | One record per written entry, in the order their payloads appear                      |
| **Footer**         | 53                   | payload sha256 (32) · entryCount uint64 · indexOffset uint64 · `MPAK` · version uint8 |

One index record:

| Field          | Width          | Meaning                                                                               |
| -------------- | -------------- | ------------------------------------------------------------------------------------- |
| `kind`         | uint8          | `PackKindCode` — `record` 0, `crdt_snapshot` 1, `crdt_update` 2                       |
| `idLen`+id     | uint16 + bytes | UTF-8 identity a client matches on: `type:id` for records, the note id for CRDT kinds |
| `keyLen`+key   | uint16 + bytes | The source R2 key — provenance, and the per-item fallback address                     |
| `sortKey`      | int64          | `server_cursor` for records and updates; `created_at` epoch seconds for snapshots     |
| `metaLen`+meta | uint16 + bytes | UTF-8 JSON, or empty. Per kind: see [entry meta](#entry-meta-per-kind)                |
| `offset`       | uint64         | Entry start **within the payload region** (add the 8-byte header for a file offset)   |
| `length`       | uint64         | Entry byte length                                                                     |
| `sha256`       | 32             | Digest of this entry's payload bytes                                                  |

Two digests, at two granularities, on purpose. The footer's covers the whole payload region and is
the cheap "is this file intact" check; each entry's covers only that entry's slice, so a streaming
reader can verify one item at a time without holding the file, and a single bad entry can be
discarded without discarding the pack.

The footer is at a fixed offset from the end, so a reader probes the tail first — magic and version
before any hashing — and rejects a foreign or future format outright. The header magic is checked
too: both ends carry it so a truncated-then-appended file cannot pass as valid.

### Reader memory bounds are in the format, not in a comment

A streaming reader sizes two allocations from fields it read out of the pack itself: the index
block from the footer's `indexOffset`, and one entry's slice from that entry's `length`. Both are
corruption- or attacker-controlled — a single flipped byte in an 8-byte `indexOffset` still points
inside the file, which would turn "read the index block" into "read the whole pack into one
buffer", the exact property the streaming reader exists to guarantee it never does.

`PACK_MAX_ENTRIES` (4096), `PACK_MAX_INDEX_ENTRY_BYTES` (4096) and the derived
`PACK_MAX_INDEX_BYTES` are therefore part of the contract rather than a deployment tuning knob.
They are sized against the format: a realistic index record (a `type:uuid` identity, an R2 key and
a freshness token) is roughly 230 bytes, and the server packs at most 256 items per pack.

## Compaction

Compaction is triggered two ways, both of which converge on the same idempotent core:

- **Queue nudge.** `POST /sync/push` and `POST /sync/crdt/snapshot` enqueue one message per
  request (not per item) onto `PACK_QUEUE` after their own commit has settled, through
  `waitUntil`. A failed enqueue can therefore never fail an already-committed push. The consumer
  runs one message per invocation (`max_batch_size = 1`, `max_concurrency = 1`, `max_retries = 3`).
- **Queue backpressure.** Queues answers a burst with `Too Many Requests`. The producer retries the
  send twice with full jitter (`ENQUEUE_RETRY_DELAYS_MS`, 200 ms upper bound), then gives up with a
  typed `PACK_ENQUEUE_RATE_LIMITED` 429. That is an expected condition, not a defect: the vault's
  rows still sit above its watermark, so the cron backfill re-drives it. Telemetry records it as a
  handled warning rather than an unhandled 500, so it stays visible without reading as an outage.
  Any enqueue failure that is not backpressure still surfaces as a genuine unhandled error.
- **Cron backfill.** The 6-hourly sweep builds nothing itself (#5278). It enqueues one backfill
  message per vault and kind with work on its own queue (`PACK_BACKFILL_QUEUE`,
  `memry-pack-backfill-<env>`), so nudges and the purge's delayed retry never wait behind it. Each
  source (the kinds above their bound, and each kind's build backlog, oldest first) gets at most
  `BACKFILL_MESSAGES_PER_SOURCE` = 25 messages, 100 per tick, so no kind starves another. Each
  message runs in its own consumer invocation, rolls up and builds within 900 subrequests (3 builds
  or 12 rollups), and re-enqueues itself `BACKFILL_HOP_DELAY_SECONDS` = 10 s later, at most
  `BACKFILL_MAX_HOPS` = 64 messages per chain. Only a build that cannot list now ends the chain
  (`PackBuildResult.reason` below the fill, at the listing cap, or held on a collision); a window
  of holes or a lost race does not. A vault's backlog drains minutes after a tick instead of 3
  packs per tick across all vaults, and a dropped or bounded chain resumes on the next tick from
  the watermark. The two consumers may run one message each for a vault at once; the build's
  watermark compare-and-swap and the rollup's guarded swap keep them from listing a range twice.

An absent `PACK_QUEUE` binding makes `enqueuePackCompaction` a no-op, which is how local dev
without Queues keeps working: compaction is an optimisation, never a correctness requirement.

### Selection and the watermark

`pack_watermarks` holds one composite marker per `(user, vault, kind)`: everything strictly below
`(last_sort_value, last_sort_tiebreak)` is packed or deliberately skipped. The comparison is a
row-value comparison, not a bare `>` on the sort value, because `crdt_snapshot` orders on
`created_at` **seconds**, which tie heavily; the tiebreak (`note_id`) is what makes progress exact
instead of skipping or looping on a tie group.

Selection takes up to `PACK_MAX_ITEMS` = 256 rows ascending and stops before the projected payload
crosses `PACK_TARGET_BYTES` = 24 MB. The target is set by the Workers isolate's 128 MB memory cap:
assembly holds one contiguous buffer for the whole file plus one transient source blob while it is
copied in, so 24 MB keeps peak at roughly 24 MB + ≤8 MB + baseline. `PACK_HARD_MAX_BYTES` = 32 MB
remains as a documented guard so the target cannot be raised back into isolate-unsafe territory
without confronting it.

Selection leaves out the snapshot of a note id whose `note` and `journal` rows in `sync_items` are
all tombstones. A delete purges the note's `crdt_snapshots` row (#2986), but tombstones from before
that purge, and pushes whose purge failed, keep the row until the cleanup sweep. A fresh device applies packs
before the pull that delivers the tombstone, so a packed body of a deleted note reaches the device
as if it were live. A note id with any live `note` or `journal` row still packs, and so does one
with no row yet, because a snapshot can land before its record. Dead rows stay in the scan and are
skipped like oversized rows, so the watermark moves past a tail of them. If the filter ran in SQL,
such a vault would scan nothing, stay first in the oldest-first backfill list, and take a message
of each tick's fan-out. The filter only covers packs built after the delete.

A pack built before the delete is immutable and still carries the body. A deleted id can come back:
a journal day is always `j<date>`. If that pack survived, a fresh device would apply the deleted
body to the re-created day. So when the server purges a deleted note's body
(`services/document-body-purge.ts`, protocol chapter 07 §7.15 and chapter 08 §8.13), it takes
every snapshot and update pack that holds the note out of the listing and rewrites each without it
(`services/pack-purge-rewrite.ts`). Every body pack row records the note and journal ids it holds
in `pack_index.documents` (migration 0024), and the purge reads that column, so it finds the
note's older revisions in any pack built before its last snapshot write and leaves every other
pack alone. A body kind that still lists a pack built before migration 0024, whose `documents` is
NULL, is dropped whole and its watermark reset instead, as every purge did before; the rebuild
records `documents`, so the next purge is scoped. A rewrite that cannot read its pack or loses its
commit twice resets the kind the same way. Until a rewrite commits, a fresh device fetches the
other bodies of that pack item by item. A compaction run that selected the old snapshot before the
purge cannot publish it: it inserts the `pack_index` row and advances the watermark in one batch,
guarded on every packed snapshot row still existing with the packed blob and its note not dead.
If the guard fails, it deletes the pack object and the next run reselects.

A journal day re-created on a build before #5351 (core) or #5358 (desktop) shows the other side
of the purge. That build wrote the new text on top of the deleted body, so after the purge the
server holds only the new updates, and a fresh device holds them pending and shows the day empty.
The author device still has the deleted body, so it repairs the day once
(`apps/desktop/src/main/sync/revive-heal.ts`, `crates/memry-core/src/sync/revive_heal.rs`). For
each live note or journal day it once deleted, it reads the server body into a scratch document.
When that body is pending and the device's own state completes it, the device pushes its full
state as one update. The day then reads on every device, and the deleted text comes back beside
the new text. That is a known limitation: the alternative loses the new text.

Rows larger than `MAX_PACKED_ITEM_BYTES` = 8 MB are excluded from packs permanently and stay on the
item-granular tail. The largest legal record payload is roughly 7 MB of JSON text (a 5 MB decoded
payload inflated by base64 and the envelope) and snapshots cap at 5 MB, so this excludes anything
near the bound: one item can never dominate a pack, and memory during the bounded-concurrency fetch
stays predictable.

### Retry safety

At-least-once queue delivery means every step has to tolerate re-running:

1. Selection reads the watermark, so a crash re-selects the same range.
2. The pack object key is unique per build: it ends in the build's `pack_index` id, so no build
   writes a key another build wrote, and a purge that deletes a dropped pack's object can never
   delete a rebuild of the same range.
3. `pack_index` carries `UNIQUE (user_id, vault_id, item_kind, min_cursor)`, so only one listed
   pack can start at a given `min_cursor`. A snapshot range whose first row shares the second of a
   listed pack (a tie group larger than one build) rolls that pack and its new rows into one pack,
   taking only the new rows that fit beside it (`readCollidingPack` in `services/pack-rollup.ts`).
   When none fit or the listed pack cannot be read, a record or update build lists nothing, holds
   the watermark and logs at error level, because those kinds sort on the unique `server_cursor` and
   only a foreign row collides (#5229). A snapshot build lists the rest of that second in a pack of
   its own at the highest free `min_cursor` below it (`snapshotSlot`), logged at warning level, so a
   tie group of any size is packed and the colliding pack is not downloaded again (#5310). Readers
   never read `minCursor`, and a snapshot pack is a cache, so its range only has to bound its
   entries. Such a pack holds that one second, and a rollup never ends a run at a pack that a later
   pack starts inside, because the swap guard would refuse it.
4. The order is **object → one D1 batch**: `storage.put(packKey, built.bytes)`, then one batch that
   inserts the `pack_index` row and moves the watermark only if that row was inserted. A crash
   between the PUT and the batch leaves an orphan pack object — harmless invisible bytes, since only
   a `pack_index` row makes a pack listable. When the batch does not list the row (a lost watermark,
   a purge, the listing cap), the same batch records the object in `pack_replaced_objects`, due at
   once, and the build deletes it. A failed delete is retried by the next deletion pass instead of
   waiting for the orphan sweep. A rollup that loses its index swap does the same. When the batch
   throws, the writer records the object the same way, best effort, and does not delete it: a batch
   can commit and lose its response, and that commit can land after any read the writer makes. The
   deletion pass deletes it later, only while no row lists its key (`listingBatch` in
   `services/pack-replaced-objects.ts`).

A build that crashed in the PUT-to-row window leaves an object no row points at, and the retry
writes a new key, so that object is never listed. The 6-hourly cleanup cron deletes it
(`cleanupOrphanedPackObjects` in `services/cleanup.ts`): it lists the `packs/` prefix of every vault
that has a `pack_index` or `pack_watermarks` row, and deletes an object only when it is older than
an hour and no `pack_index` or `pack_replaced_objects` row has its key, rechecked in D1 right
before the delete. The hour keeps
it clear of a build still committing. It reads five list pages of 90 objects per tick and resumes
from `pack_orphan_sweep` (migration 0022) on the next. The key is
`<userId>/vaults/<vaultId>/packs/<kind>/<minSortValue>_<maxSortValue>_<packId>.pack`, `packId`
being the build's `pack_index` id. The vault prefix is deliberate, so vault deletion's prefix purge
reaches these objects too.

### Holes

A slot in the selection whose bytes cannot be used is a **hole**: it is skipped, and it produces no
index record at all. Four conditions make a hole. What a hole means to a client depends on the
kind. A record row the writer cannot pack is omitted, the record range still spans it, and the
cursor-exact manifest reconcile (chapter 08 §8.10) pulls it. A lost snapshot ends a body range
only while its row still points at the key that 404'd; a row replaced since then sits at a higher
cursor.

| Condition                     | Why it is a hole rather than a failure                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source blob returns null      | Replaced or deleted between selection and fetch, or a dangling row. Not an error — the pack is a cache of a moving target.                                                                                                                                                                                                                       |
| Zero-length blob              | Real ciphertext is never empty (XChaCha20 always carries a MAC), but an aborted write can leave a 0-byte object, and a row declaring `size_bytes` 0 slips past the drift check below (`0 === 0`). The writer rejects an empty entry, and that throw would escape before the watermark moved — so the range would re-select and re-throw forever. |
| Declared-vs-actual size drift | The blob was replaced under a stable key after selection sized the buffer. Copying it would overrun or misalign the layout.                                                                                                                                                                                                                      |
| Record payload hash mismatch  | A record's bytes do not hash to the `content_hash` of the row its meta came from, so meta and payload would be two versions. A push that replaced the row moved it to a higher cursor, where the tail serves it.                                                                                                                                 |

Holes are skipped through `skipEntry`, never a bare `continue`: the writer claims slots in strict
plan order, so an unclaimed slot makes the next `writeEntry` throw and abort the whole range before
the watermark moves. A window where _every_ candidate turned out to be a hole writes no pack and
still advances the watermark, so it cannot loop.

### `PACKED_KINDS` is `['crdt_snapshot', 'record', 'crdt_update']`

A record entry carries the pull item's signature, signer device id, operation, `deletedAt` and
clock as its meta, so a client verifies it exactly as an item from `POST /sync/pull`. The meta
comes from `recordMetaFromColumns` in `services/sync.ts`, the function the pull builds its items
from, and the selection query reads it in the same row read as `blob_key` and `content_hash`.
Tombstones are packed while their payload exists.

The writer leaves out a row that the pull would not serve as an item, or that no reader accepts: a
purged tombstone (`blob_key` empty), an unknown type, a row without signer metadata or with a
corrupt clock, and a row whose index record would exceed `PACK_MAX_INDEX_ENTRY_BYTES`. The
watermark still moves past them.

Each queue message builds one pack per kind, about 542 subrequests together, and a large vault
builds across invocations from its watermarks. The Rust core reader is a later step of
[#5221](https://github.com/memrynote/memry/issues/5221).

An update entry is one `crdt_updates` row: the document id as identity, empty `keyBytes`,
`server_cursor` as sort key and watermark, and `{sequenceNum, signerDeviceId, createdAt}` as meta.
Its payload is `update_data`, read from D1 in windows of about 4 MB, so an update build makes no R2
GET per entry and takes up to `PACK_MAX_ENTRIES` = 4096 rows instead of 256. Rows pruned behind a
snapshot (#2299) or purged with their document no longer exist and are never selected, and a row
with a NULL `server_cursor` (written before migration 0011) stays on the update routes. The commit
is guarded like the snapshot one: every packed update row must still exist and its document must
not be dead, or the pack is discarded and the next run reselects.

Both update routes answer a per-document `floor`, the highest purged sequence number, read in the
same D1 batch as the updates. A reader applies a packed update only above it, so a pack downloaded
before a purge never brings the deleted incarnation back. The purge batch takes every update pack
whose `documents` names the purged document out of the listing for its rewrite, whether or not its
update rows still exist: a snapshot that pruned the packed update rows leaves them only in the
packs. While the vault still lists an update pack built before migration 0024 and the document
has any body row, update or snapshot, the batch drops every update pack and resets the watermark.

A push nudge builds no update pack. A backfill message the cron enqueues builds one under the
minimum fill below.

### Minimum fill, rollup and the pack bound

Each push used to build one pack from whatever sat past the watermark, and nothing merged packs
afterwards. The staging vault `sandboxmobile` listed 230 snapshot packs holding 9,754 entries for
6,484 live snapshots, so at least a third of its packed bytes were dead.

**Minimum fill.** A build of any kind cuts a pack only when the kind holds 256 unpacked rows, its
rows reach 24 MB, or its oldest unpacked row is 24 hours old (`PACK_MIN_FILL_ROWS`,
`PACK_SETTLE_SECONDS`, `services/pack-sizing.ts`). Younger rows stay on the item routes and the
feed. `findBacklogVaults` skips a vault below that fill, so the tick enqueues no message for it.

**The bound.** A vault lists at most `2 * (ceil(entries / 4096) + ceil(bytes / 24 MB)) + 2` packs
of one kind, where `entries` and `bytes` are what its listed packs of that kind hold
(`packCountBound`). For `sandboxmobile`'s snapshots that is `2 * (3 + 1) + 2 = 10`.

**Rollup** (`services/pack-rollup.ts`). While a kind lists more packs than its bound, a rollup takes
the longest run of adjacent packs (ascending `min_cursor`) that fit one pack together: at most 4096
entries, 24 MB and 64 packs. It downloads and verifies them, keeps every entry that is still
current, and writes one new pack under a new key. It drops:

- a record entry whose row moved to a higher cursor or was shed to a marker,
- a snapshot entry whose row now has another blob key or was purged,
- an update entry whose row was pruned or purged.

A deleted document's body rows stay in packs until the purge removes them and rewrites those packs.
An input pack it cannot download or verify is logged by id, left out, and the rollup planned again
over every listed pack of the kind without it, downloading at most 64 packs in all. A run never
spans an unreadable pack, and each one can split a run in two, so a kind lists at most its bound,
plus twice its unreadable listed packs, plus the transient one. An unreadable pack stays listed and
readers treat it as absent and take its range item by item. While the kind is above its bound,
every backfill message's rollup reads it and logs it at error level with its id and kind
(`rollup input pack unreadable`). Within the bound no rollup reads it, so nothing reports it;
detecting and rebuilding it there is #5272.

One D1 batch then records the old objects in `pack_replaced_objects`, deletes the old
`pack_index` rows and inserts the new one. The batch applies only while every old row is still
listed and every kept entry is still current, so a purge, shed or push that landed meanwhile wins
and the rollup records and deletes its own object. The watermark does not move. A record rollup's coverage is
the union of its inputs'; body packs carry no coverage yet.

**Grace period.** An old object stays readable for 600 seconds after its row leaves the listing,
twice the presigned URL lifetime, so a client that listed it before the rollup still downloads it.
`deleteReplacedPackObjects` deletes it after that, at the start and the end of every compaction
message for that vault, so a failing build cannot block it, at the start and the end of every backfill message, and at the start of every backfill tick. The record lives in D1, so a Worker restart does not
lose it, and the orphan sweep leaves every key in that table alone.

**Purge deadline.** A body purge skips the grace for objects that may hold the purged body: its
batch makes the replaced objects of each body kind the note has rows of due at once, and records
each pack it takes out of the listing as a pending rewrite. It then runs up to four rewrites, each
of which makes its old object due, and a deletion pass. Within 900 seconds of the purge the note's
ciphertext is gone from every pack object:

- With at most four rewrites and R2 answering, the purge deletes the old objects before it
  returns.
- Otherwise the purge's caller enqueues a compaction message 660 seconds later. Every compaction
  or backfill message runs four rewrites before its first deletion pass (`withReplacedObjectPasses`
  in `services/pack-message-passes.ts`). A deletion pass that meets a rewrite
  still pending past the 600-second grace resets that kind (drops its packs and sets its watermark
  to 0, so compaction rebuilds it) and deletes the object, so the delayed message finishes the
  rest. A rollup never merges across the range of a pending rewrite.
- That message fails while objects stay due or rewrites pending, so Queues redelivers it up to
  three times with no delay, inside the 240 seconds left.

The deadline is missed when the delayed message is never enqueued or when all four deliveries
fail. A purge that throws after its batch commits still enqueues the delayed message, from a push
or the cleanup; a purge whose batch never commits has not started the deadline, and the cleanup
retries it. The message logs `replaced pack objects still due after the compaction message;
redelivered` (or `backfill message`) at error level. The fallback is the deletion pass at the start of
every 6-hourly backfill tick, which covers every vault, and any later compaction or backfill message
for the vault. Record packs are not scoped yet: older versions of the deleted note's record stay in record
packs until a rollup drops them (#5247).

The 6-hourly cleanup purges at most five vaults per tick, about 41 subrequests.

**Where it runs.** Every compaction message rolls up each kind once before building, which is what
makes room in a vault at the 999-pack cap, and once more after a build that listed a pack, so the
message ends at or under the bound. Builds take the watermark with a compare-and-swap, so the nudge consumer and
the backfill consumer never both list one window. Every backfill tick enqueues each kind above
its bound, and a backfill message rolls the kind up before each build, so a vault that stopped
pushing still drains. A message that spends its budget on its last build has none left to roll up,
so a kind may list one pack above its bound until the chain's next message or the next tick.

**Observability.** Each rollup logs `pack rollup` with `packsBefore`, `packsAfter`, `bound`,
`inputs`, `entriesIn`, `entriesKept` and `deadRatio`. For one vault, this D1 query gives packs and
entries per kind:

```sql
SELECT item_kind, COUNT(*) AS packs, SUM(item_count) AS entries, SUM(byte_size) AS bytes
FROM pack_index WHERE vault_id = ? GROUP BY item_kind;
```

### Entry meta per kind

Chapter 08 §8.4 of `docs/protocol` is normative; this is the summary.

| Kind            | `metaBytes`                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `record`        | `RecordPackEntryMetaSchema`: the `/sync/pull` item without `id`, `type` and `blob`. Meta plus payload rebuild the pull item. |
| `crdt_snapshot` | `{sequenceNum, revision}`                                                                                                    |
| `crdt_update`   | `CrdtUpdatePackEntryMetaSchema`: `{sequenceNum, signerDeviceId, createdAt}`. The payload is the stored packed envelope.      |

A record entry with no meta, which is what a record pack built before this contract holds, is
unusable on its own and the item stays on `POST /sync/pull`. Released desktop and iOS builds skip
`record` and `crdt_update` packs at listing time, so a server can list them without breaking those
builds. A client advances a document's update cursor across packed updates only while their
sequence numbers are consecutive, and pulls the rest from the server at the first gap.

**Desktop body reader (#5390).** Desktop downloads every `crdt_snapshot` and `crdt_update` pack,
then reads the body manifest (`GET /sync/crdt/manifest`, every page, after the pack bytes), then
opens each document once and applies its packed snapshot and its packed updates in one pass
(`packs/body-plan.ts`, `packs/pack-body-applier.ts`). A snapshot applies only when its revision is
the manifest's. Updates apply from the snapshot's sequence, or from the document's own watermark
under the same revision, each one above the manifest `floor` and exactly the cursor plus one; two
entries for one sequence with different digests disable that document's packed updates. An update
verifies against its `signerDeviceId` key only. The walk stops at the first gap, a failed read or
a failed verify, and no watermark is written while the doc holds structs whose dependencies it
never received, so the item routes fill the rest. When a server before #5232 answers the first
manifest page 404, desktop applies packed snapshots under the old rule and no packed update. A read
that stops short on a server with the route applies no packed body at all (§8.11). A snapshot pack
counts as applied for the resume watermark only once every usable document it holds has run.
Record packs apply through the pull before the first cursor: see
[Record packs and the first cursor](#record-packs-and-the-first-cursor).

## Coverage Semantics a Client Must Respect

A pack advertises a range on its kind's ordering axis. Three rules govern what that range does and
does not promise.

**Membership is verified against the index block, never inferred from the range.** An item whose
sort key falls inside `[minCursor, maxCursor]` may have been a hole, or may be dead bytes from
before it was replaced. The client looks the identity up in the file's own index and falls back to
the item GET when it is not there.

**Snapshot rows below the watermark are healed.** The watermark is composite
`(created_at, note_id)`. A note written in the same second as an already-packed tie group but with
a _smaller_ `note_id` sorts below the watermark, and a build before #5310 passed the rest of a tie
group it could not roll in. Each such row is in no pack, which costs every fresh device one
`GET /sync/crdt/snapshot/:id`. The cron finds vaults holding a snapshot row at or below the
watermark that no pack's `documents` holds, and that vault's snapshot backfill chain packs those
rows once nothing is left above the watermark (`services/pack-snapshot-heal.ts`). The pack starts
at the row's second, or at the free `min_cursor` below it, and the watermark does not move. Its
commit holds only while no listed pack holds any of its documents, so two runs never pack a row
twice, and only while the watermark is the one it read, so a kind reset in between leaves the rows
to the rebuild. A pack waiting for its purge rewrite is out of the listing, so its documents look
unpacked: the heal does nothing while any snapshot rewrite is pending, and a free `min_cursor` is
never one a pending rewrite lists its pack back at. A vault that still lists a snapshot pack from before migration 0024 is not healed, since D1
does not know what that pack holds. A row whose blob is gone stays unpacked, and the cron sends its
vault one message per tick that lists nothing.

**Items over 8 MB are never packed**, per `MAX_PACKED_ITEM_BYTES` above.

Two packs can also share a `maxCursor`: a same-second group larger than the byte target is split
across packs. Any client bookkeeping keyed on `maxCursor` has to treat such a tie group as a unit —
see the watermark rule below.

### The coverage contract

Chapter 08 §8.10 to §8.14 define the contract steps 04 to 07 of #5221 build. Since step 07
(#5230) the listing sends each pack's `coverFrom` and `coverThrough`, and the first page, in both
`GET /sync/packs` and the `POST /sync/bootstrap` open response, states `record` coverage from the
record watermark's anchor (`COVERED_KINDS` in `pack-list.ts`). Body kinds state none yet: their
packs carry no range, and a body reader trusts the body manifest. A record chain built before
migration 0023 has no anchor; the next record build re-anchors it (`recordChainReanchor`): its
packs leave the listing, their objects wait out the grace period, and the kind is rebuilt from
cursor 0 with ranges that tile.

**Bootstrap.** The open response carries the first pack page and its coverage, so a client needs
no listing request to start. After the response it logs one line per open with each kind's
coverage, its uncovered row count (counted up to 256) and the reason (`cache_only`,
`never_packed`, `unanchored`, `tail`), and starts a backfill chain for each kind a build can extend,
on the backfill queue, so a push nudge or a purge retry never waits behind it. A vault's kind gets
at most one chain start per 15 minutes, held in `pack_bootstrap_enqueues` (migration 0025), so
repeated opens start one chain, and a failed send gives the start back to the next open
(`pack-coverage.ts`). A rollup reads the pending purge rewrites before the listing and plans around
them. Its swap fails when another rewrite became pending or another pack of the kind now starts
inside its range, so a rollup and a purge rewrite never list the same range twice. A client never
waits for that work: it takes whatever is not covered item by item.

- **One axis.** Every pack gets a coverage range `(coverFrom, coverThrough]` on `server_cursor`,
  for every kind. The first `GET /sync/packs` page states, per kind, `packedThrough` and
  `coveredThrough`. A body pack holds every needed row whose cursor is in its range, and no needed
  row sits in `(packedThrough, coveredThrough]`. A record row the writer cannot pack (a lost blob,
  an oversize entry) is left out while the range still spans it, so record ranges tile. Selecting snapshots by `server_cursor` removes the
  same-second under-coverage above. `minCursor` and `maxCursor` keep their old meaning for
  released readers.
- **Tail start.** A reader chains its usable packs of each kind from 0. If the chain reaches
  `packedThrough`, that kind is covered through `coveredThrough`. Otherwise it is covered only to
  the end of the chain. The tail starts at the lowest kind. A 404, a bad pack, a pack that a
  rollup took out of the listing, or a lost snapshot only lowers the start, and a reader should
  read the feed across such a gap instead (one page for a lost snapshot). Record packs can miss
  rows, so the reader reads the manifest after the pack bytes. The check is cursor-exact: it
  pulls every listed item it lacks or holds at another `server_cursor` (a record entry's sort
  key), pulls every item when the manifest has no cursors, and does not apply a packed live record the manifest leaves out. Packed snapshots and updates are confirmed through the batch route, read after
  the pack bytes.
- **Rollup.** Built: see [Minimum fill, rollup and the pack bound](#minimum-fill-rollup-and-the-pack-bound).
  A record rollup's range is the union of its inputs', which the listing sends.
- **Scoped purge.** Built for body packs: see [Minimum fill, rollup and the pack
  bound](#minimum-fill-rollup-and-the-pack-bound). Rewriting record packs and the
  purged-tombstone marker rule are not built (#5247).
- **Sizing.** A pack holds at most 4096 entries and 24 MiB. A vault lists at most 999 packs, so
  a released reader's 1,000-pack walk never truncates. Compaction checks the cap before a build
  and again in the batch that inserts the row, against the rows before it. A build deletes its
  object only when its own `pack_index` row is absent after that batch (a guard refused it or a
  concurrent build won), so a listed row always has its object. The cron backfill skips capped
  vaults.

## Client Bootstrap Flow

The pack path runs on a **fresh device only** — the engine's `LAST_CURSOR` state key is absent —
after the bootstrap session opens and before the item-granular pull. It is awaited rather than
fired off, because it writes into the same Y.Docs and the same databases the pull is about to
touch.

1. **Discover.** Walk `GET /sync/packs` newest-first at `PACK_LIST_PAGE_LIMIT` = 50 per page, for
   at most `MAX_PACK_LIST_PAGES` = 20 pages. Keep only packs that carry a `url`, carry an
   `expiresAt`, and whose expiry is more than `PRESIGN_EXPIRY_SAFETY_SECONDS` = 30 seconds away.
   Snapshot packs at or below a previous run's `PACKS_APPLIED_THROUGH_CURSOR` are dropped before
   anything transfers. Record packs are kept only while `LAST_CURSOR` is absent
   (`packs/pack-bootstrap.ts:334`): a device with a cursor already holds every record below it.
   The first page's `record` coverage statement is kept for the record plan.
2. **Transfer.** Up to `MAX_PARALLEL_PACK_DOWNLOADS` = 3 packs concurrently, newest cursor range
   first, paced through the same `DownloadPacer` the attachment queue uses at
   `PACK_DOWNLOAD_MAX_REQUESTS_PER_MINUTE` = 60. Elevation **multiplies** that ceiling —
   `effectiveMaxRequests` is `Math.max(1, Math.floor(maxRequests * multiplier))` — so a bootstrap
   run paces at 60 × 5 = 300 requests/minute and a run with no session paces at 60. The factor is
   read exactly once, when the pacer is constructed, and the pacer deliberately does not subscribe
   to `onBootstrapElevationChange`: a session that ends mid-run only ever narrows the factor back
   toward the base, and pack transfers are one large object each rather than thousands of small
   ones, so the ceiling is a runaway-resume guard rather than the shaping force.
   The pacer governs the pack transfers themselves, which are presigned GETs straight to R2 and
   therefore hit no Worker bucket at all. The `GET /sync/packs` listing that precedes them is not
   paced and spends the ordinary `sync_packs` bucket, which a bootstrap session does not elevate.
   Each pack streams to a temp file under `userData/sync-packs`; a partial file is resumed with
   `Range: bytes=<have>-` rather than restarted, and a server that ignores the Range and answers
   200 restarts cleanly. Body chunks go straight to the file handle — a pack is never materialised
   as one buffer.
3. **Read.** `openPackFile` opens the temp file and hands it to `openPack`, which reads the footer
   tail, then the header, bounds-checks `indexOffset` and `entryCount`, caps and decodes the index
   block, bounds-checks every entry against the payload region, and finally verifies the
   whole-payload sha256 by streaming the region in `PACK_READ_CHUNK_BYTES` = 256 KB chunks. A
   structurally bad pack is therefore rejected after it has been read, not before it is opened —
   what the streaming reader guarantees is that nothing proportional to the file is ever held in
   memory, not that a bad file is diagnosed without touching it.
4. **Apply.** For each `crdt_snapshot` entry with a well-formed `{sequenceNum, revision}` meta: ask
   the local snapshot watermark whether these bytes are still worth applying, read that entry's
   slice, verify it against the index's per-entry digest, decrypt, verify the Ed25519 signature,
   and seed the Y.Doc — with `skipSeed`, so the doc is not first seeded from local markdown, which
   would give it a client id and a history the packed baseline never saw. On success the note's
   snapshot watermark is recorded, which is what makes the CRDT sweep skip its baseline GET.
5. **Commit.** Every `PACK_APPLY_PAGE_ENTRIES` = 100 applied entries, and at the end of each pack,
   the page transaction commits with the pack watermark written **inside** it.
6. **Settle after a delivered pull.** A packed body lands before any record does, and packs are
   immutable, so a pack can hold the body of a note deleted after it was built. The write-back an
   apply arms therefore writes nothing: it never creates a note for a doc with no row. Once a pull
   reports it delivered, each packed doc whose id now has a note or journal row is written to that
   note's file (`CrdtProvider.materialize`), and each one whose id has no row is purged, watermark
   included. Without the first half a live note would keep the body its record carried, because
   the record's CRDT walk finds the watermark current and merges nothing. Without the second, a
   deleted note's doc would outlive it.

   The settle is durable. Before an apply records its watermark, it writes a
   `packSeeded:<noteId>` row to `sync_state` (and `packSeedSettlePending` once per run), and the
   settle removes a row only after its doc is settled. A run killed after pack apply, or mid-settle,
   is finished by the next full sync whose pull delivers, on the same device. Sign-out keeps these
   rows along with the per-vault CRDT store they describe, so a sign-out during the first sync is
   finished after the next sign-in. The settle does nothing while the CRDT store is not open (the
   provider runs in memory), stops at the next doc once the run is aborted, and keeps a row whose
   whole-body debt could not be persisted. Up to `PACK_SEED_SETTLE_CONCURRENCY` = 8 docs settle at
   once (`engine/full-sync-runner.ts:52`); each clears only its own row. A pull that does not
   deliver settles nothing, so no packed doc is purged before its record could land. A doc that
   comes back empty is never written over the record's file; its watermark is dropped instead, so
   the record's walk fetches the whole body.

### Signer identity

The index block carries a snapshot's freshness token but not its signer device id — that column
never made it into the format. A packed blob is therefore verified against every signing key the
account has registered, and the first key whose signature verifies is the signer.

This is not weaker than the item path. There the server names the signer and the client verifies
that one claim; both paths prove exactly "signed by a key this account registered", and forging
either still requires a device secret key the server never sees. A blob that verifies under no
known key is refused, and that note falls back to `GET /sync/crdt/snapshot/:noteId`, which does
carry the signer id and can refresh the device-key cache.

One consequence is easy to miss: on a fresh install `sync_devices` holds only this device's own
row, and peer rows arrive through the item-granular CRDT pull that runs _after_ the pack path.
Every packed snapshot was signed by some other device, so the applier refreshes the device-key
cache lazily — once per bootstrap, and only once an entry is actually up for apply, so a vault with
no usable packs pays nothing.

The key that verified the previous snapshot is tried first (`packs/pack-body-applier.ts:77-94`).
An account keeps a key for every device it ever linked, and most snapshots come from the few
devices that compacted last. Trying every key per snapshot cost 126 s of a 270 s pack phase on
17k notes. The order does not change which key verifies.

### `PACKS_APPLIED_THROUGH_CURSOR`

The watermark is the **highest pack cursor covered by an unbroken run of fully-applied packs,
counting from the oldest pack upward**. Not the highest completed pack.

Transfers run newest-first so recent notes appear first, which means the completed set is normally
a _suffix_. A watermark recording the highest completed pack would claim coverage over ranges that
were never applied. Advancing only across an unbroken prefix keeps the claim true, at the cost of
re-opening at most one interrupted pack on resume — which is cheap and idempotent, because every
note that already landed fails its freshness gate and is skipped.

Ties advance as a group. Two packs can share a `maxCursor`, and the resume filter is
`maxCursor > watermark`, so recording a value another uncompleted pack also carries would exclude
that pack from this run and from every run after it, permanently. A tie group advances the
watermark only when every pack in it completed.

The watermark is persisted inside the page transaction that commits the entries it covers, never
after it: an interrupted bootstrap must never find a committed page whose watermark did not commit
with it, nor the reverse. If the pack listing was **truncated** — the 20-page walk ended with a
cursor still pending, so packs older than everything listed exist and were never seen — no
watermark is recorded at all, because "contiguous from the oldest pack in hand" is not contiguous
from the bottom. The packs still apply; the next run re-lists from the top.

A missing row reads as 0, which is what every install written before this key existed has.

### `LAST_CURSOR` is never written by the pack path

Nothing in the pack bootstrap touches the item-granular sync cursor. The bootstrap only hands the
pull a record plan, and the pull sets the cursor after it applied that plan (next section). With
no plan, the pull behaves byte-for-byte as it does on a deployment where packs do not exist,
whether the pack path seeded 5,000 notes or returned immediately. The pack watermark gates pack
work and nothing else.

### Record packs and the first cursor

Without record packs, a fresh device pulls every record from cursor 0, page by page. Record packs
let it apply most records from a few downloads and start the feed near its head. A pack is a
cache, though: it can miss rows, hold an old write of a row, or hold a row deleted since. So the
records are reconciled against `GET /sync/manifest` and applied through the pull's own decrypt,
signature and clock path, never by the pack bootstrap (protocol 08 §8.10, Closing checks).

**Plan** (`packs/record-packs.ts:185-228`). After the pack bytes are on disk, the bootstrap:

1. Computes how far the held record packs reach: the unbroken run of ranged packs from cursor 0,
   raised to `coveredThrough` when the run reaches `packedThrough` (`recordCoverageEnd`, line 57).
   With no reach, record packs are unused.
2. Reads the record manifest to its last page (`readManifestPages`, `manifest-check.ts:106`). A
   failed or short read cannot tell a deleted record from an unread one, so record packs are
   unused and the pull runs from 0.
3. Rebuilds every record entry as a pull item. An unreadable entry lowers the tail start to
   `sortKey - 1`, so the feed serves it.
4. Reconciles, using only the newest packed entry per item (`reconcileRecords`, line 135). A live
   entry applies only at the manifest's `serverCursor`. A live entry the manifest omits is not
   applied. A tombstone applies unless the manifest lists the item again. Every manifest item not
   held at its cursor, or listed with no cursor, is pulled by id, unless its cursor is above the
   tail start, where the feed serves it.

**Apply** (`engine/packed-record-apply.ts:157-241`). The pull applies the plan in slices of 100
through its page path, pulls the by-id list, and only then writes `LAST_CURSOR` = tail start (line
234). The order is the data-loss line: a cursor written before the by-id pull, then a crash, would
skip those items for good, because the feed never answers below its cursor. Until the cursor is
written, a crash redoes the whole phase, and rows that already landed come back with an equal clock
and skip. An entry that did not apply, or a by-id item that did not land, lowers the tail start
below its cursor. A slice that stops on a key problem refuses the run.

**Rule 2: rows the manifest later drops.** Example: run 1 applies `task:a` from a pack and is
killed before the cursor. `task:a` is deleted on another device, and its tombstone is shed to a
purged-tombstone marker. Run 2 starts from cursor 0, and a pull from 0 skips markers (#2302), so
`task:a` would stay live here forever. To catch this, before the first slice the pull writes every
row it applies or pulls by id, with the cursor of the write it holds, to `sync_state` key
`recordPacksApplied` (`RECORD_PACKS_APPLIED`, line 185). While that key exists, every pull runs
rule 2 before any feed page (`pullRecords`, line 113), even a run with no pack plan:

- A recorded row the manifest does not list, whose local row exists and was not modified on this
  device, is pulled by id with `purged_tombstones` declared (`pullsUnlistedRow`,
  `engine/pack-row-modified.ts:33`). A queued write, this device's id in the row's clock, or no
  clock keeps the row out of the pull.
- Only the answer removes the row: a delete that verifies, or a marker whose delete attestation
  verifies and whose cursor is past the held cursor (`markerNotPastHeld`, line 90). A marker at or
  below the held cursor says nothing about that write.
- An unanswered request (failed HTTP, unreadable response, cooldown) is not silence. The by-id
  pull runs with `requireAnswers`, lifts the refetch cooldown for those refs, and returns false
  (`engine/item-recovery.ts:203-240`). The run is refused, `recordPacksApplied` stays, and the next
  pull asks again.
- A row the server answered with nothing that removes it stays live and is added to the durable
  set `recordPacksUnresolved` (`RECORD_PACKS_UNRESOLVED`, `engine/pack-unresolved.ts`).

The pull deletes `recordPacksApplied` only after rule 2 ran and `LAST_CURSOR` is past 0 (line
136). From there the feed serves every later marker.

**Unresolved rows and the manifest check.** The manifest check re-uploads a local row the server
manifest omits. For an unresolved row that would be wrong: its absence suggests a delete this
device could not verify, and the server accepts a create over a marker for a recreatable type, so
the delete would be reversed on every device. The check skips an unresolved row unless this device
edited it (`editedHere`, `engine/pack-row-modified.ts:59`; `manifest-check.ts:190-206`). An edit
here makes it this device's own write, which must not be lost. A key leaves the set once the
server lists the row again or this device no longer holds it (`manifest-check.ts:289-293`).

**Bodies.** A note whose packed body already reached the body manifest's head (last sequence and
snapshot revision) is marked settled (`isSettled`, `packs/pack-bootstrap.ts:708`), and the pull
skips its body pull while it applies the record packs.

### Local apply cost

The pack phase moves the network cost of a first sync into local writes. On a 17k-note vault
these parts dominated, and each now has a bound:

- **Search index.** `fts_notes` declares `id` `UNINDEXED`, so `DELETE FROM fts_notes WHERE id = ?`
  scanned every row, and indexing a fresh vault note by note was quadratic: 177 s for 17k notes.
  `createFtsTable` adds `fts_notes_content_id` on the fts5 shadow table's `c0` (the `id` column),
  and deletes and lookups go through it (`database/fts.ts:39-43`): 15 s. fts5 writes the shadow
  table for every writer, older builds included, so the index cannot go stale.
- **Signer order.** The last verifying key is tried first (see [Signer identity](#signer-identity)).
- **Settle.** Eight pack-seeded docs settle at once instead of one. One at a time, the main
  process sat idle on store, converter and file awaits for most of a 408 s settle.
- **Folder list.** The renderer used to re-walk every vault directory once per note the bootstrap
  created. The folder query now shares one coalesced refresher per query client, like the note
  lists (`renderer/src/hooks/use-notes-query.ts:94-238`): sync events fold into one refetch after
  a rest; a move, rename or folder-config change refetches at once.

### Failure modes

Every one of these ends the pack path quietly, leaves the cursor untouched, surfaces nothing to the
user, and falls back to the item-granular bootstrap. A bad pack is never fatal.

| Failure                                                                  | Scope      | Result                                                             |
| ------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------ |
| `GET /sync/packs` 404 (old server)                                       | Whole run  | Empty listing → item-granular                                      |
| Any non-2xx: 501, 429, 5xx, offline                                      | Whole run  | Empty listing → item-granular                                      |
| Response fails `PackListResponseSchema`                                  | Whole run  | Empty listing → item-granular                                      |
| Zero packs, or none above the watermark                                  | Whole run  | Returns immediately, `usedPacks: false`                            |
| No access token, or temp dir cannot be created                           | Whole run  | Returns immediately                                                |
| No CRDT store (in-memory provider)                                       | Whole run  | Returns — bodies rebuild from vault markdown instead               |
| Pack has no `url` (deployment cannot presign)                            | That pack  | Filtered out at listing time                                       |
| `url` expired and re-listing could not re-sign                           | That pack  | Skipped                                                            |
| Transfer lost to the network (offline, 5xx, 429, 403 on an expired URL)  | Phase      | Pause 30/60/120/240 s, then downloaded again; a gap after the last |
| Transfer fails any other way (404, 403 on a live URL), or aborts         | That pack  | Skipped; temp file discarded                                       |
| Bad footer magic, wrong version, truncated file, payload digest mismatch | That pack  | `openPack` throws; discarded, every item in it stays item-granular |
| Entry is not `crdt_snapshot`                                             | That entry | Counted as skipped                                                 |
| Entry meta missing or malformed `{sequenceNum, revision}`                | That entry | Freshness unprovable → item GET                                    |
| Local watermark already at or beyond the entry                           | That entry | Counted as skipped — packed bytes are stale                        |
| Per-entry checksum mismatch                                              | That entry | Counted as failed → item GET                                       |
| Decrypt failure, or no registered key verifies                           | That entry | Counted as failed → item GET                                       |

Temp files never survive: success, failure and abort all discard them.

A network drop pauses the whole pack phase (`pack-downloads.ts`, protocol 08 §8.12): no new pack GET
starts, the running ones finish, and after the pause every lost or unstarted pack downloads again,
with a fresh re-list for URLs that expired meanwhile. One pause for the phase, not a ladder per pack,
so a 30-45 s drop costs one pause instead of every queued pack.

## Presigned URLs Are Credentials

A pack `url` is a presigned R2 GET whose signature _is_ the authorization. It is a bearer
credential and must never reach a log file. `fetch` failures routinely quote the request URL in
their message, and those messages are logged verbatim by the bootstrap caller, so the URL is
stripped where the error message is built rather than at every log site.

## Related

- [`GET /sync/packs`](/architecture/sync-protocol#pack-discovery) — auth, gating,
  pagination and response shape.
- [Bootstrap sessions](/architecture/sync-protocol#bootstrap-sessions) — the elevated window the
  pack path runs inside.
- [Presigned R2 transfers](/architecture/sync-protocol#presigned-r2-transfers) — how `url` is
  issued and what happens without it.
- [CRDT & Notes Sync](/architecture/crdt) — the snapshot watermark packs write into.
