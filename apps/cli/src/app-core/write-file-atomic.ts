import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { errorCode } from './errno.ts'

/** Waits between rename attempts, as desktop's `fs_atomic::RETRY_DELAYS_MS`. */
const RETRY_DELAYS_MS = [50, 150, 450]

/** A sharing or lock violation (Windows: a reader holds the file open). */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Replaces `filePath` in one rename, so a concurrent reader sees the old or the new file,
 * never half of one, and power loss leaves one of them, as desktop's `fs_atomic` does: the
 * temp is synced before the rename and the folder after it. The replaced file keeps its
 * mode (0600 for a new one). A symlinked `filePath` updates its target, which must resolve
 * inside `root`.
 */
export async function writeFileAtomic(
  root: string,
  filePath: string,
  content: string
): Promise<void> {
  const target = await resolveInside(root, filePath)
  const mode = await existingMode(target)
  const dir = path.dirname(target)
  const tmpPath = path.join(dir, `.${randomBytes(6).toString('hex')}.tmp`)
  try {
    const handle = await fs.open(tmpPath, 'wx', 0o600)
    try {
      await handle.writeFile(content, 'utf-8')
      // The open mode is masked by the umask; chmod sets it exactly.
      if (mode !== undefined) await handle.chmod(mode)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(tmpPath, target)
  } catch (error) {
    await fs.rm(tmpPath, { force: true })
    throw error
  }
  await syncDir(dir)
}

async function resolveInside(root: string, filePath: string): Promise<string> {
  const realRoot = await fs.realpath(root)
  let resolved: string
  try {
    resolved = await fs.realpath(filePath)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
    // A dangling symlink is not a missing file: refuse rather than replace the link.
    const link = await fs.lstat(filePath).catch(() => undefined)
    if (link?.isSymbolicLink())
      throw new Error(`${filePath} is a link to a missing file`, { cause: error })
    resolved = path.join(await fs.realpath(path.dirname(filePath)), path.basename(filePath))
  }
  const relative = path.relative(realRoot, resolved)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${filePath} resolves outside the vault; it is not written`)
  }
  return resolved
}

async function existingMode(target: string): Promise<number | undefined> {
  try {
    const stat = await fs.stat(target)
    return stat.isFile() ? stat.mode & 0o7777 : undefined
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (const delay of RETRY_DELAYS_MS) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      const code = errorCode(error)
      if (code === undefined || !TRANSIENT_CODES.has(code)) throw error
      await sleep(delay)
    }
  }
  await fs.rename(from, to)
}

/** Makes the rename durable. POSIX only: Windows cannot open a folder for sync. */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fs.open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
