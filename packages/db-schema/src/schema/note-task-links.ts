import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { tasks } from './tasks.ts'

/**
 * Local-only snapshot of the task lines last written to a note's markdown
 * file. Rebuilt from the Y.Doc after every writeback; used as re-match
 * candidates when seeding a doc from disk (spec: docs/obs/02-task-linkage.md).
 * Never synced — Y.Doc snapshots carry task ids across devices.
 */
export const noteTaskLinks = sqliteTable(
  'note_task_links',
  {
    taskId: text('task_id')
      .primaryKey()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    noteId: text('note_id').notNull(),
    /** Last SERIALIZED title — mirrors the file bytes, not the live task. */
    title: text('title').notNull(),
    checked: integer('checked', { mode: 'boolean' }).notNull().default(false),
    /** Occurrence index of the task line in doc order. */
    position: integer('position').notNull().default(0),
    anchor: text('anchor'),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [index('idx_note_task_links_note').on(table.noteId)]
)

export type NoteTaskLinkRow = typeof noteTaskLinks.$inferSelect
export type NewNoteTaskLinkRow = typeof noteTaskLinks.$inferInsert
