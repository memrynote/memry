import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const customThemes = sqliteTable('custom_themes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  base: text('base').notNull(),
  variables: text('variables', { mode: 'json' }).$type<Record<string, string>>().notNull(),
  clock: text('clock', { mode: 'json' }),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  modifiedAt: text('modified_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
})

export type CustomThemeRow = typeof customThemes.$inferSelect
export type NewCustomThemeRow = typeof customThemes.$inferInsert
