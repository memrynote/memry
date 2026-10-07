/**
 * Where each note's body stands with the server (#2647).
 *
 * The body travels as CRDT updates through the note body outbox, and those
 * never move `note_cache.synced_at`, so that column cannot say whether the
 * latest text reached the server. This table records the outbox's own push
 * results for the note's body. Waiting changes are read from `sync_queue` and
 * `crdt_owed_file_bodies`; this table only holds what happened to them.
 *
 * A row is written when a body push starts and when it ends. Only a 2xx answer
 * from a CRDT body route sets `last_confirmed_at`; a record push the server
 * calls a replay never does. Deleted on a purge of the note.
 *
 * @module db/schema/note-body-sync
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const noteBodySync = sqliteTable('note_body_sync', {
  /** Note or journal id: the CRDT document id. */
  noteId: text('note_id').primaryKey(),

  /** Epoch milliseconds the latest body push started. */
  lastSentAt: integer('last_sent_at'),

  /** Epoch milliseconds the server last stored a body push of this note. */
  lastConfirmedAt: integer('last_confirmed_at'),

  /** Epoch milliseconds of the latest body push that failed and will be retried. */
  lastFailedAt: integer('last_failed_at'),

  /** Epoch milliseconds the server last refused a body push for good; its changes were dropped. */
  lastRejectedAt: integer('last_rejected_at'),

  /** Epoch milliseconds of the latest write to this row. */
  updatedAt: integer('updated_at').notNull()
})

export type NoteBodySyncRow = typeof noteBodySync.$inferSelect
