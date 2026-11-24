import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'

import {
  PACK_FOOTER_SIZE,
  PACK_HEADER_SIZE,
  PACK_MAX_ENTRIES,
  PACK_MAX_INDEX_BYTES,
  PACK_MAX_INDEX_ENTRY_BYTES,
  decodePackIndex,
  packBytesEqual,
  readFooter,
  readPackHeader,
  type PackIndexEntry
} from '@memry/contracts/pack-format'

import { createLogger } from '../../lib/logger'

const log = createLogger('PackReader')

/**
 * Bytes read per payload-hash iteration. The whole point of this module is
 * that a pack — up to PACK_TARGET_BYTES on the server, tens of megabytes — is
 * verified and consumed WITHOUT ever existing as one buffer in the main
 * process, so nothing here may read a region proportional to the file.
 */
export const PACK_READ_CHUNK_BYTES = 256 * 1024

/**
 * Random-access byte source over a pack. The file-backed implementation is the
 * production one; the seam exists so the reader's memory discipline is
 * assertable (a test source records every read length) and so a reader can be
 * driven without touching a real filesystem.
 */
export interface PackByteSource {
  readonly size: number
  /** Read exactly `length` bytes at `position`; short reads throw. */
  read(position: number, length: number): Promise<Uint8Array>
  close(): Promise<void>
}

export const openFileByteSource = async (filePath: string): Promise<PackByteSource> => {
  const handle = await fs.open(filePath, 'r')
  let size: number
  try {
    size = (await handle.stat()).size
  } catch (err) {
    await handle.close().catch(() => {
      /* the stat failure is the interesting one */
    })
    throw err
  }
  return {
    size,
    read: async (position, length) => {
      if (length < 0 || position < 0 || position + length > size) {
        throw new Error('pack read out of bounds')
      }
      // Not Buffer.allocUnsafe: a small read lands in Node's shared pool, and
      // a post to the crypto worker clones the view's whole 8 KiB buffer.
      const bytes = new Uint8Array(length)
      const { bytesRead } = await handle.read(bytes, 0, length, position)
      if (bytesRead !== length) throw new Error('pack truncated')
      return bytes
    },
    close: () => handle.close()
  }
}

export interface PackFileHandle {
  /** Index records in file order, each carrying its own payload digest. */
  readonly entries: PackIndexEntry[]
  /**
   * Read one entry's payload bytes and verify them against the digest the
   * index recorded. A mismatch throws — the caller discards that entry (or the
   * pack) and falls back to the item-granular endpoints.
   */
  readEntry(entry: PackIndexEntry): Promise<Uint8Array>
  close(): Promise<void>
}

export interface OpenPackOptions {
  readChunkBytes?: number
  /**
   * Verify the whole-payload digest before handing back a handle. On by
   * default — this is the format's "discard anything failing checksum" rule —
   * and streamed in `readChunkBytes` slices, never as one buffer.
   */
  verifyPayloadDigest?: boolean
}

/**
 * Open a pack for STREAM-APPLY off disk (#1840).
 *
 * Reads, in order: the trailing footer (magic + version + index location), the
 * 8-byte header (magic + version again), the index block, then — chunked — the
 * payload region for the whole-payload digest. Peak memory is the index block
 * plus one `readChunkBytes` slice, whatever the pack's size.
 *
 * Every structural failure throws. A bad pack is never fatal to bootstrap: the
 * caller drops it and lets the item-granular endpoints serve those items.
 */
export const openPack = async (
  source: PackByteSource,
  options: OpenPackOptions = {}
): Promise<PackFileHandle> => {
  const chunkBytes = Math.max(1, options.readChunkBytes ?? PACK_READ_CHUNK_BYTES)

  if (source.size < PACK_HEADER_SIZE + PACK_FOOTER_SIZE) throw new Error('pack too small')

  const footer = readFooter(await source.read(source.size - PACK_FOOTER_SIZE, PACK_FOOTER_SIZE))
  readPackHeader(await source.read(0, PACK_HEADER_SIZE))

  const indexEnd = source.size - PACK_FOOTER_SIZE
  if (footer.indexOffset < PACK_HEADER_SIZE || footer.indexOffset > indexEnd) {
    throw new Error('pack index offset out of bounds')
  }
  if (footer.entryCount < 0 || footer.entryCount > PACK_MAX_ENTRIES) {
    throw new Error('pack entry count out of bounds')
  }

  // The index block is the ONE allocation sized by a field read out of the
  // pack, so it is bounded before the read rather than after it. Without this,
  // a single corrupt byte in the footer's 8-byte indexOffset still points
  // inside the file and turns this call into "buffer the whole pack" — three
  // of those concurrently is an OOM of the main process instead of the
  // graceful discard the format promises.
  const indexLength = indexEnd - footer.indexOffset
  const indexCap = Math.min(PACK_MAX_INDEX_BYTES, footer.entryCount * PACK_MAX_INDEX_ENTRY_BYTES)
  if (indexLength > indexCap) throw new Error('pack index block too large')

  const indexBytes = await source.read(footer.indexOffset, indexLength)
  const entries = decodePackIndex(indexBytes, footer.entryCount)

  const payloadEnd = footer.indexOffset
  for (const entry of entries) {
    const start = PACK_HEADER_SIZE + entry.offset
    if (entry.length < 0 || start + entry.length > payloadEnd) {
      throw new Error(`pack entry out of bounds: ${entry.id}`)
    }
  }

  if (options.verifyPayloadDigest !== false) {
    const hash = createHash('sha256')
    for (let at = PACK_HEADER_SIZE; at < payloadEnd; at += chunkBytes) {
      hash.update(await source.read(at, Math.min(chunkBytes, payloadEnd - at)))
    }
    if (!packBytesEqual(new Uint8Array(hash.digest()), footer.payloadSha256)) {
      throw new Error('pack payload checksum mismatch')
    }
  }

  log.debug('Pack opened', { entryCount: entries.length, fileBytes: source.size })

  return {
    entries,
    readEntry: (entry) => readVerifiedEntry(source, entry),
    close: () => source.close()
  }
}

const readVerifiedEntry = async (
  source: PackByteSource,
  entry: PackIndexEntry
): Promise<Uint8Array> => {
  const bytes = await source.read(PACK_HEADER_SIZE + entry.offset, entry.length)
  const digest = new Uint8Array(createHash('sha256').update(bytes).digest())
  if (!packBytesEqual(digest, entry.sha256)) {
    throw new Error(`pack entry checksum mismatch: ${entry.id}`)
  }
  return bytes
}

/**
 * Pack files held open at once, across every opened pack. A fresh device holds
 * every pack until the manifest is read, and one fd per pack ran past macOS's
 * 256-fd soft limit (EMFILE dropped those packs to the routes). Opening the
 * file again for every entry read cost an open, stat and close per document.
 */
export const MAX_OPEN_PACK_FILES = 16

interface PackFile {
  readonly filePath: string
  source: Promise<PackByteSource> | null
  /** Settles once every close started on this file has finished. */
  closed: Promise<void>
  reads: number
}

// Pack files holding an fd, least recently read first.
const openFiles = new Set<PackFile>()

const closeSource = async (source: Promise<PackByteSource>): Promise<void> => {
  try {
    await (await source).close()
  } catch (error) {
    log.debug('Could not close a pack file', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/**
 * Close the file's fd. A close failure is logged, never thrown over a read's
 * result. A close the budget already started is waited for too: Windows cannot
 * remove a file whose handle is still open.
 */
const closeFile = async (file: PackFile): Promise<void> => {
  const source = file.source
  if (source) {
    file.source = null
    openFiles.delete(file)
    file.closed = Promise.all([file.closed, closeSource(source)]).then(() => undefined)
  }
  await file.closed
}

const withSource = async <T>(
  file: PackFile,
  read: (source: PackByteSource) => Promise<T>
): Promise<T> => {
  file.reads++
  try {
    const opening = (file.source ??= openFileByteSource(file.filePath))
    openFiles.delete(file)
    openFiles.add(file)
    let source: PackByteSource
    try {
      source = await opening
    } catch (error) {
      // Not cached: an EMFILE or a racing unlink may not last.
      if (file.source === opening) {
        file.source = null
        openFiles.delete(file)
      }
      throw error
    }
    return await read(source)
  } finally {
    file.reads--
    // Over budget, the least recently read idle files close. A file with a
    // read in flight never does.
    for (const held of openFiles) {
      if (openFiles.size <= MAX_OPEN_PACK_FILES) break
      if (held.reads === 0) await closeFile(held)
    }
  }
}

/**
 * Open a pack straight from a temp file path. The file stays open for entry
 * reads within the `MAX_OPEN_PACK_FILES` budget, which every opened pack
 * shares; past it, the least recently read pack's file closes and opens again
 * on its next read.
 */
export const openPackFile = async (
  filePath: string,
  options: OpenPackOptions = {}
): Promise<PackFileHandle> => {
  const file: PackFile = { filePath, source: null, closed: Promise.resolve(), reads: 0 }
  let entries: PackIndexEntry[]
  try {
    entries = (await withSource(file, (source) => openPack(source, options))).entries
  } catch (error) {
    await closeFile(file)
    throw error
  }
  let closed = false
  return {
    entries,
    readEntry: async (entry) => {
      if (closed) throw new Error('pack closed')
      return withSource(file, (source) => readVerifiedEntry(source, entry))
    },
    close: async () => {
      closed = true
      await closeFile(file)
    }
  }
}
