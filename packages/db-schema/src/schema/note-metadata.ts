import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { FileType } from '@memry/shared/file-types'

export const NoteSyncPolicies = {
  SYNC: 'sync',
  LOCAL_ONLY: 'local-only'
} as const

export type NoteSyncPolicy = (typeof NoteSyncPolicies)[keyof typeof NoteSyncPolicies]

export const noteMetadata = sqliteTable(
  'note_metadata',
  {
    id: text('id').primaryKey(),
    path: text('path').notNull().unique(),
    title: text('title').notNull(),
    emoji: text('emoji'),
    fileType: text('file_type').$type<FileType>().notNull().default('markdown'),
    mimeType: text('mime_type'),
    fileSize: integer('file_size'),
    attachmentId: text('attachment_id'),
    attachmentReferences: text('attachment_references', { mode: 'json' }).$type<string[] | null>(),
    localOnly: integer('local_only', { mode: 'boolean' }).notNull().default(false),
    syncPolicy: text('sync_policy').$type<NoteSyncPolicy>().notNull().default(NoteSyncPolicies.SYNC),
    journalDate: text('journal_date'),
    propertyDefinitionNames: text('property_definition_names', { mode: 'json' }).$type<
      string[] | null
    >(),
    clock: text('clock', { mode: 'json' }).$type<VectorClock>(),
    syncedAt: text('synced_at'),
    createdAt: text('created_at').notNull(),
    modifiedAt: text('modified_at').notNull(),
    storedAt: text('stored_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    index('idx_note_metadata_path').on(table.path),
    index('idx_note_metadata_modified').on(table.modifiedAt),
    index('idx_note_metadata_journal_date').on(table.journalDate),
    index('idx_note_metadata_local_only').on(table.localOnly)
  ]
)

export type NoteMetadata = typeof noteMetadata.$inferSelect
export type NewNoteMetadata = typeof noteMetadata.$inferInsert
