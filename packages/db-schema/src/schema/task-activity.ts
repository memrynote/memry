/**
 * Task Activity Schema
 *
 * Append-only audit trail per task: who changed what, when, and whether the
 * change later lost a sync merge.
 *
 * Two properties drive every decision in this file:
 *
 * 1. **Rows are immutable.** They are written once and never updated, so the
 *    sync record carries a whole-row `clock` and no `fieldClocks` — there is no
 *    field to merge. Apply is insert-if-absent (see task-activity-handler.ts).
 * 2. **Rows outlive their task.** There is deliberately NO foreign key to
 *    `tasks`. `task_notes`/`task_tags` cascade on task delete; a cascade here
 *    would erase the `deleted` entry itself, and peers would re-push the rows
 *    as orphans anyway.
 *
 * @module db/schema/task-activity
 */

import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import type { VectorClock } from '@memry/contracts/sync-api'

// ============================================================================
// Constants
// ============================================================================

/**
 * How long an activity row lives, in days.
 *
 * MUST be identical on every device. Retention is enforced on apply as well as
 * on write: a row pruned locally that a peer still holds would otherwise be
 * resurrected on the next pull. That only converges if every device agrees on
 * the same deterministic age rule — never a per-device row count.
 */
export const TASK_ACTIVITY_RETENTION_DAYS = 90

/** What happened to the task. */
export const TaskActivityActions = {
  CREATED: 'created',
  UPDATED: 'updated',
  COMPLETED: 'completed',
  UNCOMPLETED: 'uncompleted',
  MOVED: 'moved',
  DELETED: 'deleted',
  /** A local edit lost a sync merge — the value in `oldValue` was discarded. */
  SUPERSEDED: 'superseded'
} as const

export type TaskActivityAction = (typeof TaskActivityActions)[keyof typeof TaskActivityActions]

/** Who made the change. */
export const TaskActivityActors = {
  USER: 'user',
  GOOGLE_CALENDAR: 'google_calendar',
  SYNC: 'sync'
} as const

export type TaskActivityActor = (typeof TaskActivityActors)[keyof typeof TaskActivityActors]

// ============================================================================
// task_activity Table
// ============================================================================

export const taskActivity = sqliteTable(
  'task_activity',
  {
    /**
     * Unique identifier.
     *
     * `superseded` rows derive theirs deterministically from the conflict, so
     * two devices observing mirror images of the same merge mint the same id
     * and insert-if-absent collapses them into one row.
     */
    id: text('id').primaryKey(),

    /** Task this entry belongs to. No FK on purpose — see the module comment. */
    taskId: text('task_id').notNull(),

    /** One of TaskActivityActions */
    action: text('action').notNull(),

    /** Field name for `updated`/`superseded` rows; null for create/delete/complete/move */
    field: text('field'),

    /**
     * Value before the change, JSON-encoded.
     *
     * Always null for `description`: it is BlockNote markdown and can be
     * note-sized, so duplicating it per edit would inflate both the local DB
     * and the encrypted R2 payload. The row carries a length delta instead.
     */
    oldValue: text('old_value'),

    /** Value after the change, JSON-encoded. Null for `description` (see above). */
    newValue: text('new_value'),

    /** One of TaskActivityActors */
    actor: text('actor').notNull().default('user'),

    /**
     * Device that wrote the row. `_offline` (OFFLINE_CLOCK_DEVICE_ID) before
     * device registration; there is no rebinding hook, so such a row stays
     * `_offline` for its whole life.
     */
    deviceId: text('device_id'),

    /** ISO-8601 UTC. Sorts lexicographically, which the retention cutoff relies on. */
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),

    // ========================================================================
    // Sync
    // ========================================================================

    /** Vector clock. Whole-row LWW; rows are immutable so this only ever grows once. */
    clock: text('clock', { mode: 'json' }).$type<VectorClock>(),

    /** When this row was last synced to the server */
    syncedAt: text('synced_at')
  },
  (table) => [
    /** The only read pattern: one task's feed, newest first. */
    index('task_activity_by_task').on(table.taskId, table.createdAt)
  ]
)

export type TaskActivityRow = typeof taskActivity.$inferSelect
export type NewTaskActivityRow = typeof taskActivity.$inferInsert
