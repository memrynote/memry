import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openPack, openPackFile, type PackByteSource } from './pack-file-reader'
import { buildTestPack } from './test-pack-builder'

const bodyOf = (id: string, size: number): Uint8Array =>
  Uint8Array.from({ length: size }, (_, i) => (id.charCodeAt(0) + i) % 251)

/** Byte source over a buffer that records every read it is asked for. */
const recordingSource = (
  bytes: Uint8Array
): PackByteSource & { reads: Array<{ position: number; length: number }> } => {
  const reads: Array<{ position: number; length: number }> = []
  return {
    reads,
    size: bytes.length,
    read: async (position, length) => {
      reads.push({ position, length })
      if (position + length > bytes.length) throw new Error('pack truncated')
      return bytes.subarray(position, position + length)
    },
    close: async () => {}
  }
}

describe('pack file reader', () => {
  it('decodes the index and returns verified entry payloads', async () => {
    const pack = buildTestPack([
      { id: 'note-a', bytes: bodyOf('a', 64), meta: { sequenceNum: 3, revision: 'r-a' } },
      { id: 'note-b', bytes: bodyOf('b', 128), meta: { sequenceNum: 9, revision: 'r-b' } }
    ])

    const handle = await openPack(recordingSource(pack.bytes))
    expect(handle.entries.map((entry) => entry.id)).toEqual(['note-a', 'note-b'])
    expect(handle.entries[1].meta).toEqual({ sequenceNum: 9, revision: 'r-b' })
    expect(await handle.readEntry(handle.entries[0])).toEqual(bodyOf('a', 64))
    expect(await handle.readEntry(handle.entries[1])).toEqual(bodyOf('b', 128))
    await handle.close()
  })

  it('never reads the pack as one buffer — payload hashing is chunked', async () => {
    // 40 entries x 4KB = a 160KB payload region, read at 1KB per iteration.
    const entries = Array.from({ length: 40 }, (_, i) => ({
      id: `note-${i}`,
      bytes: bodyOf(String(i), 4096),
      meta: { sequenceNum: i + 1, revision: `r-${i}` }
    }))
    const pack = buildTestPack(entries)
    const source = recordingSource(pack.bytes)

    const handle = await openPack(source, { readChunkBytes: 1024 })

    const payloadBytes = pack.indexOffset - pack.payloadStart
    expect(payloadBytes).toBeGreaterThan(150_000)
    // Not one read covers the whole file, nor the whole payload region.
    const longest = Math.max(...source.reads.map((read) => read.length))
    expect(longest).toBeLessThan(payloadBytes)
    expect(longest).toBeLessThan(pack.bytes.length)
    // Payload hashing specifically stayed at the configured chunk size.
    const payloadReads = source.reads.filter(
      (read) => read.position >= pack.payloadStart && read.position < pack.indexOffset
    )
    expect(Math.max(...payloadReads.map((read) => read.length))).toBeLessThanOrEqual(1024)

    // Reading one entry costs exactly that entry, never more.
    const before = source.reads.length
    await handle.readEntry(handle.entries[7])
    expect(source.reads.slice(before)).toEqual([
      { position: pack.payloadStart + 7 * 4096, length: 4096 }
    ])
    await handle.close()
  })

  it('rejects a corrupt footer magic', async () => {
    const pack = buildTestPack([{ id: 'note-a', bytes: bodyOf('a', 32) }])
    pack.bytes[pack.bytes.length - 5] = 'X'.charCodeAt(0)
    await expect(openPack(recordingSource(pack.bytes))).rejects.toThrow(/footer magic/)
  })

  it('rejects an unsupported version', async () => {
    const pack = buildTestPack([{ id: 'note-a', bytes: bodyOf('a', 32) }], { version: 99 })
    await expect(openPack(recordingSource(pack.bytes))).rejects.toThrow(/unsupported pack version/)
  })

  it('rejects a bad whole-payload digest', async () => {
    const pack = buildTestPack([{ id: 'note-a', bytes: bodyOf('a', 32) }], {
      breakPayloadDigest: true
    })
    await expect(openPack(recordingSource(pack.bytes))).rejects.toThrow(/payload checksum/)
  })

  it('rejects one entry with a bad per-entry digest while the pack still opens', async () => {
    const pack = buildTestPack(
      [
        { id: 'note-a', bytes: bodyOf('a', 32) },
        { id: 'note-b', bytes: bodyOf('b', 32) }
      ],
      { breakEntryDigestFor: ['note-b'] }
    )
    const handle = await openPack(recordingSource(pack.bytes))
    // The payload region hashes fine — only note-b's index digest is wrong, so
    // the failure has to be per entry, not per pack.
    await expect(handle.readEntry(handle.entries[0])).resolves.toBeInstanceOf(Uint8Array)
    await expect(handle.readEntry(handle.entries[1])).rejects.toThrow(/entry checksum mismatch/)
    await handle.close()
  })

  it('rejects a truncated file before decoding anything', async () => {
    const pack = buildTestPack([{ id: 'note-a', bytes: bodyOf('a', 32) }])
    await expect(openPack(recordingSource(pack.bytes.subarray(0, 20)))).rejects.toThrow(
      /pack too small|truncated/
    )
  })
})

describe('openPackFile', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memry-pack-reader-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('reads a real file off disk', async () => {
    const pack = buildTestPack([
      { id: 'note-a', bytes: bodyOf('a', 1000), meta: { sequenceNum: 2, revision: 'r' } }
    ])
    const file = path.join(dir, 'one.pack')
    await fs.writeFile(file, pack.bytes)

    const handle = await openPackFile(file)
    expect(handle.entries).toHaveLength(1)
    expect(await handle.readEntry(handle.entries[0])).toEqual(bodyOf('a', 1000))
    await handle.close()
  })

  it('closes the file handle when opening fails', async () => {
    const file = path.join(dir, 'bad.pack')
    await fs.writeFile(file, Buffer.alloc(10))
    await expect(openPackFile(file)).rejects.toThrow()
  })
})
