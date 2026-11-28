/**
 * The file each watched file was renamed to, as the file's own watcher named
 * it. On macOS libuv watches a file with kqueue, which reports a rename at once
 * and names the new file, and a folder with FSEvents, which can report seconds
 * later on a loaded machine, or never. chokidar's unlink comes from the file's
 * watcher and the add of the renamed file from its folder's, so the add could
 * miss the rename window, and an outside rename synced a delete plus a create.
 * The unlink takes the new path here and adds that file itself.
 *
 * Only a watched path that is gone was renamed: a folder's watcher reports
 * its files' changes as raw renames too, naming the file and not a new name.
 * The event names a basename only, read here in the watched file's folder. A
 * file moved to another folder under a new name has no such file there, so it
 * gets no name. When the old folder does hold a file of that name, only that
 * file's add can show it was the renamed one (`forgetRenameTarget`).
 *
 * @module vault/rename-targets
 */

import { lstatSync } from 'fs'
import { createLogger } from '../lib/logger'

const logger = createLogger('RenameTargets')

/** How long a rename waits for its unlink: chokidar's `atomic` holds an unlink 100 ms. */
const RENAME_TARGET_TTL_MS = 1000

/** Whether `filePath` was renamed to `target`: it is gone, and `target` is a file. */
function wasRenamedTo(filePath: string, target: string): boolean {
  try {
    return (
      lstatSync(filePath, { throwIfNoEntry: false }) === undefined &&
      lstatSync(target, { throwIfNoEntry: false })?.isFile() === true
    )
  } catch (error) {
    logger.debug(`No rename target for ${filePath}: ${String(error)}`)
    return false
  }
}

interface Entry {
  target: string
  expiry: NodeJS.Timeout
}

export class RenameTargets {
  private entries = new Map<string, Entry>()

  /** Keeps `target` for the unlink of `filePath` if the file was renamed to it. */
  record(filePath: string, target: string): boolean {
    this.take(filePath)
    if (!wasRenamedTo(filePath, target)) return false
    const expiry = setTimeout(() => this.entries.delete(filePath), RENAME_TARGET_TTL_MS)
    this.entries.set(filePath, { target, expiry })
    return true
  }

  /** The unlink takes the file's new path. */
  take(filePath: string): string | null {
    const entry = this.entries.get(filePath)
    if (!entry) return null
    clearTimeout(entry.expiry)
    this.entries.delete(filePath)
    return entry.target
  }

  clear(): void {
    for (const { expiry } of this.entries.values()) clearTimeout(expiry)
    this.entries.clear()
  }
}
