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
 * @module vault/added-file-keys
 */

/** How long a key lives: past the latest FSEvents delivery seen on a loaded machine. */
const ADDED_KEY_TTL_MS = 120_000

interface Entry {
  key: string
  recordedAt: number
}

export class AddedFileKeys {
  private entries = new Map<string, Entry>()
  private sweptAt = 0

  /** The add of `filePath`, keyed `key` when it began, ran to its end. */
  record(filePath: string, key: string): void {
    const now = Date.now()
    if (now - this.sweptAt >= ADDED_KEY_TTL_MS) {
      this.sweptAt = now
      for (const [swept, entry] of this.entries) {
        if (now - entry.recordedAt >= ADDED_KEY_TTL_MS) this.entries.delete(swept)
      }
    }
    this.entries.set(filePath, { key, recordedAt: now })
  }

  /** Whether `filePath` is unchanged since an add read it. */
  unchanged(filePath: string, key: string | null): boolean {
    const entry = this.entries.get(filePath)
    return (
      key !== null &&
      entry !== undefined &&
      entry.key === key &&
      Date.now() - entry.recordedAt < ADDED_KEY_TTL_MS
    )
  }

  forget(filePath: string): void {
    this.entries.delete(filePath)
  }

  clear(): void {
    this.entries.clear()
  }
}
