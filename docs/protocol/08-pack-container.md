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
kind, the one its listing row names (`apps/sync-server/src/services/pack-selection.ts:113`
selects one kind per pack). A reader still checks each entry's own `kind`.

Snapshot entries carry `{sequenceNum, revision}` in `metaBytes`, which is the
**freshness token a client compares against `snapshotMeta`, or against the body
manifest's `snapshot.revision` (§8.4.3), before trusting the bytes** (`packages/contracts/src/pack-format.ts:37-40`; chapter 07 §7.8).

### 8.4.1 Will a reader ever see kind 2 — Q08.1

**Normative: a server from step 05 (#5228) on produces `crdt_update = 2`.**
The writer packs the kinds `PACKED_KINDS` names
(`apps/sync-server/src/services/pack-compaction.ts:100`): `crdt_snapshot`,
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
(`pullItemFromColumns`, `apps/sync-server/src/services/sync.ts:433-441`):
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
  (`apps/sync-server/src/services/crdt-snapshot-write.ts:277-285`, `:389`), with
  a claim its covered watermark, the highest update the claim covers
  (`:163-171`, `:352-357`, `:387-388`). A claimed watermark starts at the
  existing snapshot row or 0 and never reads the floor (`:329`, `:357`), so
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
  routes of chapter 07 §7.2. A page answered `429` is asked again, keeping
  the pages already read, as chapter 07 §7.10 states per client (#5349). A read that stops short (any page failing, a
  malformed page) answers nothing: the reader reads `floor` from
  `POST /sync/crdt/updates/batch` for every document it holds packed bodies
  of. **A server without the route** (every server before #5232) answers it
  404, and the reader falls back the same way (fail closed, §8.11).
- **Purge dependency.** Whenever the §7.15 purge removes a document that has
  any body row (a `crdt_updates` or a `crdt_snapshots` row), it MUST take
  every `crdt_update` pack that holds that document out of the listing and
  rewrite it without the document, as §8.13 states, with the same commit-time
  recheck §7.15 gives snapshot compaction. A server from step 06b (#5229)
  finds those packs through `pack_index.documents` (migration 0024, §8.13).
  While the vault still lists a `crdt_update` pack written before migration
  0024, whose `documents` is NULL, the server cannot tell which packs hold the
  document, so the same batch drops every `crdt_update` pack of the vault and
  resets that kind's pack watermark (`packKindReset`,
  `apps/sync-server/src/services/pack-replaced-objects.ts:32`, called at
  `apps/sync-server/src/services/document-body-purge.ts:155-158`); without the
  reset, compaction never packs the other documents of a dropped pack again.
  Keying that drop on update rows alone is not enough: a snapshot that claims
  the packed updates prunes their rows (#2299), and the packs still hold them
  (`apps/sync-server/src/services/document-body-purge.ts:100-104`). The purge
  does this in the D1 batch that deletes the body rows, so the removal and the
  delete commit together
  (`apps/sync-server/src/services/document-body-purge.ts:95-185`). A
  compaction run that selected the rows before the purge fails its
  commit-time recheck (`updatesCurrent`,
  `apps/sync-server/src/services/pack-update-selection.ts`). The drop shipped
  with the first kind 2 writer (step 05, #5228); step 06b scoped it. The floor
  covers a reader that holds a pack from before the purge; the removal keeps
  later listings clean.
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
period of §8.12, or at once when it may hold a purged body (§8.12, §8.13). Stale entries therefore stay as dead bytes for the life of
the object, not forever. A client MUST NOT expect a pack it has read to
change, MUST NOT expect a listed pack to stay listed or downloadable, and MUST
NOT treat a pack as authoritative: individual blobs remain the source of truth
throughout (`packages/contracts/src/sync-api.ts:739-744`).

## 8.9 Listing

**Normative.** `GET /sync/packs` returns `PackListResponseSchema`
(`packages/contracts/src/sync-api.ts:815-830`), whose `packs` are
`PackSummarySchema` (`:746-767`). The `POST /sync/bootstrap` open response
carries the same first page (chapter 10 §10.4):

| Field                    | Rule                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`, `packKey`          | non-empty strings                                                                                                                                                                                |
| `itemKind`               | one of `record`, `crdt_snapshot`, `crdt_update` (`:726`)                                                                                                                                         |
| `minCursor`, `maxCursor` | `server_cursor` bounds for `record` and `crdt_update`; `created_at` epoch-second bounds for `crdt_snapshot` (`:719-724`)                                                                         |
| `itemCount`              |                                                                                                                                                                                                  |
| `byteSize`               | **the payload region only** — header, index and footer excluded. **NOT a file length: a reader MUST NOT Range-request against it** (`:753-758`). Sizes the pack GET's deadline (chapter 00 §0.6) |
| `createdAt`              |                                                                                                                                                                                                  |
| `url`                    | a presigned GET, present **only** when the deployment opted into presigned transfers; **absent means "use the item-granular endpoints"** (`:735-737`)                                            |
| `expiresAt`              | epoch seconds at which `url` stops working (`:761-762`)                                                                                                                                          |
| `coverFrom`              | exclusive lower bound of the pack's coverage range, a `server_cursor`, for every kind (`:763-764`); §8.10                                                                                        |
| `coverThrough`           | inclusive upper bound of that range (`:765-766`). Both are absent on a cache-only pack (§8.10)                                                                                                   |

`nextCursor` is an opaque keyset token, absent on the final page, and **packs
arrive newest-first** (`packages/contracts/src/sync-api.ts:824-829`). A client
MUST treat it as opaque. The first page also carries `coverage`, one
`PackCoverageSchema` per covered kind (`packages/contracts/src/sync-api.ts:775-784`,
`:818-823`), read in the same D1 batch as the page
(`apps/sync-server/src/services/pack-list.ts`, `listPacks`), §8.10. A reader
parses `coverage` entry by entry and skips an entry it cannot parse, such as
one of a kind added after it shipped, which leaves that kind uncovered
(`PackCoverageListSchema`, `:786-797`).

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
(`apps/sync-server/src/services/sync.ts:1590-1611`) and `getSnapshot`
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
(`cover_from`, `cover_through`, migration 0023). Its builds and rollups pack
the body rows of a deleted document while those rows exist, and the purge
takes the body packs that hold them out of the listing and rewrites them
(§8.13).

**What a server from step 07 (#5230) states.** It lists `coverFrom` and
`coverThrough` on every pack that has a range, and the first page carries one
`coverage` entry for `record` when the kind's watermark has a coverage anchor,
with `packedThrough` and `coveredThrough` both equal to that anchor, the
`coverThrough` of the newest committed record pack
(`apps/sync-server/src/services/pack-list.ts`, `COVERED_KINDS` and
`coverageStatement`). It states no `coverage` for `crdt_snapshot` or
`crdt_update`: its body packs carry no range, because snapshot builds still
select on `created_at`, and a body reader trusts the body manifest, not pack
coverage. Leaving a kind out is always a true statement. A `record` watermark
written before migration 0023 has a NULL `covered_through`, so the packs built
from it are caches only and the kind states nothing. The next record build
re-anchors such a chain: in one batch, guarded on the watermark it read, it
takes the kind's packs out of the listing, records their objects for deletion
after the grace period of §8.12, and restarts the watermark at 0 with an
anchor of 0, so the rebuild tiles from 0
(`apps/sync-server/src/services/pack-replaced-objects.ts`,
`recordChainReanchor`).

**Rollback switch (#5392).** A server MAY state empty coverage and list no
packs for a vault; a reader then takes it item by item (§8.0), which is always
correct. The Worker variable `PACK_COVERAGE_DISABLED`, `*` for every vault or
a comma-separated list of vault ids, does this for each vault it names: the
listing answers `packs: []`, no `nextCursor`, and on the first page
`coverage: []`, without reading D1
(`apps/sync-server/src/services/pack-list.ts:89-93`, `:122-126`), on both
`GET /sync/packs` and `POST /sync/bootstrap`
(`apps/sync-server/src/routes/sync.ts:722`,
`apps/sync-server/src/routes/bootstrap.ts:154`), and a bootstrap claims and
starts no backfill chain (`apps/sync-server/src/services/pack-coverage.ts:211`,
`:223`). It writes nothing: pack rows, watermarks, `covered_through` and R2
objects stay as they are, and compaction keeps running on its own triggers, so
removing the variable serves the listing compaction holds by then, with no
rebuild and no re-anchor. Nulling `covered_through` by hand is not a rollback:
the next bootstrap reads the kind as `unanchored` and the next record build
re-anchors it and retires its packs (above). Unset, or a list that does not
name the vault, leaves the listing byte for byte as before.

- **It does not stop compaction.** Packs keep being built for a listed vault.
  Stopping the packer is a separate change: remove the `PACK_QUEUE` and
  `PACK_BACKFILL_QUEUE` producer bindings, in each `[env.*]` section of
  `wrangler.toml` (`apps/sync-server/wrangler.toml:124`, `:135`, `:184`,
  `:195`), and deploy, and the push nudge and the cron backfill enqueue
  nothing (`apps/sync-server/src/services/pack-queue.ts:49`,
  `apps/sync-server/src/services/pack-backfill.ts:219-221`). The consumers
  stay bound, so messages already queued still run. Removing `PACK_QUEUE`
  also drops the delayed purge retry of §8.13, which rides it
  (`apps/sync-server/src/routes/sync.ts:589`,
  `apps/sync-server/src/services/cleanup.ts:371`): a purge that needs more
  than four rewrites, or whose R2 delete fails, leaves its purged bodies in
  R2 until the deletion pass of the next 6-hourly backfill tick
  (`apps/sync-server/src/services/pack-backfill.ts:187`), not within the
  900 s bound. When stopping the cron backfill and bootstrap chains is
  enough, remove only `PACK_BACKFILL_QUEUE`, which keeps the push nudge and
  the purge retry.
- **It takes effect on the next listing.** A run that already holds a page
  keeps its presigned URLs, which expire 300 s after the listing
  (`apps/sync-server/src/services/pack-list.ts:173`,
  `apps/sync-server/src/services/r2-presign.ts:27`), so it may fetch packs
  for up to about 300 s more.
- **Vault ids match exactly.** Each entry is trimmed and compared
  case-sensitively to the vault id (`pack-list.ts:90-93`), with no scoping to
  a user. `default` is the vault id of every account a legacy client synced
  (`apps/sync-server/src/middleware/paid-sync.ts:18`), so naming it disables
  packs for all of them.
- **No code deploy.** It is a Worker secret, so it survives a deploy, and
  nothing in `wrangler.toml` sets it. `wrangler secret put` and
  `wrangler secret delete` each deploy a new version of the current Worker
  code, which is how the change takes effect:

```sh
# staging, one drill vault (or '*' for every vault)
printf '%s' '<vault-id>' | pnpm --filter @memry/sync-server exec wrangler secret put PACK_COVERAGE_DISABLED --env staging
pnpm --filter @memry/sync-server exec wrangler secret delete PACK_COVERAGE_DISABLED --env staging

# production
printf '%s' '*' | pnpm --filter @memry/sync-server exec wrangler secret put PACK_COVERAGE_DISABLED --env production
pnpm --filter @memry/sync-server exec wrangler secret delete PACK_COVERAGE_DISABLED --env production
```

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
  `apps/sync-server/src/services/pack-index-write.ts:90`), and two snapshot
  packs whose first entries share a `created_at` second share `min_cursor`. A
  watermark that moved past a pack that was never listed would leave its rows
  in no pack and in no gap a reader can see. The batch's watermark and
  coverage statements are guarded on the new row's id existing, so no schema
  changes. The insert is guarded too on the watermark and `covered_through`
  still being the ones the build selected under (`watermarkUnchanged`,
  `apps/sync-server/src/services/pack-index-write.ts:186`): of two builds that
  selected one window, only the first to commit lists, and the other deletes
  its own object. A writer that finds its insert would conflict rolls the listed pack
  and its new rows into one pack instead (§8.12), taking only the new rows that
  fit beside the listed pack's current entries
  (`apps/sync-server/src/services/pack-compaction.ts:205-258`). When none fit or
  the listed pack cannot be read, a `record` or `crdt_update` writer lists
  nothing and the watermark holds, logged at error level; those kinds sort on
  the unique `server_cursor`, so only a foreign row collides. A `crdt_snapshot`
  pack is a cache only and a body reader trusts the manifest, not its
  coverage, so a snapshot writer instead lists the rest of that `created_at`
  second in a pack of its own whose `minCursor` is the highest value below the
  second that no listed snapshot pack starts at, logged at warning level
  (`apps/sync-server/src/services/pack-snapshot-selection.ts`, `snapshotSlot`).
  No reader reads a snapshot pack's `minCursor`. A writer also packs snapshot
  rows at or below the watermark that no listed pack's `documents` holds,
  without moving the watermark, never while a `crdt_snapshot` purge rewrite is
  pending (§8.13), and only while the watermark is the one it read
  (`apps/sync-server/src/services/pack-snapshot-heal.ts`). A pending rewrite's
  `minCursor` counts as taken. A rollup never plans
  a run that another listed pack starts inside (#5229, #5310, D-TIE-REMAINDER).
- **Unlisted objects.** The batch that tries to list a pack records its object
  in `pack_replaced_objects`, due at once, when its row is absent after the
  batch (`apps/sync-server/src/services/pack-replaced-objects.ts`,
  `recordUnlisted`). This covers a build or rollup that lost the watermark or
  the index swap. The writer then deletes the object, and a failed delete is
  retried by the deletion pass of §8.12, not left for the orphan sweep. When
  the batch itself throws, the writer records the object the same way, best
  effort, and rethrows without deleting it (`listingBatch`): a batch can
  commit and lose its response, and that commit can land after any read the
  writer makes. The deletion pass deletes the object later, and only while no
  row lists its key. The object was never listed, so no reader holds a URL to
  it and it waits for no grace period.
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
(`apps/sync-server/src/services/pack-selection.ts:118`); a snapshot written
in the watermark's second with a smaller `note_id`, including every rewrite,
which moves `created_at` (`apps/sync-server/src/services/crdt-snapshot-write.ts:153`),
sorted below it and stayed item-granular forever. `server_cursor` is strictly
increasing and moves on every rewrite (`:153`), so no committed row can sort
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
     holds at a cursor other than the item's `serverCursor`, or that carries no
     `serverCursor`, is pulled by id
     through `POST /sync/pull`, at most 100 ids per request
     (`packages/contracts/src/sync-api.ts:514`). The cursor it holds is the
     entry's `sortKey` for a row taken from a pack (§8.4.2), or the
     `serverCursor` of the feed ref it pulled against (chapter 05 §5.11.1),
     that is, the cursor of the write it applied; a row held with no known
     cursor matches none, and an item that came back in `blobMissing` gave it
     no write, so it holds none for that item. A pulled item whose payload
     is lost comes back in `blobMissing` (chapter 05 §5.12.4), and the reader
     then knows its held row is not current.
  2. A live record the reader took from a pack and the manifest does not list,
     and that the device did not modify locally since, is pulled by id
     through `POST /sync/pull`, declaring `purged_tombstones` (chapter 05
     §5.12.3). The manifest lists every live row of the declared types
     (`deleted_at IS NULL`, `apps/sync-server/src/services/sync.ts:1232`), so
     absence suggests a delete, but the server is untrusted and absence is no
     evidence (chapter 05 §5.12.1). The row is removed only by what the pull
     returns: a delete that verifies under chapter 05 §5.14, or a marker whose
     delete attestation verifies (chapter 04 §4.8.4) and whose `serverCursor`
     is past the row's held cursor. A row the pull answers with nothing, with
     a refused item, or with a body that is not a pull envelope stays live and
     is logged with the record cursor. An honest server reaches this state when
     an item was deleted after its pack was built and its tombstone was shed
     before the reader pulled; the attested marker converges it. A removal is
     local: an applied tombstone queues no push.
  3. A packed tombstone applies as the pull item would (§8.4.2). The manifest
     omits tombstones, and the tombstone's clock is what lets a later
     re-create pass delete-wins (chapter 05 §5.8).

  Every live record row is in the manifest at its current `server_cursor`
  (`apps/sync-server/src/services/sync.ts:1230-1232`). Each accepted write
  gives the row a cursor no earlier write of that user had
  (`apps/sync-server/src/services/cursor.ts:1-13`, set at
  `apps/sync-server/src/services/sync.ts:910`), so a held live row whose
  cursor equals the manifest's is the current write, byte for byte. One write
  per cursor holds for live rows only: the shed empties a tombstone in place
  at its cursor (chapter 05 §5.12.3), and the manifest omits tombstones. Any live row the
  writer omitted, whatever the reason, is absent from what the reader holds or
  sits at another cursor, and rule 1 pulls it. A stale packed entry is caught
  the same way, whether or not its newer write could be packed, and even when
  two writes share a `version`.

  **A manifest without `serverCursor`.** Every server before step 04 (#5227)
  omits it (`RecordSyncManifestItemSchema`,
  `packages/contracts/src/sync-api.ts:543-545`). The check is per item, so a
  manifest that mixes items with and without it during a rollout is read item
  by item. A reader facing a manifest without it does not trust record packs: it may apply them only as a seed, and it pulls every manifest
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
  it (`apps/sync-server/src/services/pack-rollup.ts:348`, logged at `:341-345`); it stays listed. A
  rollup downloads at most 64 packs, so once a new plan needs more it plans only
  among packs already read (`:325-327`). A run never spans an excluded pack, so
  the bound of §8.14 counts each unreadable pack. Its coverage
  range is the union of theirs, `(first.coverFrom, last.coverThrough]`, so
  §8.10 holds before and after. Record ranges tile, so record inputs always
  chain. Body inputs separated by a gap chain only when the gap no longer
  holds a needed row (§8.10, **Bridging a body gap**). A rollup reads packs, not source blobs, so
  the 256-item build cap (`apps/sync-server/src/services/pack-selection.ts:39`)
  does not bind it; §8.14 does.
- **Replace, not modify.** The new pack is a new object under a key no pack
  object of the vault has used (§8.8). One D1 batch deletes the old
  `pack_index` rows, inserts the new row and records each old object for
  deletion. The old rows are deleted first in that batch: rows are unique on
  `(user_id, vault_id, item_kind, min_cursor)` and a conflicting insert does
  nothing (`apps/sync-server/src/services/pack-index-write.ts:90`), so the
  listing never holds an old pack and its replacement at once. The batch
  inserts the new row only if every input pack's listing row still exists,
  so a purge or a kind reset (§8.13) that removed an input after the rollup read it
  wins, and the rollup's object is recorded and deleted unlisted (§8.10,
  **Unlisted objects**). The new pack also drops
  every record entry whose row is now a marker. The batch carries the
  commit-time recheck of chapter 07 §7.15 for every document it holds.
- **Grace period.** An object whose row was removed is deleted no earlier than
  `PACK_REPLACED_GRACE_SECONDS` = 600 after the removal
  (`packages/contracts/src/sync-api.ts:786-791`), twice the presigned URL
  lifetime of 300 s (`apps/sync-server/src/services/r2-presign.ts:27`). A URL
  is signed only at listing time, from a listed row, so every URL that names
  the object expires before the object goes. A server MUST NOT raise the
  presign lifetime above half the grace period. The deletion pass
  (`deleteReplacedPackObjects`,
  `apps/sync-server/src/services/pack-replaced-objects.ts:124`) deletes the
  objects of replaced packs and of purged ones (§8.13). It runs for every vault
  at the start of every backfill tick
  (`apps/sync-server/src/services/pack-backfill.ts:187`), and for one vault at
  the start and the end of every compaction message and every backfill
  message, so a build that fails cannot block it. Both messages run their work
  through `withReplacedObjectPasses`
  (`apps/sync-server/src/services/pack-message-passes.ts:39-103`; compaction:
  `apps/sync-server/src/services/pack-compaction.ts:576`; backfill:
  `apps/sync-server/src/services/pack-backfill.ts:285`), which runs the purge
  rewrite pass of §8.13 first, then the deletion pass, the work, and the
  deletion pass again (`pack-message-passes.ts:50`, `:54`, `:57`, `:64`).
  A body purge (chapter 07 §7.15) skips the grace for objects that may hold
  the purged body: in the batch that deletes the body rows it makes due at once
  every replaced object of each body kind the document has rows of, except an
  object waiting for its purge rewrite (§8.13), and deletes them before it
  returns (`apps/sync-server/src/services/document-body-purge.ts:145-154`). A
  reader that listed one of them meets a 404 (below). A failed delete stays
  due. A message whose last pass leaves objects due fails, so the queue
  redelivers it; builds it committed stay committed.
- **A 404 between listing and download.** A reader treats a pack that answers
  404, 403 or any other failure as unusable: its range is a gap (§8.10), its
  items stay on the item routes and the feed. It MAY list again once to find
  the replacement, and MUST NOT retry the old URL beyond its transport retry
  or fail the sync.
- **A network drop during the download.** A failure the network may cure is
  not a gap yet: offline, a failed connection, an idle timeout, a 500, 502,
  503 or 504, a 429 (the pause lasts at least its `Retry-After`), or a 403 on
  a URL that expired while the transport retried. The Rust core pauses the
  phase on one and downloads the lost packs again after each of four
  doubling pauses from 30 s, re-listing at most once per pause for a URL that
  expired meanwhile. A re-list that fails the same curable way keeps its
  pack lost for the next pause. A URL's expiry is judged by the later of the
  wall clock and the phase's monotonic clock. A pack still failing after the
  fourth pause is a gap
  (`crates/memry-core/src/sync/pack_bootstrap/download.rs:120-170`, `:172-279`,
  #5374). A pack the re-list no longer names stays a gap, and so does one whose
  re-list fails any other way, such as a 401, 404 or 400. Desktop pauses the
  same way: one phase-wide pause, a pack lost after the fourth a gap while the
  rest of the queue still downloads, and only a curable re-list failure
  keeping its pack lost; it reads a fresh access token for each re-list and
  for the body manifest read after the pauses
  (`apps/desktop/src/main/sync/packs/pack-downloads.ts:13`, `:27-35`,
  `:68-120`; `pack-bootstrap.ts:176-184`, `:382-412`, `:474-479`, #5389).

## 8.13 Scoped purge

**Normative, step 06 MUST** (#5229). A server from step 06b (#5229, migration 0024) scopes the purge for the body kinds. When the chapter 07 §7.15 purge
removes a document's body, it touches only the `crdt_snapshot` and
`crdt_update` packs that hold the document, and the document's body
ciphertext MUST leave every pack object within `PACK_PURGE_DEADLINE_SECONDS`
= 900 of the purge's commit (`packages/contracts/src/sync-api.ts:793-794`).
**The 900 s bound** below states what holds the deadline and when it can
fail. `record` packs are not scoped yet (**Not implemented yet**, below).

- **Finding them.** The statement that inserts a body pack row records the
  distinct document ids of its entries as a JSON array in
  `pack_index.documents` (`packDocuments`,
  `apps/sync-server/src/services/pack-index-write.ts:57`). Builds, rollups and
  purge rewrites all record it. `record` packs carry NULL. The purge finds a
  document's packs with `json_each` over that column
  (`apps/sync-server/src/services/document-body-purge.ts:35-36`).
- **Packs written before migration 0024.** Their `documents` is NULL, so the
  server cannot tell which documents they hold. While the vault lists such a
  pack of a body kind and the document has rows of that kind (for
  `crdt_update`, any body row, §8.4.3), the purge batch drops every pack of
  that kind in the vault, makes their objects due at once and resets the
  kind's watermark, as every purge did before step 06b (`packKindReset`,
  `apps/sync-server/src/services/pack-replaced-objects.ts:32`). The rebuild
  records `documents`, so the next purge of that kind is scoped.
- **Out of the listing at once.** The purge batch that deletes the body rows
  also deletes the listing row of each pack whose `documents` names the
  document. It records the pack's object in `pack_replaced_objects` as a
  pending rewrite: `replaced_by = 'rewrite'`, `removed_at` the purge time
  (`apps/sync-server/src/services/document-body-purge.ts:159-174`). Other
  packs keep their rows and objects. Every statement rechecks that the
  document is dead, so a re-create that commits first keeps its packs.
- **Rewrite.** Each pending object is rewritten as a rollup of one pack
  (§8.12): the same kind, `minCursor` and `maxCursor`, a new key, and every
  entry whose row is still current. The purged document has no rows left, so
  none of its entries is kept (`rewritePurgedPacks`,
  `apps/sync-server/src/services/pack-purge-rewrite.ts:185`). The commit is
  guarded on the rewrite still pending, on every kept entry still current
  (the recheck of chapter 07 §7.15) and on the listing cap (§8.14). The same
  batch makes the old object due at once. A pack left with no current entry
  gets no new pack, and its old object is made due. Body packs carry no
  coverage range yet (§8.10), so until the rewrite commits a reader takes the
  pack's other documents item by item: speed, not data.
- **A rewrite that fails resets the kind.** A rewrite that cannot read or
  verify the old object, or that loses its commit twice to a concurrent
  prune, purge or listing, resets the kind of the vault instead
  (`packKindReset`): every pack of the kind leaves the listing, every object
  of the kind is due at once, and compaction rebuilds the kind from source
  rows. The reset sets the kind's watermark to 0 rather than deleting it, so
  a build in flight under the old watermark loses its compare-and-swap and
  deletes its own object instead of listing above the reset range. No pack's
  other documents stay unpacked. A rollup never merges across the range of a
  pending rewrite, which would list two packs over it. It reads the pending
  rewrites before the listing and plans around them (`planRollup`,
  `apps/sync-server/src/services/pack-rollup.ts:89`), and its swap batch
  inserts nothing when either of two guards fails (`swapListing`,
  `apps/sync-server/src/services/pack-rollup.ts:550-567`). The pending-set
  guard fails when a rewrite the plan did not exclude is pending. The
  listing-overlap guard fails when another listed pack of the kind starts
  inside the run's range; for `crdt_snapshot` the range's last second is open,
  because a `created_at` tie may split across two packs. A purge that takes
  a pack out of the listing after the rollup read the pending rewrites, but
  before it read the listing, has one of three outcomes. Its rewrite is still
  pending, or it listed the rewritten pack, and one guard fails the swap. Or
  its rewrite committed and listed nothing, because no entry of the pack
  stayed current: the rewrite lists a row only when `kept.length > 0` and
  otherwise only settles the pending row
  (`apps/sync-server/src/services/pack-purge-rewrite.ts:110`, `:145`, `:152`).
  No guard fails then, and the swap may commit, which is harmless because the
  run's range holds only current entries. A purge after the listing read that
  takes out an input of the run makes `replacePacks` record nothing: it
  records the inputs only while every one is still listed
  (`apps/sync-server/src/services/pack-rollup.ts:502`). When a guard fails
  or `replacePacks` records nothing, the rollup's object is deleted unlisted
  (§8.10, **Unlisted objects**).
- **When rewrites run.** After its batch commits, the purge runs up to
  `PURGE_REWRITES_PER_PASS` = 4 rewrites, oldest first, then the deletion pass
  of §8.12 (`apps/sync-server/src/services/document-body-purge.ts:204-205`).
  Every compaction message and every backfill message of the vault runs the
  same rewrite pass before its first deletion pass (`withReplacedObjectPasses`,
  `apps/sync-server/src/services/pack-message-passes.ts:50`, `:54`). When rewrites or
  due objects remain, the purge's caller enqueues a compaction message
  delayed by `PACK_PURGE_RETRY_DELAY_SECONDS` = 660, the grace plus a minute
  (`apps/sync-server/src/services/pack-replaced-objects.ts:18`; push:
  `apps/sync-server/src/routes/sync.ts:589`; cleanup:
  `apps/sync-server/src/services/cleanup.ts:358,371`).
- **A rewrite still pending past its grace.** A deletion pass that finds a
  pending rewrite whose `removed_at` is at least `PACK_REPLACED_GRACE_SECONDS`
  old resets that kind of the vault (`packKindReset`) before it selects the
  due objects, so it deletes that object and every object the reset made due
  in the same pass (`resetUnrewritten`,
  `apps/sync-server/src/services/pack-replaced-objects.ts:185`). A deletion
  never waits for a rewrite past the grace, and the range of a rewrite that
  never ran is rebuilt from source rows instead of staying unpacked.
- **The 900 s bound.** For a purge that commits at `T`:
  1. When the purge needs at most four rewrites and R2 answers, every old
     object is deleted before the purge returns, inside the push request or
     the cleanup tick that ran it.
  2. Otherwise the delayed message runs at `T + 660`. Its rewrite pass runs
     four more rewrites. Its first deletion pass resets the kinds of every
     rewrite still pending past its grace (`removed_at = T`), then deletes
     those objects and every object the reset made due; its last deletion
     pass retries any delete that failed
     (`apps/sync-server/src/services/pack-message-passes.ts:50`, `:54`, `:64`).
     A rollup in that message lists no range twice: the pending-set and
     listing-overlap guards fail its swap (`pack-rollup.ts:550-567`).
  3. A compaction message whose last pass leaves objects due or rewrites
     pending throws (`apps/sync-server/src/services/pack-message-passes.ts:90-99`).
     It reads the pending rewrites again before that decision (`:73`), because
     its deletion pass may have reset the kind of a rewrite past its grace, or
     another message may have finished it. Queues redelivers it, up to `max_retries` = 3 times with no retry delay
     (`apps/sync-server/wrangler.toml:63`), inside the remaining 240 s.

  No sweep runs more often than the 6-hourly cron. The bound fails when the
  delayed message is never enqueued (a push enqueues it best effort, after
  its response, and a failed enqueue is logged), or when all four deliveries
  fail (R2 or D1 down for that window). A purge that throws after its batch
  committed still enqueues the delayed message, on push
  (`apps/sync-server/src/services/sync.ts:1029-1032`) and on cleanup
  (`apps/sync-server/src/services/cleanup.ts:371`) alike. A message that still
  leaves objects due logs `replaced pack objects still due after the
  compaction message; redelivered` (or `backfill message`) at error level with
  the vault (`apps/sync-server/src/services/pack-message-passes.ts:91`). The
  fallback is the deletion pass at the start of every backfill tick, which
  covers every vault and resets pending rewrites the same way
  (`apps/sync-server/src/services/pack-backfill.ts:187`), and every later
  compaction or backfill message of the vault.

- **Snapshot source objects.** The purge deletes the document's
  `crdt_snapshots` objects, which are not pack objects, best effort: a failed
  delete is logged and leaves unreachable objects
  (`apps/sync-server/src/services/document-body-purge.ts:209-225`). The 900 s
  bound covers pack objects only.
- **A purge that fails.** The purge runs after the push that deleted the
  document commits, and its failure never fails the push (chapter 07 §7.15).
  The 900 s bound runs from the purge's commit, so it does not cover a purge
  whose batch never committed. The 6-hourly cleanup (`cleanupDeletedDocumentBodies`,
  `apps/sync-server/src/services/cleanup.ts`) runs the purge again, and the
  bound runs from that commit. Until then the document's packs stay listed,
  and the rules below keep their entries inert.
- **Not implemented yet** (step 06 MUSTs, tracked in #5247):
  - **Record entries.** The purge does not touch `record` packs. Entries of
    older versions of the deleted document's record stay in record pack
    objects until a rollup drops them (§8.12). The rule: each record pack
    holding the document is rewritten as above, dropping its record entries
    below the record's current cursor and keeping the entry at that cursor,
    the tombstone. A fresh reader learns the delete and its clock from it,
    and without that clock a re-create is refused with `SYNC_DELETE_WINS`
    (chapter 05 §5.8).
  - **Purged-tombstone markers.** Before the chapter 05 §5.12.3 shed turns a
    tombstone into a marker, the same steps take every record pack holding
    that `(type, id)` out of the listing, and the shed waits at least
    `PACK_REPLACED_GRACE_SECONDS` after that removal. A URL signed while such
    a pack was listed expires within 300 s (§8.12), so no reader downloads it
    after the shed. A reader that downloaded it before the shed meets the
    tombstone through a pack or the feed (§8.10), or the manifest reconcile
    (§8.10) drops the live entry through the marker's attestation. The rewrite drops every entry
    of that `(type, id)`, because a marker has no payload to pack. Today the
    shed empties the row in place, and the manifest reconcile alone keeps
    a packed entry of it inert.

**Why a lingering entry is harmless.** A reader can still hold bytes of a pack
it listed or downloaded before the purge. Each kind has the rule that makes
those entries inert:

- `record`: the tombstone is at a higher cursor and wins on clock (chapter 05
  §5.8); a re-create seeds its clock from the tombstone, so it dominates the
  old entry too. A live entry of an item whose tombstone was shed is dropped
  by the manifest reconcile through the marker's attestation (§8.10); with no
  attestation that verifies, it stays live on that reader.
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
(`apps/sync-server/src/services/pack-selection.ts:39`); a rollup is not
(§8.12).

**A vault lists at most `PACK_LIST_MAX_PACKS_PER_VAULT` = 999 packs of all
kinds** (`packages/contracts/src/sync-api.ts:809-813`), below the 1,000 a
released reader walks (§8.11). A writer rolls up before a new row would pass
it; when a rollup cannot make room, the writer stops, and the rest of the vault
stays on the tail. The server checks the cap before a build and again in the
D1 batch that inserts the `pack_index` row: the insert commits only while the
vault listed fewer than 999 packs before it, and the watermark moves only
when that row exists. The build deletes its object only when its own row,
looked up by its id, is absent after the batch, so a listed row always has
its object (`roomGuard`, `apps/sync-server/src/services/pack-list.ts:37-57`).
The cron backfill enqueues no build for a vault at the cap (`findBacklogVaults`,
`apps/sync-server/src/services/pack-backfill.ts`) but enqueues each of its kinds
above the bound, and a backfill message rolls up before it builds, so a capped
vault drains without a push.

**Every kind waits for a minimum fill.** A build cuts a pack only once the
kind holds 256 unpacked rows, its rows reach `PACK_TARGET_BYTES`, or its oldest
unpacked row is 24 h old (`PACK_MIN_FILL_ROWS`, `PACK_SETTLE_SECONDS`,
`apps/sync-server/src/services/pack-sizing.ts:24-37`); younger rows stay on
the tail. A push nudge builds no `crdt_update` pack; only a backfill message
does. Without the fill every push listed one tiny pack and an active vault
passed the cap in days.

**Backfill rate.** The 6-hourly cron builds nothing itself. It enqueues one
backfill message per vault and kind whose backlog meets the fill or whose
listed packs exceed the bound, at most 25 per source (the kinds above the
bound, and each kind's backlog), so 100 per tick, on a backfill queue of its
own, so a push nudge or a purge's delayed retry never waits behind it
(`runPackBackfill`, `apps/sync-server/src/services/pack-backfill.ts`). Each
message runs in its own invocation, rolls the kind up and builds it within a
budget of 900 subrequests (3 builds or 12 rollups), and enqueues the next
message 10 s later, at most 64 messages per chain. Only a build that cannot
list now ends the chain: below the fill (an empty scan included), at the
listing cap, or held on a range collision. A vault's backlog therefore drains
minutes after a tick, and a chain that stops at its bound resumes on the next
tick from the watermark.

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
the bound (`compactVault`, `apps/sync-server/src/services/pack-compaction.ts:575`).
A backfill message that spends its budget on its last build has none left to
roll up, so a kind may list `bound + 1` until the chain's next message, the
next tick or a compaction message rolls it up.

**Unreadable packs.** A listed pack whose object cannot be read or verified
cannot be merged (§8.12), and each one can split a run of mergeable packs in
two, so a kind lists at most the bound, plus twice the number of its listed
packs that cannot be read or verified, plus the transient `+ 1` above. Each
such pack stays listed. Dropping its row would end a record
coverage range there (§8.10). A reader treats it as absent and takes its range
item by item, which loses no data. Each rollup that meets it logs it at error
level with the pack id and kind
(`apps/sync-server/src/services/pack-rollup.ts:341-345`), and the backfill tick
enqueues the kind every tick while it is above the bound, so an operator sees
it at least once per tick. Within the bound no rollup reads it; detecting it there is
#5272.
