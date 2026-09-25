/**
 * The highest delete clock this device has seen per re-creatable id (#2409).
 *
 * A re-created deterministic id (a journal day, a tag name, a folder path)
 * must be minted with a clock that happens strictly after its tombstone, or
 * the server refuses it (protocol 05 §5.8) and a stale device can later
 * overwrite it. Local rows are hard-deleted and `sync_pending_deletes` is
 * retired exactly when the server stops listing the id, so the clock needs a
 * home of its own.
 *
 * @module db/schema/sync-tombstone-clocks
 */

import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'
import type { VectorClock } from '@memry/contracts/sync-api'

export const syncTombstoneClocks = sqliteTable(
  'sync_tombstone_clocks',
  {
    /** `note` for notes and journals (their tombstones are interchangeable), else the item type. */
    type: text('type').notNull(),

    itemId: text('item_id').notNull(),

    /** Pointwise max of every delete clock recorded for the id. Never shrinks. */
    clock: text('clock', { mode: 'json' }).$type<VectorClock>().notNull(),

    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
  },
  (table) => [primaryKey({ columns: [table.type, table.itemId] })]
)

export type SyncTombstoneClock = typeof syncTombstoneClocks.$inferSelect
