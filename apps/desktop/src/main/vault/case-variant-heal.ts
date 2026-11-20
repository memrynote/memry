/**
 * Drop the duplicate rows a case-only folder rename left on macOS and Windows.
 *
 * Before the watcher read event paths in their disk case, renaming
 * `Supernotes` to `SuperNotes` in the app moved every note, then indexed each
 * file a second time under a fresh id at its old-case path, because chokidar
 * kept reporting the old spelling. Those copies drew the old folder in the
 * sidebar next to the renamed one, though only one folder exists on disk.
 *
 * A row that names the disk's file in another case is not always a copy:
 * two distinct notes whose paths differ only in case share one file here
 * (#5263). Only a real copy is dropped (#5297).
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
import { getNoteCacheById } from '@main/database/queries/notes'
import { deleteNoteFromCache } from './note-sync'
import { emitNoteEvent } from './notes-io'

const logger = createLogger('CaseVariantHeal')

/**
 * Groups of rows whose paths differ only in case, and within each group the
 * rows that name the same file as the row the disk spells, so are its copies.
 * A case-sensitive file system (Linux) keeps such paths as separate files, and
 * every row there names its own file.
 */
function caseVariantCopies<T extends { path: string }>(
  vaultPath: string,
  rows: T[]
): Array<{ copy: T; kept: T }> {
  const byFoldedPath = new Map<string, T[]>()
  for (const row of rows) {
    const key = row.path.toLowerCase()
    byFoldedPath.set(key, [...(byFoldedPath.get(key) ?? []), row])
  }

  const copies: Array<{ copy: T; kept: T }> = []
  for (const group of byFoldedPath.values()) {
    if (group.length < 2) continue
    const onDisk = diskCaseOf(vaultPath, group[0].path)
    const kept = group.find((row) => row.path === onDisk)
    if (onDisk === null || !kept) continue
    for (const row of group) {
      if (row.path !== onDisk && diskCaseOf(vaultPath, row.path) === onDisk) {
        copies.push({ copy: row, kept })
      }
    }
  }
  return copies
}

/**
 * Whether a case-variant note row is a copy of the note the disk spells, and
 * not a distinct case twin: the index read the same body for it as for the
 * kept note, as when the old watcher indexed one file twice. Whether it ever
 * synced says nothing about its body. A twin keeps its row, so the twin rule
 * (`refusesCaseTwinFile`) still sees both rows, and neither takes the other's
 * body (#5297).
 */
function isNoteCopy(
  noteId: string,
  keptId: string,
  indexDb: ReturnType<typeof getIndexDatabase>
): boolean {
  const hash = getNoteCacheById(indexDb, noteId)?.contentHash
  return !!hash && hash === getNoteCacheById(indexDb, keptId)?.contentHash
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

  const indexDb = getIndexDatabase()
  const caseVariants = caseVariantCopies(
    vaultPath,
    dataDb.select({ id: noteMetadata.id, path: noteMetadata.path }).from(noteMetadata).all()
  )
  const noteCopies: Array<{ id: string; path: string }> = []
  for (const { copy: note, kept } of caseVariants) {
    if (!isNoteCopy(note.id, kept.id, indexDb)) {
      logger.warn('Kept a case twin that shares its file with another note', { id: note.id })
      continue
    }
    noteCopies.push({ id: note.id, path: note.path })
    deleteNoteFromCache(indexDb, note.id)
    emitNoteEvent(NotesChannels.events.DELETED, {
      id: note.id,
      path: note.path,
      source: 'external'
    })
  }
  await flushProjectionEvents()

  const folderCopies = caseVariantCopies(
    vaultPath,
    dataDb.select({ path: folderConfigs.path }).from(folderConfigs).all()
  )
  for (const { copy: folder } of folderCopies) {
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
