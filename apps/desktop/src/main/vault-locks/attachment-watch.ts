/**
 * Read-only again for files added or replaced outside the app in a locked
 * note's attachments folder, sync downloads included. The vault watcher skips
 * the attachments folder so it never indexes attachments; this watch covers it
 * only while a lock exists, and does nothing but protect locked files.
 *
 * @module vault-locks/attachment-watch
 */

import fs from 'fs'
import path from 'path'
import { watch as chokidarWatch } from 'chokidar'
import { createLogger } from '../lib/logger'
import { protectLockedFile } from './files'

const log = createLogger('VaultLockAttachments')

interface AttachmentWatch {
  root: string
  close(): Promise<void>
}

let active: AttachmentWatch | null = null

const protect = (filePath: string): void => void protectLockedFile(filePath)

/**
 * chokidar never reports a root created after the watch starts, so the root is
 * created first. Not recursive: a vault folder that went away is not recreated.
 * Files found by the initial scan are protected too, so nothing waits for the
 * scan and a file added while it runs is not missed.
 */
function startWatch(root: string): AttachmentWatch {
  try {
    fs.mkdirSync(root)
  } catch (error) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- caught fs error; only .code is read and a non-errno value yields undefined
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      log.warn('Could not create the attachments folder to watch', { error })
    }
  }
  const watcher = chokidarWatch(root, {
    depth: 1,
    followSymlinks: false,
    ignored: (filePath) => path.basename(filePath).startsWith('.'),
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
  })
    .on('add', protect)
    .on('change', protect)
    .on('error', (error) => log.warn('Watching locked attachments failed', { error }))
  return { root, close: () => watcher.close() }
}

/** Watch this attachments root, or nothing for null. A new root replaces the old one. */
export async function watchLockedAttachments(root: string | null): Promise<void> {
  if ((active?.root ?? null) === root) return
  const previous = active
  active = root === null ? null : startWatch(root)
  await previous?.close()
}
