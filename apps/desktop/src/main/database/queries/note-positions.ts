import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { notePositions, type NotePosition } from '@memry/db-schema/schema/note-positions'
import type { DataDb } from '../types'

export function getNotePosition(db: DataDb, path: string): NotePosition | undefined {
  return db.select().from(notePositions).where(eq(notePositions.path, path)).get()
}

export function getNotesInFolder(db: DataDb, folderPath: string): NotePosition[] {
  return db
    .select()
    .from(notePositions)
    .where(eq(notePositions.folderPath, folderPath))
    .orderBy(asc(notePositions.position))
    .all()
}

export function getNextPositionInFolder(db: DataDb, folderPath: string): number {
  const result = db
    .select({ maxPosition: sql<number>`max(${notePositions.position})` })
    .from(notePositions)
    .where(eq(notePositions.folderPath, folderPath))
    .get()

  return (result?.maxPosition ?? -1) + 1
}

export function setNotePosition(
  db: DataDb,
  path: string,
  folderPath: string,
  position: number
): void {
  const existing = getNotePosition(db, path)
  if (existing) {
    db.update(notePositions).set({ folderPath, position }).where(eq(notePositions.path, path)).run()
  } else {
    db.insert(notePositions).values({ path, folderPath, position }).run()
  }
}

export function reorderNotesInFolder(db: DataDb, folderPath: string, notePaths: string[]): void {
  db.transaction(() => {
    for (let i = 0; i < notePaths.length; i++) {
      setNotePosition(db, notePaths[i], folderPath, i)
    }
  })
}

export function deleteNotePosition(db: DataDb, path: string): boolean {
  const result = db.delete(notePositions).where(eq(notePositions.path, path)).run()
  return result.changes > 0
}

export function moveNoteToFolder(
  db: DataDb,
  path: string,
  newFolderPath: string,
  position?: number
): void {
  const pos = position ?? getNextPositionInFolder(db, newFolderPath)
  setNotePosition(db, path, newFolderPath, pos)
}

export function insertNoteAtPosition(
  db: DataDb,
  path: string,
  folderPath: string,
  position: number
): void {
  db.transaction(() => {
    const notesInFolder = getNotesInFolder(db, folderPath)

    for (const note of notesInFolder) {
      if (note.position >= position && note.path !== path) {
        db.update(notePositions)
          .set({ position: note.position + 1 })
          .where(eq(notePositions.path, note.path))
          .run()
      }
    }

    setNotePosition(db, path, folderPath, position)
  })
}

export function getAllNotePositions(db: DataDb): NotePosition[] {
  return db.select().from(notePositions).all()
}

// ============================================================================
// Lifecycle — keeping a manual order attached to the item that earned it
// ============================================================================

/** Parent folder of a vault-relative path. Root lives under `''`. */
function parentFolderOf(itemPath: string): string {
  const cut = itemPath.lastIndexOf('/')
  return cut === -1 ? '' : itemPath.slice(0, cut)
}

/**
 * Give a freshly created note or folder the slot above every positioned sibling.
 *
 * The tree reads a missing row as `Number.MAX_SAFE_INTEGER`, so in a folder the
 * user has arranged by hand a new item sorts under everything ever dragged —
 * the bottom of the list, every time (#1646). A row of `min - 1` puts it where
 * the person who just pressed "new note" is looking instead.
 *
 * When nothing in `folderPath` carries a position the folder still runs on the
 * tree's implicit order (notes newest-first, folders A→Z) and this writes
 * nothing: a row here would freeze that order for good, and the newest note is
 * already at the top of it. Any row left behind by an earlier item that held
 * this exact path is cleared, so the new item cannot inherit a dead slot.
 *
 * Notes and folders share one position namespace per parent, so "the user
 * ordered this folder" is judged per parent, not per kind.
 */
export function placeNewItemAtTop(db: DataDb, itemPath: string, folderPath: string): void {
  const result = db
    .select({ minPosition: sql<number | null>`min(${notePositions.position})` })
    .from(notePositions)
    .where(and(eq(notePositions.folderPath, folderPath), ne(notePositions.path, itemPath)))
    .get()

  const min = result?.minPosition
  if (min === null || min === undefined) {
    deleteNotePosition(db, itemPath)
    return
  }

  setNotePosition(db, itemPath, folderPath, min - 1)
}

/**
 * Carry a manual position across a path change.
 *
 * Rows are keyed by path and a rename rewrites the path, so without this the
 * note the user just named drops its slot and falls to the bottom — which is
 * the second half of #1646, since every new note opens straight into rename.
 * No-op when the item never had a position.
 */
export function carryPositionToPath(db: DataDb, oldPath: string, newPath: string): void {
  if (oldPath === newPath) return

  const existing = getNotePosition(db, oldPath)
  if (!existing) return

  db.transaction(() => {
    deleteNotePosition(db, oldPath)
    setNotePosition(db, newPath, existing.folderPath, existing.position)
  })
}

/**
 * Re-key a renamed or moved folder: its own row plus every row beneath it.
 *
 * A folder rename rewrites the path of everything inside it, so all of those
 * rows go stale at once — the folder keeps its slot but its whole contents lose
 * theirs. `renameFolder` also serves drag-to-another-parent, so the folder's own
 * `folderPath` is re-derived from the new path rather than carried over.
 */
export function carryFolderPositions(db: DataDb, oldPath: string, newPath: string): void {
  if (oldPath === newPath) return

  const oldPrefix = `${oldPath}/`
  const newPrefix = `${newPath}/`
  const descendants = getAllNotePositions(db).filter((row) => row.path.startsWith(oldPrefix))
  const own = getNotePosition(db, oldPath)

  if (!own && descendants.length === 0) return

  db.transaction(() => {
    if (own) {
      deleteNotePosition(db, oldPath)
      setNotePosition(db, newPath, parentFolderOf(newPath), own.position)
    }

    for (const row of descendants) {
      const nextFolder =
        row.folderPath === oldPath
          ? newPath
          : row.folderPath.startsWith(oldPrefix)
            ? newPrefix + row.folderPath.slice(oldPrefix.length)
            : row.folderPath

      deleteNotePosition(db, row.path)
      setNotePosition(db, newPrefix + row.path.slice(oldPrefix.length), nextFolder, row.position)
    }
  })
}

/**
 * Drop a deleted folder's row and everything beneath it.
 *
 * Left behind, those rows are inherited by whatever is created at the same path
 * later — a new folder of the same name would open holding a stranger's order.
 */
export function dropFolderPositions(db: DataDb, folderPath: string): void {
  const prefix = `${folderPath}/`
  const stale = getAllNotePositions(db).filter(
    (row) => row.path === folderPath || row.path.startsWith(prefix)
  )
  if (stale.length === 0) return

  db.transaction(() => {
    for (const row of stale) {
      deleteNotePosition(db, row.path)
    }
  })
}
