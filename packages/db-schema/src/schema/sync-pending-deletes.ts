/**
 * Deletes raised while the sync runtime was down (#1579).
 *
 * Create and update both have an offline fallback — the `increment*ClockOffline`
 * helpers mark the row dirty and `recoverDirtyItems` re-pushes it at the next
 * runtime start. Delete had none, on any record type: the row is gone, so there
 * is nothing left to mark dirty and nothing for a sweep to find. The mutation
 * evaporated and peers kept the item forever.
 *
 * A row here is the tombstone that survives instead: the payload the sync
 * service would have queued, captured at the moment the delete happened, while
 * the item's clock is still readable.
 *
 * @module db/schema/sync-pending-deletes
 */

import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

export const syncPendingDeletes = sqliteTable(
  'sync_pending_deletes',
  {
    /** Sync item type, e.g. `note` or `task`. */
    type: text('type').notNull(),

    /** Id of the deleted item. */
    itemId: text('item_id').notNull(),

    /**
     * What the delete needs to reach the server.
     *
     * For record types this is the caller's row snapshot, replayed through the
     * type's own sync service so its clock rule and its local-only guard stay
     * where they are. For notes and journals it is the finished tombstone body
     * — their services build it from the row, which no longer exists by the
     * time this drains.
     */
    payload: text('payload').notNull(),

    /** When the delete was raised. Diagnostics only; nothing orders on it. */
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
  },
  (table) => [
    // Deleting the same item twice before the runtime comes back is one
    // tombstone, not two.
    primaryKey({ columns: [table.type, table.itemId] })
  ]
)

export type SyncPendingDelete = typeof syncPendingDeletes.$inferSelect
export type NewSyncPendingDelete = typeof syncPendingDeletes.$inferInsert
