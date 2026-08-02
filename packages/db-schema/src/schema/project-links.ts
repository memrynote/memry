import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { projects } from './projects.ts'

export const projectLinks = sqliteTable(
  'project_links',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    itemType: text('item_type').notNull(),
    itemId: text('item_id').notNull(),
    position: integer('position').notNull().default(0),
    /** 1 when the linked item is shown in the project hub's overview rail. */
    pinned: integer('pinned').notNull().default(0),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    uniqueIndex('idx_project_links_unique').on(table.projectId, table.itemType, table.itemId),
    index('idx_project_links_project').on(table.projectId, table.itemType),
    index('idx_project_links_item').on(table.itemId, table.itemType)
  ]
)

export type ProjectLink = typeof projectLinks.$inferSelect
export type NewProjectLink = typeof projectLinks.$inferInsert
