/**
 * Class: compression framing (`compression.json`), 9 cases.
 *
 * Generated through the production `compressPayload` / `decompressPayload`
 * (`packages/sync-client/src/compress.ts`), not a local deflate call.
 *
 * Determinism: D1, with one caveat. `pako.deflate` output is deterministic for
 * a given input and library version, but it is NOT part of the protocol that it
 * be a particular byte sequence: any valid zlib stream that inflates to the
 * right bytes conforms. So the file records both, and the two suites assert
 * different things —
 *
 *  - the desktop suite asserts byte equality against `expectedFrameHex`, which
 *    is what detects a `pako` upgrade changing output;
 *  - a second implementation asserts the weaker, correct property: that
 *    `expectedFrameHex[1..]` inflates to the input, that the flag byte matches,
 *    and that its own compressor round-trips through `decompressPayload`.
 *
 * Requiring `flate2` to match `pako` byte for byte would be a false requirement
 * that fails for a reason that does not matter.
 *
 * Chapter: docs/protocol/04-record-envelope.md §4.1.
 */
import { createRequire } from 'node:module'

import { compressPayload, decompressPayload } from '../../../sync-client/src/compress.ts'
import { meta } from './shared'

const require = createRequire(import.meta.url)
const pakoVersion = (require('pako/package.json') as { version: string }).version

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)

/** Deterministic pseudo-random bytes: deflate cannot shrink these. */
function incompressible(length: number): Uint8Array {
  const out = new Uint8Array(length)
  let state = 0x9e3779b9
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    out[i] = (state >>> 24) & 0xff
  }
  return out
}

/** `size` bytes of highly compressible text. */
const filler = (size: number): Uint8Array => utf8('ab'.repeat(Math.ceil(size / 2)).slice(0, size))

interface Case {
  name: string
  input: Uint8Array
  pins: string
}

const CASES: Case[] = [
  {
    name: '63 bytes, compressible',
    input: filler(63),
    pins: 'flag 0x00: the threshold is a strict "under 64"'
  },
  {
    name: '64 bytes, compressible',
    input: filler(64),
    pins: 'flag 0x01: the first length allowed to compress'
  },
  {
    name: '4 KiB of repeated text',
    input: filler(4096),
    pins: 'flag 0x01, and the payload begins 78 9c (RFC 1950 zlib, not gzip)'
  },
  {
    name: '4 KiB of incompressible bytes',
    input: incompressible(4096),
    pins: 'flag 0x00: deflate did not shrink it, so stored wins'
  },
  {
    name: '64 bytes of incompressible bytes',
    input: incompressible(64),
    pins: 'the >= boundary: a result no shorter than the input is discarded'
  },
  {
    name: 'empty input',
    input: new Uint8Array(0),
    pins: 'decompress returns an empty buffer as-is, with no flag consumed'
  }
]

export function buildCompression(): Record<string, unknown> {
  const cases = CASES.map((entry) => {
    const frame = compressPayload(entry.input)
    const inflated = decompressPayload(frame)
    return {
      name: entry.name,
      inputHex: hex(entry.input),
      inputBytes: entry.input.length,
      expectedFlag: entry.input.length === 0 ? null : frame[0],
      expectedFrameHex: hex(frame),
      expectedInflatedHex: hex(inflated),
      pins: entry.pins
    }
  })

  // Reader-only cases: frames a writer never produces but a reader must handle.
  const compressible = compressPayload(filler(4096))
  const readerCases = [
    {
      name: 'unknown flag 0x02 is treated as stored',
      frameHex: hex(Uint8Array.from([0x02, ...filler(10)])),
      expectedInflatedHex: hex(filler(10)),
      pins: 'a reader treats ANY flag other than 0x01 as stored; there is no unknown-flag rejection'
    }
  ]

  const errorCases = [
    {
      name: 'a 0x01 frame truncated to half its length',
      frameHex: hex(compressible.subarray(0, Math.floor(compressible.length / 2))),
      expectErrorContains: 'Failed to decompress payload: incomplete deflate stream',
      pins: 'MUST be a hard error. pako returns undefined rather than throwing for a stream that never reaches Z_STREAM_END, and returning that as an empty buffer turns a truncated body into a content wipe'
    },
    {
      name: 'a 0x01 frame whose payload is gzip rather than zlib',
      frameHex: hex(
        Uint8Array.from([0x01, 0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03])
      ),
      expectErrorContains: '',
      pins: 'MUST fail. Exists purely to catch an implementation that reached for GzEncoder'
    }
  ]

  return {
    meta: meta({
      class: 'compression',
      chapter: 'docs/protocol/04-record-envelope.md §4.1',
      pakoVersion,
      implementation: 'packages/sync-client/src/compress.ts',
      storedThresholdBytes: 64,
      flags: { stored: 0, zlib: 1 },
      caseCount: cases.length + readerCases.length + errorCases.length
    }),
    cases,
    readerCases,
    errorCases
  }
}
