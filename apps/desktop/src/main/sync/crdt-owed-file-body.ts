/**
 * "This note's vault file holds a body its CRDT doc has not taken" (#2646).
 *
 * With no CRDT store, a main-process edit to a note no editor holds finds an
 * empty doc and cannot be fed. The marker remembers that the file is ahead of
 * the doc, so the next merge of the server body applies the file on top of it
 * instead of writing the server body over the file. Durable, because the edit
 * may wait for the server across restarts.
 *
 * Never throws: a database that cannot be read or written reads as "not owed".
 *
 * @module sync/crdt-owed-file-body
 */

import { eq } from 'drizzle-orm'
import { crdtOwedFileBodies } from '@memry/db-schema/schema/crdt-owed-file-bodies'
import { getDatabase, type DataDb } from '../database/client'
import { createLogger } from '../lib/logger'

const log = createLogger('CrdtOwedFileBody')

function withDatabase<T>(noteId: string, fallback: T, fn: (db: DataDb) => T): T {
  try {
    return fn(getDatabase())
  } catch (err) {
    log.warn('Could not use the owed file body marker', { noteId, error: err })
    return fallback
  }
}

export function recordOwedFileBody(noteId: string): void {
  withDatabase(noteId, undefined, (db) => {
    db.insert(crdtOwedFileBodies)
      .values({ noteId, createdAt: Date.now() })
      .onConflictDoNothing()
      .run()
  })
}

export function owesFileBody(noteId: string): boolean {
  return withDatabase(
    noteId,
    false,
    (db) =>
      db
        .select({ noteId: crdtOwedFileBodies.noteId })
        .from(crdtOwedFileBodies)
        .where(eq(crdtOwedFileBodies.noteId, noteId))
        .get() !== undefined
  )
}

export function clearOwedFileBody(noteId: string): void {
  withDatabase(noteId, undefined, (db) => {
    db.delete(crdtOwedFileBodies).where(eq(crdtOwedFileBodies.noteId, noteId)).run()
  })
}
