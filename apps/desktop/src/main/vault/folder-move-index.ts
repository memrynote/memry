/**
 * Carry the index rows of a moved folder's contents to their new paths, and
 * re-point path-form wiki-links to them, with no write-back of a note under
 * the folder beside the move.
 *
 * @module vault/folder-move-index
 */

import { binaryRecordFields } from '@memry/shared/file-types'
import { NotesChannels } from '@memry/contracts/notes-api'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { foldNotePath } from '@memry/storage-data'
import {
  extractDateFromPath,
  getNoteCacheById,
  listNoteCacheUnderFolder
} from '@main/database/queries/notes'
import { getDatabase, getIndexDatabase } from '../database'
import { holdFlushUntil, takeWritebackTurn } from '../sync/crdt-writeback'
import { moveNotesInCache, type NoteMove } from './note-sync'
import { clearPendingDelete } from './rename-tracker'
import { emitNoteEvent } from './notes-io'
import { rewriteInboundWikiLinks } from './rename-link-rewrite'
import { noteLinkStem } from '@memry/shared/wiki-target'

/** A note whose index row `renameFolder` moved along with its folder. */
export interface FolderMovedNote {
  id: string
  oldPath: string
  newPath: string
  /** Journal date; a journal's path is derived from it and never synced. */
  date: string | null
}

/** Settles once the last folder rename queued has released its turns. */
let folderMoves: Promise<unknown> = Promise.resolve()

/**
 * Runs `move`, a folder rename's move of `folderPath` and of its rows, with no
 * write-back turn of a note under the folder beside it. A pass takes its
 * note's path from the index row it read, so a pass that read its row before
 * the rows moved writes the old path after the folder moved. It makes the old
 * folder again with the note's body in it and moves the note's rows back, and
 * the next vault open lists the file left at the new path as a second note
 * (#5671). For a case twin, the file the other twin keeps also holds bytes
 * that are not its own (#5643). The rename waits out each note's turn and
 * holds it until `move` ends, so a pass that starts meanwhile reads the new
 * path. A note that turns up while the rename waits is held too before `move`
 * starts. The turns are taken all at once, so a large folder waits for its
 * slowest pass, not for the sum of them.
 *
 * Folder renames hold their turns one at a time. Two that overlap (a folder
 * and one inside it) each took the turns they could, so one could hold a note
 * the other waited for while it waited for a note the other held. `move` ends
 * once the rows are at their new paths: a quit flush waits for the held
 * turns, so nothing in `move` waits on the CRDT store (#5475). A flush also
 * waits for a rename still queued, which holds no turn yet, so a quit never
 * leaves a folder moved with its rows at the old path.
 */
export function moveFolderHoldingWritebacks<T>(
  folderPath: string,
  move: () => Promise<T>
): Promise<T> {
  const run = folderMoves.then(() => holdWritebacksWhile(folderPath, move))
  folderMoves = run.catch(() => {})
  holdFlushUntil(run, `folder rename ${folderPath}`)
  return run
}

async function holdWritebacksWhile<T>(folderPath: string, move: () => Promise<T>): Promise<T> {
  const { promise: released, resolve: release } = Promise.withResolvers<void>()
  const held = new Set<string>()
  // Settles once the note's turn is held, or rejects when the turn fails
  // before it starts (a repair queued ahead of it threw).
  const hold = (id: string): Promise<void> =>
    new Promise((entered, failed) => {
      held.add(id)
      takeWritebackTurn(id, () => {
        entered()
        return released
      }).catch(failed)
    })
  try {
    let pending = noteIdsUnder(folderPath)
    while (pending.length > 0) {
      await Promise.all(pending.map(hold))
      pending = noteIdsUnder(folderPath).filter((id) => !held.has(id))
    }
    // No await between the last listing and the move's start.
    return await move()
  } finally {
    release()
  }
}

/**
 * The note rows under `folderPath`, in any case: on a case-insensitive disk a
 * row spelled with the folder in another case names a file in it too.
 */
function noteIdsUnder(folderPath: string): string[] {
  const folded = foldNotePath(`${folderPath}/`)
  return getDatabase()
    .select({ id: noteMetadata.id, path: noteMetadata.path })
    .from(noteMetadata)
    .all()
    .filter((row) => foldNotePath(row.path).startsWith(folded))
    .map((row) => row.id)
}

/**
 * Point every index row under the moved folder at its new path.
 *
 * Without this the index only learns of the move from the watcher's per-file
 * unlink + add, and a missed event leaves the sidebar drawing the folder at its
 * old path until a restart reconciles it (#2513). Once the rows move, the
 * watcher's events for these files no-op: the unlink finds no row at the old
 * path, the add finds one at the new path. A row whose journal date the move
 * changes is left to the watcher, which turns it into a new item (see
 * `renameKeepsJournalDate`).
 */
export async function moveIndexedNotesWithFolder(
  oldPath: string,
  newPath: string
): Promise<FolderMovedNote[]> {
  const db = getIndexDatabase()
  const moved: FolderMovedNote[] = []
  const moves: NoteMove[] = []

  for (const row of listNoteCacheUnderFolder(db, oldPath)) {
    const cached = getNoteCacheById(db, row.id)
    if (!cached) continue
    const newRelativePath = newPath + cached.path.slice(oldPath.length)
    const date = cached.date ?? null
    if (date !== extractDateFromPath(newRelativePath)) continue

    const binary = binaryRecordFields(cached)
    if (binary) {
      moves.push({
        kind: 'file',
        input: {
          id: cached.id,
          path: newRelativePath,
          title: cached.title,
          fileType: binary.fileType,
          mimeType: binary.mimeType,
          fileSize: cached.fileSize ?? 0,
          createdAt: new Date(cached.createdAt),
          modifiedAt: new Date(cached.modifiedAt)
        }
      })
    } else {
      moves.push({
        kind: 'markdown',
        input: {
          id: cached.id,
          path: newRelativePath,
          title: cached.title,
          createdAt: cached.createdAt,
          modifiedAt: cached.modifiedAt,
          fileSize: cached.fileSize ?? 0,
          localOnly: cached.localOnly ?? false,
          emoji: cached.emoji ?? null
        }
      })
    }
    moved.push({ id: cached.id, oldPath: cached.path, newPath: newRelativePath, date })
  }

  if (moved.length === 0) return moved
  await moveNotesInCache(db, moves)

  // An unlink the watcher saw before the rows moved is waiting to be paired
  // with an add. That add now finds its row and stops early, so the pending
  // delete would fire and delete the note.
  for (const note of moved) clearPendingDelete(note.id)
  return moved
}

/**
 * Tell the renderer each note of a folder rename moved, and re-point the
 * path-form wiki-links (`[[Old/Note]]`) that name the moved folder. Call once
 * the rename has released its write-back turns: the rewrite feeds each linking
 * note's doc and can wait on the CRDT store.
 */
export async function announceFolderMove(moved: FolderMovedNote[]): Promise<void> {
  const db = getIndexDatabase()
  for (const note of moved) {
    emitNoteEvent(NotesChannels.events.MOVED, {
      id: note.id,
      oldPath: note.oldPath,
      newPath: note.newPath
    })
  }

  for (const note of moved) {
    const title = getNoteCacheById(db, note.id)?.title ?? ''
    await rewriteInboundWikiLinks({
      noteId: note.id,
      from: { title, pathStem: noteLinkStem(note.oldPath) },
      to: { title, pathStem: noteLinkStem(note.newPath) },
      oldPath: note.oldPath,
      newPath: note.newPath
    })
  }
}
