import { sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

/**
 * Per-item "last opened" trail powering the Home "Recently opened" widget.
 *
 * Device-local: this table is NOT in SYNC_ITEM_TYPES. Reading history is a
 * higher-frequency signal than editing, and it is not worth a sync write per
 * note activation — the widget promises "what you opened on this machine".
 *
 * Only identity + timestamp is stored. Title/icon are resolved from the note
 * cache at read time so a renamed note reads correctly and a deleted note
 * drops out of the list, rather than lingering under a stale denormalized
 * title the way `search_reasons` does.
 */
export const recentlyOpened = sqliteTable(
  'recently_opened',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id').notNull(),
    // Currently always 'note'. Carried so canvas/journal can join later
    // without a schema migration.
    itemType: text('item_type').notNull(),
    openedAt: text('opened_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    uniqueIndex('idx_recently_opened_item').on(table.itemType, table.itemId),
    index('idx_recently_opened_opened').on(table.openedAt)
  ]
)

export type RecentlyOpenedRow = typeof recentlyOpened.$inferSelect
export type NewRecentlyOpenedRow = typeof recentlyOpened.$inferInsert
