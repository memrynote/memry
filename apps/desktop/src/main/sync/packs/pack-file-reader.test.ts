import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PACK_FOOTER_SIZE,
  PACK_MAX_ENTRIES,
  PACK_MAX_INDEX_ENTRY_BYTES
} from '@memry/contracts/pack-format'

import {
  MAX_OPEN_PACK_FILES,
  openPack,
  openPackFile,
  type PackByteSource,
  type PackFileHandle
} from './pack-file-reader'
import { buildTestPack } from './test-pack-builder'

/** Overwrite one of the footer's two uint64 fields in place. */
const rewriteFooterU64 = (
  bytes: Uint8Array,
  field: 'entryCount' | 'indexOffset',
  value: number
): void => {
  const at = bytes.length - PACK_FOOTER_SIZE + 32 + (field === 'entryCount' ? 0 : 8)
  let remaining = value
  for (let i = 7; i >= 0; i--) {
    bytes[at + i] = remaining % 256
    remaining = Math.floor(remaining / 256)
  }
}

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

  it('rejects a footer version echo that drifts from the header', async () => {
    // Header and footer both carry the version precisely so a reader can
    // refuse a file whose two halves disagree — a truncated or spliced object.
    const pack = buildTestPack([{ id: 'note-a', bytes: bodyOf('a', 32) }], { footerVersion: 99 })
    await expect(openPack(recordingSource(pack.bytes))).rejects.toThrow(/unsupported pack version/)
  })

  it('#given a corrupt index offset #then it is refused without buffering the file', async () => {
    // One flipped byte in the footer's 8-byte indexOffset still points inside
    // the file, and "read the index block" then means "read the whole pack
    // into one buffer" — three of those concurrently is an OOM of the main
    // process instead of the graceful discard the format promises.
    const pack = buildTestPack(
      Array.from({ length: 4 }, (_, i) => ({ id: `note-${i}`, bytes: bodyOf(String(i), 65_536) }))
    )
    rewriteFooterU64(pack.bytes, 'indexOffset', 8)
    const source = recordingSource(pack.bytes)

    await expect(openPack(source)).rejects.toThrow(/index block too large/)

    // Nothing bigger than the footer probe was ever asked for.
    const cap = 4 * PACK_MAX_INDEX_ENTRY_BYTES
    expect(Math.max(...source.reads.map((read) => read.length))).toBeLessThanOrEqual(cap)
    expect(Math.max(...source.reads.map((read) => read.length))).toBeLessThan(pack.bytes.length)
  })

  it('#given a corrupt entry count #then it is refused before any index read', async () => {
    const pack = buildTestPack([{ id: 'note-a', bytes: bodyOf('a', 32) }])
    rewriteFooterU64(pack.bytes, 'entryCount', PACK_MAX_ENTRIES + 1)
    const source = recordingSource(pack.bytes)

    await expect(openPack(source)).rejects.toThrow(/entry count out of bounds/)
    expect(source.reads.every((read) => read.length <= PACK_FOOTER_SIZE)).toBe(true)
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

  // A post to the crypto worker clones a view's whole buffer. A small entry read
  // into Node's shared Buffer pool sent the 8 KiB pool with every update.
  it('reads a small entry into a buffer of its own size', async () => {
    const pack = buildTestPack([
      { id: 'note-a', bytes: bodyOf('a', 200), meta: { sequenceNum: 2, revision: 'r' } }
    ])
    const file = path.join(dir, 'small.pack')
    await fs.writeFile(file, pack.bytes)

    const handle = await openPackFile(file)
    const bytes = await handle.readEntry(handle.entries[0])
    expect(structuredClone(bytes).buffer.byteLength).toBe(bytes.byteLength)
    await handle.close()
  })

  // A fresh device can hold hundreds of packs at once; one fd each ran into
  // macOS's 256-fd soft limit and dropped every pack past it to the routes.
  it.skipIf(process.platform === 'win32')(
    '#given more opened packs than the fd budget #then at most the budget stays open',
    async () => {
      const pack = buildTestPack([
        { id: 'note-a', bytes: bodyOf('a', 1000), meta: { sequenceNum: 2, revision: 'r' } }
      ])
      const openFds = async (): Promise<number> => (await fs.readdir('/dev/fd')).length
      const before = await openFds()
      const handles: PackFileHandle[] = []
      for (let i = 0; i < MAX_OPEN_PACK_FILES + 4; i++) {
        const file = path.join(dir, `p${i}.pack`)
        await fs.writeFile(file, pack.bytes)
        handles.push(await openPackFile(file))
      }
      expect(await openFds()).toBeLessThanOrEqual(before + MAX_OPEN_PACK_FILES)
      for (const handle of handles) {
        expect(await handle.readEntry(handle.entries[0])).toEqual(bodyOf('a', 1000))
      }
      expect(await openFds()).toBeLessThanOrEqual(before + MAX_OPEN_PACK_FILES)
      for (const handle of handles) await handle.close()
      expect(await openFds()).toBe(before)
    }
  )

  // An open, stat and close per document read was the pack phase's own cost.
  it('opens the file once for the verify and every entry read', async () => {
    const pack = buildTestPack(
      Array.from({ length: 5 }, (_, i) => ({
        id: `note-${i}`,
        bytes: bodyOf(String(i), 300),
        meta: { sequenceNum: i + 1, revision: 'r' }
      }))
    )
    const file = path.join(dir, 'five.pack')
    await fs.writeFile(file, pack.bytes)
    const opens = vi.spyOn(fs, 'open')

    try {
      const handle = await openPackFile(file)
      for (const [i, entry] of handle.entries.entries()) {
        expect(await handle.readEntry(entry)).toEqual(bodyOf(String(i), 300))
      }
      await handle.close()
      expect(opens).toHaveBeenCalledTimes(1)
    } finally {
      opens.mockRestore()
    }
  })

  it('#given closing a file fails #then a failed entry read keeps its own error', async () => {
    const good = buildTestPack([
      { id: 'note-a', bytes: bodyOf('a', 200), meta: { sequenceNum: 1, revision: 'r' } }
    ])
    const bad = buildTestPack(
      [{ id: 'note-b', bytes: bodyOf('b', 200), meta: { sequenceNum: 1, revision: 'r' } }],
      { breakEntryDigestFor: ['note-b'] }
    )
    const files: string[] = []
    for (let i = 0; i <= MAX_OPEN_PACK_FILES; i++) {
      files.push(path.join(dir, `p${i}.pack`))
      await fs.writeFile(files[i], i === 0 ? bad.bytes : good.bytes)
    }
    const realOpen = fs.open.bind(fs)
    const closes = vi.fn()
    // Every close really releases its fd, then reports a failure.
    const opens = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args)
      const realClose = handle.close
      handle.close = async () => {
        closes()
        await realClose()
        throw new Error('close failed')
      }
      return handle
    })

    try {
      const handles: PackFileHandle[] = []
      for (const file of files) handles.push(await openPackFile(file))
      closes.mockClear()
      // The bad pack's fd is the oldest, so reading it opens it again and
      // closes another pack's fd past the budget.
      await expect(handles[0].readEntry(handles[0].entries[0])).rejects.toThrow(
        'pack entry checksum mismatch'
      )
      expect(closes).toHaveBeenCalled()
      for (const handle of handles) await handle.close()
    } finally {
      opens.mockRestore()
    }
  })

  // Windows refuses to remove a file with an open handle, so the run's rm must
  // not start while a close the budget began is still running.
  it('#given the budget is closing a pack file #then closing the pack waits for that close', async () => {
    const pack = buildTestPack([
      { id: 'note-a', bytes: bodyOf('a', 200), meta: { sequenceNum: 1, revision: 'r' } }
    ])
    const files: string[] = []
    for (let i = 0; i <= MAX_OPEN_PACK_FILES; i++) {
      files.push(path.join(dir, `p${i}.pack`))
      await fs.writeFile(files[i], pack.bytes)
    }
    const realOpen = fs.open.bind(fs)
    const { promise: closeStarted, resolve: startClose } = Promise.withResolvers<void>()
    const { promise: closeGoes, resolve: releaseClose } = Promise.withResolvers<void>()
    const opens = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args)
      if (String(args[0]) !== files[0]) return handle
      const realClose = handle.close
      handle.close = async () => {
        startClose()
        await closeGoes
        await realClose()
      }
      return handle
    })

    try {
      const handles: PackFileHandle[] = []
      for (const file of files.slice(0, MAX_OPEN_PACK_FILES)) {
        handles.push(await openPackFile(file))
      }
      // One file past the budget: its read closes the oldest, p0.
      const last = openPackFile(files[MAX_OPEN_PACK_FILES])
      await closeStarted
      const closing = handles[0].close().then(() => 'closed')
      const settled = await Promise.race([
        closing,
        new Promise((resolve) => setImmediate(() => resolve('pending')))
      ])
      expect(settled).toBe('pending')
      releaseClose()
      await closing
      handles.push(await last)
      for (const handle of handles) await handle.close()
    } finally {
      releaseClose()
      opens.mockRestore()
    }
  })

  it('#given stat and close both fail #then opening reports the stat error', async () => {
    const file = path.join(dir, 'stat.pack')
    await fs.writeFile(file, Buffer.alloc(100))
    const realOpen = fs.open.bind(fs)
    const opens = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args)
      const realClose = handle.close
      handle.stat = async () => {
        throw new Error('stat failed')
      }
      handle.close = async () => {
        await realClose()
        throw new Error('close failed')
      }
      return handle
    })

    try {
      await expect(openPackFile(file)).rejects.toThrow('stat failed')
    } finally {
      opens.mockRestore()
    }
  })

  it('closes the file handle when opening fails', async () => {
    const file = path.join(dir, 'bad.pack')
    await fs.writeFile(file, Buffer.alloc(10))
    await expect(openPackFile(file)).rejects.toThrow('pack too small')
  })
})
