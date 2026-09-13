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
| `keyBytes`  | UTF-8                | the source R2 key: provenance plus a per-item fallback                                                            |
| `sortKey`   | int64                | §8.4                                                                                                              |
| `metaLen`   | uint16               | 0 means no metadata                                                                                               |
| `metaBytes` | UTF-8 JSON, or empty | parsed with `JSON.parse`; a malformed value throws and the caller discards the pack (`:260-264`)                  |
| `offset`    | uint64               | **relative to the start of the payload region**, so absolute position is `PACK_HEADER_SIZE + offset` (`:308-312`) |
| `length`    | uint64               |                                                                                                                   |
| `sha256`    | 32 bytes             | digest of **that entry's** payload bytes                                                                          |

The `offset` interpretation is the off-by-eight a reader gets wrong first.

**A negative `sortKey` does not survive the reference reader.** `ByteReader.i64`
reconstructs the 64-bit value through doubles
(`packages/contracts/src/pack-format.ts:189-196`), so `-1` decodes as `0`. Every
`sortKey` a writer emits today is a non-negative `server_cursor` or epoch second
(§8.4), so the loss is unreachable in practice. **Normative: a writer MUST NOT
emit a negative `sortKey`, and a reader MUST NOT be given one.** The behaviour is
pinned by the `pack-container.json` case that carries one, recorded as the reader
actually behaves rather than as it ought to.

## 8.4 Kinds and identity semantics

**Normative.** `PackKindCode` is `record = 0`, `crdt_snapshot = 1`,
`crdt_update = 2` (`packages/contracts/src/pack-format.ts:94-98`).

| Kind            | Identity (`idBytes`) | `sortKey`                       |
| --------------- | -------------------- | ------------------------------- |
| `record`        | `type:id`            | `server_cursor`                 |
| `crdt_snapshot` | the document id      | `created_at`, epoch **seconds** |
| `crdt_update`   | the document id      | `created_at`, epoch seconds     |

(`packages/contracts/src/pack-format.ts:31-36`.)

Snapshot entries carry `{sequenceNum, revision}` in `metaBytes`, which is the
**freshness token a client compares against `snapshotMeta` before trusting the
bytes** (`packages/contracts/src/pack-format.ts:37-40`; chapter 07 §7.8).

### 8.4.1 Will a reader ever see kind 2 — Q08.1

**Normative: `crdt_update = 2` is reserved and no writer produces it.** Updates
live in D1 and have no R2 small-object GET floor to kill
(`packages/contracts/src/sync-api.ts:495-496`).

**A conforming reader MUST accept kind 2 structurally** — `KIND_BY_CODE` maps it
(`packages/contracts/src/pack-format.ts:102-106`) and rejecting it would be a
gratuitous incompatibility with a future writer — **and MAY decline to use the
entry**, falling back to the item-granular endpoints for that document, exactly
as it would for a pack it could not verify (§8.0).

**Disposition of Q08.1: answered** (this section).

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
(`packages/contracts/src/sync-api.ts:516-517`).

## 8.9 Listing

**Normative.** `GET /sync/packs` returns `PackListResponseSchema`
(`packages/contracts/src/sync-api.ts:538-547`), whose `packs` are
`PackSummarySchema` (`:519-536`):

| Field                    | Rule                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `packKey`          | non-empty strings                                                                                                                                     |
| `itemKind`               | one of `record`, `crdt_snapshot`, `crdt_update` (`:498`)                                                                                              |
| `minCursor`, `maxCursor` | `server_cursor` bounds for `record`; `created_at` epoch-second bounds for `crdt_snapshot` (`:492-494`)                                                |
| `itemCount`              |                                                                                                                                                       |
| `byteSize`               | **the payload region only** — header, index and footer excluded. **NOT a file length: a reader MUST NOT Range-request against it** (`:526-530`)       |
| `createdAt`              |                                                                                                                                                       |
| `url`                    | a presigned GET, present **only** when the deployment opted into presigned transfers; **absent means "use the item-granular endpoints"** (`:507-509`) |
| `expiresAt`              | epoch seconds at which `url` stops working (`:534`)                                                                                                   |

`nextCursor` is an opaque keyset token, absent on the final page, and **packs
arrive newest-first** (`packages/contracts/src/sync-api.ts:541-546`). A client
MUST treat it as opaque.

## 8.10 Coverage is not total

**Normative.** Records tile their cursor axis completely. **Snapshot coverage can
under-cover same-second writes**: a document written the same second as an
already-packed tie group with a smaller id sorts below the watermark and stays
item-granular forever. Holes inside a range, from replaced or deleted items, are
dead bytes and also fall back to item GETs
(`packages/contracts/src/sync-api.ts:511-517`).

**Membership MUST be verified against the pack's own index block, never assumed
from the advertised cursor range.**
