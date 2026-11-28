/**
 * The identity key (`buildAddedFileIdentityKey`) each file had when the
 * watcher's add of it began, by event path. One add can reach the watcher
 * twice: macOS can deliver a write's FSEvents in two batches, which chokidar
 * reports as an add and then a change, and a renamed file is added from its
 * unlink and again from its folder's event (`addRenamedFile`). An add or a
 * change of a file whose key is unchanged since then is that add's own event.
 * Run, the change of a binary pushed bytes nobody changed, and the add of a
 * note the index had not read fed its body to the note's doc.
 *
 * A key is taken before the add reads the file, so a write while the add
 * runs, which chokidar can fold into its event, changes the key.
 *
 * A key proves the file unchanged only if any later write moves its mtime.
 * An mtime with a fraction of a second comes from a disk that keeps finer
 * times (APFS, NTFS, ext4), where `awaitWriteFinish` holds the add 100 ms past
 * the last write. HFS+ keeps whole seconds, FAT and exFAT two, and so do some
 * network shares: there a same-size edit inside the add's second kept the key,
 * its change was dropped, and the next in-app edit wrote the old body over
 * it. No clock tells such an edit apart, since a share stamps mtimes with
 * the server's: a whole-second key counts only with the content hash of the
 * bytes the add read, which the file must still hash to. An add that read no
 * bytes, a binary's or a new note's, keeps no such key.
 *
 * @module vault/added-file-keys
 */

import type { Stats } from 'fs'
import { buildAddedFileIdentityKey } from './rename-tracker'

/** How long a key lives: past the latest FSEvents delivery seen on a loaded machine. */
const ADDED_KEY_TTL_MS = 120_000

interface Entry {
  key: string
  /** For a whole-second mtime, the hash of the bytes the add read. */
  contentHash: string | null
  recordedAt: number
}

export class AddedFileKeys {
  private entries = new Map<string, Entry>()
  private sweptAt = 0

  /**
   * The add of `filePath`, which found `stats` as it began, ran to its end,
   * and read bytes with `readHash` if it read the file.
   */
  record(filePath: string, stats: Stats, readHash: string | null): void {
    const key = buildAddedFileIdentityKey(stats)
    const wholeSecond = stats.mtimeMs % 1000 === 0
    const contentHash = wholeSecond ? readHash : null
    if (key === null || (wholeSecond && contentHash === null)) {
      this.entries.delete(filePath)
      return
    }
    const now = Date.now()
    if (now - this.sweptAt >= ADDED_KEY_TTL_MS) {
      this.sweptAt = now
      for (const [swept, entry] of this.entries) {
        if (now - entry.recordedAt >= ADDED_KEY_TTL_MS) this.entries.delete(swept)
      }
    }
    this.entries.set(filePath, { key, contentHash, recordedAt: now })
  }

  /** Whether `filePath`, which has `stats` now, is unchanged since an add read it. */
  async unchanged(
    filePath: string,
    stats: Stats | null,
    hashOf: (filePath: string) => Promise<string | null>
  ): Promise<boolean> {
    const entry = this.entries.get(filePath)
    const key = stats && buildAddedFileIdentityKey(stats)
    if (!key || entry?.key !== key || Date.now() - entry.recordedAt >= ADDED_KEY_TTL_MS) {
      return false
    }
    return entry.contentHash === null || (await hashOf(filePath)) === entry.contentHash
  }

  forget(filePath: string): void {
    this.entries.delete(filePath)
  }

  clear(): void {
    this.entries.clear()
  }
}
