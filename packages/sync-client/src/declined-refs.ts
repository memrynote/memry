import { eq } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import type { SyncItemType } from '@memry/contracts/sync-api'
import type { DrizzleDb } from './drizzle-db'

/**
 * Server items this device will never apply, because what they describe is
 * already held here under another id: a second inbox project, or a calendar
 * source whose (provider, kind, remote id) belongs to an existing row. The
 * manifest check skips them, otherwise each one counts as server-only forever
 * and every check resets the cursor and re-pulls the whole vault.
 *
 * Stored as JSON in `sync_state`, so no migration is needed and older builds
 * ignore the key.
 */
const DECLINED_REFS_KEY = 'declinedSyncRefs'

export interface DeclinedRef {
  type: SyncItemType
  id: string
}

const isDeclinedRef = (value: unknown): value is DeclinedRef =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as DeclinedRef).type === 'string' &&
  typeof (value as DeclinedRef).id === 'string'

export function listDeclinedRefs(db: DrizzleDb): DeclinedRef[] {
  const row = db
    .select({ value: syncState.value })
    .from(syncState)
    .where(eq(syncState.key, DECLINED_REFS_KEY))
    .get()
  if (!row) return []
  try {
    const parsed: unknown = JSON.parse(row.value)
    return Array.isArray(parsed) ? parsed.filter(isDeclinedRef) : []
  } catch {
    return []
  }
}

function writeDeclinedRefs(db: DrizzleDb, refs: DeclinedRef[]): void {
  const value = JSON.stringify(refs)
  db.insert(syncState)
    .values({ key: DECLINED_REFS_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt: new Date() } })
    .run()
}

export function recordDeclinedRef(db: DrizzleDb, ref: DeclinedRef): void {
  const refs = listDeclinedRefs(db)
  if (refs.some((r) => r.type === ref.type && r.id === ref.id)) return
  writeDeclinedRefs(db, [...refs, { type: ref.type, id: ref.id }])
}

/** Drops every declined ref `keep` rejects, e.g. ids the server no longer lists. */
export function retainDeclinedRefs(db: DrizzleDb, keep: (ref: DeclinedRef) => boolean): void {
  const refs = listDeclinedRefs(db)
  const kept = refs.filter(keep)
  if (kept.length !== refs.length) writeDeclinedRefs(db, kept)
}
