import { eq } from 'drizzle-orm'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { syncState } from '@memry/db-schema/schema/sync-state'

import { createLogger } from '../../lib/logger'
import { SYNC_STATE_KEYS } from './sync-context'

const log = createLogger('PackUnresolved')

/**
 * `type:id` of the record-pack rows §8.10 rule 2 kept (#5390): unlisted by a
 * complete manifest, pulled by id, and answered with nothing that removed
 * them. Absence suggests a delete whose marker this device could not verify,
 * so the manifest check never re-uploads one of them as a create; the server
 * accepts that create over a marker for a recreatable type and the delete
 * would be reversed everywhere. Outlives the pack phase's own record, which
 * ends with the first cursor.
 */
export function readUnresolved(db: DrizzleDb): Set<string> {
  const raw = db
    .select({ value: syncState.value })
    .from(syncState)
    .where(eq(syncState.key, SYNC_STATE_KEYS.RECORD_PACKS_UNRESOLVED))
    .get()?.value
  if (raw === undefined) return new Set()
  try {
    const keys: unknown = JSON.parse(raw)
    if (Array.isArray(keys)) return new Set(keys.filter((key) => typeof key === 'string'))
  } catch {
    // Falls through to the log below.
  }
  log.warn('Unresolved record-pack set unreadable — ignored')
  return new Set()
}

export function writeUnresolved(db: DrizzleDb, keys: ReadonlySet<string>): void {
  if (keys.size === 0) {
    db.delete(syncState).where(eq(syncState.key, SYNC_STATE_KEYS.RECORD_PACKS_UNRESOLVED)).run()
    return
  }
  const value = JSON.stringify([...keys])
  db.insert(syncState)
    .values({ key: SYNC_STATE_KEYS.RECORD_PACKS_UNRESOLVED, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt: new Date() } })
    .run()
}
