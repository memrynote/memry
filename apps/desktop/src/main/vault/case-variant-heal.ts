/**
 * Drop the duplicate rows a case-only folder rename left on macOS and Windows.
 *
 * Before the watcher read event paths in their disk case, renaming
 * `Supernotes` to `SuperNotes` in the app moved every note, then indexed each
 * file a second time under a fresh id at its old-case path, because chokidar
 * kept reporting the old spelling. Those copies drew the old folder in the
 * sidebar next to the renamed one, though only one folder exists on disk.
 *
 * @module vault/case-variant-heal
 */

import { eq } from 'drizzle-orm'
import { NotesChannels } from '@memry/contracts/notes-api'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { getDatabase, getIndexDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { flushProjectionEvents } from '../projections'
import { diskCaseOf } from './disk-case'
import { deleteNoteFromCache } from './note-sync'
import { emitNoteEvent } from './notes-io'

const logger = createLogger('CaseVariantHeal')

/**
 * Groups of rows whose paths differ only in case, and within each group the
 * rows that name the same file as the row the disk spells, so are its copies.
 * A case-sensitive file system (Linux) keeps such paths as separate files, and
 * every row there names its own file.
 */
function caseVariantCopies<T extends { path: string }>(vaultPath: string, rows: T[]): T[] {
  const byFoldedPath = new Map<string, T[]>()
  for (const row of rows) {
    const key = row.path.toLowerCase()
    byFoldedPath.set(key, [...(byFoldedPath.get(key) ?? []), row])
  }

  const copies: T[] = []
  for (const group of byFoldedPath.values()) {
    if (group.length < 2) continue
    const onDisk = diskCaseOf(vaultPath, group[0].path)
    if (onDisk === null || !group.some((row) => row.path === onDisk)) continue
    for (const row of group) {
      if (row.path !== onDisk && diskCaseOf(vaultPath, row.path) === onDisk) {
        copies.push(row)
      }
    }
  }
  return copies
}

/**
 * Remove each note row that is a case-variant copy of another, and each
 * folder_config row that is a case-variant copy of another.
 *
 * Local only, and no file is touched: the copy's file is the kept row's file.
 * No delete is synced either. A peer on a case-insensitive file system can
 * hold the copy and the kept note in that one file, and a synced delete
 * unlinks the copy's file there, which would take the kept note with it.
 */
export async function healCaseVariantRows(
  vaultPath: string
): Promise<{ notes: number; folders: number }> {
  const dataDb = getDatabase()

  const noteCopies = caseVariantCopies(
    vaultPath,
    dataDb.select({ id: noteMetadata.id, path: noteMetadata.path }).from(noteMetadata).all()
  )
  const indexDb = getIndexDatabase()
  for (const note of noteCopies) {
    deleteNoteFromCache(indexDb, note.id)
    emitNoteEvent(NotesChannels.events.DELETED, { ...note, source: 'external' })
  }
  await flushProjectionEvents()

  const folderCopies = caseVariantCopies(
    vaultPath,
    dataDb.select({ path: folderConfigs.path }).from(folderConfigs).all()
  )
  for (const folder of folderCopies) {
    dataDb.delete(folderConfigs).where(eq(folderConfigs.path, folder.path)).run()
  }

  if (noteCopies.length > 0 || folderCopies.length > 0) {
    logger.info('Dropped case-variant copies of notes and folders', {
      notes: noteCopies.length,
      folders: folderCopies.length
    })
  }
  return { notes: noteCopies.length, folders: folderCopies.length }
}
