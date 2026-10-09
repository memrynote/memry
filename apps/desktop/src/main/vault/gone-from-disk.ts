/**
 * The one "is this vault file really gone" check. The watcher's unlink, the
 * vault-open note scan, the canvas reconcile and the canvas tombstone path
 * release all ask it before a removal that syncs a delete or frees a path.
 *
 * @module vault/gone-from-disk
 */

import fs from 'fs/promises'
import path from 'path'
import { createLogger } from '../lib/logger'

const logger = createLogger('GoneFromDisk')

type Presence = 'gone' | 'present' | 'unreadable'

async function presence(absolutePath: string): Promise<Presence> {
  try {
    await fs.stat(absolutePath)
    return 'present'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'unreadable'
  }
}

/**
 * True only when the file and its iCloud placeholder are both absent.
 *
 * - Only ENOENT/ENOTDIR count as absent. Any other failure (EACCES, EIO, a
 *   network volume timeout, chmod 000, an antivirus lock) means the file may
 *   still be there, so it is kept (#2764).
 * - iCloud Drive before macOS 14 evicts a file under "Optimize Mac Storage" by
 *   swapping it for a hidden `.<name>.icloud` placeholder. The file is still in
 *   the vault, just not downloaded, so it is kept (#3004). Once the placeholder
 *   is gone too, the file is (#3010).
 *
 * The caller checks that the vault is mounted (`isVaultReachable`) first: an
 * unmounted vault hides every file at once.
 */
export async function isGoneFromDisk(absolutePath: string): Promise<boolean> {
  const file = await presence(absolutePath)
  if (file === 'unreadable') {
    logger.warn('File cannot be read; keeping it', { path: absolutePath })
  }
  if (file !== 'gone') return false

  const placeholder = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.icloud`
  )
  const evicted = await presence(placeholder)
  if (evicted !== 'gone') {
    logger.info('File evicted to iCloud; keeping it', { path: absolutePath })
    return false
  }
  return true
}
