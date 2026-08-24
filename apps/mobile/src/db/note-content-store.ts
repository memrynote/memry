import {
  DEFAULT_JOURNAL_DATE_FORMAT,
  formatJournalFilename
} from '@memry/storage-vault/journal-format'
import type { VaultDb } from './index'

/**
 * SQLite-backed `NoteContentStore` (T034) — the exact interface desktop
 * defines in `packages/storage-vault/src/note-content-store.ts`, over the
 * `note_bodies` table instead of vault files (decision record §5: no files
 * for notes on mobile; bodies are raw markdown incl. frontmatter,
 * byte-identical to desktop, so `@memry/app-core` parsing works unchanged).
 *
 * The interface is declared locally rather than imported because the desktop
 * module implementing it reaches `node:fs` and the architecture boundary bans
 * anything node-reachable from `apps/mobile`; the shape must stay identical.
 *
 * Rows are keyed by sync item id (the pipeline's natural key) with a unique
 * `path` column carrying the vault-relative path, which is what this
 * interface addresses rows by. A `write()` to a path no sync item has claimed
 * yet stores the row under a `path:`-prefixed placeholder id — Phase 4's
 * create path replaces it when the item exists.
 */
export interface NoteContentStore {
  resolve(relativePath: string): string
  read(relativePath: string): Promise<string | null>
  write(relativePath: string, content: string): Promise<void>
  remove(relativePath: string): Promise<boolean>
  exists(relativePath: string): Promise<boolean>
  getJournalRelativePath(date: string): string
}

export interface MobileVaultStoreLayout {
  vaultId: string
  journalFolder: string
  journalDateFormat?: string
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
}

export function createMobileNoteContentStore(
  db: VaultDb,
  layout: MobileVaultStoreLayout
): NoteContentStore {
  const now = () => Date.now()

  return {
    resolve(relativePath) {
      return `memry-vault://${layout.vaultId}/${normalizeRelativePath(relativePath)}`
    },

    async read(relativePath) {
      const row = await db.getFirstAsync<{ markdown: string }>(
        'SELECT markdown FROM note_bodies WHERE path = ?',
        [normalizeRelativePath(relativePath)]
      )
      return row?.markdown ?? null
    },

    async write(relativePath, content) {
      const path = normalizeRelativePath(relativePath)
      const changed = await db.runAsync(
        'UPDATE note_bodies SET markdown = ?, fetched_at = ? WHERE path = ?',
        [content, now(), path]
      )
      if (changed.changes === 0) {
        await db.runAsync(
          `INSERT INTO note_bodies (item_id, path, markdown, fetched_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(item_id) DO UPDATE SET markdown = excluded.markdown, path = excluded.path, fetched_at = excluded.fetched_at`,
          [`path:${path}`, path, content, now()]
        )
      }
    },

    async remove(relativePath) {
      const result = await db.runAsync('DELETE FROM note_bodies WHERE path = ?', [
        normalizeRelativePath(relativePath)
      ])
      return result.changes > 0
    },

    async exists(relativePath) {
      const row = await db.getFirstAsync<{ one: number }>(
        'SELECT 1 AS one FROM note_bodies WHERE path = ?',
        [normalizeRelativePath(relativePath)]
      )
      return row !== null
    },

    getJournalRelativePath(date) {
      const filename = formatJournalFilename(
        date,
        layout.journalDateFormat ?? DEFAULT_JOURNAL_DATE_FORMAT
      )
      return normalizeRelativePath(`${layout.journalFolder}/${filename}.md`)
    }
  }
}
