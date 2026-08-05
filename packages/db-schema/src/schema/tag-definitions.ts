import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { nocaseText } from './nocase.ts'

export const tagDefinitions = sqliteTable('tag_definitions', {
  name: nocaseText('name').primaryKey(),
  color: text('color').notNull(),
  // True only when a human picked `color`. False means the palette handed it out
  // in `getOrCreateTag`, which indexes by local tag count and so disagrees with
  // every other device — such a colour may not repaint another device's tag.
  // See drizzle-data/0046_tag_definition_color_authored.sql.
  colorAuthored: integer('color_authored', { mode: 'boolean' }).notNull().default(false),
  icon: text('icon'),
  clock: text('clock', { mode: 'json' }),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  categoryId: text('category_id'),
  sortOrder: integer('sort_order').notNull().default(0),
  views: text('views')
})

export type TagDefinition = typeof tagDefinitions.$inferSelect
export type NewTagDefinition = typeof tagDefinitions.$inferInsert
