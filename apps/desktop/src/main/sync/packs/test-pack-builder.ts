import { createHash } from 'node:crypto'

import {
  PACK_FOOTER_SIZE,
  PACK_HEADER_SIZE,
  PACK_MAGIC,
  PACK_VERSION,
  PackKindCode,
  type PackEntryMeta,
  type PackKindName
} from '@memry/contracts/pack-format'

/**
 * Minimal pack WRITER for tests only.
 *
 * The production writer lives in the Worker (`apps/sync-server`), which the
 * desktop app may not import — that boundary is the whole reason the format
 * moved into `@memry/contracts`. This builder encodes against those same
 * exported constants, so a layout change breaks both halves together; the
 * server's own `pack-format.test.ts` covers writer↔`parsePack`, and
 * `parsePack` and the streaming client reader share `decodePackIndex`.
 */

export interface TestPackEntry {
  kind?: PackKindName
  id: string
  sourceKey?: string
  sortKey?: number
  meta?: PackEntryMeta
  bytes: Uint8Array
}

export interface BuiltTestPack {
  bytes: Uint8Array
  payloadStart: number
  indexOffset: number
}

const u16 = (value: number): number[] => [(value >>> 8) & 0xff, value & 0xff]
const u32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff
]
const u64 = (value: number): number[] => [...u32(Math.floor(value / 2 ** 32)), ...u32(value >>> 0)]

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(bytes).digest())

export interface BuildTestPackOptions {
  magic?: string
  version?: number
  /** Footer version echo, when it must differ from the header's. */
  footerVersion?: number
  /** Corrupt the whole-payload digest recorded in the footer. */
  breakPayloadDigest?: boolean
  /** Ids whose per-entry digest is recorded wrong. */
  breakEntryDigestFor?: string[]
}

export const buildTestPack = (
  entries: TestPackEntry[],
  options: BuildTestPackOptions = {}
): BuiltTestPack => {
  const encoder = new TextEncoder()
  const header = [
    ...encoder.encode(options.magic ?? PACK_MAGIC),
    options.version ?? PACK_VERSION,
    0,
    0,
    0
  ]

  const payload: number[] = []
  const index: number[] = []
  let offset = 0
  for (const entry of entries) {
    const meta = entry.meta ? JSON.stringify(entry.meta) : ''
    const digest = options.breakEntryDigestFor?.includes(entry.id)
      ? new Uint8Array(32).fill(0xaa)
      : sha256(entry.bytes)
    index.push(PackKindCode[entry.kind ?? 'crdt_snapshot'])
    const id = encoder.encode(entry.id)
    index.push(...u16(id.length), ...id)
    const sourceKey = encoder.encode(entry.sourceKey ?? `blobs/${entry.id}`)
    index.push(...u16(sourceKey.length), ...sourceKey)
    index.push(...u64(entry.sortKey ?? 0))
    const metaBytes = encoder.encode(meta)
    index.push(...u16(metaBytes.length), ...metaBytes)
    index.push(...u64(offset), ...u64(entry.bytes.length))
    index.push(...digest)
    payload.push(...entry.bytes)
    offset += entry.bytes.length
  }

  const payloadBytes = new Uint8Array(payload)
  const payloadDigest = options.breakPayloadDigest
    ? new Uint8Array(32).fill(0xbb)
    : sha256(payloadBytes)
  const indexOffset = PACK_HEADER_SIZE + payloadBytes.length

  const footer = [
    ...payloadDigest,
    ...u64(entries.length),
    ...u64(indexOffset),
    ...encoder.encode(PACK_MAGIC),
    options.footerVersion ?? options.version ?? PACK_VERSION
  ]

  const bytes = new Uint8Array([...header, ...payloadBytes, ...index, ...footer])
  if (footer.length !== PACK_FOOTER_SIZE) throw new Error('test pack footer size drifted')
  return { bytes, payloadStart: PACK_HEADER_SIZE, indexOffset }
}
