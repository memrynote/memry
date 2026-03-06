import { eq, asc, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { notePositions, type NotePosition } from '@memry/db-schema/schema/note-positions'
import * as schema from '@memry/db-schema/schema'

type DrizzleDb = BetterSQLite3Database<typeof schema>

export function getNotePosition(db: DrizzleDb, path: string): NotePosition | undefined {
  return db.select().from(notePositions).where(eq(notePositions.path, path)).get()
}

export function getNotesInFolder(db: DrizzleDb, folderPath: string): NotePosition[] {
  return db
    .select()
    .from(notePositions)
    .where(eq(notePositions.folderPath, folderPath))
    .orderBy(asc(notePositions.position))
    .all()
}

export function getNextPositionInFolder(db: DrizzleDb, folderPath: string): number {
  const result = db
    .select({ maxPosition: sql<number>`max(${notePositions.position})` })
    .from(notePositions)
    .where(eq(notePositions.folderPath, folderPath))
    .get()

  return (result?.maxPosition ?? -1) + 1
}

export function setNotePosition(
  db: DrizzleDb,
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

export function reorderNotesInFolder(db: DrizzleDb, folderPath: string, notePaths: string[]): void {
  for (let i = 0; i < notePaths.length; i++) {
    const path = notePaths[i]
    setNotePosition(db, path, folderPath, i)
  }
}

export function deleteNotePosition(db: DrizzleDb, path: string): boolean {
  const result = db.delete(notePositions).where(eq(notePositions.path, path)).run()
  return result.changes > 0
}

export function moveNoteToFolder(
  db: DrizzleDb,
  path: string,
  newFolderPath: string,
  position?: number
): void {
  const pos = position ?? getNextPositionInFolder(db, newFolderPath)
  setNotePosition(db, path, newFolderPath, pos)
}

export function insertNoteAtPosition(
  db: DrizzleDb,
  path: string,
  folderPath: string,
  position: number
): void {
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
}

export function getAllNotePositions(db: DrizzleDb): NotePosition[] {
  return db.select().from(notePositions).all()
}
