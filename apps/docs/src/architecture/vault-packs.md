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

Replaced and deleted items are simply dead bytes inside old packs forever. Nothing garbage-collects
them, because a pack is written once and never modified.

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
| `sortKey`      | int64          | `server_cursor` for records; `created_at` epoch seconds for CRDT kinds                |
| `metaLen`+meta | uint16 + bytes | UTF-8 JSON, or empty. For snapshots: `{sequenceNum, revision}`                        |
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
- **Cron backfill.** The 6-hourly sweep drains historical backlog at `PACKS_PER_BACKFILL_TICK` = 3
  packs per tick across all vaults, oldest backlog first, with no sleeps inside the invocation —
  Worker CPU is billed wall-CPU, so pacing is expressed as bounded work per tick plus a resumable
  watermark, never as waiting.

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

Rows larger than `MAX_PACKED_ITEM_BYTES` = 8 MB are excluded from packs permanently and stay on the
item-granular tail. The largest legal record payload is roughly 7 MB of JSON text (a 5 MB decoded
payload inflated by base64 and the envelope) and snapshots cap at 5 MB, so this excludes anything
near the bound: one item can never dominate a pack, and memory during the bounded-concurrency fetch
stays predictable.

### Retry safety

At-least-once queue delivery means every step has to tolerate re-running:

1. Selection reads the watermark, so a crash re-selects the same range.
2. The pack object key is deterministic from the range, so a retry PUTs identical bytes to the same
   object, and an R2 put is idempotent.
3. `pack_index` carries `UNIQUE (user_id, vault_id, item_kind, min_cursor)`, so a duplicate insert
   is a no-op.
4. The order is **object → D1 row → watermark**: `storage.put(packKey, built.bytes)`, then
   `insertPackIndexRow(...)`, then `advanceWatermark(...)`. A crash inside that ordering is why the
   first three properties have to hold. Between the PUT and the row it leaves an orphan pack object
   — harmless invisible bytes, since only a `pack_index` row makes a pack listable. Between the row
   and the watermark it costs an idempotent rebuild that lands on the UNIQUE constraint.

One known residual: a window whose every source blob turned out to be a hole writes no pack and
advances its watermark _without_ a `pack_index` row. If an earlier attempt of that same range
crashed in the PUT-to-row window, the object at the deterministic key now has no row pointing at it
and can never be listed — permanently dead bytes. Harmless today, and the concrete case a future
sweep should cover. Such a sweep has to list the real key, which `packObjectKey` builds as
`<userId>/vaults/<vaultId>/packs/<kind>/<minSortValue>_<maxSortValue>.pack` — the vault prefix is
deliberate, so vault deletion's prefix purge already reaches these objects, and a sweep listing a
bare `packs/<kind>/` prefix would match nothing.

### Holes

A slot in the selection whose bytes cannot be used is a **hole**: it is skipped, and it produces no
index record at all. Three conditions make a hole, and all three mean the same thing to a client —
the item was never in this pack, so fetch it individually.

| Condition                     | Why it is a hole rather than a failure                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source blob returns null      | Replaced or deleted between selection and fetch, or a dangling row. Not an error — the pack is a cache of a moving target.                                                                                                                                                                                                                       |
| Zero-length blob              | Real ciphertext is never empty (XChaCha20 always carries a MAC), but an aborted write can leave a 0-byte object, and a row declaring `size_bytes` 0 slips past the drift check below (`0 === 0`). The writer rejects an empty entry, and that throw would escape before the watermark moved — so the range would re-select and re-throw forever. |
| Declared-vs-actual size drift | The blob was replaced under a stable key after selection sized the buffer. Copying it would overrun or misalign the layout.                                                                                                                                                                                                                      |

Holes are skipped through `skipEntry`, never a bare `continue`: the writer claims slots in strict
plan order, so an unclaimed slot makes the next `writeEntry` throw and abort the whole range before
the watermark moves. A window where _every_ candidate turned out to be a hole writes no pack and
still advances the watermark, so it cannot loop.

### `PACKED_KINDS` is `['crdt_snapshot']` only

`compactOneRange` supports `record`, and the format has a `record` kind code, but the pipeline
deliberately does not build record packs.

A record pack entry is exactly the R2 payload blob — `{dataNonce, encryptedData, encryptedKey,
keyNonce}` and nothing else. The Ed25519 **signature**, the signer device id, the vector clock, the
operation and `deleted_at` all live in the `sync_items` D1 row and reach a client only through
`POST /sync/pull`. The index block carries none of them. A client could therefore not verify a
packed record without skipping signature verification, which is unacceptable in an end-to-end
encrypted vault where the server is untrusted. Building them anyway would mint immutable R2 objects
no client can ever read, and packs are never rewritten — those bytes would be dead forever.

Records keep bootstrapping through the item-granular pull, which already pages them. The snapshot
axis is where the per-note GET floor actually was.

Re-enabling record packs needs the signature, signer, clock and operation carried in the entry meta
— the meta field is free-form JSON, so that is additive rather than a format break — plus a client
apply path that verifies them. Tracked as
[#1852](https://github.com/memrynote/memry/issues/1852).

`crdt_update` is reserved and never produced: updates live in D1 rows, not R2 objects, so there is
no small-object GET floor there to kill.

## Coverage Semantics a Client Must Respect

A pack advertises a range on its kind's ordering axis. Three rules govern what that range does and
does not promise.

**Membership is verified against the index block, never inferred from the range.** An item whose
sort key falls inside `[minCursor, maxCursor]` may have been a hole, or may be dead bytes from
before it was replaced. The client looks the identity up in the file's own index and falls back to
the item GET when it is not there.

**Snapshot coverage can under-cover same-second writes.** The watermark is composite
`(created_at, note_id)`. A note written in the same second as an already-packed tie group but with
a _smaller_ `note_id` sorts below the watermark and is permanently excluded from packing. It stays
in the item-granular tail forever. That is a missed optimisation, never lost data — the individual
blob is still the source of truth at that ordering value.

**Items over 8 MB are never packed**, per `MAX_PACKED_ITEM_BYTES` above.

Two packs can also share a `maxCursor`: a same-second group larger than the byte target is split
across packs. Any client bookkeeping keyed on `maxCursor` has to treat such a tie group as a unit —
see the watermark rule below.

## Client Bootstrap Flow

The pack path runs on a **fresh device only** — the engine's `LAST_CURSOR` state key is absent —
after the bootstrap session opens and before the item-granular pull. It is awaited rather than
fired off, because it writes into the same Y.Docs and the same databases the pull is about to
touch.

1. **Discover.** Walk `GET /sync/packs` newest-first at `PACK_LIST_PAGE_LIMIT` = 50 per page, for
   at most `MAX_PACK_LIST_PAGES` = 20 pages. Keep only packs that are `crdt_snapshot`, carry a
   `url`, carry an `expiresAt`, and whose expiry is more than `PRESIGN_EXPIRY_SAFETY_SECONDS` = 30
   seconds away. Packs at or below a previous run's `PACKS_APPLIED_THROUGH_CURSOR` are dropped
   before anything transfers.
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

Nothing in the pack bootstrap touches the item-granular sync cursor. That is what makes the whole
feature removable at runtime: the pull that follows behaves byte-for-byte as it does on a
deployment where packs do not exist, whether the pack path seeded 5,000 notes or returned
immediately. The pack watermark gates pack work and nothing else.

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
| Transfer fails, or aborts                                                | That pack  | Skipped; temp file discarded                                       |
| Bad footer magic, wrong version, truncated file, payload digest mismatch | That pack  | `openPack` throws; discarded, every item in it stays item-granular |
| Entry is not `crdt_snapshot`                                             | That entry | Counted as skipped                                                 |
| Entry meta missing or malformed `{sequenceNum, revision}`                | That entry | Freshness unprovable → item GET                                    |
| Local watermark already at or beyond the entry                           | That entry | Counted as skipped — packed bytes are stale                        |
| Per-entry checksum mismatch                                              | That entry | Counted as failed → item GET                                       |
| Decrypt failure, or no registered key verifies                           | That entry | Counted as failed → item GET                                       |

Temp files never survive: success, failure and abort all discard them.

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
