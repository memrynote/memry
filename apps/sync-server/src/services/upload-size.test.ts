import { XCHACHA20_PARAMS } from '@memry/contracts/crypto'
import { describe, expect, it } from 'vitest'

import {
  CHUNK_CRYPTO_OVERHEAD,
  MAX_CHUNK_CRYPTO_OVERHEAD,
  expectedEncryptedTotal,
  getUploadedByteTotal,
  parseUploadedChunks,
  readUploadedChunks,
  type UploadedChunkEntry
} from './upload-size'

// upload-size.ts is pure byte accounting. It does not itself enforce a limit —
// the comparisons live in routes/blob.ts (chunk PUT: `uploadedBytes === null ||
// uploadedBytes + chunkData.byteLength > expectedEncrypted` -> 413
// STORAGE_FILE_TOO_LARGE, blob.ts:318-324) and in services/vault-deletion.ts.
// What this module owns is producing the exact ceiling those comparisons use,
// and failing closed (null) when the persisted byte counts cannot be trusted.

describe('crypto overhead constants', () => {
  it('derives per-chunk overhead from the contracts crypto params', () => {
    // #then — the module comment promises it cannot silently drift from
    // packages/contracts/src/crypto.ts.
    expect(CHUNK_CRYPTO_OVERHEAD).toBe(XCHACHA20_PARAMS.NONCE_LENGTH + XCHACHA20_PARAMS.TAG_LENGTH)
    expect(CHUNK_CRYPTO_OVERHEAD).toBe(40)
  })

  it('leaves slack above the current overhead for a future AEAD', () => {
    // #then — MAX_ is the client-declared sanity bound; if it ever dropped below
    // the real overhead, honest clients would be rejected at upload init.
    expect(MAX_CHUNK_CRYPTO_OVERHEAD).toBe(64)
    expect(MAX_CHUNK_CRYPTO_OVERHEAD).toBeGreaterThan(CHUNK_CRYPTO_OVERHEAD)
  })
})

describe('expectedEncryptedTotal', () => {
  it('derives the ceiling from plaintext size plus per-chunk overhead when no size was declared', () => {
    // #given / #when — the `encryptedSize === null` path is what keeps
    // already-installed clients and pre-`encrypted_size` sessions working.
    // #then
    expect(expectedEncryptedTotal(1024, 1, null)).toBe(1024 + CHUNK_CRYPTO_OVERHEAD)
    expect(expectedEncryptedTotal(2048, 2, null)).toBe(2048 + CHUNK_CRYPTO_OVERHEAD * 2)
    expect(expectedEncryptedTotal(0, 0, null)).toBe(0)
  })

  it('scales overhead linearly with chunk count, not with size', () => {
    // #then — one 10 MiB chunk costs one tag; ten 1 MiB chunks cost ten.
    const tenMib = 10 * 1024 * 1024
    expect(expectedEncryptedTotal(tenMib, 1, null)).toBe(tenMib + CHUNK_CRYPTO_OVERHEAD)
    expect(expectedEncryptedTotal(tenMib, 10, null)).toBe(tenMib + CHUNK_CRYPTO_OVERHEAD * 10)
  })

  it('honours an explicitly declared encrypted size verbatim', () => {
    // #given — a client that declared its own on-the-wire total.
    // #then — the declared number wins; blob.ts has already range-checked it
    // against totalSize + MAX_CHUNK_CRYPTO_OVERHEAD * chunkCount before this
    // value is persisted (blob.ts:232).
    expect(expectedEncryptedTotal(1024, 2, 1234)).toBe(1234)
    // Deliberately smaller than the derived figure: still honoured verbatim.
    expect(expectedEncryptedTotal(1024, 2, 1)).toBe(1)
  })

  it('treats a declared size of zero as declared, not as absent', () => {
    // #then — the source uses `??`, so only null/undefined trigger the derive
    // path. A `||` regression here would silently hand a zero-byte session the
    // full derived allowance.
    expect(expectedEncryptedTotal(1024, 2, 0)).toBe(0)
    expect(expectedEncryptedTotal(1024, 2, 0)).not.toBe(1024 + CHUNK_CRYPTO_OVERHEAD * 2)
  })

  it('produces the exact boundary value that blob.ts compares with a strict >', () => {
    // #given — blob.ts:318 rejects only when running total EXCEEDS this number,
    // so a session landing exactly on it is allowed. Pin the arithmetic so the
    // inclusive boundary is not shifted by a rounding change.
    const ceiling = expectedEncryptedTotal(1024, 1, null)

    // #then
    expect(ceiling).toBe(1064)
    expect(ceiling > ceiling).toBe(false) // exactly at the limit: accepted
    expect(ceiling + 1 > ceiling).toBe(true) // one byte over: rejected
  })
})

describe('parseUploadedChunks', () => {
  it('parses a well-formed chunk array', () => {
    // #given
    const raw = JSON.stringify([
      { i: 0, h: 'hash-0', b: 100 },
      { i: 1, h: 'hash-1', b: 200 }
    ])

    // #then
    expect(parseUploadedChunks(raw)).toEqual([
      { i: 0, h: 'hash-0', b: 100 },
      { i: 1, h: 'hash-1', b: 200 }
    ])
  })

  it('returns no chunks for an empty array', () => {
    expect(parseUploadedChunks('[]')).toEqual([])
  })

  it.each([
    ['object', '{"i":0}'],
    ['null literal', 'null'],
    ['string literal', '"nope"'],
    ['number literal', '42'],
    ['boolean literal', 'true']
  ])('treats a valid-JSON non-array payload as no chunks: %s', (_label, raw) => {
    // #then — a session whose column decoded to a non-array must count as zero
    // landed bytes, which makes callers fail closed rather than over-credit.
    expect(parseUploadedChunks(raw)).toEqual([])
  })

  // FIXED: the bare `JSON.parse(value)` used to throw a SyntaxError on a
  // malformed column, which propagated to every unguarded caller — most
  // damagingly services/vault-deletion.ts, where it aborted the whole vault
  // deletion so the user's storage was never released and the vault could not
  // be deleted. The function is now total, matching its JSDoc.
  it('tolerates malformed JSON as no chunks, as its JSDoc promises', () => {
    expect(parseUploadedChunks('not json')).toEqual([])
  })

  it('never throws on any malformed payload', () => {
    // #then — totality is the contract storage-releasing callers depend on:
    // vault-deletion.ts must not abort on an unreadable column.
    expect(parseUploadedChunks('')).toEqual([])
    expect(parseUploadedChunks('[{"i":0},')).toEqual([])
    expect(parseUploadedChunks('{"i":0')).toEqual([])
    expect(parseUploadedChunks('undefined')).toEqual([])
  })
})

describe('readUploadedChunks', () => {
  // parseUploadedChunks flattens "corrupt" into "empty", which is right for
  // storage-releasing callers and wrong for billing ones. readUploadedChunks is
  // how routes/blob.ts tells the two apart.

  it('reports a well-formed array as readable', () => {
    // #given
    const raw = JSON.stringify([{ i: 0, h: 'hash-0', b: 100 }])

    // #then
    expect(readUploadedChunks(raw)).toEqual({
      ok: true,
      entries: [{ i: 0, h: 'hash-0', b: 100 }]
    })
  })

  it('reports a genuinely empty upload as readable, not corrupt', () => {
    // #then — a session with no chunks yet is the normal state right after
    // initiate. It must NOT be conflated with an unreadable column, or every
    // fresh session would 500 on its first chunk PUT.
    expect(readUploadedChunks('[]')).toEqual({ ok: true, entries: [] })
  })

  it('reports malformed JSON as corrupt', () => {
    // #then — same [] entries as the tolerant parse, but flagged so billing
    // callers can refuse rather than credit the user zero landed bytes.
    expect(readUploadedChunks('not json')).toEqual({
      ok: false,
      entries: [],
      reason: 'malformed-json'
    })
    expect(readUploadedChunks('')).toEqual({ ok: false, entries: [], reason: 'malformed-json' })
  })

  it.each([
    ['object', '{"i":0}'],
    ['null literal', 'null'],
    ['string literal', '"nope"'],
    ['number literal', '42'],
    ['boolean literal', 'true']
  ])('reports a valid-JSON non-array payload as corrupt: %s', (_label, raw) => {
    // #then — valid JSON that is not a chunk list is just as unreadable as
    // broken JSON, and is distinguished only for triage in the log line.
    expect(readUploadedChunks(raw)).toEqual({ ok: false, entries: [], reason: 'not-an-array' })
  })

  it('agrees with parseUploadedChunks on entries for every input', () => {
    // #then — parseUploadedChunks is defined as `readUploadedChunks(...).entries`,
    // so the tolerant path can never drift from the discriminated one.
    for (const raw of ['[]', '[{"i":0,"h":"a","b":1}]', 'not json', '{}', 'null', '']) {
      expect(parseUploadedChunks(raw)).toEqual(readUploadedChunks(raw).entries)
    }
  })
})

describe('getUploadedByteTotal', () => {
  it('sums the per-chunk byte counts', () => {
    // #given
    const entries: UploadedChunkEntry[] = [
      { i: 0, h: 'hash-0', b: 100 },
      { i: 1, h: 'hash-1', b: 250 }
    ]

    // #then
    expect(getUploadedByteTotal(entries)).toBe(350)
  })

  it('returns zero for no chunks', () => {
    expect(getUploadedByteTotal([])).toBe(0)
  })

  it('accepts a zero-byte chunk as a real count, not a missing one', () => {
    // #then — 0 is a valid non-negative integer, so it must sum, not poison.
    expect(getUploadedByteTotal([{ i: 0, h: 'hash-0', b: 0 }])).toBe(0)
    expect(
      getUploadedByteTotal([
        { i: 0, h: 'hash-0', b: 0 },
        { i: 1, h: 'hash-1', b: 10 }
      ])
    ).toBe(10)
  })

  it('returns null when a chunk has no byte count at all', () => {
    // #given — `b` is optional on the interface, so pre-`b` sessions hit this.
    // #then — must NOT default the missing chunk to zero: under-counting landed
    // bytes is exactly how a client would slip past the blob.ts ceiling.
    expect(getUploadedByteTotal([{ i: 0, h: 'hash-0' }])).toBeNull()
    expect(
      getUploadedByteTotal([
        { i: 0, h: 'hash-0', b: 100 },
        { i: 1, h: 'hash-1' }
      ])
    ).toBeNull()
  })

  it.each([
    ['string', '100'],
    ['numeric string', '0'],
    ['null', null],
    ['undefined', undefined],
    ['object', {}],
    ['array', []],
    ['boolean', true],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY]
  ])('returns null for a non-integer byte count: %s', (_label, bytes) => {
    // #then — Number.isInteger rejects NaN and Infinity too, so a poisoned
    // count can never make the running total unbounded or unorderable.
    const entries = [{ i: 0, h: 'hash-0', b: bytes }] as unknown as UploadedChunkEntry[]
    expect(getUploadedByteTotal(entries)).toBeNull()
  })

  it('returns null for a fractional byte count', () => {
    expect(getUploadedByteTotal([{ i: 0, h: 'hash-0', b: 1.5 }])).toBeNull()
  })

  it('returns null for a negative byte count', () => {
    // #then — a negative count would otherwise subtract from the running total
    // and buy headroom under the blob.ts ceiling.
    expect(
      getUploadedByteTotal([
        { i: 0, h: 'hash-0', b: 1000 },
        { i: 1, h: 'hash-1', b: -900 }
      ])
    ).toBeNull()
  })

  it('short-circuits to null regardless of where the bad entry sits', () => {
    // #then — one untrustworthy entry invalidates the whole sum.
    const bad = { i: 9, h: 'hash-9' } as UploadedChunkEntry
    const good = { i: 0, h: 'hash-0', b: 10 }
    expect(getUploadedByteTotal([bad, good, good])).toBeNull()
    expect(getUploadedByteTotal([good, bad, good])).toBeNull()
    expect(getUploadedByteTotal([good, good, bad])).toBeNull()
  })

  it('composes with parseUploadedChunks to fail closed on an untrusted column', () => {
    // #given — the exact pipeline used at blob.ts:305-318 and
    // vault-deletion.ts:52.
    const trustworthy = JSON.stringify([{ i: 0, h: 'hash-0', b: 1024 + CHUNK_CRYPTO_OVERHEAD }])
    const untrustworthy = JSON.stringify([{ i: 0, h: 'hash-0' }])

    // #then
    expect(getUploadedByteTotal(parseUploadedChunks(trustworthy))).toBe(
      1024 + CHUNK_CRYPTO_OVERHEAD
    )
    expect(getUploadedByteTotal(parseUploadedChunks(untrustworthy))).toBeNull()
    // A non-array column also yields 0 landed bytes rather than a bogus credit.
    expect(getUploadedByteTotal(parseUploadedChunks('{}'))).toBe(0)
  })

  it('lets a malformed column resolve to zero landed bytes instead of throwing', () => {
    // #given — the exact expression at vault-deletion.ts:52. It computes
    // `total_size - landed`, so 0 landed releases the FULL reservation, which
    // is what that function's own JSDoc prescribes for an unparseable column.
    // Before the fix this threw and aborted the entire vault deletion.
    // #then
    expect(getUploadedByteTotal(parseUploadedChunks('not json'))).toBe(0)
    expect(getUploadedByteTotal(parseUploadedChunks(''))).toBe(0)
  })
})
