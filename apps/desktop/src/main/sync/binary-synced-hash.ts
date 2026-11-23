/**
 * The sha256 of the bytes a server holds for a binary note's file, as this
 * device last landed or uploaded them (#5598). A peer's replacement compares
 * the file to it: other bytes, or no hash recorded, are a change on no server,
 * which the landing keeps as a conflict copy.
 *
 * One `sync_state` row per binary note, `binarySyncedHash:<noteId>`, deleted
 * with the note's row. No migration: an older build never reads the rows, and
 * a row it left stale names bytes a server held, so it can only read as changed.
 *
 * @module sync/binary-synced-hash
 */

import { eq } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'

const KEY_PREFIX = 'binarySyncedHash:'

export function recordSyncedBinaryHash(db: DrizzleDb, noteId: string, sha256: string): void {
  const updatedAt = new Date()
  db.insert(syncState)
    .values({ key: KEY_PREFIX + noteId, value: sha256, updatedAt })
    .onConflictDoUpdate({ target: syncState.key, set: { value: sha256, updatedAt } })
    .run()
}

export function readSyncedBinaryHash(db: DrizzleDb, noteId: string): string | undefined {
  return db
    .select({ value: syncState.value })
    .from(syncState)
    .where(eq(syncState.key, KEY_PREFIX + noteId))
    .get()?.value
}

export function forgetSyncedBinaryHash(db: DrizzleDb, noteId: string): void {
  db.delete(syncState)
    .where(eq(syncState.key, KEY_PREFIX + noteId))
    .run()
}
