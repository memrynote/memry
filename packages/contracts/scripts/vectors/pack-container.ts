/**
 * Class: MPAK pack container (`pack-container.json`), 10 READER-ONLY cases.
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

import {
  PACK_FOOTER_SIZE,
  PACK_HEADER_SIZE,
  PACK_MAGIC,
  PACK_MAX_ENTRIES,
  PACK_VERSION,
  PackKindCode
} from '../../src/pack-format'
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
    // int64 sortKey, two's complement big-endian.
    const negative = entry.sortKey < 0
    const magnitude = negative ? 2 ** 64 + entry.sortKey : entry.sortKey
    index.u64(magnitude)
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

function expectedEntries(entries: EntryInput[]): unknown[] {
  let offset = 0
  return entries.map((entry) => {
    const row: Record<string, unknown> = {
      kind: entry.kind,
      id: entry.id,
      sourceKey: entry.sourceKey,
      sortKey: entry.sortKey,
      offset,
      length: entry.payload.length
    }
    if (entry.meta) row.meta = entry.meta
    offset += entry.payload.length
    return row
  })
}

export function buildPackContainer(): Record<string, unknown> {
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

  const cases = [
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
  ].map((entry) => ({
    name: entry.name,
    pins: entry.pins,
    packHex: hex(assemble(entry.entries)),
    expected: {
      version: PACK_VERSION,
      entries: expectedEntries(entry.entries),
      integrityVerified: true
    }
  }))

  const errorCases = [
    {
      name: 'header magic corrupted',
      packHex: hex(assemble(oneRecord, { headerMagic: 'MPAX' })),
      expectErrorContains: 'pack header magic mismatch',
      pins: 'rejected before any hashing'
    },
    {
      name: 'header version set to 2',
      packHex: hex(assemble(oneRecord, { headerVersion: 2 })),
      expectErrorContains: 'unsupported pack version 2',
      pins: 'a reader rejects any version but its own'
    },
    {
      name: 'footer payload digest corrupted',
      packHex: hex(assemble(oneRecord, { corruptPayloadDigest: true })),
      expectErrorContains: 'pack payload checksum mismatch',
      pins: 'the whole-payload digest'
    },
    {
      name: 'one entry digest corrupted while the payload digest still passes',
      packHex: hex(assemble(threeKinds, { corruptEntryDigestIndex: 1 })),
      expectErrorContains: 'pack entry checksum mismatch: abc123def456',
      pins: 'per-entry verification is NOT skipped when the whole-payload digest passes'
    },
    {
      name: 'entryCount above PACK_MAX_ENTRIES',
      packHex: hex(assemble(oneRecord, { entryCountOverride: PACK_MAX_ENTRIES + 1 })),
      expectErrorContains: 'pack truncated',
      pins: 'parsePack does not itself enforce PACK_MAX_ENTRIES — it runs out of index bytes first. A streaming reader MUST apply the cap before allocating (chapter 08 §8.6)'
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
