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
 * chokidar reads a folder, then watches it, and on macOS the watch starts
 * later still, so a file written in between reports nothing. The folder is
 * read again once its watch has had time to start; for the root, which holds
 * one folder per note, each of those folders is.
 */
const RESCAN_AFTER_MS = 2000

const isHidden = (filePath: string): boolean => path.basename(filePath).startsWith('.')

async function protectFilesIn(folder: string, depth: number): Promise<void> {
  try {
    for (const entry of await fs.promises.readdir(folder, { withFileTypes: true })) {
      if (isHidden(entry.name)) continue
      const entryPath = path.join(folder, entry.name)
      if (entry.isFile()) protect(entryPath)
      else if (entry.isDirectory() && depth > 0) await protectFilesIn(entryPath, depth - 1)
    }
  } catch (error) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- caught fs error; only .code is read and a non-errno value yields undefined
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Could not read a locked attachments folder again', { error })
    }
  }
}

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
  const rescans = new Set<NodeJS.Timeout>()
  const watcher = chokidarWatch(root, {
    depth: 1,
    followSymlinks: false,
    ignored: isHidden,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
  })
    .on('add', protect)
    .on('change', protect)
    .on('addDir', (folder) => {
      const rescan = setTimeout(() => {
        rescans.delete(rescan)
        void protectFilesIn(folder, folder === root ? 1 : 0)
      }, RESCAN_AFTER_MS)
      rescans.add(rescan)
    })
    .on('error', (error) => log.warn('Watching locked attachments failed', { error }))
  return {
    root,
    close: () => {
      for (const rescan of rescans) clearTimeout(rescan)
      return watcher.close()
    }
  }
}

/** Watch this attachments root, or nothing for null. A new root replaces the old one. */
export async function watchLockedAttachments(root: string | null): Promise<void> {
  if ((active?.root ?? null) === root) return
  const previous = active
  active = root === null ? null : startWatch(root)
  await previous?.close()
}
