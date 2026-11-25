import { eq } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'

/**
 * The `sync_state` key prefix of an owed journal day merge, one row per
 * foreign id. A leaf module, so sign-out's keep-set and a user delete reach it
 * without loading the drain's vault and CRDT graph.
 */
export const JOURNAL_DAY_MERGE_KEY_PREFIX = 'journalDayMerge:'

/**
 * A user delete of a journal day (`enqueueJournalDelete`). When the day is a
 * held foreign id, its owed merge goes with it: the user deleted the day, and
 * the drain must not build `j<date>` from it and push it back to every device
 * (§1.9.1). The delete purges its doc.
 */
export function forgetOwedJournalDayMerge(db: DrizzleDb, foreignId: string): void {
  db.delete(syncState)
    .where(eq(syncState.key, JOURNAL_DAY_MERGE_KEY_PREFIX + foreignId))
    .run()
}
