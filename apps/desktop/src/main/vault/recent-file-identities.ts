/**
 * Identity keys (`buildFileIdentityKey`) of files the watcher saw written, by
 * event path. The index row's hash trails an outside edit until the edit's
 * debounced change runs, so an unlink takes its path's key here and gives it
 * to the pending delete: a rename keeps the key, and its add still matches
 * (#5518). chokidar holds a `change` until the write finishes, and a rename
 * inside that wait never gets one, so a raw fs event records the key first
 * (#5549).
 *
 * @module vault/recent-file-identities
 */

import type { Stats } from 'fs'
import { buildFileIdentityKey } from './rename-tracker'

/**
 * How long a change's key outlives its debounced change. chokidar's `atomic`
 * holds an unlink 100 ms, so a rename made while the change ran reports its
 * unlink after it; past that, the row's hash has caught up.
 */
export const CHANGE_KEY_GRACE_MS = 500

/**
 * How long a raw write's key lives without a `change`: chokidar's write-finish
 * wait (100 ms stable), then `atomic`'s 100 ms unlink hold, with margin.
 */
export const WRITE_KEY_TTL_MS = 1000

/** The file a key belongs to, whatever its size and mtime. */
function fileOf(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`
}

interface Entry {
  key: string
  file: string
  /** Set while a `change` holds the key until its debounced change ran. */
  change: number | null
  expiry: NodeJS.Timeout | null
}

export class RecentFileIdentities {
  private entries = new Map<string, Entry>()
  private changes = 0

  /** A raw fs event on the file, before chokidar reports any change. */
  recordWrite(filePath: string, stats: Stats): void {
    const key = buildFileIdentityKey(stats)
    if (key === null) return
    const entry = this.entries.get(filePath)
    if (entry?.change != null) {
      entry.key = key
      entry.file = fileOf(stats)
      return
    }
    this.set(filePath, { key, file: fileOf(stats), change: null, expiry: null }, WRITE_KEY_TTL_MS)
  }

  /**
   * `filePath`'s own watcher named the file's new name, and `renamedStats` are
   * the file there now: it takes the key only if it is the file the key is of.
   */
  recordRenamed(filePath: string, renamedStats: Stats): void {
    const entry = this.entries.get(filePath)
    const key = buildFileIdentityKey(renamedStats)
    if (key !== null && entry?.file === fileOf(renamedStats)) entry.key = key
  }

  /**
   * chokidar's `change`: the key stays until `changeRan` releases it. A file
   * with no identity drops any older key, so it keeps the hash-only match.
   */
  recordChange(filePath: string, stats: Stats | undefined): void {
    const key = stats ? buildFileIdentityKey(stats) : null
    if (!stats || key === null) {
      this.take(filePath)
      return
    }
    this.set(filePath, { key, file: fileOf(stats), change: ++this.changes, expiry: null }, null)
  }

  /**
   * Call when the debounced change starts; the returned release starts the
   * grace period. A newer change re-armed the debounce and keeps its own key.
   */
  changeRan(filePath: string): () => void {
    const change = this.entries.get(filePath)?.change ?? null
    return () => {
      const entry = this.entries.get(filePath)
      if (change === null || entry?.change !== change) return
      entry.change = null
      this.set(filePath, entry, CHANGE_KEY_GRACE_MS)
    }
  }

  /** The unlink takes the file's key. */
  take(filePath: string): string | null {
    const entry = this.entries.get(filePath)
    if (!entry) return null
    if (entry.expiry) clearTimeout(entry.expiry)
    this.entries.delete(filePath)
    return entry.key
  }

  clear(): void {
    for (const entry of this.entries.values()) if (entry.expiry) clearTimeout(entry.expiry)
    this.entries.clear()
  }

  private set(filePath: string, entry: Entry, ttl: number | null): void {
    const previous = this.entries.get(filePath)
    if (previous?.expiry) clearTimeout(previous.expiry)
    entry.expiry =
      ttl === null
        ? null
        : setTimeout(() => {
            if (this.entries.get(filePath) === entry) this.entries.delete(filePath)
          }, ttl)
    this.entries.set(filePath, entry)
  }
}
