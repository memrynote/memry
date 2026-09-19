/**
 * Payload keys a newer client wrote that this build's schema does not know
 * (#2183).
 *
 * Desktop applies a pulled payload through `handler.schema.parse`, and every
 * handler schema is a plain `z.object`, so Zod strips every key it has no field
 * for. The projection row that survives is then re-serialised on the next push,
 * which deletes the newer client's field from the server copy.
 *
 * A row here is the stripped remainder, kept verbatim next to the item so the
 * push path can put it back.
 *
 * @module db/schema/sync-unknown-fields
 */

import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

export const syncUnknownFields = sqliteTable(
  'sync_unknown_fields',
  {
    /** Sync item type, e.g. `note` or `task`. */
    type: text('type').notNull(),

    /** Id of the item the keys belong to. */
    itemId: text('item_id').notNull(),

    /**
     * JSON object of the top-level payload keys this build's schema stripped,
     * with their values exactly as received. Never read for local behavior —
     * it is only merged back under the freshly built payload on push.
     */
    fields: text('fields').notNull(),

    /** When the remainder was last captured. Diagnostics only. */
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull()
  },
  (table) => [primaryKey({ columns: [table.type, table.itemId] })]
)

export type SyncUnknownFields = typeof syncUnknownFields.$inferSelect
export type NewSyncUnknownFields = typeof syncUnknownFields.$inferInsert
