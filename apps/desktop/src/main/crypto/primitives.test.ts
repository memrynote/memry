import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import { generateFileKey, secureCleanup } from './primitives'

beforeAll(async () => {
  await sodium.ready
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('generateFileKey', () => {
  it('returns a 32-byte key', () => {
    // #given/when
    const key = generateFileKey()

    // #then
    expect(key).toHaveLength(32)
  })

  it('returns unique keys across 1000 calls (entropy smoke test)', () => {
    // #given a large batch of generated keys
    const seen = new Set<string>()
    const sampleCount = 1000

    // #when
    for (let i = 0; i < sampleCount; i++) {
      seen.add(sodium.to_hex(generateFileKey()))
    }

    // #then no duplicates — uniqueness across 1000 32-byte CSPRNG samples is ~certain
    expect(seen.size).toBe(sampleCount)
  })

  it('produces a roughly uniform byte distribution across many samples', () => {
    // #given a large pool of bytes drawn from generateFileKey
    const sampleCount = 200
    const histogram = new Uint32Array(256)
    for (let i = 0; i < sampleCount; i++) {
      const key = generateFileKey()
      for (const byte of key) {
        histogram[byte]++
      }
    }
    const totalBytes = sampleCount * 32

    // #when checking distinct-byte coverage
    const distinctValues = histogram.reduce((acc, count) => (count > 0 ? acc + 1 : acc), 0)

    // #then nearly all 256 byte values appeared (CSPRNG → uniform expectation)
    expect(distinctValues).toBeGreaterThanOrEqual(250)

    // #then no single byte value dominates more than 5% of the sample
    const expectedMean = totalBytes / 256
    const maxAllowedCount = Math.floor(expectedMean * 5)
    const maxCount = Math.max(...Array.from(histogram))
    expect(maxCount).toBeLessThanOrEqual(maxAllowedCount)
  })
})

describe('secureCleanup', () => {
  it('overwrites a single buffer in place with zeros', () => {
    // #given a buffer with non-zero contents
    const buf = new Uint8Array([1, 2, 3, 4, 5])

    // #when
    secureCleanup(buf)

    // #then every byte is zero (mutation in place)
    expect(Array.from(buf)).toEqual([0, 0, 0, 0, 0])
  })

  it('zeros every buffer when called with multiple arguments', () => {
    // #given several buffers
    const a = new Uint8Array([9, 9, 9])
    const b = new Uint8Array([7, 7, 7, 7])
    const c = new Uint8Array(16).fill(0xff)

    // #when
    secureCleanup(a, b, c)

    // #then all are zeroed
    expect(a.every((byte) => byte === 0)).toBe(true)
    expect(b.every((byte) => byte === 0)).toBe(true)
    expect(c.every((byte) => byte === 0)).toBe(true)
  })

  it('invokes sodium.memzero exactly once per buffer in order', () => {
    // #given spies on the underlying primitives
    const memzeroSpy = vi.spyOn(sodium, 'memzero')
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([4, 5, 6])

    // #when
    secureCleanup(a, b)

    // #then memzero received each buffer in argument order
    const memzeroCalls = memzeroSpy.mock.calls.map(([buf]) => buf)
    expect(memzeroCalls).toEqual([a, b])
  })

  it('handles being called with no arguments without throwing', () => {
    // #given no buffers
    // #when/then
    expect(() => secureCleanup()).not.toThrow()
  })

  it('zeros an empty buffer without throwing', () => {
    // #given a zero-length buffer (early-return path in unlockKeyMaterial)
    const empty = new Uint8Array()

    // #when/then
    expect(() => secureCleanup(empty)).not.toThrow()
    expect(empty).toHaveLength(0)
  })
})
