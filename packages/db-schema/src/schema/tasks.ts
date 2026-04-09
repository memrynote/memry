import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { VectorClock, FieldClocks } from '@memry/contracts/sync-api'
import { projects } from './projects.ts'
import { statuses } from './statuses.ts'

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    statusId: text('status_id').references(() => statuses.id, { onDelete: 'set null' }),
    parentId: text('parent_id'),

    title: text('title').notNull(),
    description: text('description'),
    priority: integer('priority').notNull().default(0),
    position: integer('position').notNull().default(0),

    dueDate: text('due_date'),
    dueTime: text('due_time'),
    startDate: text('start_date'),

    repeatConfig: text('repeat_config', { mode: 'json' }),
    repeatFrom: text('repeat_from'),

    // Note linking
    sourceNoteId: text('source_note_id'),

    completedAt: text('completed_at'),
    archivedAt: text('archived_at'),

    clock: text('clock', { mode: 'json' }).$type<VectorClock>(),
    fieldClocks: text('field_clocks', { mode: 'json' }).$type<FieldClocks>(),
    syncedAt: text('synced_at'),

    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    modifiedAt: text('modified_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  },
  (table) => [
    index('idx_tasks_project').on(table.projectId),
    index('idx_tasks_status').on(table.statusId),
    index('idx_tasks_parent').on(table.parentId),
    index('idx_tasks_due_date').on(table.dueDate),
    index('idx_tasks_completed').on(table.completedAt)
  ]
)

export type Task = typeof tasks.$inferSelect
export type NewTask = typeof tasks.$inferInsert
