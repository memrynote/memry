import yauzl from 'yauzl'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

export interface ZipEntry {
  /** Path within the (possibly nested) archive, e.g. "Parent Page <id>/Child Page <id>.html". */
  filepath: string
  /** Basename, e.g. "Child Page <id>.html". */
  name: string
  /** Lowercased extension without dot, e.g. "html". */
  extension: string
  /** Parent dir within the archive ("" at root). */
  parent: string
  read(): Promise<Buffer>
  readText(): Promise<string>
}

type EntryCallback = (entry: ZipEntry) => Promise<void>

/** Throws if a zip entry path would escape the archive root (zip-slip). */
export function assertSafeEntryPath(entryPath: string): void {
  const normalized = path.normalize(entryPath)
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error(`Unsafe zip entry path: ${entryPath}`)
  }
}

/**
 * Iterate every file entry across the given zip files, recursing into a nested
 * `.zip` only when it sits at the root of its parent archive (Notion exports
 * wrap content in `Export-….zip → …-Part-N.zip`). Non-root zips are treated as
 * ordinary attachments and surfaced as entries.
 */
export async function forEachZipEntry(
  zipPaths: string[],
  signal: AbortSignal,
  cb: EntryCallback
): Promise<void> {
  for (const zipPath of zipPaths) {
    if (signal.aborted) return
    const buffer = await readFile(zipPath)
    await iterateBuffer(buffer, signal, cb)
  }
}

async function iterateBuffer(
  buffer: Buffer,
  signal: AbortSignal,
  cb: EntryCallback
): Promise<void> {
  const entries = await readZipEntries(buffer)
  for (const entry of entries) {
    if (signal.aborted) return
    if (entry.fileName.endsWith('/')) continue // directory marker
    assertSafeEntryPath(entry.fileName)

    const extension = extensionOf(entry.fileName)
    const parent = parentOf(entry.fileName)

    if (extension === 'zip' && parent === '') {
      const nested = await entry.read()
      await iterateBuffer(nested, signal, cb)
      continue
    }

    await cb({
      filepath: entry.fileName,
      name: path.posix.basename(entry.fileName),
      extension,
      parent,
      read: () => entry.read(),
      readText: async () => (await entry.read()).toString('utf8')
    })
  }
}

// --- yauzl glue (promisified) ---

interface RawEntry {
  fileName: string
  read(): Promise<Buffer>
}

function readZipEntries(buffer: Buffer): Promise<RawEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) {
        reject(err ?? new Error('Failed to open zip'))
        return
      }
      const out: RawEntry[] = []
      zip.on('entry', (entry) => {
        out.push({
          fileName: entry.fileName,
          read: () =>
            new Promise<Buffer>((res, rej) => {
              zip.openReadStream(entry, (e, stream) => {
                if (e || !stream) {
                  rej(e ?? new Error('Failed to open read stream'))
                  return
                }
                const chunks: Buffer[] = []
                stream.on('data', (c) => chunks.push(c as Buffer))
                stream.on('end', () => res(Buffer.concat(chunks)))
                stream.on('error', rej)
              })
            })
        })
        zip.readEntry()
      })
      zip.on('end', () => resolve(out))
      zip.on('error', reject)
      zip.readEntry()
    })
  })
}

function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf('.')
  return i < 0 ? '' : fileName.slice(i + 1).toLowerCase()
}

function parentOf(fileName: string): string {
  const parent = path.posix.dirname(fileName)
  return parent === '.' ? '' : parent
}
