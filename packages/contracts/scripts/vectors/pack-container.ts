/**
 * Class: MPAK pack container (`pack-container.json`), 19 READER-ONLY cases,
 * plus `coverageCases`: where a reader's tail starts (chapter 08 §8.10).
 *
 * The pack WRITER lives server-side and is not in `packages/contracts`
 * (`packages/contracts/src/pack-format.ts:10-14`). `packages/contracts` must
 * not depend on `apps/sync-server`, and making the exception for a script
 * inside the package would put the dependency in the package's own tree and
 * weaken a boundary that exists for a reason.
 *
 * So this generator hand-assembles container bytes and the verifier asserts
 * `parsePack` accepts them and returns the expected entries. That proves the
 * READER, which is the only half a client needs: a client is never a pack
 * writer (chapter 08 §8.1), and the writer stays covered by the server's own
 * tests.
 *
 * The assembler below is not a reimplementation of the writer in the sense the
 * governing rule forbids — there is nothing in this package to reimplement, and
 * what is asserted is the production reader, not the assembler.
 *
 * Determinism: D1. Payload bytes are fixed and digests are SHA-256 of them.
 *
 * Chapter: docs/protocol/08-pack-container.md.
 */
import { createHash } from 'node:crypto'

import { ready } from 'libsodium-wrappers-sumo'
import { z } from 'zod'

import { encryptRecordForPush } from '../../../sync-client/src/push/record-encrypt.ts'
import {
  FIXED,
  deterministicProvider,
  fromHex,
  signerFromSeed
} from '../../test-vectors/deterministic-provider'

import {
  PACK_FOOTER_SIZE,
  PACK_HEADER_SIZE,
  PACK_MAGIC,
  PACK_MAX_ENTRIES,
  PACK_VERSION,
  PackKindCode,
  parsePack
} from '../../src/pack-format'
import { buildCrdtUpdate } from './crdt-update'
import { buildRecordEnvelope } from './record-envelope'
import { meta } from './shared'

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(bytes).digest())
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)

interface EntryInput {
  kind: keyof typeof PackKindCode
  id: string
  sourceKey: string
  sortKey: number
  meta?: Record<string, unknown>
  payload: Uint8Array
}

class Writer {
  private readonly parts: number[] = []
  push(...bytes: number[]): void {
    this.parts.push(...bytes)
  }
  bytes(value: Uint8Array): void {
    for (const b of value) this.parts.push(b)
  }
  u8(value: number): void {
    this.parts.push(value & 0xff)
  }
  u16(value: number): void {
    this.parts.push((value >>> 8) & 0xff, value & 0xff)
  }
  u64(value: number): void {
    const high = Math.floor(value / 2 ** 32)
    const low = value >>> 0
    this.u32(high)
    this.u32(low)
  }
  /**
   * Signed int64, two's complement big-endian, written through BigInt.
   *
   * A negative `sortKey` cannot go through `u64`: 2^64 - 1 is past the integer
   * precision of a double, so the arithmetic silently rounds and the reader
   * decodes 0 instead of -1.
   */
  i64(value: number): void {
    const masked = BigInt.asUintN(64, BigInt(value))
    this.u32(Number(masked >> 32n))
    this.u32(Number(masked & 0xffffffffn))
  }
  u32(value: number): void {
    this.parts.push(
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff
    )
  }
  build(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

interface PackOverrides {
  headerMagic?: string
  headerVersion?: number
  footerMagic?: string
  footerVersion?: number
  corruptPayloadDigest?: boolean
  corruptEntryDigestIndex?: number
  entryCountOverride?: number
}

function assemble(entries: EntryInput[], overrides: PackOverrides = {}): Uint8Array {
  const header = new Writer()
  header.bytes(utf8(overrides.headerMagic ?? PACK_MAGIC))
  header.u8(overrides.headerVersion ?? PACK_VERSION)
  header.u8(0)
  header.u16(0)

  const payload = new Writer()
  const placed: Array<EntryInput & { offset: number }> = []
  let cursor = 0
  for (const entry of entries) {
    payload.bytes(entry.payload)
    placed.push({ ...entry, offset: cursor })
    cursor += entry.payload.length
  }
  const payloadBytes = payload.build()

  const index = new Writer()
  placed.forEach((entry, i) => {
    index.u8(PackKindCode[entry.kind])
    const id = utf8(entry.id)
    index.u16(id.length)
    index.bytes(id)
    const key = utf8(entry.sourceKey)
    index.u16(key.length)
    index.bytes(key)
    index.i64(entry.sortKey)
    const metaJson = entry.meta ? utf8(JSON.stringify(entry.meta)) : new Uint8Array(0)
    index.u16(metaJson.length)
    index.bytes(metaJson)
    index.u64(entry.offset)
    index.u64(entry.payload.length)
    const digest = sha256(entry.payload)
    if (overrides.corruptEntryDigestIndex === i) digest[0] ^= 0xff
    index.bytes(digest)
  })
  const indexBytes = index.build()

  const payloadDigest = sha256(payloadBytes)
  if (overrides.corruptPayloadDigest) payloadDigest[0] ^= 0xff

  const footer = new Writer()
  footer.bytes(payloadDigest)
  footer.u64(overrides.entryCountOverride ?? placed.length)
  footer.u64(PACK_HEADER_SIZE + payloadBytes.length)
  footer.bytes(utf8(overrides.footerMagic ?? PACK_MAGIC))
  footer.u8(overrides.footerVersion ?? PACK_VERSION)

  const headerBytes = header.build()
  const footerBytes = footer.build()
  const out = new Uint8Array(
    headerBytes.length + payloadBytes.length + indexBytes.length + footerBytes.length
  )
  out.set(headerBytes, 0)
  out.set(payloadBytes, headerBytes.length)
  out.set(indexBytes, headerBytes.length + payloadBytes.length)
  out.set(footerBytes, headerBytes.length + payloadBytes.length + indexBytes.length)
  return out
}

const RECORD_BLOB = utf8(
  '{"dataNonce":"AA==","encryptedData":"AA==","encryptedKey":"AA==","keyNonce":"AA=="}'
)
const SNAPSHOT_BLOB = Uint8Array.from({ length: 64 }, (_, i) => (i * 11 + 3) & 0xff)
const UPDATE_BLOB = Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xff)

const oneRecord: EntryInput[] = [
  {
    kind: 'record',
    id: 'note:abc123def456',
    sourceKey: 'u/1/v/1/note/abc123def456',
    sortKey: 42,
    payload: RECORD_BLOB
  }
]

const threeKinds: EntryInput[] = [
  ...oneRecord,
  {
    kind: 'crdt_snapshot',
    id: 'abc123def456',
    sourceKey: 'u/1/v/1/snap/abc123def456',
    sortKey: 1760000000,
    meta: { sequenceNum: 7, revision: '1c2e6f4b-0000-4000-8000-000000000001' },
    payload: SNAPSHOT_BLOB
  },
  {
    kind: 'crdt_update',
    id: 'abc123def456',
    sourceKey: 'u/1/v/1/upd/1',
    sortKey: 1760000001,
    payload: UPDATE_BLOB
  }
]

const RecordEnvelopeCasesSchema = z.object({
  cases: z.array(
    z.object({
      name: z.string(),
      input: z.object({ vaultKeyHex: z.string(), signingSeedHex: z.string() }),
      expected: z.object({
        pushItem: z.object({
          id: z.string(),
          type: z.string(),
          operation: z.string(),
          encryptedKey: z.string(),
          keyNonce: z.string(),
          encryptedData: z.string(),
          dataNonce: z.string(),
          signature: z.string(),
          signerDeviceId: z.string(),
          clock: z.record(z.string(), z.number()).optional(),
          deletedAt: z.number().optional()
        }),
        roundTripUtf8: z.string()
      })
    })
  )
})

const CrdtUpdateCasesSchema = z.object({
  cases: z.array(
    z.object({
      name: z.string(),
      input: z.object({
        noteId: z.string(),
        vaultKeyHex: z.string(),
        signingSeedHex: z.string(),
        updateHex: z.string()
      }),
      expected: z.object({ packedHex: z.string() })
    })
  )
})

type RecordEnvelopeCase = z.infer<typeof RecordEnvelopeCasesSchema>['cases'][number]
type CrdtUpdateCase = z.infer<typeof CrdtUpdateCasesSchema>['cases'][number]

const byName = <T extends { name: string }>(cases: T[], name: string): T => {
  const found = cases.find((c) => c.name === name)
  if (!found) throw new Error(`vector case missing: ${name}`)
  return found
}

/**
 * A record entry built from a signed record-envelope case (chapter 08 §8.4.2).
 *
 * The expected pull item comes from the push item, the way the server's pull
 * answers for that row: the signed fields, `cryptoVersion: 1`, and the four
 * blob fields under `blob`. The verifier rebuilds it from the PACK BYTES, so
 * the two derivations meet only when meta plus payload carry everything the
 * pull item does.
 */
function recordEntryFrom(source: RecordEnvelopeCase, sortKey: number) {
  const push = source.expected.pushItem
  const blob = {
    dataNonce: push.dataNonce,
    encryptedData: push.encryptedData,
    encryptedKey: push.encryptedKey,
    keyNonce: push.keyNonce
  }
  const pullMeta: Record<string, unknown> = {
    operation: push.operation,
    cryptoVersion: 1,
    signature: push.signature,
    signerDeviceId: push.signerDeviceId,
    ...(push.deletedAt === undefined ? {} : { deletedAt: push.deletedAt }),
    ...(push.clock === undefined ? {} : { clock: push.clock })
  }
  // Chapter 08 §8.4.2: meta also carries the row's sync_items.version, which the pull item lacks.
  const entryMeta = { ...pullMeta, version: 1 }
  const entry: EntryInput = {
    kind: 'record',
    id: `${push.type}:${push.id}`,
    sourceKey: `u/1/v/1/${push.type}/${push.id}`,
    sortKey,
    meta: entryMeta,
    // Chapter 05 §5.9 A: the R2 object is the four fields, keys sorted, no whitespace.
    payload: utf8(JSON.stringify(blob, Object.keys(blob).toSorted()))
  }
  const expectation = {
    id: entry.id,
    usable: true,
    sortKey,
    sourceKey: entry.sourceKey,
    pullItem: { id: push.id, type: push.type, ...pullMeta, blob },
    vaultKeyHex: source.input.vaultKeyHex,
    signingSeedHex: source.input.signingSeedHex,
    plaintextUtf8: source.expected.roundTripUtf8
  }
  return { entry, expectation }
}

/**
 * A record whose id holds two colons, signed through the production push path.
 * `record-envelope` has no such item, and the signature covers the id, so a
 * reader that splits `idBytes` at any colon but the first fails to verify it.
 */
async function colonIdRecord(source: RecordEnvelopeCase): Promise<RecordEnvelopeCase> {
  await ready
  const content = 'a folder config whose path holds colons'
  const signer = signerFromSeed(source.input.signingSeedHex)
  const { pushItem } = await encryptRecordForPush(deterministicProvider(), {
    id: 'Projects:2026:Q1',
    type: 'folder_config',
    operation: 'update',
    content: utf8(content),
    vaultKey: fromHex(source.input.vaultKeyHex),
    signingSecretKey: signer.secretKey,
    signerDeviceId: FIXED.DEVICE_A,
    clock: { [FIXED.DEVICE_A]: 1 }
  })
  return {
    name: 'folder_config with colons in its id',
    input: source.input,
    expected: { pushItem, roundTripUtf8: content }
  }
}

function updateEntryFrom(source: CrdtUpdateCase, sequenceNum: number, sortKey: number) {
  const entryMeta = { sequenceNum, signerDeviceId: 'device-a', createdAt: 1760000000 + sequenceNum }
  const entry: EntryInput = {
    kind: 'crdt_update',
    id: source.input.noteId,
    // §8.4.3: an update is a D1 row with no R2 object, so keyBytes is empty.
    sourceKey: '',
    sortKey,
    meta: entryMeta,
    payload: Uint8Array.from(Buffer.from(source.expected.packedHex, 'hex'))
  }
  const expectation = {
    noteId: source.input.noteId,
    usable: true,
    sortKey,
    meta: entryMeta,
    vaultKeyHex: source.input.vaultKeyHex,
    signingSeedHex: source.input.signingSeedHex,
    plaintextHex: source.input.updateHex
  }
  return { entry, expectation }
}

// Plan cases (§8.4.3). Their payloads are never opened, so a fixed blob with
// one varied byte stands in for an envelope; only sequence numbers and
// digests decide the plan.
function planEntry(sequenceNum: number, sortKey: number, variant = 0): EntryInput {
  return {
    kind: 'crdt_update',
    id: 'abc123def456',
    sourceKey: '',
    sortKey,
    meta: { sequenceNum, signerDeviceId: 'device-a', createdAt: 1760000000 + sequenceNum },
    payload: Uint8Array.from(UPDATE_BLOB, (b, i) => (i === 0 ? b ^ sequenceNum ^ variant : b))
  }
}

/**
 * One reader run over a document's packed updates (§8.4.3). `floor` is what
 * the update route answered (null: no `floor` key), `floorReadAfterPack`
 * whether that answer came after the reader held the pack bytes, and
 * `snapshotSequenceNum` the `snapshotMeta.sequenceNum` the reader also saw,
 * which the rule ignores.
 */
function plan(
  scenario: string,
  cursor: number,
  floor: number | null,
  floorReadAfterPack: boolean,
  snapshotSequenceNum: number | null,
  apply: number[]
) {
  const cursorAfter = apply.length > 0 ? apply[apply.length - 1] : cursor
  return { scenario, cursor, floor, floorReadAfterPack, snapshotSequenceNum, apply, cursorAfter }
}

type CoverageKind = 'record' | 'crdt_snapshot' | 'crdt_update'

/**
 * One reader's tail start (chapter 08 §8.10): the packs it holds, which of
 * them it could use, the listing's `coverage` (null: none, every server
 * today), whether it declared `note_body`, and the sortKey of every unusable
 * record entry. `tailFrom` is the highest cursor the rule lets it start at.
 */
function coverage(
  scenario: string,
  noteBody: boolean,
  stated: Array<[CoverageKind, number, number]> | null,
  packs: Array<[CoverageKind, number | null, number | null, boolean]>,
  unusableRecordSortKeys: number[],
  tailFrom: number
) {
  return {
    scenario,
    noteBody,
    coverage:
      stated?.map(([itemKind, packedThrough, coveredThrough]) => ({
        itemKind,
        packedThrough,
        coveredThrough
      })) ?? null,
    packs: packs.map(([itemKind, coverFrom, coverThrough, usable]) => ({
      itemKind,
      ...(coverFrom === null ? {} : { coverFrom }),
      ...(coverThrough === null ? {} : { coverThrough }),
      usable
    })),
    unusableRecordSortKeys,
    tailFrom
  }
}

function coverageCases() {
  return [
    coverage('no coverage (every server today)', false, null, [['record', 0, 100, true]], [], 0),
    coverage(
      'record packs that chain up to packedThrough',
      false,
      [['record', 200, 210]],
      [
        ['record', 100, 200, true],
        ['record', 0, 100, true]
      ],
      [],
      210
    ),
    coverage(
      'a pack in the middle of the chain answered 404',
      false,
      [['record', 300, 300]],
      [
        ['record', 0, 100, true],
        ['record', 100, 200, false],
        ['record', 200, 300, true]
      ],
      [],
      100
    ),
    coverage(
      'a rollup listed both the old packs and the new one',
      false,
      [['record', 200, 250]],
      [
        ['record', 0, 100, true],
        ['record', 100, 200, true],
        ['record', 0, 200, true]
      ],
      [],
      250
    ),
    coverage(
      'the newest pack left the listing during the walk',
      false,
      [['record', 200, 200]],
      [['record', 0, 100, true]],
      [],
      100
    ),
    coverage(
      'an unusable record entry',
      false,
      [['record', 300, 300]],
      [['record', 0, 300, true]],
      [150],
      149
    ),
    coverage(
      'note_body declared and a body kind has no coverage entry',
      true,
      [['record', 100, 100]],
      [['record', 0, 100, true]],
      [],
      0
    ),
    coverage(
      'note_body not declared: body kinds do not bound the tail',
      false,
      [
        ['record', 100, 100],
        ['crdt_snapshot', 0, 0]
      ],
      [['record', 0, 100, true]],
      [],
      100
    ),
    coverage(
      'note_body declared: the lowest kind bounds the tail',
      true,
      [
        ['record', 300, 300],
        ['crdt_snapshot', 250, 280],
        ['crdt_update', 0, 260]
      ],
      [
        ['record', 0, 300, true],
        ['crdt_snapshot', 0, 250, true]
      ],
      [],
      260
    ),
    coverage(
      'a snapshot pack without a coverage range is a cache only',
      true,
      [
        ['record', 100, 100],
        ['crdt_snapshot', 50, 60],
        ['crdt_update', 0, 100]
      ],
      [
        ['record', 0, 100, true],
        ['crdt_snapshot', null, null, true]
      ],
      [],
      0
    )
  ]
}

async function entryContractSpecs() {
  const records = RecordEnvelopeCasesSchema.parse(await buildRecordEnvelope()).cases
  const updates = CrdtUpdateCasesSchema.parse(await buildCrdtUpdate()).cases

  const live = [
    recordEntryFrom(byName(records, 'note create, body over 64 bytes and compressible'), 42),
    recordEntryFrom(byName(records, 'task update with clock'), 43),
    recordEntryFrom(byName(records, 'settings update with no clock'), 44)
  ]
  const tombstone = recordEntryFrom(byName(records, 'note delete with deletedAt'), 45)

  const unusableBase = recordEntryFrom(byName(records, 'journal update'), 46)
  const withoutSignature = Object.fromEntries(
    Object.entries(unusableBase.entry.meta ?? {}).filter(([key]) => key !== 'signature')
  )
  const noMeta: EntryInput = { ...unusableBase.entry, meta: undefined }
  const badMeta: EntryInput = {
    ...recordEntryFrom(byName(records, 'note create with a second data nonce'), 47).entry,
    meta: withoutSignature
  }

  const undeclared: EntryInput = {
    ...recordEntryFrom(byName(records, 'journal update'), 48).entry,
    id: 'whiteboard:board-1'
  }
  const colonId = recordEntryFrom(
    await colonIdRecord(byName(records, 'settings update with no clock')),
    49
  )

  const first = updateEntryFrom(byName(updates, '512-byte update, compressible'), 4, 100)
  const second = updateEntryFrom(byName(updates, '40-byte update'), 5, 103)

  const acrossPurge = [1, 2, 3, 4, 5].map((seq) => planEntry(seq, 200 + seq))

  return [
    {
      name: 'record entries carrying the pull-item meta',
      entries: live.map((r) => r.entry),
      pins: 'chapter 08 §8.4.2: meta plus payload rebuild the /sync/pull item, which verifies and decrypts; an absent optional field (clock) stays absent',
      entryContract: { records: live.map((r) => r.expectation) }
    },
    {
      name: 'a tombstone record entry',
      entries: [tombstone.entry],
      pins: 'chapter 08 §8.4.2: a delete carries operation and deletedAt in meta and its signed payload as bytes',
      entryContract: { records: [tombstone.expectation] }
    },
    {
      name: 'record entries a reader cannot use',
      entries: [noMeta, badMeta],
      pins: 'chapter 08 §8.4.2: no meta (a record pack written before this contract) or meta failing RecordPackEntryMetaSchema makes the ENTRY unusable, not the pack; the GET /sync/changes tail starts at or below its sortKey - 1',
      entryContract: {
        records: [
          { id: noMeta.id, usable: false },
          { id: badMeta.id, usable: false }
        ]
      }
    },
    {
      name: 'a record entry of a type the reader does not declare',
      entries: [undeclared],
      pins: 'chapter 08 §8.4.2: an entry whose type is outside the reader subscription is skipped, as the GET /sync/changes tail would not have served it; unlike an unusable entry it does not bound the tail',
      entryContract: { records: [{ id: undeclared.id, usable: false }] }
    },
    {
      name: 'a record id containing colons',
      entries: [colonId.entry],
      pins: 'chapter 08 §8.4.2: idBytes splits at the FIRST colon; the signature covers the id, so any other split fails to verify',
      entryContract: { records: [colonId.expectation] }
    },
    {
      name: 'crdt_update entries of one document',
      entries: [first.entry, second.entry],
      pins: 'chapter 08 §8.4.3: identity is the document id, sortKey the server_cursor, meta {sequenceNum, signerDeviceId, createdAt}, payload the stored packed envelope',
      entryContract: { updates: [first.expectation, second.expectation] }
    },
    {
      name: 'packed updates of a document purged at sequence 3',
      entries: acrossPurge,
      pins: 'chapter 08 §8.4.3: a pack built before a purge still holds the deleted updates 1..3. A packed update is applied only above the floor read after the pack, at cursor + 1; snapshotMeta never stands in for the floor',
      entryContract: {
        updatePlans: [
          plan('floor read after the pack', 4, 3, true, null, [5]),
          plan('cursor at the floor', 3, 3, true, null, [4, 5]),
          plan('fresh device after the purge', 0, 3, true, null, []),
          plan('answer without floor (every server today)', 0, null, true, null, []),
          plan('claimed snapshot after the purge, no floor', 0, null, true, 0, []),
          plan('claimed snapshot after the purge, with floor', 0, 3, true, 0, []),
          plan('floor read before the purge, then the pack', 0, 0, false, null, []),
          plan('floor above the pack', 0, 7, true, null, [])
        ]
      }
    },
    {
      name: 'packed updates with a sequence gap',
      entries: [planEntry(1, 301), planEntry(2, 302), planEntry(4, 304)],
      pins: 'chapter 08 §8.4.3: the cursor stops at the first missing number and the reader pulls from it',
      entryContract: { updatePlans: [plan('never purged', 0, 0, true, null, [1, 2])] }
    },
    {
      name: 'one update pair carried with two digests',
      entries: [planEntry(5, 405), planEntry(5, 406, 0x80), planEntry(6, 407)],
      pins: 'chapter 08 §8.4.3: two entries for one (document, sequenceNum) with different digests make the document packed updates unusable',
      entryContract: { updatePlans: [plan('never purged', 4, 0, true, null, [])] }
    }
  ]
}

/**
 * The expected block is the READER'S OWN OUTPUT, not a prediction.
 *
 * A generator that wrote down what it believed `parsePack` should return would
 * encode the author's belief; running the reader records the behaviour. It also
 * captures a real limitation honestly: `ByteReader.i64` reconstructs a 64-bit
 * value through doubles, so a negative `sortKey` does not survive
 * (`-1` decodes as `0`). Chapter 08 §8.3 states that; this file pins it.
 */
async function readBack(packBytes: Uint8Array): Promise<unknown> {
  const parsed = await parsePack(packBytes)
  return { version: parsed.version, entries: parsed.entries, integrityVerified: true }
}

export async function buildPackContainer(): Promise<Record<string, unknown>> {
  const utf8Id: EntryInput[] = [
    {
      kind: 'record',
      id: 'folder_config:Notas/Año 2026/Reuniões',
      sourceKey: 'u/1/v/1/fc/1',
      sortKey: 9,
      payload: RECORD_BLOB
    }
  ]
  const emptyMeta: EntryInput[] = [
    {
      kind: 'crdt_snapshot',
      id: 'abc123def456',
      sourceKey: 'u/1/v/1/snap/x',
      sortKey: -1,
      payload: SNAPSHOT_BLOB
    }
  ]

  const specs = [
    {
      name: 'one record entry',
      entries: oneRecord,
      pins: 'the minimal valid pack: header, one index record, footer'
    },
    {
      name: 'three entries, one of each kind',
      entries: threeKinds,
      pins: 'PackKindCode 0, 1, 2 and the two sortKey semantics side by side'
    },
    {
      name: 'a crdt_snapshot entry with freshness meta',
      entries: [threeKinds[1]],
      pins: 'the JSON meta field carrying {sequenceNum, revision} — the token a client compares against snapshotMeta before trusting the bytes'
    },
    {
      name: 'an entry with an empty meta field and a negative sortKey',
      entries: emptyMeta,
      pins: 'metaLen 0 means NO meta key on the decoded entry; sortKey is a signed int64'
    },
    {
      name: 'a multi-byte UTF-8 identity',
      entries: utf8Id,
      pins: 'idLen counts BYTES, not characters'
    }
  ]

  const cases = []
  for (const spec of [...specs, ...(await entryContractSpecs())]) {
    const packBytes = assemble(spec.entries)
    cases.push({
      name: spec.name,
      pins: spec.pins,
      packHex: hex(packBytes),
      expected: await readBack(packBytes),
      ...('entryContract' in spec ? { entryContract: spec.entryContract } : {})
    })
  }

  const errorCases = [
    {
      name: 'header magic corrupted',
      packHex: hex(assemble(oneRecord, { headerMagic: 'MPAX' })),
      expectErrorContains: 'pack header magic mismatch',
      expectErrorCode: 'header-magic-mismatch',
      pins: 'rejected before any hashing'
    },
    {
      name: 'header version set to 2',
      packHex: hex(assemble(oneRecord, { headerVersion: 2 })),
      expectErrorContains: 'unsupported pack version 2',
      expectErrorCode: 'unsupported-version',
      pins: 'a reader rejects any version but its own'
    },
    {
      name: 'footer payload digest corrupted',
      packHex: hex(assemble(oneRecord, { corruptPayloadDigest: true })),
      expectErrorContains: 'pack payload checksum mismatch',
      expectErrorCode: 'payload-checksum-mismatch',
      pins: 'the whole-payload digest'
    },
    {
      name: 'one entry digest corrupted while the payload digest still passes',
      packHex: hex(assemble(threeKinds, { corruptEntryDigestIndex: 1 })),
      expectErrorContains: 'pack entry checksum mismatch: abc123def456',
      expectErrorCode: 'entry-checksum-mismatch',
      pins: 'per-entry verification is NOT skipped when the whole-payload digest passes'
    },
    {
      name: 'entryCount above PACK_MAX_ENTRIES',
      packHex: hex(assemble(oneRecord, { entryCountOverride: PACK_MAX_ENTRIES + 1 })),
      // No expectErrorContains: the reference's message is unreachable for a
      // conforming reader. See referenceOnlyMessage.
      expectErrorCode: 'entry-count-too-large',
      referenceOnlyMessage: 'pack truncated',
      pins: 'parsePack does not itself enforce PACK_MAX_ENTRIES — it runs out of index bytes first and says "pack truncated". A conforming reader applies the cap BEFORE allocating (chapter 08 §8.6) and therefore fails earlier, with entry-count-too-large. Asserting the reference message here would require deleting the check the chapter mandates, so only the code is normative'
    }
  ]

  return {
    meta: meta({
      class: 'pack-container',
      chapter: 'docs/protocol/08-pack-container.md',
      reader: 'packages/contracts/src/pack-format.ts',
      writerNote: 'reader-only by design: the writer is server-side and is not imported here',
      layout: { PACK_MAGIC, PACK_VERSION, PACK_HEADER_SIZE, PACK_FOOTER_SIZE, PACK_MAX_ENTRIES },
      kindCodes: PackKindCode,
      caseCount: cases.length + errorCases.length
    }),
    cases,
    errorCases,
    coverageCases: coverageCases()
  }
}
