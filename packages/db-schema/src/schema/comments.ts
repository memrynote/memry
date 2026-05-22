import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { CommentMentionRef } from '@memry/contracts/comments-api'
import type { VectorClock } from '@memry/contracts/sync-api'

export const comments = sqliteTable(
  'comments',
  {
    id: text('id').primaryKey(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    selectedQuote: text('selected_quote').notNull(),
    blockId: text('block_id'),
    rangeStart: integer('range_start'),
    rangeEnd: integer('range_end'),
    prefix: text('prefix'),
    suffix: text('suffix'),
    body: text('body').notNull().default(''),
    mentionRefs: text('mention_refs', { mode: 'json' })
      .$type<CommentMentionRef[]>()
      .notNull()
      .default([]),
    attachmentRefs: text('attachment_refs', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default([]),
    status: text('status').notNull().default('open'),
    clock: text('clock', { mode: 'json' }).$type<VectorClock>(),
    syncedAt: text('synced_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    modifiedAt: text('modified_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    index('idx_comments_target').on(table.targetType, table.targetId),
    index('idx_comments_target_status').on(table.targetType, table.targetId, table.status),
    index('idx_comments_status').on(table.status)
  ]
)

export type CommentRow = typeof comments.$inferSelect
export type NewCommentRow = typeof comments.$inferInsert
