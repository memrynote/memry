import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * Durable outbox for note-attachment uploads.
 *
 * A row is written before an upload is handed to the in-memory queue and only
 * deleted after the server accepts the file, so an upload that fails or is
 * interrupted by quit survives restarts and is retried on the next sync
 * runtime start. `attempts`/`lastError` keep the failure inspectable.
 */
export const attachmentUploadQueue = sqliteTable(
  'attachment_upload_queue',
  {
    id: text('id').primaryKey(),
    noteId: text('note_id').notNull(),
    diskPath: text('disk_path').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [uniqueIndex('attachment_upload_queue_note_path').on(table.noteId, table.diskPath)]
)

export type AttachmentUploadQueueRow = typeof attachmentUploadQueue.$inferSelect
export type NewAttachmentUploadQueueRow = typeof attachmentUploadQueue.$inferInsert
