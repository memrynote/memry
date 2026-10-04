/**
 * Notes whose vault file holds a body their CRDT doc has not taken (#2646).
 *
 * Written when a main-process edit reaches a note whose doc could not take it
 * (no store, no editor). Deleted when the doc takes the file: a feed of the
 * file, a seed from it, or a purge of the note.
 *
 * @module db/schema/crdt-owed-file-bodies
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const crdtOwedFileBodies = sqliteTable('crdt_owed_file_bodies', {
  /** Note or journal id: the CRDT document id. */
  noteId: text('note_id').primaryKey(),

  /** Epoch milliseconds of the first edit the doc could not take. Logs only. */
  createdAt: integer('created_at').notNull()
})
