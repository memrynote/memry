import { createHash } from 'crypto'
import fs from 'fs/promises'
import type { FileHandle } from 'fs/promises'

/**
 * The sha256 (hex, as an attachment manifest's checksum) of the file at
 * `filePath`, or null when nothing is there. Read in 1 MiB windows, so a
 * large file never sits in memory whole. No Electron or database imports: the
 * large-file worker runs it.
 */
export async function sha256OfFile(filePath: string): Promise<string | null> {
  let handle: FileHandle
  try {
    handle = await fs.open(filePath, 'r')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  try {
    const hash = createHash('sha256')
    const window = Buffer.allocUnsafe(1024 * 1024)
    let read: number
    while ((read = (await handle.read(window, 0, window.length, null)).bytesRead) > 0) {
      hash.update(window.subarray(0, read))
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}
