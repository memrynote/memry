import { inArray } from 'drizzle-orm'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import type { ProjectContents } from '@memry/domain-tasks'
import type { IndexDb } from '../database'

/**
 * Drop linked notes and files the vault index no longer holds.
 *
 * `listProjectContents` resolves links against `note_metadata` in the data DB,
 * but opening a note goes through the index. A file that disappears while the
 * app is closed is only dropped from the index on the next launch
 * (`reconcileMissingFiles`), so its metadata row and project link survive and
 * the hub lists a note that answers "no longer in this vault" when clicked
 * (#2653). The hub lists only what it can open.
 */
export function withoutMissingVaultItems(
  indexDb: IndexDb,
  contents: ProjectContents
): ProjectContents {
  const ids = [...contents.notes.map((n) => n.id), ...contents.files.map((f) => f.id)]
  if (ids.length === 0) return contents

  const indexed = new Set(
    indexDb
      .select({ id: noteCache.id })
      .from(noteCache)
      .where(inArray(noteCache.id, ids))
      .all()
      .map((row) => row.id)
  )
  if (indexed.size === ids.length) return contents

  const notes = contents.notes.filter((note) => indexed.has(note.id))
  const files = contents.files.filter((file) => indexed.has(file.id))
  return {
    ...contents,
    notes,
    files,
    counts: { ...contents.counts, notes: notes.length, files: files.length }
  }
}
