# 08 — The MPAK pack container

**Status**: normative. Every normative sentence carries a `path:line` citation
(chapter 00 §0.1).

## 8.0 Packs are optional — Q08.4

**Normative, and stated first so a v1 implementation can stop reading here: a
conforming client that never fetches a pack is still correct.** A pack is a
**derived cache** of bytes that also exist as individual blobs
(`packages/contracts/src/pack-format.ts:52-55`). A bad pack is treated as absent
and the client falls back to the item-granular endpoints of chapters 05 and 07;
source blobs are never derived and never vanish.

Implementing chapter 08 buys fewer round trips on a first sync. It buys nothing
else. **Disposition of Q08.4: answered** (this section).

## 8.1 A client is never a writer — Q08.2

**Normative.** The **writer lives server-side and is not in
`packages/contracts`**; the package ships the reader only
(`packages/contracts/src/pack-format.ts:10-14`). `@memry/contracts` is the only
package both halves depend on, and the architecture check forbids the desktop app
importing from `apps/sync-server`.

**A conforming client implements a reader and MUST NOT write a pack.**
Consequently the vector class for this chapter is reader-only
(`packages/contracts/test-vectors/pack-container.json`): the cases are recorded
container bytes plus their expected parse, because a generator that reimplemented
the writer would prove the generator rather than the implementation.

**Disposition of Q08.2: answered** (this section).

## 8.2 Layout

**Normative**, all integers **big-endian**
(`packages/contracts/src/pack-format.ts:16-51`, verified against the reader at
`:213-268` and `:289-330`):

| Region  | Offset        | Size                 | Field                                          |
| ------- | ------------- | -------------------- | ---------------------------------------------- |
| header  | 0             | 4                    | magic, ASCII `MPAK`                            |
| header  | 4             | 1                    | format version, `PACK_VERSION = 1`             |
| header  | 5             | 1                    | reserved, 0                                    |
| header  | 6             | 2                    | `flags` uint16, currently 0                    |
| payload | 8             | sum of entry lengths | opaque ciphertext, no padding or separators    |
| index   | `indexOffset` | `entryCount` records | §8.3                                           |
| footer  | end − 53      | 32                   | SHA-256 of the whole payload region            |
| footer  |               | 8                    | `entryCount` uint64                            |
| footer  |               | 8                    | `indexOffset` uint64, **absolute file offset** |
| footer  |               | 4                    | magic `MPAK`                                   |
| footer  |               | 1                    | version echo                                   |

`PACK_HEADER_SIZE = 8` (`packages/contracts/src/pack-format.ts:70`),
`PACK_FOOTER_SIZE = 53` (`:62-67`), `PACK_MAGIC = 'MPAK'` (`:58`),
`PACK_VERSION = 1` (`:60`).

**The payload region runs from `PACK_HEADER_SIZE` to the absolute `indexOffset`**
(`packages/contracts/src/pack-format.ts:297`).

## 8.3 One index record

**Normative**, in this order
(`packages/contracts/src/pack-format.ts:245-265`):

| Field       | Type                 | Note                                                                                                              |
| ----------- | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `kind`      | uint8                | `PackKindCode`; an unknown code is a hard error (`:248-249`)                                                      |
| `idLen`     | uint16               | **length in bytes, not characters**                                                                               |
| `idBytes`   | UTF-8                | the identity (§8.4)                                                                                               |
| `keyLen`    | uint16               |                                                                                                                   |
| `keyBytes`  | UTF-8                | the source R2 key: provenance plus a per-item fallback; empty for `crdt_update` (§8.4.3)                          |
| `sortKey`   | int64                | §8.4                                                                                                              |
| `metaLen`   | uint16               | 0 means no metadata                                                                                               |
| `metaBytes` | UTF-8 JSON, or empty | parsed with `JSON.parse`; a malformed value throws and the caller discards the pack (`:260-264`)                  |
| `offset`    | uint64               | **relative to the start of the payload region**, so absolute position is `PACK_HEADER_SIZE + offset` (`:308-312`) |
| `length`    | uint64               |                                                                                                                   |
| `sha256`    | 32 bytes             | digest of **that entry's** payload bytes                                                                          |

The `offset` interpretation is the off-by-eight a reader gets wrong first.

**A negative `sortKey` does not survive the reference reader.** `ByteReader.i64`
reconstructs the 64-bit value through doubles
(`packages/contracts/src/pack-format.ts:189-196`), so `-1` decodes as `0`.

The **mechanism** matters, because the stated outcome is not reproducible from
a naive reading: a plain signed decode gives `-1`, and so does
`hi_i32 * 2^32 + lo_u32`. The reference reads two **unsigned** 32-bit halves
into a double as `u32 * 2^32 + u32`. At that magnitude doubles are spaced 2048
apart, so `0xFFFF_FFFF_FFFF_FFFF` **rounds up to exactly `2^64`**, and the
`v >= 2^63 ? v - 2^64 : v` branch then yields `0` rather than `-1`. A port that
reproduces the rule without the rounding step disagrees with the reference
about entry order on any pack that carries one, which is why the step is
written down here rather than left in the vector.

**Invalid UTF-8 in `idBytes` or `keyBytes` is replaced, not rejected.** The
reference decodes non-fatally, substituting U+FFFD, and a reader MUST do the
same: a corrupt byte in an identity makes one entry unaddressable, while
rejecting makes the whole pack unreadable, and §8.10 already says coverage is
not total. No committed case exercises this. Every
`sortKey` a writer emits today is a non-negative `server_cursor` or epoch second
(§8.4), so the loss is unreachable in practice. **Normative: a writer MUST NOT
emit a negative `sortKey`, and a reader MUST NOT be given one.** The behaviour is
pinned by the `pack-container.json` case that carries one, recorded as the reader
actually behaves rather than as it ought to.

## 8.4 Kinds and identity semantics

**Normative.** `PackKindCode` is `record = 0`, `crdt_snapshot = 1`,
`crdt_update = 2` (`packages/contracts/src/pack-format.ts:94-98`).

| Kind            | Identity (`idBytes`) | `sortKey`                       | `metaBytes`                  |
| --------------- | -------------------- | ------------------------------- | ---------------------------- |
| `record`        | `type:id`            | `server_cursor`                 | the pull-item fields, §8.4.2 |
| `crdt_snapshot` | the document id      | `created_at`, epoch **seconds** | `{sequenceNum, revision}`    |
| `crdt_update`   | the document id      | `server_cursor`                 | §8.4.3                       |

(`packages/contracts/src/pack-format.ts:31-36`.) Every pack holds entries of one
kind, the one its listing row names (`apps/sync-server/src/services/pack-compaction.ts:162-215`
selects one kind per pack). A reader still checks each entry's own `kind`.

Snapshot entries carry `{sequenceNum, revision}` in `metaBytes`, which is the
**freshness token a client compares against `snapshotMeta` before trusting the
bytes** (`packages/contracts/src/pack-format.ts:37-40`; chapter 07 §7.8).

### 8.4.1 Will a reader ever see kind 2 — Q08.1

**Normative: no writer produces `crdt_update = 2` today.** `PACKED_KINDS` in
`apps/sync-server/src/services/pack-compaction.ts` does not list `crdt_update`:
it lists `crdt_snapshot`, and `record` once step 04 (#5227, #5253) lands. When
a kind 2 writer ships (step 05, #5228), its entries follow §8.4.3.

**A conforming reader MUST accept kind 2 structurally** — `KIND_BY_CODE` maps it
(`packages/contracts/src/pack-format.ts:102-106`) and rejecting it would be a
gratuitous incompatibility with a future writer — **and MAY decline to use the
entry**, falling back to the item-granular endpoints for that document, exactly
as it would for a pack it could not verify (§8.0).

**Disposition of Q08.1: answered** (this section).

### 8.4.2 Record entries

**Normative.** A record entry is one `POST /sync/pull` item, split three ways
(`RecordPackEntryMetaSchema`, `packages/contracts/src/sync-api.ts:846-850`):

| Pull item field                                                                   | Where the entry carries it                  |
| --------------------------------------------------------------------------------- | ------------------------------------------- |
| `type`, `id`                                                                      | `idBytes`, as `type:id`                     |
| the row's `sync_items.blob_key`                                                   | `keyBytes`                                  |
| `blob`                                                                            | the payload bytes                           |
| `operation`, `cryptoVersion`, `signature`, `signerDeviceId`, `deletedAt`, `clock` | `metaBytes`, under the pull item's own keys |

`RecordPackEntryMetaSchema` is `RecordPullItemResponseSchema` without `id`,
`type` and `blob` (`packages/contracts/src/sync-api.ts:832-850`), so a field
added to the pull item reaches the entry with no second list to update. A writer
fills the meta from the same columns `POST /sync/pull` answers from
(`pullItemFromColumns`, `apps/sync-server/src/services/sync.ts:401-420`):
`deletedAt` and `clock` are present exactly when the pull item has them.

- **Payload.** The payload is the R2 object byte for byte: the four blob fields
  as sorted-key JSON (chapter 05 §5.9 A,
  `apps/sync-server/src/services/sync.ts:343-351`). A reader parses it as JSON
  and validates it with `EncryptedItemPayloadSchema`
  (`packages/contracts/src/sync-api.ts:389-394`) as the item's `blob`.
- **Identity.** A reader splits `idBytes` at the **first** `:`. No record type
  contains one (`RECORD_SYNC_ITEM_TYPES`,
  `packages/contracts/src/sync-api.ts:38-66`), and an id may: a
  `folder_config` id is a folder path (chapter 05 §5.12.1).
- **Key.** `keyBytes` is the row's `sync_items.blob_key`, the key
  `POST /sync/pull` reads the payload from
  (`apps/sync-server/src/services/sync.ts:469`). It is provenance; the
  reader's fallback is `POST /sync/pull`, never a GET of that key.
- **Rebuild and validate.** `{...meta, id, type, blob}` MUST validate as
  `RecordPullItemResponseSchema`
  (`packages/contracts/src/sync-api.ts:832-837`). The reader then treats it as
  a pull item in every respect: signature verification against the signer's
  key, `cryptoVersion` (chapter 00 §0.2.1), the delete-wins and clock rules of
  chapter 05 §5.8 and chapter 06. Coming from a pack gives an entry no
  precedence: the same clock comparison against local state decides whether it
  applies, so an entry older than the local row changes nothing (chapter 05
  §5.8).
- **An unusable entry costs that entry, not the pack.** An entry whose meta is
  absent (`metaLen` 0) or fails `RecordPackEntryMetaSchema`, whose payload is
  not a valid blob, or whose rebuilt item fails validation or verification is
  ignored, and the item stays item-granular (see **Record tail**). The
  pack digests already passed (§8.5), so the rest of the pack is intact. This is what a reader does
  with a record pack written before this section, which carries no meta:
  the `PACKED_KINDS` comment in
  `apps/sync-server/src/services/pack-compaction.ts` describes that writer
  until step 04 (#5227) replaces it.
- **Undeclared types.** A pack is not filtered by the reader's type
  subscription (chapter 05 §5.3). A reader skips an entry whose type it does
  not declare, as `POST /sync/pull` would not have served it: the server reads
  only the subscription's record types
  (`apps/sync-server/src/lib/sync-types.ts:20-24`,
  `pullItems` with the subscription's `recordTypes`,
  `apps/sync-server/src/routes/sync.ts:637-643`).
- **Record tail.** A reader that uses record packs and then follows the cursor
  tail through `GET /sync/changes` (chapter 05 §5.11.1) MUST start that tail at
  a cursor no higher than `sortKey − 1` of every record entry it found
  unusable. The tail then names the item again and `POST /sync/pull` serves
  it. Starting the tail at a pack's `maxCursor` instead loses every unusable
  entry for good: the tail never answers below its cursor. An entry of an
  undeclared type is exempt, because the tail would not serve it either.
- **No payload, no entry.** A purged tombstone (chapter 05 §5.12.3) and a row
  whose payload is lost (§5.12.4) have no payload bytes. A writer MUST NOT emit
  them as record entries; `POST /sync/pull` keeps them out of `items` for the
  same reason (`packages/contracts/src/sync-api.ts:897-907`).
- **Index entry size.** A writer MUST NOT emit an index entry larger than
  `PACK_MAX_INDEX_ENTRY_BYTES`, which a conforming reader rejects (§8.6;
  `crates/memry-core/src/protocol/pack/index.rs:165-170`). An item whose entry
  would exceed it is left out of packs.

`pack-container.json` pins this with real signed items: the verifier rebuilds
each pull item from the pack bytes and decrypts it through the production
reader (`packages/contracts/src/__tests__/pack-container.test.ts`).

### 8.4.3 Update entries (kind 2)

**Normative.** An update entry is one `crdt_updates` row, as
`GET /sync/crdt/updates` returns it (chapter 07 §7.11), split the same way
(`CrdtUpdatePackEntryMetaSchema`, `packages/contracts/src/sync-api.ts:857-861`):

| Field                                        | Where the entry carries it                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `noteId`                                     | `idBytes`: the document id, a note or a journal (chapter 07 §7.1)          |
| none: an update has no R2 object             | `keyBytes`: empty (`keyLen` 0)                                             |
| `server_cursor`                              | `sortKey`                                                                  |
| `data`                                       | the payload: the stored packed envelope (chapter 04 §4.11), not its base64 |
| `sequenceNum`, `signerDeviceId`, `createdAt` | `metaBytes`                                                                |

- **Identity.** One document has many updates, so an entry is named by
  `(document id, sequenceNum)`. D1 holds that pair unique
  (`apps/sync-server/migrations/0001_baseline.sql:218`), and a sequence number
  for an id never moves down (chapter 07 §7.4), so the pair names one immutable
  row. Two entries a reader holds for the same pair with different digests make
  that document's packed updates unusable: the reader fetches it through the
  routes of chapter 07 §7.2.
- **Key.** An update is a D1 row with no R2 object, so a writer emits empty
  `keyBytes`. A reader MUST NOT fetch `keyBytes` of a kind 2 entry, empty or
  not: its fallback is the routes of chapter 07 §7.2.
- **Sort key.** `sortKey` is the row's `server_cursor`
  (`apps/sync-server/migrations/0011_crdt_server_cursor.sql:15`). A row with a
  NULL cursor, written before migration `0011`, is never a kind 2 entry and
  stays on the routes of chapter 07 §7.2, as it stays out of the feed (§7.17).
- **Ordering.** A writer emits entries in ascending `sortKey`. Within one
  document that is ascending `sequenceNum` (chapter 07 §7.17). A reader sorts a
  document's entries by `sequenceNum` itself and does not rely on index order.
- **Sequence continuity.** Only an update takes a new number:
  `COALESCE(MAX(sequence_num), 0) + 1` over the union of the update, snapshot
  and floor tables, inside an `INSERT OR IGNORE` that takes none for an ignored
  retry (`apps/sync-server/src/services/crdt.ts:143-151`). A snapshot takes an
  existing number or a lower one: without a claim the union's current maximum
  (`apps/sync-server/src/services/crdt-snapshot-write.ts:252-260`, `:336`), with
  a claim its covered watermark, the highest update the claim covers
  (`:138-146`, `:152-156`, `:334-335`). A claimed watermark starts at the
  existing snapshot row or 0 and never reads the floor (`:283`, `:311-312`), so
  after a purge a claimed snapshot can number below the floor (#5248). So a
  document's updates above any baseline are numbered `baseline + 1`,
  `baseline + 2`, and so on, and a snapshot's number is never a lower bound for
  packed updates. A reader applies packed updates under chapter 07
  §7.9 with one addition: **it advances a document's update cursor across a
  packed update only when that update's `sequenceNum` is the cursor plus one.**
  At the first missing number it stops using packed updates for that document
  and pulls from its cursor through the routes of chapter 07 §7.2, then may
  resume with the packed updates above what the pull returned. A pack never
  proves that an update is absent, so a gap is resolved by the server, never
  skipped. This is chapter 07 §7.9's stop-at-gap rule applied to packed data.
- **Floor.** **A reader applies a packed update of a document only when the
  update's `sequenceNum` is above that document's `floor` and is its cursor
  plus one, where `floor` comes from a `GET /sync/crdt/updates` or batch answer
  for that document read after the reader holds the pack bytes, in the same
  run; an answer without `floor` makes every packed update of that document
  unusable.** `floor` is the document's highest purged sequence number, 0 when
  it was never purged (chapter 07 §7.4, §7.15); it is introduced by step 05
  (#5228), which also ships the first kind 2 writer, and no server sends it
  today, so today's readers fall back to chapter 07 §7.2 (fail closed). The
  reason is the purge: it records floor `N` and deletes rows `1..N`, but a pack
  built before it still holds updates `1..N`. Without the floor a fresh device
  at cursor 0 applies the deleted text into the re-created document. A floor
  read before the pack can predate a purge the pack still reflects, so it is
  read again on every run. Neither `snapshotMeta.sequenceNum` (#5248) nor the
  lowest `sequenceNum` a route returned stands in for it.
- **Purge dependency.** Whenever the §7.15 purge deletes any `crdt_updates`
  row of a document, it MUST take every `crdt_update` pack that holds that
  document out of the listing, and rewrite it, as §8.13 states for every kind,
  with the same commit-time recheck §7.15 gives snapshot compaction. Until the
  membership index of §8.13 exists, that is every `crdt_update` pack of the
  vault, and the same batch MUST reset the `crdt_update` pack watermark, as
  the purge does for `crdt_snapshot`
  (`apps/sync-server/src/services/document-body-purge.ts:106-118`); without the
  reset, compaction never packs the other documents of a dropped pack again.
  Today the purge drops only `crdt_snapshot` packs, and only when it deleted a
  snapshot blob (`apps/sync-server/src/services/document-body-purge.ts:102-104`).
  **This ships before any server writes a kind 2 entry (step 05, #5228).** The
  floor covers a reader that holds a pack from before the purge; the drop
  keeps later listings clean.
- **Verification.** The reader opens the envelope with the document id as
  associated data and checks it against `signerDeviceId`'s key, as for an
  update the route returned (chapter 07 §7.14).

`pack-container.json` pins two updates of one document, opened through the
production reader.

## 8.5 Reader obligations

**Normative.** A reader MUST reject, and treat the pack as absent, on any of:

| Condition                         | Message                              | Line       |
| --------------------------------- | ------------------------------------ | ---------- |
| file shorter than header + footer | `pack too small`                     | `:290`     |
| header magic mismatch             | `pack header magic mismatch`         | `:231`     |
| header version mismatch           | `unsupported pack version <n>`       | `:232`     |
| footer shorter than 53 bytes      | `pack too small`                     | `:214`     |
| footer magic mismatch             | `pack footer magic mismatch`         | `:222`     |
| footer version mismatch           | `unsupported pack version <n>`       | `:223`     |
| payload digest mismatch           | `pack payload checksum mismatch`     | `:298-300` |
| any per-entry digest mismatch     | `pack entry checksum mismatch: <id>` | `:314-316` |
| unknown entry kind                | `unknown pack entry kind`            | `:249`     |
| a read running past the buffer    | `pack truncated`                     | `:169`     |

**Per-entry verification is not skipped when the whole-payload digest passes**
(`packages/contracts/src/pack-format.ts:307-316` re-hashes every entry after
`:297-300` has already passed). A successful parse returns
`integrityVerified: true` (`:329`).

`readFooter` works on the **tail slice alone**, so a streaming reader never has
to hold the file (`packages/contracts/src/pack-format.ts:206-212`).

## 8.6 Memory bounds are structural

**Normative** (`packages/contracts/src/pack-format.ts:72-92`):

| Constant                     | Value         |
| ---------------------------- | ------------- |
| `PACK_MAX_INDEX_ENTRY_BYTES` | 4096          |
| `PACK_MAX_ENTRIES`           | 4096          |
| `PACK_MAX_INDEX_BYTES`       | their product |

The reason is on record: `indexOffset` and each entry's `length` are attacker- or
corruption-controlled, so a single flipped byte in an 8-byte `indexOffset` still
points inside the file and turns "read the index block" into "read the whole pack
into one buffer" — which is exactly the property a streaming reader exists to
guarantee it never does
(`packages/contracts/src/pack-format.ts:73-83`).

**Note for an implementer: `parsePack` does not itself enforce
`PACK_MAX_ENTRIES`.** A footer claiming more entries than the index block holds
fails as `pack truncated` (`packages/contracts/src/pack-format.ts:169`) rather
than as a bound violation. **A conforming reader MUST apply the caps above
explicitly before allocating**, because the in-memory `parsePack` reference
already holds the whole file and therefore cannot demonstrate the bound.

### 8.6.1 The five rejection codes

**Normative.** A pack is rejected for five distinct reasons and a caller has to
tell them apart, so each carries a code. Chapter 04 §4.11.1 established the
rule these follow: an English message is one implementation's, the code is the
contract.

| Code                        | Condition                                                       |
| --------------------------- | --------------------------------------------------------------- |
| `header-magic-mismatch`     | the header is not `MPAK`                                        |
| `unsupported-version`       | a header or footer version this reader does not know            |
| `payload-checksum-mismatch` | the whole-payload digest in the footer                          |
| `entry-checksum-mismatch`   | one entry's digest, checked even when the payload digest passed |
| `entry-count-too-large`     | `entryCount` above `PACK_MAX_ENTRIES`                           |

**`entry-count-too-large` is the code with no fixed message**, and the reason
is the note above: the in-memory reference never reaches it, because it runs
out of index bytes first and says `pack truncated`. A conforming reader applies
the cap **before allocating** and therefore fails earlier and differently.
`pack-container.json` records the reference's string as `referenceOnlyMessage`
rather than as `expectErrorContains`, so a port asserting the message would not
be asserting conformance — it would be asserting that it had skipped the check
this chapter requires.

## 8.7 `flags` — Q08.3

`flags` is a uint16 at offset 6, currently 0
(`packages/contracts/src/pack-format.ts:23`). **No reader reads it**:
`readPackHeader` checks bytes 0 to 4 only
(`packages/contracts/src/pack-format.ts:228-233`).

**Normative — a reader MUST ignore `flags` and MUST NOT reject a non-zero
value.** Rejecting would make the field unusable: a writer that set a flag could
never ship, because every already-released reader would refuse the pack. The
field is reserved for a change that is **backward compatible by construction**;
a change that is not compatible bumps `PACK_VERSION` instead, which every reader
already rejects (§8.5). This is a deliberate choice of forward compatibility over
strictness, and the cost is that a reader ignoring a meaningful flag reads the
pack as if the flag were unset — which is why any future flag must be
ignorable.

**Disposition of Q08.3: answered** (this section).

## 8.8 Immutability

**Normative.** A pack **object is never modified after its single PUT**, and
its key is never written again: new data goes into new objects under new keys
(`packages/contracts/src/pack-format.ts:52-53`). What changes is the listing.
A pack's `pack_index` row may be removed, by a rollup that replaces it
(§8.12) or by a purge (§8.13), and the object is deleted after the grace
period of §8.12. Stale entries therefore stay as dead bytes for the life of
the object, not forever. A client MUST NOT expect a pack it has read to
change, MUST NOT expect a listed pack to stay listed or downloadable, and MUST
NOT treat a pack as authoritative: individual blobs remain the source of truth
throughout (`packages/contracts/src/sync-api.ts:730-735`).

## 8.9 Listing

**Normative.** `GET /sync/packs` returns `PackListResponseSchema`
(`packages/contracts/src/sync-api.ts:793-808`), whose `packs` are
`PackSummarySchema` (`:737-758`):

| Field                    | Rule                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `packKey`          | non-empty strings                                                                                                                                     |
| `itemKind`               | one of `record`, `crdt_snapshot`, `crdt_update` (`:717`)                                                                                              |
| `minCursor`, `maxCursor` | `server_cursor` bounds for `record` and `crdt_update`; `created_at` epoch-second bounds for `crdt_snapshot` (`:711-716`)                              |
| `itemCount`              |                                                                                                                                                       |
| `byteSize`               | **the payload region only** — header, index and footer excluded. **NOT a file length: a reader MUST NOT Range-request against it** (`:744-749`)       |
| `createdAt`              |                                                                                                                                                       |
| `url`                    | a presigned GET, present **only** when the deployment opted into presigned transfers; **absent means "use the item-granular endpoints"** (`:726-728`) |
| `expiresAt`              | epoch seconds at which `url` stops working (`:752-753`)                                                                                               |
| `coverFrom`              | exclusive lower bound of the pack's coverage range, a `server_cursor`, for every kind (`:754-755`); §8.10                                             |
| `coverThrough`           | inclusive upper bound of that range (`:756-757`). Both are absent on a pack written before §8.10, which is a cache only                               |

`nextCursor` is an opaque keyset token, absent on the final page, and **packs
arrive newest-first** (`packages/contracts/src/sync-api.ts:802-807`). A client
MUST treat it as opaque. The first page also carries `coverage`, one
`PackCoverageSchema` per kind (`packages/contracts/src/sync-api.ts:766-775`,
`:796-801`), §8.10.

## 8.10 Coverage and where the tail starts

**One axis.** Coverage is stated on `server_cursor` for every kind. Records,
snapshots and updates draw it from one per-user sequence, reserved inside the
batch that commits the row, so no reader sees a cursor above a row that has
not committed (chapter 05 §5.11, chapter 07 §7.17). A pack's coverage range is
`(coverFrom, coverThrough]` (`packages/contracts/src/sync-api.ts:754-757`).
`minCursor`, `maxCursor` and the snapshot `sortKey` keep their per-kind
meaning (§8.4, §8.9), because the released readers order and resume on them
(§8.11).

**The invariant.** **For each kind, a listed pack holds every row of that kind
a reader needs whose `server_cursor` lies in the pack's coverage range, and no
such row has a `server_cursor` in `(packedThrough, coveredThrough]` of that
kind's `coverage` entry** (`packages/contracts/src/sync-api.ts:760-775`). A row
a reader needs is one the feed or the item routes would serve it: not a body
row of a dead document (chapter 07 §7.15), not a row with no payload (§8.4.2),
not a purged-tombstone marker (chapter 05 §5.12.3). "Holds" means an entry at
that row's current cursor; a row that later moves to a higher cursor (a
rewrite, a delete) leaves a dead entry behind, and its new state is at the
new cursor.

What a server MUST do to keep it (steps 06 and 07, #5229, #5230):

- A writer selects rows of every kind by `server_cursor` above the kind's
  watermark. A pack's `coverFrom` is the `coverThrough` of the kind's previous
  pack, or 0, so windows of rows it skipped as unneeded fall inside the next
  range. The one exception is a row it needs but cannot pack (an index entry
  above `PACK_MAX_INDEX_ENTRY_BYTES`, §8.4.2): it is never inside a range, so
  the previous range ends below it and the next one starts at its cursor,
  leaving a gap a reader reads through the feed.
- `coverage` is read in the same D1 batch as the first page, and a pack row,
  its watermark and `coveredThrough` commit in one batch, so the statement and
  the page are one consistent read.
- A server states no `coverage` for `crdt_snapshot` or `crdt_update` while the
  vault holds a needed row of that kind with a NULL `server_cursor`: such a row
  is in no range and never in the feed (chapter 07 §7.17).
- `packedThrough` is the `coverThrough` of the kind's newest committed pack.
  A rollup or purge that takes packs out of the listing never lowers it, so a
  reader whose packs do not chain up to it sees the gap. A server that drops
  every pack of a kind and resets its watermark resets that kind's
  `packedThrough` and `coveredThrough` to 0 in the same batch.
- A pack without `coverFrom` and `coverThrough` is a cache only. Every
  snapshot pack built before this section is one.

**This closes the same-second under-coverage.** The snapshot writer used a
`(created_at, note_id)` watermark
(`apps/sync-server/src/services/pack-compaction.ts:198`); a snapshot written
in the watermark's second with a smaller `note_id`, including every rewrite,
which moves `created_at` (`apps/sync-server/src/services/crdt-snapshot-write.ts:128`),
sorted below it and stayed item-granular forever. `server_cursor` is strictly
increasing and moves on every rewrite (`:128`), so no committed row can sort
below a watermark it was not selected under.

**Where the tail starts.** A reader computes, for each kind that bounds its
tail (`record` always; `crdt_snapshot` and `crdt_update` when it declared
`note_body`, chapter 05 §5.3):

1. `end`: walk its **usable** packs of that kind (downloaded, verified, with a
   coverage range) in ascending `coverFrom`, from 0, extending `end` to a
   pack's `coverThrough` while that pack's `coverFrom` is at or below `end`.
   Overlapping ranges are fine; a rollup can list both the old and the new
   pack (§8.12).
2. `T_kind` = `max(end, coveredThrough)` when `end` reaches `packedThrough`,
   otherwise `end`. A kind with no `coverage` entry, or no `coverage` at all
   (every server today), gives 0.
3. For `record`, at most `sortKey - 1` of every unusable record entry
   (§8.4.2, **Record tail**).

The reader tails `GET /sync/changes` from `min(T_kind)`. A gap in the walk is
a pack the reader could not use (a 404, an expired URL, a bad digest), a pack
a rollup or purge took out of the listing mid-walk, or a row a writer could
not pack; each one lowers the start, which costs feed pages and loses nothing.
A reader MAY instead read the feed across a gap `(a, b]`, from cursor `a`
until a page's `nextCursor` reaches `b`, and then treat the gap as usable for
every kind; a feed page serves every declared kind in `(cursor, nextCursor]`
(chapter 05 §5.11).

**Closing checks.** Packs and the tail are a fast path; a reader still closes
it with checks the server answers:

- **Records:** the manifest check (chapter 05 §5.15). A record the manifest
  lists at a version the reader does not hold is pulled by id.
- **Bodies:** before it applies a packed snapshot, a reader confirms its
  `revision` against `snapshotMeta` from a `POST /sync/crdt/updates/batch`
  answer read after it holds the pack bytes, in the same run; a different or
  missing revision means the chapter 07 §7.8 baseline through the route. The
  same answer carries the `floor` packed updates need (§8.4.3). Revisions are
  a fresh UUID per write (chapter 07 §7.5), so a snapshot of a deleted
  incarnation never matches the current one.

**Membership MUST be verified against the pack's own index block, never assumed
from the advertised range.**

## 8.11 Compatibility of record and update packs

**Normative.** A server MAY list `record` and `crdt_update` packs to every
client version. The readers that shipped before §8.4.2 and §8.4.3 ignore them,
and a reader built to those sections reads packs from any older server. Readers
cited: desktop at the last release tag `v2026-11-19` (`df8108df66`), and the
Rust core at `be319a42f9` on `main`, which the iOS build ships
(`crates/memry-core/src/sync/pack_bootstrap.rs`, last changed in `6b5d90b80e`).

| Reader                    | Server lists a `record` or `crdt_update` pack                                                                                                                                                                                                                                                    | A `record` pack without meta                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| desktop `v2026-11-19`     | `PackListResponseSchema` accepts all three kinds (`packages/contracts/src/sync-api.ts:717` at the tag); the pack is dropped before download (`apps/desktop/src/main/sync/packs/pack-bootstrap.ts:189` at the tag), and a non-snapshot entry in any pack it opens is counted skipped (`:347-350`) | never downloaded                                              |
| Rust core, iOS            | `usable_pack` returns `None` for any kind but `crdt_snapshot` (`crates/memry-core/src/sync/pack_bootstrap.rs:334-337`); `apply_pack` skips any other entry (`:238-243`)                                                                                                                          | never downloaded                                              |
| a reader built to §8.4.2+ | reads it                                                                                                                                                                                                                                                                                         | each entry unusable, item stays on `POST /sync/pull` (§8.4.2) |

- **New reader, old server.** A server whose `PACKED_KINDS`
  (`apps/sync-server/src/services/pack-compaction.ts`) is `['crdt_snapshot']`,
  every server before step 04 (#5227), lists no record or update pack, and the reader bootstraps records and updates
  item by item (§8.0). No server has written a kind 2 entry. A record pack
  from a server that built them before §8.4.2 carries no meta, and the row
  above applies.
- **Listing order.** The listing sorts on `max_cursor` across kinds
  (`apps/sync-server/src/services/pack-list.ts:79`, `:95`). Record and update
  packs advertise `server_cursor` bounds, which sit far below the epoch-second
  bounds of snapshot packs for any vault whose cursor is under about 1.7 × 10⁹,
  so a shipped reader meets them only on the last pages, after every snapshot
  pack. Both shipped readers stop after 20 pages
  (`apps/desktop/src/main/sync/packs/pack-bootstrap.ts:54` at the tag,
  `crates/memry-core/src/sync/pack_bootstrap.rs:52`) of 50 packs
  (`PACK_LIST_PAGE_LIMIT`, `:51` at the tag, `:49`). When the extra packs push a
  listing past 1,000 packs, the walk ends `truncated`: the snapshot packs it saw
  still apply, and the applied-through watermark is not recorded
  (`apps/desktop/src/main/sync/packs/pack-bootstrap.ts:310-314` at the tag,
  `crates/memry-core/src/sync/pack_bootstrap.rs:184-188`), so the next run lists
  again. That costs requests and loses nothing.
- **Listing size.** Every run that ends `truncated` repeats the 20-page walk,
  so a vault whose listing passed 1,000 packs would cost a released reader 20
  listing requests on every bootstrap run. §8.14 keeps every vault below
  1,000 listed packs of all kinds, so the walk never truncates.
- **Coverage fields.** `coverFrom`, `coverThrough` and `coverage` are
  optional. Desktop `v2026-11-19` parses the listing with zod objects that
  strip unknown keys (`packages/contracts/src/sync-api.ts:738`, `:757` at the
  tag), and the Rust core reads only the keys it names
  (`crates/memry-core/src/sync/pack_bootstrap.rs:338-342`), so both ignore
  them.
- **Replaced and purged packs.** A released reader whose download fails, on a
  404 or any other error, logs it and leaves those items to the item routes
  (`apps/desktop/src/main/sync/packs/pack-bootstrap.ts:449-454` at the tag,
  `crates/memry-core/src/sync/pack_bootstrap.rs:178-180`). Desktop re-lists
  for an expired URL and finds no pack under a replaced id
  (`apps/desktop/src/main/sync/packs/pack-bootstrap.ts:420-433` at the tag).
  So §8.12 and §8.13 cost a released reader requests, never data.

## 8.12 Rollup

**Normative** (step 06, #5229). A rollup reads small packs of one kind whose
coverage ranges chain, and writes one pack that replaces them:

- **Contents.** The new pack holds every entry of the old ones that is still
  a needed row at that cursor (§8.10), and drops dead entries: rows that moved
  to a higher cursor, dead documents' bodies, purged markers. Its coverage
  range is the union of theirs, `(first.coverFrom, last.coverThrough]`, so
  §8.10 holds before and after. A rollup reads packs, not source blobs, so
  the 256-item build cap (`apps/sync-server/src/services/pack-compaction.ts:69`)
  does not bind it; §8.14 does.
- **Replace, not modify.** The new pack is a new object under a key no pack
  object of the vault has used (§8.8). One D1 batch deletes the old
  `pack_index` rows, inserts the new row and records each old object for
  deletion. The old rows are deleted first in that batch: rows are unique on
  `(user_id, vault_id, item_kind, min_cursor)` and a conflicting insert does
  nothing (`apps/sync-server/src/services/pack-compaction.ts:548`). The batch
  carries the commit-time recheck of chapter 07 §7.15 for every document it
  holds, so a purge that committed after the rollup read its inputs wins.
- **Grace period.** An object whose row was removed is deleted no earlier than
  `PACK_REPLACED_GRACE_SECONDS` = 600 after the removal
  (`packages/contracts/src/sync-api.ts:777-782`), twice the presigned URL
  lifetime of 300 s (`apps/sync-server/src/services/r2-presign.ts:27`). A URL
  is signed only at listing time, from a listed row, so every URL that names
  the object expires before the object goes. A server MUST NOT raise the
  presign lifetime above half the grace period.
- **A 404 between listing and download.** A reader treats a pack that answers
  404, 403 or any other failure as unusable: its range is a gap (§8.10), its
  items stay on the item routes and the feed. It MAY list again once to find
  the replacement, and MUST NOT retry the old URL beyond its transport retry
  or fail the sync.

## 8.13 Scoped purge

**Normative** (step 06, #5229). When the chapter 07 §7.15 purge removes a
document's body, the document's ciphertext leaves every pack object within
`PACK_PURGE_DEADLINE_SECONDS` = 900 of the purge's commit
(`packages/contracts/src/sync-api.ts:784-785`), and only the packs that hold it
are touched:

- **Finding them.** A writer records, in the batch that inserts a pack row,
  one membership row per document the pack holds: the entry id for
  `crdt_snapshot` and `crdt_update`, and the `note:` or `journal:` id of a
  `record` entry. The purge reads the packs of a document from those rows.
- **Out of the listing at once.** The purge batch that deletes the body rows
  also deletes the listing rows of those packs and records their objects for
  deletion after the grace period of §8.12. 600 s of grace is inside the 900 s
  deadline. The document's older record versions go too: its tombstone, at a
  higher cursor, is the row's current state.
- **Rewrite.** Each removed pack is rewritten without the document, under the
  same coverage range and a new key, as a rollup of one pack (§8.12). Until
  the rewrite commits its range is a gap, which lowers a reader's tail start
  (§8.10): speed, not data. The rewrite has no deadline.
- **Purged-tombstone markers.** Before the chapter 05 §5.12.3 shed turns a
  tombstone into a marker, the same steps take every record pack holding that
  `(type, id)` out of the listing. A fresh reader never sees a marker, so an
  older live entry left listed would bring a deleted item back.

**Why a lingering entry is harmless.** A reader can still hold bytes of a pack
it listed or downloaded before the purge. Each kind has the rule that makes
those entries inert:

- `record`: the tombstone is at a higher cursor and wins on clock (chapter 05
  §5.8); a re-create seeds its clock from the tombstone, so it dominates the
  old entry too.
- `crdt_snapshot`: applied only after its `revision` matches `snapshotMeta`
  read after the pack (§8.10); a deleted incarnation's revision never does.
- `crdt_update`: applied only above a `floor` read after the pack (§8.4.3).

A reader that applied a body and then meets the document's tombstone deletes
the body (chapter 07 §7.15).

## 8.14 Sizing

**Normative** (steps 04 to 06, #5227, #5228, #5229). One pack holds at most
`PACK_MAX_ENTRIES` = 4096 entries (`packages/contracts/src/pack-format.ts:90`)
and at most `PACK_TARGET_BYTES` = 24 MiB of payload
(`apps/sync-server/src/services/pack-compaction.ts:47`), whichever comes
first; every entry stays under `PACK_MAX_INDEX_ENTRY_BYTES`
(`packages/contracts/src/pack-format.ts:88`). A build from source blobs is
also capped at 256 items by its subrequest budget
(`apps/sync-server/src/services/pack-compaction.ts:69`); a rollup is not
(§8.12).

**A vault lists at most `PACK_LIST_MAX_PACKS_PER_VAULT` = 999 packs of all
kinds** (`packages/contracts/src/sync-api.ts:787-791`), below the 1,000 a
released reader walks (§8.11). A writer rolls up before a new row would pass
it; when a rollup cannot make room, the writer stops, and the rest of the vault
stays on the tail. At 24 MiB per pack that bound is about 23 GiB, far above
the 28 MB measured vault of #5221.
