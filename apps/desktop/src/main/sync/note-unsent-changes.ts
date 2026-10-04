import { and, eq, gt, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/data-schema'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'

/**
 * A `note_metadata` row, note or journal, whose record holds changes the server
 * has not acknowledged: the server knows the item (`clock` set), it may leave
 * the device, and it was never stamped synced or was edited after the stamp.
 * `gt` against a NULL `syncedAt` is NULL in SQLite, so the second arm needs no
 * `IS NOT NULL` guard.
 */
export function hasUnsentRecordChanges(): SQL | undefined {
  return and(
    isNotNull(noteMetadata.clock),
    sql`${noteMetadata.localOnly} IS NOT 1`,
    or(isNull(noteMetadata.syncedAt), gt(noteMetadata.modifiedAt, noteMetadata.syncedAt))
  )
}

export function noteHasUnsentRecordChanges(db: DrizzleDb, noteId: string): boolean {
  const row = db
    .select({ id: noteMetadata.id })
    .from(noteMetadata)
    .where(
      and(eq(noteMetadata.id, noteId), isNull(noteMetadata.journalDate), hasUnsentRecordChanges())
    )
    .get()
  return row !== undefined
}
