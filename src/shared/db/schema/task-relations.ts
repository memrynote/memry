import { sqliteTable, text, primaryKey, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { tasks } from './tasks'

export const taskNotes = sqliteTable(
  'task_notes',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    noteId: text('note_id').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [primaryKey({ columns: [table.taskId, table.noteId] })]
)

export const taskTags = sqliteTable(
  'task_tags',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.tag] }),
    index('idx_task_tags_tag').on(table.tag)
  ]
)

export type TaskNote = typeof taskNotes.$inferSelect
export type NewTaskNote = typeof taskNotes.$inferInsert
export type TaskTag = typeof taskTags.$inferSelect
export type NewTaskTag = typeof taskTags.$inferInsert
