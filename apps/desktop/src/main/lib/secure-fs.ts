import { open, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createLogger } from './logger'

const log = createLogger('SecureFS')

const OVERWRITE_CHUNK_SIZE = 64 * 1024

export async function secureDeleteFile(filePath: string): Promise<void> {
  let handle

  try {
    handle = await open(filePath, 'r+')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }

    log.warn('Could not open file before deletion', {
      filePath,
      error: err instanceof Error ? err.message : String(err)
    })
    await unlink(filePath).catch((unlinkErr: NodeJS.ErrnoException) => {
      if (unlinkErr.code !== 'ENOENT') {
        throw unlinkErr
      }
    })
    return
  }

  try {
    const fileSize = (await handle.stat()).size
    let offset = 0
    while (offset < fileSize) {
      const chunkSize = Math.min(OVERWRITE_CHUNK_SIZE, fileSize - offset)
      const randomData = randomBytes(chunkSize)
      await handle.write(randomData, 0, chunkSize, offset)
      offset += chunkSize
    }
    await handle.sync()
  } catch (err) {
    log.warn('Could not overwrite file before deletion', {
      filePath,
      error: err instanceof Error ? err.message : String(err)
    })
  } finally {
    await handle.close()
  }

  await unlink(filePath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') {
      throw err
    }
  })
}
