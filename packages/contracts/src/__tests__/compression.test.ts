/**
 * Verifier for `compression.json` (T070).
 *
 * Byte equality against `pako`'s output, plus the two error cases. The
 * truncated-stream case is the one that matters most: `pako.inflate` returns
 * `undefined` rather than throwing for a stream that never reaches
 * `Z_STREAM_END`, and returning that under a `Uint8Array` type turns a
 * truncated body into a successful decrypt of an empty item, which the applier
 * writes as a content wipe.
 */
import { describe, expect, it } from 'vitest'

import { compressPayload, decompressPayload } from '../../../sync-client/src/compress.ts'
import { fromHex, hex, loadVectorFile } from './vector-loader'

const vectors = loadVectorFile<{
  meta: { caseCount: number; pakoVersion: string; storedThresholdBytes: number }
  cases: Array<{
    name: string
    inputHex: string
    inputBytes: number
    expectedFlag: number | null
    expectedFrameHex: string
    expectedInflatedHex: string
    pins: string
  }>
  readerCases: Array<{ name: string; frameHex: string; expectedInflatedHex: string; pins: string }>
  errorCases: Array<{ name: string; frameHex: string; expectErrorContains: string; pins: string }>
}>('compression.json')

describe('compression vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.cases.length + vectors.readerCases.length + vectors.errorCases.length).toBe(
      vectors.meta.caseCount
    )
  })

  it('the stored threshold is a strict "under 64"', () => {
    expect(vectors.meta.storedThresholdBytes).toBe(64)
    const under = vectors.cases.find((c) => c.inputBytes === 63)
    const at = vectors.cases.find((c) => c.inputBytes === 64 && c.expectedFlag === 1)
    expect(under?.expectedFlag, '63 compressible bytes must be STORED').toBe(0)
    expect(at, '64 compressible bytes must be the first length allowed to compress').toBeDefined()
  })

  for (const entry of vectors.cases) {
    it(entry.name, () => {
      const input = fromHex(entry.inputHex)
      const frame = compressPayload(input)
      expect(hex(frame), `${entry.pins} (a pako upgrade changing output also lands here)`).toBe(
        entry.expectedFrameHex
      )
      if (entry.expectedFlag !== null) expect(frame[0]).toBe(entry.expectedFlag)
      expect(hex(decompressPayload(fromHex(entry.expectedFrameHex)))).toBe(
        entry.expectedInflatedHex
      )
    })
  }

  for (const entry of vectors.readerCases) {
    it(entry.name, () => {
      expect(hex(decompressPayload(fromHex(entry.frameHex))), entry.pins).toBe(
        entry.expectedInflatedHex
      )
    })
  }

  for (const entry of vectors.errorCases) {
    it(entry.name, () => {
      // MUST throw, and MUST NOT return an empty buffer.
      let returned: Uint8Array | undefined
      expect(() => {
        returned = decompressPayload(fromHex(entry.frameHex))
      }, entry.pins).toThrow()
      expect(returned, 'a failed decompress must not return a value at all').toBeUndefined()
      if (entry.expectErrorContains.length > 0) {
        expect(() => decompressPayload(fromHex(entry.frameHex))).toThrow(entry.expectErrorContains)
      }
    })
  }

  it('a zlib frame begins 78 9c, and is not gzip', () => {
    const zlib = vectors.cases.find((c) => c.expectedFlag === 1)
    expect(zlib, 'no compressed case in the file').toBeDefined()
    expect(zlib!.expectedFrameHex.slice(2, 6)).toBe('789c')
    expect(zlib!.expectedFrameHex.slice(2, 8)).not.toBe('1f8b08')
  })
})
