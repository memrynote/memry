/**
 * Notes the app's create command made on this device (#5371).
 *
 * Written only by `createNoteCommand`. A note the vault ingest or the file
 * watcher indexed from a file has no row: that file may come from a folder
 * another device shares (iCloud, Dropbox, git) and already synced. An
 * in-memory editor open seeds a never-synced note offline only with a row here
 * (`isNeverSyncedLocalNote`). Rows are never deleted; one whose note is gone is
 * never read.
 *
 * @module db/schema/notes-created-here
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const notesCreatedHere = sqliteTable('notes_created_here', {
  /** The note id: the CRDT document id. */
  noteId: text('note_id').primaryKey(),

  /** Epoch milliseconds of the create. Logs only. */
  createdAt: integer('created_at').notNull()
})
