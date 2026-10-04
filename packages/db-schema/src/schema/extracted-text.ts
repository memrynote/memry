import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'
import { noteCache } from './notes-cache.ts'

/**
 * How a part's text was read. `unreadable` keeps the part's slot so a resumed
 * job does not retry a page that already failed twice.
 */
export const EXTRACTED_TEXT_METHODS = ['pdf-text', 'ocr', 'unreadable'] as const
export type ExtractedTextMethod = (typeof EXTRACTED_TEXT_METHODS)[number]

/**
 * Text the index read from something other than a note's markdown, searchable
 * under `note_id`. Index DB only: every device extracts its own and nothing here
 * syncs. A filed PDF stores one row per page (`part` is the 1-based page), an
 * image one row (`part` 1). The rows go with their `note_cache` row.
 */
export const extractedText = sqliteTable(
  'extracted_text',
  {
    noteId: text('note_id')
      .notNull()
      .references(() => noteCache.id, { onDelete: 'cascade' }),
    part: integer('part').notNull(),
    method: text('method').$type<ExtractedTextMethod>().notNull(),
    text: text('text').notNull()
  },
  (table) => [primaryKey({ columns: [table.noteId, table.part] })]
)

export const FILE_TEXT_JOB_STATUSES = ['pending', 'done', 'failed'] as const
export type FileTextJobStatus = (typeof FILE_TEXT_JOB_STATUSES)[number]

/**
 * Background extraction state for one filed PDF or image. `signature` is the
 * size and mtime of the bytes the `extracted_text` rows came from; a file whose
 * signature moves starts over. A `pending` job resumes after its last stored part.
 * `app_version` is the build that last worked on it, so a newer build retries
 * what an older one failed.
 */
export const fileTextJobs = sqliteTable('file_text_jobs', {
  noteId: text('note_id')
    .primaryKey()
    .references(() => noteCache.id, { onDelete: 'cascade' }),
  signature: text('signature').notNull(),
  status: text('status').$type<FileTextJobStatus>().notNull(),
  pageCount: integer('page_count'),
  error: text('error'),
  appVersion: text('app_version').notNull(),
  updatedAt: text('updated_at').notNull()
})

export type FileTextJobRow = typeof fileTextJobs.$inferSelect
