/**
 * Class: MPAK pack container (`pack-container.json`), 14 READER-ONLY cases.
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

import { z } from 'zod'

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
  const entryMeta: Record<string, unknown> = {
    operation: push.operation,
    cryptoVersion: 1,
    signature: push.signature,
    signerDeviceId: push.signerDeviceId,
    ...(push.deletedAt === undefined ? {} : { deletedAt: push.deletedAt }),
    ...(push.clock === undefined ? {} : { clock: push.clock })
  }
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
    pullItem: { id: push.id, type: push.type, ...entryMeta, blob },
    vaultKeyHex: source.input.vaultKeyHex,
    signingSeedHex: source.input.signingSeedHex,
    plaintextUtf8: source.expected.roundTripUtf8
  }
  return { entry, expectation }
}

function updateEntryFrom(source: CrdtUpdateCase, sequenceNum: number, sortKey: number) {
  const entryMeta = { sequenceNum, signerDeviceId: 'device-a', createdAt: 1760000000 + sequenceNum }
  const entry: EntryInput = {
    kind: 'crdt_update',
    id: source.input.noteId,
    sourceKey: `u/1/v/1/upd/${source.input.noteId}/${sequenceNum}`,
    sortKey,
    meta: entryMeta,
    payload: Uint8Array.from(Buffer.from(source.expected.packedHex, 'hex'))
  }
  const expectation = {
    noteId: source.input.noteId,
    usable: true,
    meta: entryMeta,
    vaultKeyHex: source.input.vaultKeyHex,
    signingSeedHex: source.input.signingSeedHex,
    plaintextHex: source.input.updateHex
  }
  return { entry, expectation }
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

  const first = updateEntryFrom(byName(updates, '512-byte update, compressible'), 4, 100)
  const second = updateEntryFrom(byName(updates, '40-byte update'), 5, 103)

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
      pins: 'chapter 08 §8.4.2: no meta (a record pack written before this contract) or meta failing RecordPackEntryMetaSchema makes the ENTRY unusable, not the pack; the item stays item-granular',
      entryContract: {
        records: [
          { id: noMeta.id, usable: false },
          { id: badMeta.id, usable: false }
        ]
      }
    },
    {
      name: 'crdt_update entries of one document',
      entries: [first.entry, second.entry],
      pins: 'chapter 08 §8.4.3: identity is the document id, sortKey the server_cursor, meta {sequenceNum, signerDeviceId, createdAt}, payload the stored packed envelope',
      entryContract: { updates: [first.expectation, second.expectation] }
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
    errorCases
  }
}
