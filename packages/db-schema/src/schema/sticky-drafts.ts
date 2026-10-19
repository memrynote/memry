import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { VectorClock } from '@memry/contracts/sync-api'

/**
 * Unsent sticky text (`sticky_draft` sync records). Sending or discarding a
 * draft deletes its row; ids are random and never come back.
 */
export const stickyDrafts = sqliteTable('sticky_drafts', {
  id: text('id').primaryKey(),
  content: text('content').notNull(),
  /** `note`, `task` or `journal`. Free text so a row from a newer build is kept, not rejected. */
  kind: text('kind').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  modifiedAt: text('modified_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  /** Whole-row LWW clock. NULL = never synced; `seedUnclocked` keys on it. */
  clock: text('clock', { mode: 'json' }).$type<VectorClock>(),
  syncedAt: text('synced_at')
})

export type StickyDraftRow = typeof stickyDrafts.$inferSelect
