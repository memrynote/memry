/**
 * The note-attachment files this device knows the server has (#2651).
 *
 * One row per file a note owns or embeds, keyed by its vault-relative path:
 * written when an upload of it succeeds and when a download materializes it.
 * Attachment ids are random per upload, so this record is the only way to tell
 * a new file on a note that already holds references from one already up.
 *
 * `attachmentId` is null for a file counted when an older note was first seen:
 * nothing says whether it went up, and re-uploading it would duplicate it. A
 * row with an empty `path` marks a note counted while it had no file on disk.
 *
 * @module db/schema/attachment-files
 */

import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

export const attachmentFiles = sqliteTable(
  'attachment_files',
  {
    noteId: text('note_id').notNull(),
    /** Vault-relative, forward slashes. */
    path: text('path').notNull(),
    attachmentId: text('attachment_id'),
    recordedAt: integer('recorded_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.noteId, table.path] })]
)
