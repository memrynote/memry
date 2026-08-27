import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64 } from '../base64'

/**
 * Hermes has no `btoa`/`atob`, and neither React Native 0.86 nor Expo 57's
 * winter runtime installs them — reaching for the global is a crash on first
 * use, which is why every base64 crossing in the app goes through this module.
 * These cases pin it against Node's own encoder so a hand-rolled codec cannot
 * quietly disagree with the rest of the world.
 */
describe('base64', () => {
  const cases: [string, Uint8Array][] = [
    ['empty', new Uint8Array(0)],
    ['one byte (two pad chars)', new Uint8Array([0xff])],
    ['two bytes (one pad char)', new Uint8Array([0x00, 0x01])],
    ['three bytes (no padding)', new Uint8Array([0xde, 0xad, 0xbe])],
    ['every byte value', new Uint8Array(Array.from({ length: 256 }, (_, i) => i))]
  ]

  for (const [name, bytes] of cases) {
    it(`matches Node's encoder for ${name}`, () => {
      const expected = Buffer.from(bytes).toString('base64')
      expect(bytesToBase64(bytes)).toBe(expected)
      expect(Array.from(base64ToBytes(expected))).toEqual(Array.from(bytes))
    })
  }

  it('round-trips a payload larger than the encoder chunk', () => {
    // Bigger than the 8 KB accumulator, so the chunk-join path is exercised —
    // the editor asset that goes through here is ~1 MB.
    const bytes = new Uint8Array(64 * 1024).map((_, i) => (i * 31) % 256)
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes))
  })

  it('decodes an unpadded string', () => {
    // Some producers strip `=`; the decoder must not depend on it.
    const bytes = new Uint8Array([1, 2, 3, 4])
    const padded = bytesToBase64(bytes)
    expect(Array.from(base64ToBytes(padded.replace(/=+$/, '')))).toEqual(Array.from(bytes))
  })

  it('rejects a character outside the alphabet', () => {
    expect(() => base64ToBytes('AA*A')).toThrow(/invalid base64/)
  })
})
