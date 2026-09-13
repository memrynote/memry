/**
 * Verifier for `cbor-canonical.json` (T069).
 *
 * Asserts BOTH production encoders produce the recorded bytes for every case.
 * There are two copies of `encodeCbor` — `packages/sync-client/src/pull/cbor.ts`
 * and `apps/desktop/src/main/crypto/cbor.ts` — kept byte-identical by a
 * comment. This turns the comment into a test.
 *
 * Only the sync-client copy is importable from here (desktop's reaches Electron
 * through its crypto barrel), so the desktop copy is asserted against the same
 * file in `apps/desktop/src/main/sync/vector-parity.test.ts`.
 */
import { decode } from 'cborg'
import { describe, expect, it } from 'vitest'

import { encodeCbor } from '../../../sync-client/src/pull/cbor.ts'
import { CBOR_FIELD_ORDER } from '../cbor-ordering'
import { hex, loadVectorFile } from './vector-loader'

interface OkCase {
  name: string
  fieldOrderName: string
  fieldOrder: string[]
  input: Record<string, unknown>
  expectedHex: string
  expectedDecodedKeyOrder: string[]
  pins: string
}

interface RejectCase {
  name: string
  fieldOrderName: string
  input: Record<string, unknown>
  expectErrorContains: string
}

const vectors = loadVectorFile<{
  meta: { caseCount: number; ordering: string }
  cases: OkCase[]
  rejectCases: RejectCase[]
}>('cbor-canonical.json')

/** `Uint8Array` and `undefined` survive the file as tagged objects. */
function rehydrate(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === 'object' && '$bytesHex' in value) {
      out[key] = Uint8Array.from(Buffer.from((value as { $bytesHex: string }).$bytesHex, 'hex'))
    } else if (value && typeof value === 'object' && '$undefined' in value) {
      out[key] = undefined
    } else {
      out[key] = value
    }
  }
  return out
}

describe('cbor-canonical vectors', () => {
  it('the ordering this protocol uses is RFC 8949 §4.2.3, not §4.2.1', () => {
    expect(vectors.meta.ordering).toContain('§4.2.3')
  })

  it('carries the recorded case count', () => {
    expect(vectors.cases.length + vectors.rejectCases.length).toBe(vectors.meta.caseCount)
  })

  for (const entry of vectors.cases) {
    it(entry.name, () => {
      const bytes = encodeCbor(rehydrate(entry.input), entry.fieldOrder)
      expect(hex(bytes), entry.pins).toBe(entry.expectedHex)

      const decoded = decode(bytes) as Map<string, unknown> | Record<string, unknown>
      const keyOrder = decoded instanceof Map ? [...decoded.keys()] : Object.keys(decoded)
      expect(keyOrder).toEqual(entry.expectedDecodedKeyOrder)
    })
  }

  for (const entry of vectors.rejectCases) {
    it(entry.name, () => {
      expect(() =>
        encodeCbor(
          rehydrate(entry.input),
          CBOR_FIELD_ORDER[entry.fieldOrderName as keyof typeof CBOR_FIELD_ORDER]
        )
      ).toThrow(entry.expectErrorContains)
    })
  }

  it('the length-first case actually disagrees with lexicographic order', () => {
    // The case exists only to catch a §4.2.1 encoder, so a change that made it
    // agree with lexicographic order would silently retire the whole check.
    const probe = vectors.cases.find((c) => c.fieldOrderName === 'LENGTH_FIRST_PROBE')
    expect(probe, 'the length-first probe case is missing').toBeDefined()
    expect(probe!.expectedDecodedKeyOrder).toEqual(['z', 'aa'])
    expect([...probe!.expectedDecodedKeyOrder].sort()).not.toEqual(probe!.expectedDecodedKeyOrder)
  })
})
