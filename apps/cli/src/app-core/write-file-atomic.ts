import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Replaces `filePath` in one rename, so a concurrent reader sees the old or the new file, never half of one. */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = path.join(path.dirname(filePath), `.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await fs.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    await fs.rename(tmpPath, filePath)
  } catch (error) {
    await fs.rm(tmpPath, { force: true })
    throw error
  }
}
