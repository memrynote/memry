/**
 * The file each watched file was renamed to, as the file's own watcher named
 * it. On macOS libuv watches a file with kqueue, which reports a rename at once
 * and names the new file, and a folder with FSEvents, which can report seconds
 * later on a loaded machine, or never. chokidar's unlink comes from the file's
 * watcher and the add of the renamed file from its folder's, so the add could
 * miss the rename window, and an outside rename synced a delete plus a create.
 * The unlink takes the new path here and adds that file itself.
 *
 * @module vault/rename-targets
 */

/** How long a rename waits for its unlink: chokidar's `atomic` holds an unlink 100 ms. */
const RENAME_TARGET_TTL_MS = 1000

interface Entry {
  target: string
  expiry: NodeJS.Timeout
}

export class RenameTargets {
  private entries = new Map<string, Entry>()

  record(filePath: string, target: string): void {
    this.take(filePath)
    const expiry = setTimeout(() => this.entries.delete(filePath), RENAME_TARGET_TTL_MS)
    this.entries.set(filePath, { target, expiry })
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
