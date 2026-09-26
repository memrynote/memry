/**
 * Notes and journals whose change-feed body this device dropped because no
 * row existed for the id yet (#2421).
 *
 * Not a debt: nothing pulls a row here. It keeps a later record of the id on
 * its whole-body pull and the note off snapshot claims. Deleted when the
 * whole-body walk of the note merges, or when a delete tombstone for the id
 * applies.
 *
 * @module db/schema/crdt-body-withheld
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const crdtBodyWithheld = sqliteTable('crdt_body_withheld', {
  /** Note or journal id: the CRDT document id. */
  noteId: text('note_id').primaryKey(),

  /** Epoch milliseconds of the first rowless drop. Logs only. */
  createdAt: integer('created_at').notNull()
})
