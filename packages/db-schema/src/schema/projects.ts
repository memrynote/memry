import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { FieldClocks, VectorClock } from '@memry/contracts/sync-api'

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  color: text('color').notNull().default('#6366f1'),
  icon: text('icon'),
  position: integer('position').notNull().default(0),
  isInbox: integer('is_inbox', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  modifiedAt: text('modified_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  archivedAt: text('archived_at'),

  clock: text('clock', { mode: 'json' }).$type<VectorClock>(),
  fieldClocks: text('field_clocks', { mode: 'json' }).$type<FieldClocks>(),
  syncedAt: text('synced_at')
})

export type Project = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
