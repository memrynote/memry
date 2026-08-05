import { describe, expect, it } from 'vitest'
import { compressPayload, decompressPayload } from './compress'

// compressPayload/decompressPayload sit INSIDE the crypto envelope: push
// compresses before encrypting, pull decompresses after decrypting. Any loss
// here is silent data corruption that no signature check can catch, because
// the bytes are signed AFTER compression. Round-trip fidelity is the whole
// contract.

const FLAG_RAW = 0x00
const FLAG_DEFLATE = 0x01

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

function repeat(byte: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(byte)
}

/** Deterministic pseudo-random bytes — incompressible, and stable across runs. */
function pseudoRandomBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length)
  let state = seed
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    out[i] = state >>> 24
  }
  return out
}

describe('compressPayload / decompressPayload', () => {
  describe('#given payloads of every shape #when round-tripped', () => {
    it('#then decompress returns byte-identical input', () => {
      const cases: Array<[string, Uint8Array]> = [
        ['empty', new Uint8Array(0)],
        ['single byte', bytes(0)],
        ['single 0xff byte', bytes(0xff)],
        ['short utf8', new TextEncoder().encode('hello world')],
        ['63 bytes (below the compression threshold)', repeat(0x41, 63)],
        ['64 bytes (at the compression threshold)', repeat(0x41, 64)],
        ['65 bytes (above the compression threshold)', repeat(0x41, 65)],
        ['all 256 byte values', new Uint8Array(Array.from({ length: 256 }, (_, i) => i))],
        ['highly compressible 100KB', repeat(0x7a, 100_000)],
        ['incompressible 100KB', pseudoRandomBytes(100_000)],
        [
          '1MB note-sized JSON',
          new TextEncoder().encode(JSON.stringify({ b: 'x'.repeat(1_000_000) }))
        ],
        ['embedded NUL bytes', bytes(1, 0, 2, 0, 0, 3)],
        ['lone surrogate bytes (invalid utf8)', bytes(0xed, 0xa0, 0x80, 0xff, 0xfe)]
      ]

      for (const [label, input] of cases) {
        const restored = decompressPayload(compressPayload(input))
        expect(restored, label).toEqual(input)
        expect(restored.byteLength, label).toBe(input.byteLength)
      }
    })

    it('#then the input buffer is never mutated in place', () => {
      // The caller (encryptItemForPush) still owns `content` after this call.
      const input = repeat(0x5a, 4096)
      const snapshot = input.slice()

      compressPayload(input)

      expect(input).toEqual(snapshot)
    })
  })

  describe('#given payloads below the 64-byte threshold #when compressed', () => {
    it('#then they are stored raw with a 1-byte flag prefix', () => {
      const input = new TextEncoder().encode('short')

      const compressed = compressPayload(input)

      expect(compressed[0]).toBe(FLAG_RAW)
      expect(compressed.byteLength).toBe(input.byteLength + 1)
      expect(compressed.subarray(1)).toEqual(input)
    })

    it('#then empty input still carries the flag byte', () => {
      const compressed = compressPayload(new Uint8Array(0))

      expect(compressed.byteLength).toBe(1)
      expect(compressed[0]).toBe(FLAG_RAW)
      expect(decompressPayload(compressed)).toEqual(new Uint8Array(0))
    })
  })

  describe('#given a large compressible payload #when compressed', () => {
    it('#then it is deflated and marked with the deflate flag', () => {
      const input = repeat(0x61, 50_000)

      const compressed = compressPayload(input)

      expect(compressed[0]).toBe(FLAG_DEFLATE)
      expect(compressed.byteLength).toBeLessThan(input.byteLength)
      expect(decompressPayload(compressed)).toEqual(input)
    })
  })

  describe('#given a large incompressible payload #when compressed', () => {
    it('#then it falls back to raw rather than growing the payload', () => {
      // Deflate expands random data. Without the fallback every binary
      // attachment would push MORE bytes than it has, against a 5MB cap.
      const input = pseudoRandomBytes(20_000, 7)

      const compressed = compressPayload(input)

      expect(compressed[0]).toBe(FLAG_RAW)
      expect(compressed.byteLength).toBe(input.byteLength + 1)
      expect(decompressPayload(compressed)).toEqual(input)
    })
  })

  describe('#given malformed compressed input #when decompressed', () => {
    it('#then a deflate-flagged garbage body throws instead of yielding partial bytes', () => {
      // A truncated/corrupt R2 body must surface as a decrypt-path failure, not
      // as silently truncated note content.
      const garbage = new Uint8Array([FLAG_DEFLATE, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x01])

      expect(() => decompressPayload(garbage)).toThrow()
    })

    // pako's `inflate()` only assigns `result` when the deflate stream ENDS. A
    // truncated stream leaves err === 0 and result === undefined, so
    // `pako.inflate()` returns undefined WITHOUT throwing. decompressPayload
    // must convert that into a throw: otherwise decrypt.ts wraps it as
    // `{ content: undefined, verified: true }` and decrypt-item.ts turns it
    // into '' via `new TextDecoder().decode(undefined)` — a truncated payload
    // reported as a SUCCESSFUL decrypt of an empty item, which applies as a
    // content wipe rather than a failure.
    it('#then a truncated deflate body throws instead of returning nothing', () => {
      const full = compressPayload(repeat(0x62, 50_000))
      const truncated = full.slice(0, Math.floor(full.byteLength / 2))

      expect(() => decompressPayload(truncated)).toThrow(/incomplete deflate stream/)
    })

    it('#then a deflate body with a flipped byte throws', () => {
      const full = compressPayload(repeat(0x63, 50_000))
      const corrupted = full.slice()
      corrupted[5] = corrupted[5] ^ 0xff

      expect(() => decompressPayload(corrupted)).toThrow()
    })

    it('#then a zero-length buffer is returned as-is rather than throwing', () => {
      // Guard clause: a 0-byte body has no flag byte to read.
      const empty = new Uint8Array(0)

      expect(decompressPayload(empty)).toEqual(empty)
    })
  })

  describe('#given an unknown flag byte #when decompressed', () => {
    it('#then the body is returned raw (unknown flags are treated as uncompressed)', () => {
      // Documented consequence: if a future writer ever introduces flag 0x02,
      // an older client returns the still-encoded body as if it were plaintext
      // instead of failing. Today only 0x00/0x01 are ever written, and the
      // cryptoVersion gate in decrypt.ts is what guards format changes.
      const body = new TextEncoder().encode('payload')
      const unknownFlag = new Uint8Array(1 + body.byteLength)
      unknownFlag[0] = 0x02
      unknownFlag.set(body, 1)

      expect(decompressPayload(unknownFlag)).toEqual(body)
    })
  })
})
