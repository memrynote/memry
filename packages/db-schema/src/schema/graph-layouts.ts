import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

/**
 * Saved graph node positions, one row per graph view.
 *
 * Lives in index.db: it is per-device and disposable. Losing it (index rebuild,
 * new device) only means the graph settles into a fresh arrangement, which is
 * the behaviour before layouts were saved. `positions` is a versioned JSON blob
 * (`GraphLayoutSchema` in contracts) so one open is one row read, not one per node.
 */
export const graphLayouts = sqliteTable('graph_layouts', {
  viewKey: text('view_key').primaryKey(),
  positions: text('positions').notNull(),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
})

export type GraphLayoutRow = typeof graphLayouts.$inferSelect
