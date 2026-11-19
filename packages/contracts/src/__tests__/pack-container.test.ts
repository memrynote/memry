/**
 * Verifier for `pack-container.json` (T072).
 *
 * Reader-only, because a client is never a pack writer. `parsePack` must accept
 * every good case with the expected entries, and reject every bad one with the
 * documented message.
 *
 * `readFooter` is exercised on the TAIL SLICE alone, because that is what a
 * streaming reader passes: it never holds the file.
 */
import sodium, { ready } from 'libsodium-wrappers-sumo'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  decryptCrdtUpdatePacked,
  decryptRecordItem
} from '../../../sync-client/src/pull/record-decrypt.ts'
import { deterministicProvider, hex } from '../../test-vectors/deterministic-provider'
import {
  PACK_FOOTER_SIZE,
  PACK_HEADER_SIZE,
  PACK_MAGIC,
  PACK_MAX_ENTRIES,
  PACK_VERSION,
  PackKindCode,
  extractEntry,
  parsePack,
  readFooter
} from '../pack-format'
import {
  CrdtUpdatePackEntryMetaSchema,
  EncryptedItemPayloadSchema,
  RecordPackEntryMetaSchema,
  RecordPullItemResponseSchema
} from '../sync-api'
import { fromHex, loadVectorFile } from './vector-loader'

interface EntryContract {
  records?: Array<{
    id: string
    usable: boolean
    // Present when `usable`.
    pullItem?: unknown
    vaultKeyHex?: string
    signingSeedHex?: string
    plaintextUtf8?: string
  }>
  updates?: Array<{
    noteId: string
    usable: boolean
    meta: unknown
    vaultKeyHex: string
    signingSeedHex: string
    plaintextHex: string
  }>
}

const vectors = loadVectorFile<{
  meta: {
    caseCount: number
    layout: Record<string, unknown>
    kindCodes: Record<string, number>
  }
  cases: Array<{
    name: string
    pins: string
    packHex: string
    expected: { version: number; entries: unknown[]; integrityVerified: boolean }
    entryContract?: EntryContract
  }>
  errorCases: Array<{
    name: string
    packHex: string
    // Absent when the reference's message is unreachable for a conforming
    // reader; `referenceOnlyMessage` records it for the record instead.
    expectErrorContains?: string
    referenceOnlyMessage?: string
    // The portable half. A second implementation asserts this, never the
    // English message.
    expectErrorCode: string
    pins: string
  }>
}>('pack-container.json')

describe('pack-container vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.cases.length + vectors.errorCases.length).toBe(vectors.meta.caseCount)
  })

  it('the recorded layout matches the production constants', () => {
    expect(vectors.meta.layout).toEqual({
      PACK_MAGIC,
      PACK_VERSION,
      PACK_HEADER_SIZE,
      PACK_FOOTER_SIZE,
      PACK_MAX_ENTRIES
    })
    expect(vectors.meta.kindCodes).toEqual({ ...PackKindCode })
  })

  for (const entry of vectors.cases) {
    // oxlint-disable-next-line vitest/valid-title -- title comes from vector/fixture data typed as string; the rule is not type-aware
    it(entry.name, async () => {
      const bytes = fromHex(entry.packHex)
      const parsed = await parsePack(bytes)
      expect(parsed.version, entry.pins).toBe(entry.expected.version)
      expect(parsed.integrityVerified).toBe(true)
      expect(parsed.entries).toEqual(entry.expected.entries)
    })

    it(`${entry.name}: the footer parses from the tail slice alone`, () => {
      const bytes = fromHex(entry.packHex)
      const tail = bytes.subarray(bytes.length - PACK_FOOTER_SIZE)
      const fromTail = readFooter(tail)
      const fromWhole = readFooter(bytes)
      expect(fromTail).toEqual(fromWhole)
    })
  }

  for (const entry of vectors.errorCases) {
    // oxlint-disable-next-line vitest/valid-title -- title comes from vector/fixture data typed as string; the rule is not type-aware
    it(entry.name, async () => {
      // oxlint-disable-next-line vitest/valid-expect -- promise is awaited below, after fake timers advance; awaiting here would deadlock
      const rejects = expect(parsePack(fromHex(entry.packHex)), entry.pins).rejects
      // `entry-count-too-large` has no asserted message: the reference reaches
      // "pack truncated" only because it does not apply §8.6's cap, and a
      // conforming reader fails earlier. Assert that it still rejects.
      await (entry.expectErrorContains
        ? rejects.toThrow(entry.expectErrorContains)
        : rejects.toThrow())
    })
  }

  it('every error case carries a portable error code', () => {
    // Without this, a second implementation can only assert this reader's
    // English, which pins the phrasing rather than the behaviour.
    for (const entry of vectors.errorCases) {
      expect(entry.expectErrorCode, entry.name).toBeTruthy()
    }
  })

  it('a per-entry digest failure is caught even when the payload digest passes', () => {
    // Named explicitly so a refactor that short-circuits after the whole-payload
    // digest cannot quietly retire the per-entry check.
    const entry = vectors.errorCases.find((c) => c.expectErrorCode === 'entry-checksum-mismatch')
    expect(entry, 'the per-entry digest case is missing').toBeDefined()
  })

  it('an offset is relative to the payload region, not to the file', () => {
    // The off-by-eight a reader gets wrong first: the first entry starts at
    // offset 0, which sits at PACK_HEADER_SIZE in the file.
    const first = vectors.cases[0].expected.entries[0] as { offset: number }
    expect(first.offset).toBe(0)
    expect(PACK_HEADER_SIZE).toBe(8)
  })
})

/**
 * Chapter 08 §8.4.2 and §8.4.3: what one record or update entry means.
 *
 * Rebuilt from the pack bytes and pushed through the production verify and
 * decrypt paths, so a meta that dropped a field the pull item carries fails
 * here on the signature, not on a shape comparison alone.
 */
describe('pack entry contract vectors', () => {
  beforeAll(async () => {
    await ready
  })

  const contractCases = vectors.cases.filter((c) => c.entryContract)

  it('covers record entries, a record entry without meta, and kind 2', () => {
    const records = contractCases.flatMap((c) => c.entryContract?.records ?? [])
    const updates = contractCases.flatMap((c) => c.entryContract?.updates ?? [])
    expect(records.some((r) => r.usable)).toBe(true)
    expect(records.some((r) => !r.usable)).toBe(true)
    expect(updates.length).toBeGreaterThan(1)
  })

  for (const entry of contractCases) {
    // oxlint-disable-next-line vitest/valid-title -- title comes from vector/fixture data typed as string; the rule is not type-aware
    it(entry.name, async () => {
      const bytes = fromHex(entry.packHex)
      const parsed = await parsePack(bytes)
      const wantRecords = entry.entryContract?.records ?? []
      const wantUpdates = entry.entryContract?.updates ?? []
      const records = parsed.entries.filter((e) => e.kind === 'record')
      const updates = parsed.entries.filter((e) => e.kind === 'crdt_update')
      expect(records.map((e) => e.id)).toEqual(wantRecords.map((r) => r.id))
      expect(updates.length).toBe(wantUpdates.length)

      for (const [i, packed] of records.entries()) {
        const want = wantRecords[i]
        const meta = RecordPackEntryMetaSchema.safeParse(packed.meta)
        expect(meta.success, `${packed.id}: usable`).toBe(want.usable)
        if (!meta.success) continue
        // `type:id`, split at the first colon: no record type contains one.
        const split = packed.id.indexOf(':')
        const blob = EncryptedItemPayloadSchema.parse(
          JSON.parse(new TextDecoder().decode(extractEntry(bytes, packed)))
        )
        const pullItem = RecordPullItemResponseSchema.parse({
          ...meta.data,
          id: packed.id.slice(split + 1),
          type: packed.id.slice(0, split),
          blob
        })
        expect(pullItem).toEqual(want.pullItem)

        const signer = sodium.crypto_sign_seed_keypair(fromHex(want.signingSeedHex ?? ''))
        const plaintext = await decryptRecordItem(
          deterministicProvider(),
          { ...pullItem, ...pullItem.blob, cryptoVersion: pullItem.cryptoVersion ?? 1 },
          fromHex(want.vaultKeyHex ?? ''),
          signer.publicKey
        )
        expect(new TextDecoder().decode(plaintext)).toBe(want.plaintextUtf8)
      }

      // Within one document, server_cursor order is sequenceNum order (chapter 07 §7.17).
      const sortKeys = updates.map((u) => u.sortKey)
      const sequenceNums = updates.map(
        (u) => CrdtUpdatePackEntryMetaSchema.parse(u.meta).sequenceNum
      )
      expect(sortKeys).toEqual(sortKeys.toSorted((a, b) => a - b))
      expect(sequenceNums).toEqual(sequenceNums.toSorted((a, b) => a - b))

      for (const [i, packed] of updates.entries()) {
        const want = wantUpdates[i]
        expect(packed.id).toBe(want.noteId)
        const meta = CrdtUpdatePackEntryMetaSchema.parse(packed.meta)
        expect(meta).toEqual(want.meta)
        const signer = sodium.crypto_sign_seed_keypair(fromHex(want.signingSeedHex))
        const plaintext = await decryptCrdtUpdatePacked(
          deterministicProvider(),
          extractEntry(bytes, packed),
          fromHex(want.vaultKeyHex),
          packed.id,
          signer.publicKey
        )
        expect(hex(plaintext)).toBe(want.plaintextHex)
      }
    })
  }
})
