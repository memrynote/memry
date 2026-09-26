/**
 * What a committed local change still owes the server (#2301).
 *
 * A local edit used to commit in three steps: the row, then the sync clock,
 * then the `sync_queue` row. A crash between them left an edit no later push
 * would carry. A row here is written in the same transaction as the edit and
 * deleted in the transaction that bumps the clock and queues the push, so a
 * crash in between leaves this row for the next sync runtime start to replay.
 *
 * Append-only FIFO: rows are never coalesced here. `sync_queue` stays the one
 * place that folds mutations for the same item.
 *
 * @module db/schema/sync-intents
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

export const syncIntents = sqliteTable(
  'sync_intents',
  {
    /** Rowid: insertion order, which is the replay order within an item. */
    seq: integer('seq').primaryKey(),

    /** Sync item type, e.g. `task` or `project`. */
    type: text('type').notNull(),

    itemId: text('item_id').notNull(),

    /** `create`, `update` or `delete`. */
    op: text('op').notNull(),

    /** JSON array of the local sync adapter's extra arguments. */
    args: text('args').notNull().default('[]'),

    /** Failed runtime-start replays. The row stays until a replay succeeds. */
    attempts: integer('attempts').notNull().default(0),

    /** Last replay error message. Local diagnostics only. */
    lastError: text('last_error'),

    createdAt: integer('created_at', { mode: 'timestamp' }).notNull()
  },
  (table) => [index('idx_sync_intents_item').on(table.type, table.itemId)]
)

export type SyncIntentRow = typeof syncIntents.$inferSelect
export type NewSyncIntentRow = typeof syncIntents.$inferInsert
