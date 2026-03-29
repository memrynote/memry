import { eq, asc, desc, inArray, count, and } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  noteSnapshots,
  type NoteSnapshot,
  type NewNoteSnapshot
} from '@memry/db-schema/schema/notes-cache'
import * as schema from '@memry/db-schema/schema'

type DrizzleDb = BetterSQLite3Database<typeof schema>

export function insertNoteSnapshot(db: DrizzleDb, snapshot: NewNoteSnapshot): NoteSnapshot {
  return db.insert(noteSnapshots).values(snapshot).returning().get()
}

export function getNoteSnapshots(db: DrizzleDb, noteId: string, limit = 50): NoteSnapshot[] {
  return db
    .select()
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId))
    .orderBy(desc(noteSnapshots.createdAt))
    .limit(limit)
    .all()
}

export function getNoteSnapshotById(db: DrizzleDb, snapshotId: string): NoteSnapshot | undefined {
  return db.select().from(noteSnapshots).where(eq(noteSnapshots.id, snapshotId)).get()
}

export function getLatestSnapshot(db: DrizzleDb, noteId: string): NoteSnapshot | undefined {
  return db
    .select()
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId))
    .orderBy(desc(noteSnapshots.createdAt))
    .limit(1)
    .get()
}

export function snapshotExistsWithHash(
  db: DrizzleDb,
  noteId: string,
  contentHash: string
): boolean {
  const result = db
    .select({ id: noteSnapshots.id })
    .from(noteSnapshots)
    .where(and(eq(noteSnapshots.noteId, noteId), eq(noteSnapshots.contentHash, contentHash)))
    .limit(1)
    .get()
  return result !== undefined
}

export function deleteNoteSnapshot(db: DrizzleDb, snapshotId: string): void {
  db.delete(noteSnapshots).where(eq(noteSnapshots.id, snapshotId)).run()
}

export function deleteNoteSnapshots(db: DrizzleDb, noteId: string): void {
  db.delete(noteSnapshots).where(eq(noteSnapshots.noteId, noteId)).run()
}

export function countNoteSnapshots(db: DrizzleDb, noteId: string): number {
  const result = db
    .select({ count: count() })
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId))
    .get()
  return result?.count ?? 0
}

export function pruneOldSnapshots(db: DrizzleDb, noteId: string, keepCount: number): number {
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
  db: DrizzleDb,
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
