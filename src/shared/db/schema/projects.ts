import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  color: text('color').notNull().default('#6366f1'),
  icon: text('icon'),
  position: integer('position').notNull().default(0),
  isInbox: integer('is_inbox', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  modifiedAt: text('modified_at').notNull().default(sql`(datetime('now'))`),
  archivedAt: text('archived_at')
})

export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
