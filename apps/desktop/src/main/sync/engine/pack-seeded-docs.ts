import { like } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'

/**
 * Pack-seeded docs not yet settled against their records (#1840).
 *
 * A packed body lands before any record, so nothing writes it to the vault
 * until a delivered pull says whether its note lives. The doc's own snapshot
 * watermark hides it from the next pack run, and the record's walk merges
 * nothing new, so this marker is the only thing that still knows the doc owes
 * a settle. It is written before the watermark and removed only once the doc
 * is settled, which makes every crash point converge on the next delivered
 * pull. `SYNC_STATE_KEYS.PACK_SEED_SETTLE_PENDING` says whether any exist.
 *
 * One `sync_state` row per note rather than one JSON value: a vault seeds
 * thousands of docs, and rewriting a growing list on every apply would cost
 * quadratic bytes. Older builds never read these keys.
 */
const KEY_PREFIX = 'packSeeded:'

export function packSeededKey(noteId: string): string {
  return KEY_PREFIX + noteId
}

export function listPackSeeded(db: DrizzleDb): string[] {
  return db
    .select({ key: syncState.key })
    .from(syncState)
    .where(like(syncState.key, `${KEY_PREFIX}%`))
    .all()
    .map((row) => row.key.slice(KEY_PREFIX.length))
}
