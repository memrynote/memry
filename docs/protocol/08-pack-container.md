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
kind, the one its listing row names (`apps/sync-server/src/services/pack-compaction.ts:200`
selects one kind per pack). A reader still checks each entry's own `kind`.

Snapshot entries carry `{sequenceNum, revision}` in `metaBytes`, which is the
**freshness token a client compares against `snapshotMeta`, or against the body
manifest's `snapshot.revision` (§8.4.3), before trusting the bytes** (`packages/contracts/src/pack-format.ts:37-40`; chapter 07 §7.8).

### 8.4.1 Will a reader ever see kind 2 — Q08.1

**Normative: a server from step 05 (#5228) on produces `crdt_update = 2`.**
The writer packs the kinds `PACKED_KINDS` names
(`apps/sync-server/src/services/pack-compaction.ts:133`): `crdt_snapshot`,
`record` from step 04 (#5227, #5253) on, and `crdt_update` from step 05 on,
whose entries follow §8.4.3
(`apps/sync-server/src/services/pack-update-selection.ts`). An older server
writes no kind 2 entry.

**A conforming reader MUST accept kind 2 structurally** — `KIND_BY_CODE` maps it
(`packages/contracts/src/pack-format.ts:102-106`) and rejecting it would be a
gratuitous incompatibility with a future writer — **and MAY decline to use the
entry**, falling back to the item-granular endpoints for that document, exactly
as it would for a pack it could not verify (§8.0).

**Disposition of Q08.1: answered** (this section).

### 8.4.2 Record entries

**Normative.** A record entry is one `POST /sync/pull` item, split three ways
(`RecordPackEntryMetaSchema`, `packages/contracts/src/sync-api.ts:865-869`):

| Pull item field                                                                   | Where the entry carries it                  |
| --------------------------------------------------------------------------------- | ------------------------------------------- |
| `type`, `id`                                                                      | `idBytes`, as `type:id`                     |
| the row's `sync_items.blob_key`                                                   | `keyBytes`                                  |
| `blob`                                                                            | the payload bytes                           |
| `operation`, `cryptoVersion`, `signature`, `signerDeviceId`, `deletedAt`, `clock` | `metaBytes`, under the pull item's own keys |
| the row's `server_cursor`                                                         | `sortKey` (§8.4)                            |

`RecordPackEntryMetaSchema` is `RecordPullItemResponseSchema` without `id`,
`type` and `blob` (`packages/contracts/src/sync-api.ts:851-869`), so a field
added to the pull item reaches the entry with no second list to update. A writer
fills the meta from the same columns `POST /sync/pull` answers from
(`pullItemFromColumns`, `apps/sync-server/src/services/sync.ts:415-441`):
`deletedAt` and `clock` are present exactly when the pull item has them.

- **Cursor.** The entry's `sortKey` is the row's `server_cursor`, the cursor
  the manifest reconcile compares (§8.10, **Closing checks**). It identifies
  one write: every accepted push reserves a fresh cursor in the batch that
  commits the row (`apps/sync-server/src/services/sync.ts:881`), and the
  cursor is unique per user and only grows
  (`apps/sync-server/src/services/cursor.ts:1-13`). `sync_items.version` does
  not: a push reads the row, writes `version + 1`, and upserts with no
  compare-and-swap (`apps/sync-server/src/services/sync.ts:748`, `:817`,
  `:911`), so two concurrent pushes can commit the same version with different
  content (`apps/sync-server/src/services/sync.test.ts:2711`). Meta carries no
  `version`.

- **Payload.** The payload is the R2 object byte for byte: the four blob fields
  as sorted-key JSON (chapter 05 §5.9 A,
  `apps/sync-server/src/services/sync.ts:354-361`). A reader parses it as JSON
  and validates it with `EncryptedItemPayloadSchema`
  (`packages/contracts/src/sync-api.ts:389-394`) as the item's `blob`.
- **Identity.** A reader splits `idBytes` at the **first** `:`. No record type
  contains one (`RECORD_SYNC_ITEM_TYPES`,
  `packages/contracts/src/sync-api.ts:38-66`), and an id may: a
  `folder_config` id is a folder path (chapter 05 §5.12.1).
- **Key.** `keyBytes` is the row's `sync_items.blob_key`, the key
  `POST /sync/pull` reads the payload from
  (`apps/sync-server/src/services/sync.ts:490`). It is provenance; the
  reader's fallback is `POST /sync/pull`, never a GET of that key.
- **Rebuild and validate.** `{...meta, id, type, blob}` MUST validate as
  `RecordPullItemResponseSchema`
  (`packages/contracts/src/sync-api.ts:851-856`). The reader then treats it as
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
  every record pack built before step 04 (#5227).
- **Undeclared types.** A pack is not filtered by the reader's type
  subscription (chapter 05 §5.3). A reader skips an entry whose type it does
  not declare, as `POST /sync/pull` would not have served it: the server reads
  only the subscription's record types
  (`apps/sync-server/src/lib/sync-types.ts:20-24`,
  `pullItems` with the subscription's `recordTypes`,
  `apps/sync-server/src/routes/sync.ts:649-657`).
- **Record tail.** A reader that uses record packs and then follows the cursor
  tail through `GET /sync/changes` (chapter 05 §5.11.1) MUST start that tail at
  a cursor no higher than `sortKey − 1` of every record entry it found
  unusable. The tail then names the item again and `POST /sync/pull` serves
  it. Starting the tail at a pack's `maxCursor` instead loses every unusable
  entry for good: the tail never answers below its cursor. An entry of an
  undeclared type is exempt, because the tail would not serve it either.
- **Manifest reconcile.** A reader that uses record packs MUST reconcile them
  against `GET /sync/manifest`, read after it holds the pack bytes, before it
  trusts them (§8.10, **Closing checks**). The reconcile is cursor-exact: a
  manifest item whose `serverCursor` differs from the cursor of the row the
  reader holds goes to `POST /sync/pull`. A live record it took from a pack that the manifest does
  not list is not applied.
- **No payload, no entry.** A purged tombstone (chapter 05 §5.12.3) and a row
  whose payload is lost (§5.12.4) have no payload bytes. A writer MUST NOT emit
  them as record entries; `POST /sync/pull` keeps them out of `items` for the
  same reason (`packages/contracts/src/sync-api.ts:916-926`). The writer
  omits them, and the record range still spans them: the cursor-exact
  reconcile delivers a live one (§8.10).
- **Index entry size.** A writer MUST NOT emit an index entry larger than
  `PACK_MAX_INDEX_ENTRY_BYTES`, which a conforming reader rejects (§8.6;
  `crates/memry-core/src/protocol/pack/index.rs:165-170`). An item whose entry
  would exceed it is left out of packs, and the record range still spans it
  (§8.10).

`pack-container.json` pins this with real signed items: the verifier rebuilds
each pull item from the pack bytes and decrypts it through the production
reader (`packages/contracts/src/__tests__/pack-container.test.ts`).

### 8.4.3 Update entries (kind 2)

**Normative.** An update entry is one `crdt_updates` row, as
`GET /sync/crdt/updates` returns it (chapter 07 §7.11), split the same way
(`CrdtUpdatePackEntryMetaSchema`, `packages/contracts/src/sync-api.ts:876-880`):

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
  for that document, or from a body manifest read (below), read after the
  reader holds the pack bytes, in the same run; an answer without `floor`
  makes every packed update of that document unusable.** `floor` is the document's highest purged sequence number, 0 when
  it was never purged (chapter 07 §7.4, §7.15). A server from step 05
  (#5228) on, the first kind 2 writer, sends it on both routes, read in the
  same D1 batch as the updates it answers with (`readFloors`,
  `apps/sync-server/src/services/crdt.ts:312-332`), so a purge cannot commit
  between the two reads. An older server omits it, and a reader then falls
  back to chapter 07 §7.2 (fail closed). The
  reason is the purge: it records floor `N` and deletes rows `1..N`, but a pack
  built before it still holds updates `1..N`. Without the floor a fresh device
  at cursor 0 applies the deleted text into the re-created document. A floor
  read before the pack can predate a purge the pack still reflects, so it is
  read again on every run. Neither `snapshotMeta.sequenceNum` (#5248) nor the
  lowest `sequenceNum` a route returned stands in for it.
- **Body manifest.** `GET /sync/crdt/manifest` (chapter 07 §7.4.1, #5232)
  answers the same `floor` for up to 1,000 documents per request, read in one
  D1 batch with the document's snapshot and highest update, so it satisfies
  the floor rule above in `ceil(n / 1000)` requests instead of `ceil(n / 100)`
  batch calls. A **body manifest read** is every page from no `cursor` until
  `nextCursor` is `null`, every page parsed by `CrdtManifestResponseSchema`,
  all requested after the reader holds the pack bytes, in the same run. A
  document absent from a body manifest read has no body row and floor 0 at
  its page's read, so its packed updates are unusable and it goes to the
  routes of chapter 07 §7.2. A read that stops short (any page failing, a
  malformed page) answers nothing: the reader reads `floor` from
  `POST /sync/crdt/updates/batch` for every document it holds packed bodies
  of. **A server without the route** (every server before #5232) answers it
  404, and the reader falls back the same way (fail closed, §8.11).
- **Purge dependency.** Whenever the §7.15 purge removes a document that has
  any body row (a `crdt_updates` or a `crdt_snapshots` row), it MUST take
  every `crdt_update` pack that holds that
  document out of the listing, and rewrite it, as §8.13 states for every kind,
  with the same commit-time recheck §7.15 gives snapshot compaction. Until the
  membership index of §8.13 exists, that is every `crdt_update` pack of the
  vault, and the same batch MUST reset the `crdt_update` pack watermark, as
  the purge does for `crdt_snapshot`
  (`apps/sync-server/src/services/document-body-purge.ts:174-177`); without the
  reset, compaction never packs the other documents of a dropped pack again.
  Keying on update rows alone is not enough: a snapshot that claims the
  packed updates prunes their rows (#2299), and the packs still hold them.
  The purge does both in the D1 batch that deletes the body rows,
  conditioned on the document having one, so the drop and the delete commit
  together (`apps/sync-server/src/services/document-body-purge.ts:98-154`). A
  compaction run that selected the rows before the purge fails its
  commit-time recheck (`updatesCurrent`,
  `apps/sync-server/src/services/pack-update-selection.ts`). This shipped with
  the first kind 2 writer (step 05, #5228). The floor covers a reader that
  holds a pack from before the purge; the drop keeps later listings clean.
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
(`packages/contracts/src/pack-format.ts:52-53`). A key is unique per build,
not per range: it ends in the build's `pack_index` id
(`<min>_<max>_<packId>.pack`, `packObjectKey` in
`apps/sync-server/src/services/pack-index-write.ts`), so a rebuild of a range a
purge dropped never lands on the key the purge then deletes. A reader takes
the object from the listed `url` and never parses the key. What changes is the listing.
A pack's `pack_index` row may be removed, by a rollup that replaces it
(§8.12) or by a purge (§8.13), and the object is deleted after the grace
period of §8.12. Stale entries therefore stay as dead bytes for the life of
the object, not forever. A client MUST NOT expect a pack it has read to
change, MUST NOT expect a listed pack to stay listed or downloadable, and MUST
NOT treat a pack as authoritative: individual blobs remain the source of truth
throughout (`packages/contracts/src/sync-api.ts:739-744`).

## 8.9 Listing

**Normative.** `GET /sync/packs` returns `PackListResponseSchema`
(`packages/contracts/src/sync-api.ts:802-827`), whose `packs` are
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
arrive newest-first** (`packages/contracts/src/sync-api.ts:831-836`). A client
MUST treat it as opaque. The first page also carries `coverage`, one
`PackCoverageSchema` per kind (`packages/contracts/src/sync-api.ts:775-784`,
`:805-820`), §8.10. A reader parses `coverage` entry by entry and skips an
entry it cannot parse, such as one of a kind added after it shipped, which
leaves that kind uncovered (`:801-811`).

## 8.10 Coverage and where the tail starts

**One axis.** Coverage is stated on `server_cursor` for every kind. Records,
snapshots and updates draw it from one per-user sequence, reserved inside the
batch that commits the row, so no reader sees a cursor above a row that has
not committed (`apps/sync-server/src/services/cursor.ts:1-13`; chapter 05
§5.11, chapter 07 §7.17). A pack's coverage range is
`(coverFrom, coverThrough]` (`packages/contracts/src/sync-api.ts:763-766`).
`minCursor`, `maxCursor` and the snapshot `sortKey` keep their per-kind
meaning (§8.4, §8.9), because the released readers order and resume on them
(§8.11).

**The invariant.** **For `crdt_snapshot` and `crdt_update`, a listed pack
holds every row of that kind a reader needs whose `server_cursor` lies in the
pack's coverage range, and no such row has a `server_cursor` in
`(packedThrough, coveredThrough]` of that kind's `coverage` entry**
(`packages/contracts/src/sync-api.ts:769-784`). **For `record`, coverage is
complete up to omitted rows, and the cursor-exact manifest reconcile
(Closing checks, below) delivers every omitted row.**

A body row a reader needs is one with a payload that the feed or the body
routes would serve it, and every body row of a document whose record is
deleted: a re-create keeps those rows at their old cursors while the purge has
not run or has failed (chapter 07 §7.15), so a writer packs them and a reader
drops them on the tombstone (**Closing checks**). "Holds" means an entry at
that row's current cursor; a row that later moves to a higher cursor (a
rewrite, a delete) leaves a dead entry behind, and its new state is at the
new cursor.

A record row the writer cannot pack is **omitted**, and the record range
still spans it: a lost payload (`blob_missing_at` set, or a 404 when the
writer reads it, chapter 05 §5.12.4), an index entry above
`PACK_MAX_INDEX_ENTRY_BYTES` (§8.4.2), a corrupt clock, a missing signer, or
any meta it cannot build. An omitted live row is in the manifest at its
current `server_cursor` (`apps/sync-server/src/services/sync.ts:1230-1232`),
which no entry the reader holds carries, so the reconcile pulls it, and `POST /sync/pull` serves it or reports it in
`blobMissing`. An omitted tombstone, and a purged-tombstone marker (chapter 05
§5.12.3), is not needed: the manifest omits the item, so the reconcile drops
any older packed live entry of it, and `POST /sync/pull` answers a tombstone
whose payload is lost as a purged tombstone
(`apps/sync-server/src/services/sync.ts:480-486`).

**A lost body row.** Only a `crdt_snapshot` row can lose its payload:
`crdt_updates` keeps its bytes in D1 (`update_data`,
`apps/sync-server/src/services/crdt.ts:143`). A writer counts a 404 on a
snapshot object as lost only while the row still points at the key it read,
re-reading the row as `markSyncItemBlobMissing`
(`apps/sync-server/src/services/sync.ts:1590-1605`) and `getSnapshot`
(`apps/sync-server/src/services/crdt.ts:478-490`) do. A row that moved or is
gone is not needed at that cursor; its replacement sits at a higher cursor. A
lost body row is needed and cannot be packed, so it ends the range (below).
The CRDT routes have no `blobMissing`. A reader meets the row in the feed as a
snapshot ref (chapter 07 §7.17.1), and `GET /sync/crdt/snapshot` answers a
retryable 503 while the row still points at the lost key (chapter 07 §7.7.1,
**Readers racing the delete**).
The reader treats that as a transport failure, keeps the document owed, and
never treats it as empty. The next snapshot write moves the row to a higher
cursor, and that is what ends the loss.

What a server MUST do to keep it. Each item is a **step 06 MUST** (#5229)
unless it says **step 07 MUST** (#5230). A server from step 06a (#5229) on
records a coverage range on every `record` pack it builds or rolls up
(`cover_from`, `cover_through`, migration 0023) and lists none of it yet. Its
body packs carry no range until step 07, because its snapshot builds still
select on `created_at`. Its builds and rollups pack the body rows of a deleted
document while those rows exist, and the purge drops the packs that hold them
(§8.13). A `record` watermark written before migration 0023 has a NULL
`covered_through`, and the packs built from it stay caches only.

- A writer selects rows of every kind by `server_cursor` above the kind's
  watermark. A pack's `coverFrom` is the `coverThrough` of the kind's previous
  pack, or 0, so windows of rows it skipped as unneeded or omitted fall inside
  the next range. Record ranges therefore tile. A body row it needs but cannot
  pack (a lost snapshot, an index entry above `PACK_MAX_INDEX_ENTRY_BYTES`, a
  meta it cannot build) is never inside a range: the previous range ends below
  it and the next one starts at its cursor, a gap one cursor wide. A writer
  MUST NOT leave such a body row out of a range silently.
- **Bridging a body gap.** The gap persists while its row is still needed
  and unpackable. A rollup or rebuild MAY bridge two adjacent ranges when the
  gap between them no longer holds a needed row: the row moved to a higher
  cursor, or the purge removed it. **Step 06 MUST:** the writer checks each
  gap on its next run and bridges every gap that no longer holds a needed
  row, so a gap outlives its lost row by at most one run.
- `coverage` is read in the same D1 batch as the first page, and a pack row,
  its watermark and `coveredThrough` commit in one batch, so the statement and
  the page are one consistent read.
- **The watermark and coverage advance only in a batch whose `pack_index`
  insert applied.** The insert does nothing on a conflict on
  `(user_id, vault_id, item_kind, min_cursor)`
  (`apps/sync-server/migrations/0007_pack_index.sql:32`,
  `apps/sync-server/src/services/pack-index-write.ts:67`), and two snapshot
  packs whose first entries share a `created_at` second share `min_cursor`. A
  watermark that moved past a pack that was never listed would leave its rows
  in no pack and in no gap a reader can see. The batch's watermark and
  coverage statements are guarded on the new row's id existing, so no schema
  changes. The insert is guarded too on the watermark and `covered_through`
  still being the ones the build selected under (`watermarkUnchanged`,
  `apps/sync-server/src/services/pack-index-write.ts:161`): of two builds that
  selected one window, only the first to commit lists, and the other deletes
  its own object. A writer that finds its insert would conflict rolls the listed pack
  and its new rows into one pack instead (§8.12).
- **Step 07 MUST:** a server states no `coverage` for `crdt_snapshot` or
  `crdt_update` while the vault holds a needed row of that kind with a NULL
  `server_cursor`: such a row is in no range and never in the feed (chapter 07
  §7.17).
- `coverage` names only kinds that every client release the server serves
  parses (`PackKindSchema`, `packages/contracts/src/sync-api.ts:728`). A reader
  built to this section skips an entry it cannot parse (§8.9), so a server
  that gets this wrong costs it the tail start of that kind, never the listing.
- `packedThrough` is the `coverThrough` of the kind's newest committed pack.
  A rollup or purge that takes packs out of the listing never lowers it, so a
  reader whose packs do not chain up to it sees the gap. A server that drops
  every pack of a kind and resets its watermark resets that kind's
  `packedThrough` and `coveredThrough` to 0 in the same batch.
- A pack without `coverFrom` and `coverThrough` is a cache only. Every
  snapshot pack built before this section is one.

**This closes the same-second under-coverage.** The snapshot writer used a
`(created_at, note_id)` watermark
(`apps/sync-server/src/services/pack-compaction.ts:205`); a snapshot written
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
   Overlapping ranges are fine: the listing never holds an old pack and its
   replacement at once (§8.12), but a walk that spans a rollup can meet the
   old packs on one page and the new pack on a later one.
2. `T_kind` = `max(end, coveredThrough)` when `end` reaches `packedThrough`,
   otherwise `end`. A kind with no `coverage` entry, or no `coverage` at all
   (every server today), gives 0.
3. For `record`, at most `sortKey - 1` of every unusable record entry
   (§8.4.2, **Record tail**).

The reader tails `GET /sync/changes` from `min(T_kind)`. A gap in the walk is
a pack the reader could not use (a 404, an expired URL, a bad digest), a pack
a rollup or purge took out of the listing mid-walk, or a body row a writer
could not pack; each one lowers the start, which costs feed pages and loses
nothing. A lower start is paid on every bootstrap while the gap stays: a lost
row at cursor 50 in a vault of 20,000 rows starts the tail at 49, about 40
feed pages, for every kind. So a reader SHOULD read the feed across a gap
`(a, b]`, from cursor `a` until a page's `nextCursor` reaches `b`, and then
treat the gap as usable for every kind; a feed page serves every declared kind
in `(cursor, nextCursor]` (chapter 05 §5.11). A writer's gap is one cursor
wide, so reading across it costs one feed page per gap. A gap left by an
unusable or delisted pack costs pages in proportion to the rows it spans.

**Closing checks.** Packs and the tail are a fast path; a reader still closes
it with checks the server answers:

- **Records: the manifest reconcile.** The manifest is the truth and a pack is
  a cache (#5221, target design 5). Record coverage can have holes a reader
  cannot see: a tombstone shed to a marker before any pack carried it, which
  the feed then serves only to a reader that declares `purged_tombstones`
  (chapter 05 §5.12.3), and rows the writer omitted (an oversize index
  entry, a corrupt clock, a lost blob). So a reader that applies record packs
  MUST read `GET /sync/manifest` to its last page (chapter 05 §5.15) after it
  holds the pack bytes, and reconcile before it trusts the packs. The
  reconcile is **cursor-exact**:
  1. A manifest item the reader does not hold, holds only as a tombstone, or
     holds at a cursor other than the item's `serverCursor` is pulled by id
     through `POST /sync/pull`, at most 100 ids per request
     (`packages/contracts/src/sync-api.ts:514`). The cursor it holds is the
     entry's `sortKey` for a row taken from a pack (§8.4.2), or the
     `serverCursor` of the feed ref it pulled against (chapter 05 §5.11.1); a
     row held with no known cursor matches none. A pulled item whose payload
     is lost comes back in `blobMissing` (chapter 05 §5.12.4), and the reader
     then knows its held row is not current.
  2. A live record the reader took from a pack and the manifest does not list
     is not applied, or is removed if it was applied, unless the device
     modified it locally since. The manifest lists every live row of the
     declared types (`deleted_at IS NULL`,
     `apps/sync-server/src/services/sync.ts:1232`), so absence from a complete
     manifest read after the pack means the item was deleted. This is the one
     exception to the chapter 05 §5.12.3 rule that absence deletes nothing,
     and it covers only rows taken from a pack and never changed.
  3. A packed tombstone applies as the pull item would (§8.4.2). The manifest
     omits tombstones, and the tombstone's clock is what lets a later
     re-create pass delete-wins (chapter 05 §5.8).

  Every live record row is in the manifest at its current `server_cursor`
  (`apps/sync-server/src/services/sync.ts:1230-1232`). Each accepted write
  gives the row a cursor no earlier write of that user had
  (`apps/sync-server/src/services/cursor.ts:1-13`, set at
  `apps/sync-server/src/services/sync.ts:910`), so a held row whose cursor
  equals the manifest's is the current write, byte for byte. Any live row the
  writer omitted, whatever the reason, is absent from what the reader holds or
  sits at another cursor, and rule 1 pulls it. A stale packed entry is caught
  the same way, whether or not its newer write could be packed, and even when
  two writes share a `version`.

  **A manifest without `serverCursor`.** Every server before step 04 (#5227)
  omits it (`RecordSyncManifestItemSchema`,
  `packages/contracts/src/sync-api.ts:543-545`). A reader then does not trust
  record packs: it may apply them only as a seed, and it pulls every manifest
  item through `POST /sync/pull`, as if it held none of them. Rules 2 and 3
  still apply. This fails closed, and it costs what a bootstrap without
  record packs costs: `ceil(n / 100)` pull requests for `n` live records, 136
  at 13,527.

- **Bodies:** before it applies a packed snapshot, a reader confirms its
  `revision` against `snapshotMeta` from a `POST /sync/crdt/updates/batch`
  answer, or against the document's `snapshot.revision` from a body manifest
  read (§8.4.3), read after it holds the pack bytes, in the same run; a
  different or missing revision, a `null` `snapshot`, or a document absent
  from the read means the chapter 07 §7.8 baseline through the route. The
  same answer carries the `floor` packed updates need (§8.4.3). A body
  manifest read also gives each document's `maxSequenceNum`, its highest
  stored update: a document whose applied cursor is below it after the packs
  pulls the rest through the routes of chapter 07 §7.2. A reader prefers the
  body manifest and uses the batch answer when the server answers the
  manifest 404 or the read stops short, as §8.4.3 states. Revisions are
  a fresh UUID per write (chapter 07 §7.5), so a snapshot of a deleted
  incarnation never matches the current one. A reader drops every body it
  took from a pack for a document whose record, after the reconcile, is a
  tombstone or absent. The writer packs those rows because a re-create keeps
  them (the invariant above), and the revision check then confirms them
  against the re-created document.

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
| desktop `v2026-11-19`     | `PackListResponseSchema` accepts all three kinds (`packages/contracts/src/sync-api.ts:726` at the tag); the pack is dropped before download (`apps/desktop/src/main/sync/packs/pack-bootstrap.ts:189` at the tag), and a non-snapshot entry in any pack it opens is counted skipped (`:347-350`) | never downloaded                                              |
| Rust core, iOS            | `usable_pack` returns `None` for any kind but `crdt_snapshot` (`crates/memry-core/src/sync/pack_bootstrap.rs:322-325`); `apply_pack` skips any other entry (`:238-243`)                                                                                                                          | never downloaded                                              |
| a reader built to §8.4.2+ | reads it                                                                                                                                                                                                                                                                                         | each entry unusable, item stays on `POST /sync/pull` (§8.4.2) |

- **Body manifest.** `GET /sync/crdt/manifest` (chapter 07 §7.4.1) is a new
  route with a new schema, and no released reader calls it. A reader built to
  §8.4.3 that meets a server without it gets 404, and reads `floor` and
  `snapshotMeta` from `POST /sync/crdt/updates/batch` instead, for every
  document it holds packed bodies of (fail closed). It never applies a packed
  body on a manifest read that stopped short.
- **New reader, old server.** A server whose `PACKED_KINDS`
  (`apps/sync-server/src/services/pack-compaction.ts`) is `['crdt_snapshot']`,
  every server before step 04 (#5227), lists no record or update pack, and the reader bootstraps records and updates
  item by item (§8.0). No server before step 05 (#5228) writes a kind 2 entry. A record pack
  from a server that built them before §8.4.2 carries no meta, and the row
  above applies.
- **Listing order.** The listing sorts on `max_cursor` across kinds
  (`apps/sync-server/src/services/pack-list.ts:79`, `:95`). Record and update
  packs advertise `server_cursor` bounds, which sit far below the epoch-second
  bounds of snapshot packs for any vault whose cursor is under about 1.7 × 10⁹,
  so a shipped reader meets them only on the last pages, after every snapshot
  pack. Both shipped readers stop after 20 pages
  (`apps/desktop/src/main/sync/packs/pack-bootstrap.ts:54` at the tag,
  `crates/memry-core/src/sync/pack_bootstrap.rs:51`) of 50 packs
  (`PACK_LIST_PAGE_LIMIT`, `:51` at the tag, `:48`). When the extra packs push a
  listing past 1,000 packs, the walk ends `truncated`: the snapshot packs it saw
  still apply, and the applied-through watermark is not recorded
  (`apps/desktop/src/main/sync/packs/pack-bootstrap.ts:310-314` at the tag,
  `crates/memry-core/src/sync/pack_bootstrap.rs:183-187`), so the next run lists
  again. That costs requests and loses nothing.
- **Listing size.** Every run that ends `truncated` repeats the 20-page walk,
  so a vault whose listing passed 1,000 packs would cost a released reader 20
  listing requests on every bootstrap run. §8.14 keeps every vault below
  1,000 listed packs of all kinds, so the walk never truncates.
- **Coverage fields.** `coverFrom`, `coverThrough` and `coverage` are
  optional. Desktop `v2026-11-19` parses the listing with zod objects that
  strip unknown keys (`packages/contracts/src/sync-api.ts:747`, `:766` at the
  tag), and the Rust core reads only the keys it names
  (`crates/memry-core/src/sync/pack_bootstrap.rs:326-330`), so both ignore
  them.
- **Replaced and purged packs.** A released reader whose download fails, on a
  404 or any other error, logs it and leaves those items to the item routes
  (`apps/desktop/src/main/sync/packs/pack-bootstrap.ts:449-454` at the tag,
  `crates/memry-core/src/sync/pack_bootstrap.rs:177-179`). Desktop re-lists
  for an expired URL and finds no pack under a replaced id
  (`apps/desktop/src/main/sync/packs/pack-bootstrap.ts:420-433` at the tag).
  So §8.12 and §8.13 cost a released reader requests, never data.

## 8.12 Rollup

**Normative, step 06 MUST** (#5229). A server from step 06a on rolls up
(`apps/sync-server/src/services/pack-rollup.ts`) and records each replaced
object in `pack_replaced_objects` for the grace period. A rollup reads small packs of one kind whose
coverage ranges chain, and writes one pack that replaces them:

- **Contents.** The new pack holds every entry of the old ones that is still
  a needed row at that cursor (§8.10), and drops dead entries: rows that moved
  to a higher cursor and rows that no longer exist (a body the purge removed,
  a tombstone shed to a marker). A deleted document's body rows stay while
  they exist (§8.10): a newer row of the same item supersedes an entry, a
  deletion does not. An input the rollup cannot download or verify is left
  out and the run is planned again over every listed pack of the kind without
  it (`apps/sync-server/src/services/pack-rollup.ts:269`); it stays listed. A
  rollup downloads at most 64 packs, so once a new plan needs more it plans only
  among packs already read (`:246`). A run never spans an excluded pack, so
  the bound of §8.14 counts each unreadable pack. Its coverage
  range is the union of theirs, `(first.coverFrom, last.coverThrough]`, so
  §8.10 holds before and after. Record ranges tile, so record inputs always
  chain. Body inputs separated by a gap chain only when the gap no longer
  holds a needed row (§8.10, **Bridging a body gap**). A rollup reads packs, not source blobs, so
  the 256-item build cap (`apps/sync-server/src/services/pack-compaction.ts:109`)
  does not bind it; §8.14 does.
- **Replace, not modify.** The new pack is a new object under a key no pack
  object of the vault has used (§8.8). One D1 batch deletes the old
  `pack_index` rows, inserts the new row and records each old object for
  deletion. The old rows are deleted first in that batch: rows are unique on
  `(user_id, vault_id, item_kind, min_cursor)` and a conflicting insert does
  nothing (`apps/sync-server/src/services/pack-index-write.ts:67`), so the
  listing never holds an old pack and its replacement at once. The batch
  inserts the new row only if every input pack's listing row still exists,
  so a purge or a shed (§8.13) that removed an input after the rollup read it
  wins, and the rollup's object is deleted unlisted. The new pack also drops
  every record entry whose row is now a marker. The batch carries the
  commit-time recheck of chapter 07 §7.15 for every document it holds.
- **Grace period.** An object whose row was removed is deleted no earlier than
  `PACK_REPLACED_GRACE_SECONDS` = 600 after the removal
  (`packages/contracts/src/sync-api.ts:786-791`), twice the presigned URL
  lifetime of 300 s (`apps/sync-server/src/services/r2-presign.ts:27`). A URL
  is signed only at listing time, from a listed row, so every URL that names
  the object expires before the object goes. A server MUST NOT raise the
  presign lifetime above half the grace period. The deletion job of §8.13
  deletes the objects of replaced packs too. From step 06a a purge (chapter
  07 §7.15) makes every replaced object of each kind it drops due in the batch
  that drops the listing, and deletes them at once: such an object may hold
  the purged body, and the reader the grace protects already lost the listed
  packs of that kind to the same purge. The packs it drops from the listing
  are recorded as due in the same batch, before their rows go, so the same
  deletion covers them. A failed delete stays due. Only then does the purge
  enqueue a compaction message `PACK_REPLACED_GRACE_SECONDS` + 60 s later
  (`PACK_PURGE_RETRY_DELAY_SECONDS`,
  `apps/sync-server/src/services/pack-replaced-objects.ts`), whose deletion
  pass runs before its builds and again after them, so a build that fails
  cannot block it (`apps/sync-server/src/services/pack-compaction.ts:676,697`).
  A message whose last pass leaves objects due fails, so the queue redelivers
  it inside the deadline; builds it committed stay committed.
- **A 404 between listing and download.** A reader treats a pack that answers
  404, 403 or any other failure as unusable: its range is a gap (§8.10), its
  items stay on the item routes and the feed. It MAY list again once to find
  the replacement, and MUST NOT retry the old URL beyond its transport retry
  or fail the sync.

## 8.13 Scoped purge

**Normative, step 06 MUST** (#5229); no server scopes the purge yet. When the
chapter 07 §7.15 purge removes a document's body, only the packs that hold it
are touched, and the document's ciphertext MUST leave every pack object within
`PACK_PURGE_DEADLINE_SECONDS` = 900 of the purge's commit
(`packages/contracts/src/sync-api.ts:793-794`):

- **Finding them.** A writer records, in the batch that inserts a pack row,
  one membership row per document the pack holds: the entry id for
  `crdt_snapshot` and `crdt_update`, and the `note:` or `journal:` id of a
  `record` entry. The purge reads the packs of a document from those rows.
- **Out of the listing at once.** The purge batch that deletes the body rows
  also deletes the listing rows of those packs and records their objects for
  deletion.
- **Rewrite.** Each removed pack is rewritten under the same coverage range
  and a new key, as a rollup of one pack (§8.12). It drops the document's body
  entries and its record entries below the record's current cursor, and keeps
  the record entry at that cursor, the tombstone: a fresh reader learns the
  delete and its clock from it, and without that clock a re-create is refused
  with `SYNC_DELETE_WINS` (chapter 05 §5.8). Until the rewrite commits its
  range is a gap, which lowers a reader's tail start (§8.10): speed, not
  data. The rewrite reads the old object, so it MUST commit before the old
  object is deleted. When the deadline forces the deletion first, the server
  rebuilds that range from source rows instead, so no range stays a gap.
- **Object deletion.** The purge batch enqueues a queue message delayed by
  `PACK_REPLACED_GRACE_SECONDS` (§8.12). Its consumer deletes each recorded
  object whose rewrite has committed. A sweep that runs at most every 300 s
  covers every recorded deletion past its grace period, whether its queue
  message failed, waited, or was never delivered. A deletion waits for a
  rewrite in flight only while the next sweep still falls inside the
  deadline. Every object is gone within 900 s of the purge's commit unless two
  delete attempts fail; a lost queue message counts as one. A deletion still
  pending past the deadline raises an alert, an error log with the vault and
  the object count, and the sweep keeps retrying it. This replaces today's purge, which logs a failed
  snapshot-object delete and drops it
  (`apps/sync-server/src/services/document-body-purge.ts:190-206`).
- **A purge that fails.** The purge runs after the push that deleted the
  document commits, and its failure never fails the push (chapter 07 §7.15).
  The 900 s bound runs from the purge's commit, so it does not cover a purge
  that failed. The 6-hourly cleanup (`cleanupDeletedDocumentBodies`,
  `apps/sync-server/src/services/cleanup.ts`) runs the purge again, and the
  bound runs from that commit. Until then the document's packs stay listed,
  and the rules below keep their entries inert.
- **Purged-tombstone markers.** Before the chapter 05 §5.12.3 shed turns a
  tombstone into a marker, the same steps take every record pack holding that
  `(type, id)` out of the listing, and the shed waits at least
  `PACK_REPLACED_GRACE_SECONDS` after that removal. A URL signed while such a
  pack was listed expires within 300 s (§8.12), so no reader downloads it
  after the shed. A reader that downloaded it before the shed meets the
  tombstone through a pack or the feed (§8.10), and the manifest reconcile
  (§8.10) drops the live entry in any case. The rewrite drops every entry of
  that `(type, id)`, because a marker has no payload to pack.

**Why a lingering entry is harmless.** A reader can still hold bytes of a pack
it listed or downloaded before the purge. Each kind has the rule that makes
those entries inert:

- `record`: the tombstone is at a higher cursor and wins on clock (chapter 05
  §5.8); a re-create seeds its clock from the tombstone, so it dominates the
  old entry too. A live entry of an item whose tombstone was shed is dropped
  by the manifest reconcile (§8.10).
- `crdt_snapshot`: applied only after its `revision` matches `snapshotMeta`,
  or the body manifest's `snapshot.revision` (§8.4.3), read after the pack
  (§8.10); a deleted incarnation's revision never does.
- `crdt_update`: applied only above a `floor` read after the pack (§8.4.3).

A reader that applied a body and then meets the document's tombstone deletes
the body (chapter 07 §7.15).

## 8.14 Sizing

**Normative, steps 04 to 06 MUST** (#5227, #5228, #5229). One pack holds at most
`PACK_MAX_ENTRIES` = 4096 entries (`packages/contracts/src/pack-format.ts:90`)
and at most `PACK_TARGET_BYTES` = 24 MiB of payload
(`apps/sync-server/src/services/pack-sizing.ts:15`), whichever comes
first; every entry stays under `PACK_MAX_INDEX_ENTRY_BYTES`
(`packages/contracts/src/pack-format.ts:88`). A build from source blobs is
also capped at 256 items by its subrequest budget
(`apps/sync-server/src/services/pack-compaction.ts:109`); a rollup is not
(§8.12).

**A vault lists at most `PACK_LIST_MAX_PACKS_PER_VAULT` = 999 packs of all
kinds** (`packages/contracts/src/sync-api.ts:796-800`), below the 1,000 a
released reader walks (§8.11). A writer rolls up before a new row would pass
it; when a rollup cannot make room, the writer stops, and the rest of the vault
stays on the tail. The server checks the cap before a build and again in the
D1 batch that inserts the `pack_index` row: the insert commits only while the
vault listed fewer than 999 packs before it, and the watermark moves only
when that row exists. The build deletes its object only when its own row,
looked up by its id, is absent after the batch, so a listed row always has
its object (`roomGuard`, `apps/sync-server/src/services/pack-list.ts:41-61`).
The cron backfill skips a vault at the cap for builds (`findBacklogVaults`,
`apps/sync-server/src/services/pack-backfill.ts`) and rolls it up first, so
a capped vault drains without a push.

**Every kind waits for a minimum fill.** A build cuts a pack only once the
kind holds 256 unpacked rows, its rows reach `PACK_TARGET_BYTES`, or its oldest
unpacked row is 24 h old (`PACK_MIN_FILL_ROWS`, `PACK_SETTLE_SECONDS`,
`apps/sync-server/src/services/pack-sizing.ts:24-37`); younger rows stay on
the tail. A push nudge builds no `crdt_update` pack; only the cron backfill
does. Without the fill every push listed one tiny pack and an active vault
passed the cap in days.

**The pack bound.** A server keeps each kind at most
`2 * (ceil(entries / 4096) + ceil(bytes / PACK_TARGET_BYTES)) + 2` listed
packs, where `entries` and `bytes` are what that kind's listed packs hold
(`packCountBound`, `apps/sync-server/src/services/pack-sizing.ts:52`). Above
it, a rollup merges the longest run of adjacent packs that fit one pack. Above
the bound such a run exists, because if every adjacent pair passed a limit,
`floor(n / 2)` disjoint pairs would hold more than the kind does. The `+ 2`
covers the one boundary between cache-only and covered packs. The 28 MB vault
of #5221 is bound at about 10 packs per kind. A compaction message rolls up
again after a build that listed a pack, so it ends with that kind at or under
the bound (`compactVault`, `apps/sync-server/src/services/pack-compaction.ts:690`).
A cron tick builds after its rollups and has no budget for another, so a kind
it built for may list `bound + 1` until the next tick or message rolls it up.

**Unreadable packs.** A listed pack whose object cannot be read or verified
cannot be merged (§8.12), and each one can split a run of mergeable packs in
two, so a kind lists at most the bound, plus twice the number of its listed
packs that cannot be read or verified, plus the transient `+ 1` above. Each
such pack stays listed. Dropping its row would end a record
coverage range there (§8.10). A reader treats it as absent and takes its range
item by item, which loses no data. Each rollup that meets it logs it at error
level with the pack id and kind
(`apps/sync-server/src/services/pack-rollup.ts:262-266`), and the backfill tick
rolls the kind up every tick while it is above the bound, so an operator sees
it once per tick. Within the bound no rollup reads it; detecting it there is
#5272.
