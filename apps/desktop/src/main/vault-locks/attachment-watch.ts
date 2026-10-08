/**
 * Read-only again for files added or replaced outside the app in a locked
 * note's attachments folder, sync downloads included. The vault watcher skips
 * the attachments folder so it never indexes attachments; this watch covers it
 * only while a lock exists, and does nothing but protect locked files.
 *
 * @module vault-locks/attachment-watch
 */

import path from 'path'
import chokidar from 'chokidar'
import { createLogger } from '../lib/logger'
import { protectLockedFile } from './files'

const log = createLogger('VaultLockAttachments')

interface AttachmentWatch {
  root: string
  /** Settles once chokidar is ready, or when the watch is closed before that. */
  ready: Promise<void>
  close(): Promise<void>
}

let active: AttachmentWatch | null = null

function startWatch(root: string): AttachmentWatch {
  const protect = (filePath: string): void => void protectLockedFile(filePath)
  const watcher = chokidar
    .watch(root, {
      ignoreInitial: true,
      depth: 1,
      followSymlinks: false,
      ignored: (filePath) => path.basename(filePath).startsWith('.'),
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
    })
    .on('add', protect)
    .on('change', protect)
    .on('error', (error) => log.warn('Watching locked attachments failed', { error }))
  let settle = (): void => {}
  const ready = new Promise<void>((resolve) => (settle = resolve))
  watcher.once('ready', settle)
  return {
    root,
    ready,
    close: async () => {
      settle()
      await watcher.close()
    }
  }
}

/** Watch this attachments root, or nothing for null. A new root replaces the old one. */
export async function watchLockedAttachments(root: string | null): Promise<void> {
  if ((active?.root ?? null) === root) return
  const previous = active
  const next = root === null ? null : startWatch(root)
  active = next
  await previous?.close()
  await next?.ready
}
