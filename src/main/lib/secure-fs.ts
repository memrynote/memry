import { open, unlink, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createLogger } from './logger'

const log = createLogger('SecureFS')

const OVERWRITE_CHUNK_SIZE = 64 * 1024

export async function secureDeleteFile(filePath: string): Promise<void> {
  let fileSize: number
  try {
    const info = await stat(filePath)
    fileSize = info.size
  } catch {
    return
  }

  try {
    const handle = await open(filePath, 'r+')
    try {
      let offset = 0
      while (offset < fileSize) {
        const chunkSize = Math.min(OVERWRITE_CHUNK_SIZE, fileSize - offset)
        const randomData = randomBytes(chunkSize)
        await handle.write(randomData, 0, chunkSize, offset)
        offset += chunkSize
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (err) {
    log.warn('Could not overwrite file before deletion', {
      filePath,
      error: err instanceof Error ? err.message : String(err)
    })
  }

  await unlink(filePath)
}
