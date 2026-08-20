import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { VectorClock } from '@memry/contracts/sync-api'

/**
 * User-uploaded icons offered alongside emoji and the built-in icon set.
 *
 * The rendered file lives at `<vault>/.memry/icons/<id>.<ext>`; `data` keeps the
 * same bytes base64-encoded so the row is the whole sync payload and a device
 * that pulls it can write the file itself.
 */
export const customIcons = sqliteTable('custom_icons', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** `png` or `svg` — raster uploads are normalized to PNG before insert. */
  ext: text('ext').notNull(),
  /** Base64-encoded image bytes. */
  data: text('data').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  /** Whole-row LWW clock (no field clocks). NULL = never synced; `seedUnclocked` keys on it. */
  clock: text('clock', { mode: 'json' }).$type<VectorClock>(),
  syncedAt: text('synced_at')
})

export type CustomIconRow = typeof customIcons.$inferSelect
export type NewCustomIconRow = typeof customIcons.$inferInsert
