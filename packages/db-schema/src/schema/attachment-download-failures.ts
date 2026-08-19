import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

/**
 * Durable memory of attachment downloads that did NOT succeed.
 *
 * The only replay guard used to be an in-memory Set that recorded the *emit*,
 * was cleared on every sync-runtime stop and vanished with the process — so a
 * reference to an attachment the server 404s was re-requested on every launch,
 * forever. Rows here outlive both, and are written from the download outcome
 * rather than the request, so a 404 and a success are no longer the same event.
 *
 * A row is deleted the moment the download succeeds, and when this device
 * uploads that attachment itself, so the table only ever holds live failures.
 *
 * `nextAttemptAt` is the whole retry policy: a transient failure (5xx, network,
 * auth) gets an exponential backoff and keeps trying; a permanent 404 gets a
 * day-long cooldown for a bounded number of probes and then `NULL`, meaning no
 * automatic retry.
 */
export const attachmentDownloadFailures = sqliteTable(
  'attachment_download_failures',
  {
    /** `${ownerId}::${attachmentId}` — deterministic, so upserts need no lookup. */
    id: text('id').primaryKey(),
    /** Note id for embedded note attachments, canvas id for canvas assets. */
    ownerId: text('owner_id').notNull(),
    attachmentId: text('attachment_id').notNull(),
    /** 'missing' = the server answered 404. 'transient' = anything else. */
    reason: text('reason').$type<'missing' | 'transient'>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** Epoch ms of the earliest next attempt. NULL = do not retry automatically. */
    nextAttemptAt: integer('next_attempt_at'),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('idx_attachment_download_failures_owner').on(table.ownerId)]
)

export type AttachmentDownloadFailureRow = typeof attachmentDownloadFailures.$inferSelect
export type NewAttachmentDownloadFailureRow = typeof attachmentDownloadFailures.$inferInsert
