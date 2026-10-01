/**
 * Carry the index rows of a moved folder's contents to their new paths.
 *
 * @module vault/folder-move-index
 */

import { isBinaryFileType } from '@memry/shared/file-types'
import { NotesChannels } from '@memry/contracts/notes-api'
import {
  extractDateFromPath,
  getNoteCacheById,
  listNoteCacheUnderFolder
} from '@main/database/queries/notes'
import { getIndexDatabase } from '../database'
import { flushProjectionEvents } from '../projections'
import { syncFileToCache, syncNoteStatToCache } from './note-sync'
import { clearPendingDelete } from './rename-tracker'
import { emitNoteEvent } from './notes-io'

/** A note whose index row `renameFolder` moved along with its folder. */
export interface FolderMovedNote {
  id: string
  oldPath: string
  newPath: string
  /** Journal date; a journal's path is derived from it and never synced. */
  date: string | null
}

/**
 * Point every index row under the moved folder at its new path.
 *
 * Without this the index only learns of the move from the watcher's per-file
 * unlink + add, and a missed event leaves the sidebar drawing the folder at its
 * old path until a restart reconciles it (#2513). Same helpers the watcher's
 * rename and `moveNote` use. Once the rows move, the watcher's events for these
 * files no-op: the unlink finds no row at the old path, the add finds one at
 * the new path. A row whose journal date the move changes is left to the
 * watcher, which turns it into a new item (see `renameKeepsJournalDate`).
 */
export async function moveIndexedNotesWithFolder(
  oldPath: string,
  newPath: string
): Promise<FolderMovedNote[]> {
  const db = getIndexDatabase()
  const moved: FolderMovedNote[] = []

  for (const row of listNoteCacheUnderFolder(db, oldPath)) {
    const cached = getNoteCacheById(db, row.id)
    if (!cached) continue
    const newRelativePath = newPath + cached.path.slice(oldPath.length)
    const date = cached.date ?? null
    if (date !== extractDateFromPath(newRelativePath)) continue

    if (isBinaryFileType(cached.fileType)) {
      syncFileToCache(db, {
        id: cached.id,
        path: newRelativePath,
        title: cached.title,
        fileType: cached.fileType as Exclude<typeof cached.fileType, 'markdown'>,
        mimeType: cached.mimeType ?? null,
        fileSize: cached.fileSize ?? 0,
        createdAt: new Date(cached.createdAt),
        modifiedAt: new Date(cached.modifiedAt)
      })
    } else {
      syncNoteStatToCache(
        db,
        {
          id: cached.id,
          path: newRelativePath,
          title: cached.title,
          createdAt: cached.createdAt,
          modifiedAt: cached.modifiedAt,
          fileSize: cached.fileSize ?? 0,
          localOnly: cached.localOnly ?? false,
          emoji: cached.emoji ?? null
        },
        { isNew: false }
      )
    }
    moved.push({ id: cached.id, oldPath: cached.path, newPath: newRelativePath, date })
  }

  if (moved.length === 0) return moved
  await flushProjectionEvents()

  for (const note of moved) {
    // An unlink the watcher saw before the rows moved is waiting to be paired
    // with an add. That add now finds its row and stops early, so the pending
    // delete would fire and delete the note.
    clearPendingDelete(note.id)
    emitNoteEvent(NotesChannels.events.MOVED, {
      id: note.id,
      oldPath: note.oldPath,
      newPath: note.newPath
    })
  }
  return moved
}
