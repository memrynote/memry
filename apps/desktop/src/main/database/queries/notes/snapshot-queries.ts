import { eq, asc, desc, inArray, count, and } from 'drizzle-orm'
import {
  noteSnapshots,
  type NoteSnapshot,
  type NewNoteSnapshot
} from '@memry/db-schema/schema/notes-cache'
import type { IndexDb } from '../../types'

export function insertNoteSnapshot(db: IndexDb, snapshot: NewNoteSnapshot): NoteSnapshot {
  return db.insert(noteSnapshots).values(snapshot).returning().get()
}

export function getNoteSnapshots(db: IndexDb, noteId: string, limit = 50): NoteSnapshot[] {
  return db
    .select()
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId))
    .orderBy(desc(noteSnapshots.createdAt))
    .limit(limit)
    .all()
}

export function getNoteSnapshotById(db: IndexDb, snapshotId: string): NoteSnapshot | undefined {
  return db.select().from(noteSnapshots).where(eq(noteSnapshots.id, snapshotId)).get()
}

export function getLatestSnapshot(db: IndexDb, noteId: string): NoteSnapshot | undefined {
  return db
    .select()
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId))
    .orderBy(desc(noteSnapshots.createdAt))
    .limit(1)
    .get()
}

export function snapshotExistsWithHash(db: IndexDb, noteId: string, contentHash: string): boolean {
  const result = db
    .select({ id: noteSnapshots.id })
    .from(noteSnapshots)
    .where(and(eq(noteSnapshots.noteId, noteId), eq(noteSnapshots.contentHash, contentHash)))
    .limit(1)
    .get()
  return result !== undefined
}

export function deleteNoteSnapshot(db: IndexDb, snapshotId: string): void {
  db.delete(noteSnapshots).where(eq(noteSnapshots.id, snapshotId)).run()
}

export function deleteNoteSnapshots(db: IndexDb, noteId: string): void {
  db.delete(noteSnapshots).where(eq(noteSnapshots.noteId, noteId)).run()
}

export function countNoteSnapshots(db: IndexDb, noteId: string): number {
  const result = db
    .select({ count: count() })
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId))
    .get()
  return result?.count ?? 0
}

export function pruneOldSnapshots(db: IndexDb, noteId: string, keepCount: number): number {
  const snapshotsToKeep = db
    .select({ id: noteSnapshots.id })
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId))
    .orderBy(desc(noteSnapshots.createdAt))
    .limit(keepCount)
    .all()
    .map((s) => s.id)

  if (snapshotsToKeep.length === 0) {
    return 0
  }

  const allSnapshots = db
    .select({ id: noteSnapshots.id })
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId))
    .all()

  const toDelete = allSnapshots.filter((s) => !snapshotsToKeep.includes(s.id))

  if (toDelete.length > 0) {
    db.delete(noteSnapshots)
      .where(
        inArray(
          noteSnapshots.id,
          toDelete.map((s) => s.id)
        )
      )
      .run()
  }

  return toDelete.length
}

export function getNoteSnapshotStats(
  db: IndexDb,
  noteId: string
): { count: number; oldestDate: string | null; newestDate: string | null } {
  const snapshots = db
    .select({ createdAt: noteSnapshots.createdAt })
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId))
    .orderBy(asc(noteSnapshots.createdAt))
    .all()

  if (snapshots.length === 0) {
    return { count: 0, oldestDate: null, newestDate: null }
  }

  return {
    count: snapshots.length,
    oldestDate: snapshots[0].createdAt,
    newestDate: snapshots[snapshots.length - 1].createdAt
  }
}
