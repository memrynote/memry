/**
 * Which binary files may hold a case twin's bytes, kept in `sync_state` so a
 * restart keeps the hold (#5522, #5560). `case-twin-file.ts` writes both
 * lists; the watcher reads them, and a note's own download landing clears it.
 *
 * @module vault/case-twin-bytes
 */

import { eq } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { foldNotePath } from '@memry/storage-data'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { SYNC_STATE_KEYS } from '../sync/engine/sync-context'
import { createLogger } from '../lib/logger'

const log = createLogger('CaseTwinBytes')

type ListKey =
  | typeof SYNC_STATE_KEYS.CASE_TWIN_HELD_CHANGES
  | typeof SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES

function readList(db: DrizzleDb, key: ListKey): Set<string> {
  const value = db
    .select({ value: syncState.value })
    .from(syncState)
    .where(eq(syncState.key, key))
    .get()?.value
  if (!value) return new Set()
  try {
    const ids: unknown = JSON.parse(value)
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [])
  } catch (error) {
    log.warn('Case twin list is corrupt; starting it again', { key, error })
    return new Set()
  }
}

function writeList(db: DrizzleDb, key: ListKey, entries: Set<string>): void {
  if (entries.size === 0) {
    db.delete(syncState).where(eq(syncState.key, key)).run()
    return
  }
  const value = JSON.stringify([...entries])
  const updatedAt = new Date()
  db.insert(syncState)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt } })
    .run()
}

function update(db: DrizzleDb, key: ListKey, entry: string, present: boolean): boolean {
  const entries = readList(db, key)
  const had = entries.has(entry)
  if (had === present) return had
  if (present) entries.add(entry)
  else entries.delete(entry)
  writeList(db, key, entries)
  return had
}

/** The watcher held an outside change to this shared file (disk spelling). */
export function recordHeldCaseTwinChange(db: DrizzleDb, diskPath: string): void {
  update(db, SYNC_STATE_KEYS.CASE_TWIN_HELD_CHANGES, foldNotePath(diskPath), true)
}

/** Whether a change to this shared file was held, forgetting it. */
export function takeHeldCaseTwinChange(db: DrizzleDb, diskPath: string): boolean {
  return update(db, SYNC_STATE_KEYS.CASE_TWIN_HELD_CHANGES, foldNotePath(diskPath), false)
}

/** This note's file may hold a case twin's bytes: no change to it is pushed. */
export function markCaseTwinForeignBytes(db: DrizzleDb, noteId: string): void {
  update(db, SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES, noteId, true)
}

export function holdsCaseTwinForeignBytes(db: DrizzleDb, noteId: string): boolean {
  return readList(db, SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES).has(noteId)
}

/** The note's own attachment landed on its file. */
export function clearCaseTwinForeignBytes(db: DrizzleDb, noteId: string): void {
  update(db, SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES, noteId, false)
}
