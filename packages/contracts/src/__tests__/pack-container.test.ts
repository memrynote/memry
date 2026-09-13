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
import { describe, expect, it } from 'vitest'

import {
  PACK_FOOTER_SIZE,
  PACK_HEADER_SIZE,
  PACK_MAGIC,
  PACK_MAX_ENTRIES,
  PACK_VERSION,
  PackKindCode,
  parsePack,
  readFooter
} from '../pack-format'
import { fromHex, loadVectorFile } from './vector-loader'

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
  }>
  errorCases: Array<{ name: string; packHex: string; expectErrorContains: string; pins: string }>
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
    it(entry.name, async () => {
      await expect(parsePack(fromHex(entry.packHex)), entry.pins).rejects.toThrow(
        entry.expectErrorContains
      )
    })
  }

  it('a per-entry digest failure is caught even when the payload digest passes', () => {
    // Named explicitly so a refactor that short-circuits after the whole-payload
    // digest cannot quietly retire the per-entry check.
    const entry = vectors.errorCases.find((c) => c.expectErrorContains.startsWith('pack entry'))
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
