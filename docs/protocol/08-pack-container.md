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

**Normative: no writer produces `crdt_update = 2` today.** `PACKED_KINDS` is
`['crdt_snapshot']` (`apps/sync-server/src/services/pack-compaction.ts:104`).
When a writer ships, its entries follow §8.4.3.

**A conforming reader MUST accept kind 2 structurally** — `KIND_BY_CODE` maps it
(`packages/contracts/src/pack-format.ts:102-106`) and rejecting it would be a
gratuitous incompatibility with a future writer — **and MAY decline to use the
entry**, falling back to the item-granular endpoints for that document, exactly
as it would for a pack it could not verify (§8.0).

**Disposition of Q08.1: answered** (this section).

### 8.4.2 Record entries

**Normative.** A record entry is one `POST /sync/pull` item, split three ways
(`RecordPackEntryMetaSchema`, `packages/contracts/src/sync-api.ts:803-807`):

| Pull item field                                                                   | Where the entry carries it                  |
| --------------------------------------------------------------------------------- | ------------------------------------------- |
| `type`, `id`                                                                      | `idBytes`, as `type:id`                     |
| the row's `sync_items.blob_key`                                                   | `keyBytes`                                  |
| `blob`                                                                            | the payload bytes                           |
| `operation`, `cryptoVersion`, `signature`, `signerDeviceId`, `deletedAt`, `clock` | `metaBytes`, under the pull item's own keys |

`RecordPackEntryMetaSchema` is `RecordPullItemResponseSchema` without `id`,
`type` and `blob` (`packages/contracts/src/sync-api.ts:789-807`), so a field
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
  (`packages/contracts/src/sync-api.ts:789-794`). The reader then treats it as
  a pull item in every respect: signature verification against the signer's
  key, `cryptoVersion` (chapter 00 §0.2.1), the delete-wins and clock rules of
  chapter 05 §5.8 and chapter 06. Coming from a pack gives an entry no
  precedence: the same clock comparison against local state decides whether it
  applies, so an entry older than the local row changes nothing (chapter 05
  §5.8).
- **An unusable entry costs that entry, not the pack.** An entry whose meta is
  absent (`metaLen` 0) or fails `RecordPackEntryMetaSchema`, whose payload is
  not a valid blob, or whose rebuilt item fails validation or verification is
  ignored, and the item stays on `POST /sync/pull` (see **Record tail**). The
  pack digests already passed (§8.5), so the rest of the pack is intact. This is what a reader does
  with a record pack written before this section, which carries no meta
  (`apps/sync-server/src/services/pack-compaction.ts:88-104` describes that
  writer).
- **Undeclared types.** A pack is not filtered by the reader's type
  subscription (chapter 05 §5.3). A reader skips an entry whose type it does
  not declare, as `POST /sync/pull` would not have served it: the server reads
  only the subscription's record types
  (`apps/sync-server/src/lib/sync-types.ts:20-24`,
  `pullItems` with the subscription's `recordTypes`,
  `apps/sync-server/src/routes/sync.ts:637-643`).
- **Record tail.** A reader that uses record packs and then pulls the rest
  through `POST /sync/pull` MUST start that pull at a cursor no higher than
  `sortKey − 1` of every record entry it skipped, for any reason in this
  section. Starting the tail at a pack's `maxCursor` instead loses every
  skipped entry for good: no pull ever answers below its cursor.
- **No payload, no entry.** A purged tombstone (chapter 05 §5.12.3) and a row
  whose payload is lost (§5.12.4) have no payload bytes. A writer MUST NOT emit
  them as record entries; `POST /sync/pull` keeps them out of `items` for the
  same reason (`packages/contracts/src/sync-api.ts:854-863`).
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
(`CrdtUpdatePackEntryMetaSchema`, `packages/contracts/src/sync-api.ts:814-818`):

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
  existing number: without a claim the union's current maximum
  (`apps/sync-server/src/services/crdt-snapshot-write.ts:252-260`, `:336`), with
  a claim its covered watermark, the highest update the claim covers
  (`:138-146`, `:152-156`, `:334-335`). So a document's updates above any
  baseline are numbered `baseline + 1`, `baseline + 2`, and so on. A reader applies packed updates under chapter 07
  §7.9 with one addition: **it advances a document's update cursor across a
  packed update only when that update's `sequenceNum` is the cursor plus one.**
  At the first missing number it stops using packed updates for that document
  and pulls from its cursor through the routes of chapter 07 §7.2, then may
  resume with the packed updates above what the pull returned. A pack never
  proves that an update is absent, so a gap is resolved by the server, never
  skipped. This is chapter 07 §7.9's stop-at-gap rule applied to packed data.
- **Lower bound.** A reader MUST NOT use any packed update of a document until
  it holds a server-provided lower bound `L` for that document, and then uses
  only packed updates with `sequenceNum > L`, starting its cursor at
  `max(cursor, L)`. With no bound it uses none and fetches the document through
  chapter 07 §7.2. The reason is the purge: it sets the floor `N` and deletes
  rows `1..N` (chapter 07 §7.15), but a pack built before it still holds
  updates `1..N`, and no client sees the floor. A fresh device starts that
  re-created document at cursor 0 and, without a bound, applies the deleted
  text as `cursor + 1`. Today's servers provide two bounds:
  - `snapshotMeta.sequenceNum` (chapter 07 §7.11), once the reader has
    applied that snapshot under §7.8. A snapshot of a re-created document
    numbers at or above the floor (§7.4).
  - the first answer of `GET /sync/crdt/updates` or its batch form for
    `since` = the reader's cursor: one less than the lowest `sequenceNum` it
    returns, because the route answers the surviving rows above `since` in
    ascending order (`apps/sync-server/src/services/crdt.ts:270`). An empty
    answer means no row above the cursor survives, so no packed update is
    usable.
- **Purge dependency.** The §7.15 purge drops only `crdt_snapshot` packs
  (`apps/sync-server/src/services/document-body-purge.ts:45-127`). **Before any
  server writes a kind 2 entry (step 05 of #5221), the purge MUST also drop the
  vault's `crdt_update` packs and reset that kind's watermark**, with the same
  commit-time recheck §7.15 gives snapshot compaction. Part b of #5226
  (coverage, rollup and scoped purge) depends on this. The lower bound covers a
  reader that listed a pack before the purge; the drop keeps every later
  listing clean.
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

**Normative.** A pack is **never modified after its single PUT**. New data goes
into new packs; stale entries stay as dead bytes forever
(`packages/contracts/src/pack-format.ts:52-53`). A client MUST NOT expect a pack
it has read to change, and MUST NOT treat a pack as authoritative: individual
blobs remain the source of truth throughout
(`packages/contracts/src/sync-api.ts:526-527`).

## 8.9 Listing

**Normative.** `GET /sync/packs` returns `PackListResponseSchema`
(`packages/contracts/src/sync-api.ts:548-557`), whose `packs` are
`PackSummarySchema` (`:519-536`):

| Field                    | Rule                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `packKey`          | non-empty strings                                                                                                                                     |
| `itemKind`               | one of `record`, `crdt_snapshot`, `crdt_update` (`:498`)                                                                                              |
| `minCursor`, `maxCursor` | `server_cursor` bounds for `record` and `crdt_update`; `created_at` epoch-second bounds for `crdt_snapshot` (`:711-716`)                              |
| `itemCount`              |                                                                                                                                                       |
| `byteSize`               | **the payload region only** — header, index and footer excluded. **NOT a file length: a reader MUST NOT Range-request against it** (`:526-530`)       |
| `createdAt`              |                                                                                                                                                       |
| `url`                    | a presigned GET, present **only** when the deployment opted into presigned transfers; **absent means "use the item-granular endpoints"** (`:507-509`) |
| `expiresAt`              | epoch seconds at which `url` stops working (`:534`)                                                                                                   |

`nextCursor` is an opaque keyset token, absent on the final page, and **packs
arrive newest-first** (`packages/contracts/src/sync-api.ts:551-556`). A client
MUST treat it as opaque.

## 8.10 Coverage is not total

**Normative.** Records tile their cursor axis completely. **Snapshot coverage can
under-cover same-second writes**: a document written the same second as an
already-packed tie group with a smaller id sorts below the watermark and stays
item-granular forever. Holes inside a range, from replaced or deleted items, are
dead bytes and also fall back to item GETs
(`packages/contracts/src/sync-api.ts:521-527`).

**Membership MUST be verified against the pack's own index block, never assumed
from the advertised cursor range.**

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

- **New reader, old server.** A server whose `PACKED_KINDS` is
  `['crdt_snapshot']` (`apps/sync-server/src/services/pack-compaction.ts:104`)
  lists no record or update pack, and the reader bootstraps records and updates
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
- **Sizing dependency for part b.** Every run that ends `truncated` repeats
  the 20-page walk, so a vault whose listing passes 1,000 packs of all kinds
  costs a released reader 20 listing requests on every bootstrap run. Before a
  server lists record or update packs, part b of #5226 MUST keep a released
  reader's walk from truncating, by bounding how many packs a vault lists or
  by listing non-snapshot packs only to a client that asks for them. Part b
  owns the rule; this chapter states only the obligation.
