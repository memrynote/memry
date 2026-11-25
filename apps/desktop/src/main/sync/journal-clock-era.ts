import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { eq } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { utcNow } from '@memry/shared/utc'

/**
 * The `sync_state` key holding when this vault first opened under a build that
 * stamps journal push acks (#5659). Additive: older builds never read it, and
 * a downgrade leaves it in place.
 */
const KEY = 'journalClockEra'

/**
 * When this vault first opened under a build that stamps journal push acks
 * (#5659), recorded on first call. A journal `modifiedAt` before it was written
 * by an older build, which acked journal pushes without stamping `syncedAt`, so
 * its `modifiedAt > syncedAt` says nothing about whether the server holds the
 * row. Recorded at vault open, before the watcher can observe an edit.
 */
export function journalClockEra(db: DrizzleDb): string {
  db.insert(syncState)
    .values({ key: KEY, value: utcNow(), updatedAt: new Date() })
    .onConflictDoNothing({ target: syncState.key })
    .run()
  const row = db
    .select({ value: syncState.value })
    .from(syncState)
    .where(eq(syncState.key, KEY))
    .get()
  if (!row) throw new Error('journalClockEra: the era row was not written')
  return row.value
}
