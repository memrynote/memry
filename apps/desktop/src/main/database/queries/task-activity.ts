/**
 * Read side of the task activity log.
 *
 * Writes live in `tasks/activity-log.ts`; this module only reads and prunes.
 *
 * @module database/queries/task-activity
 */

import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { taskActivity } from '@memry/db-schema/schema/task-activity'
import type { TaskActivityEntry } from '@memry/contracts/tasks-api'
import type { DataDb } from '../client'

export interface ListTaskActivityInput {
  taskId: string
  limit?: number
  offset?: number
  actions?: string[]
}

export interface ListTaskActivityResult {
  entries: TaskActivityEntry[]
  total: number
  hasMore: boolean
}

const DEFAULT_LIMIT = 50

export function listTaskActivity(
  db: DataDb,
  input: ListTaskActivityInput,
  currentDeviceId: string | null
): ListTaskActivityResult {
  const limit = input.limit ?? DEFAULT_LIMIT
  const offset = input.offset ?? 0

  const filters = [eq(taskActivity.taskId, input.taskId)]
  if (input.actions && input.actions.length > 0) {
    filters.push(inArray(taskActivity.action, input.actions))
  }
  const where = filters.length === 1 ? filters[0] : and(...filters)

  const rows = db
    .select()
    .from(taskActivity)
    .where(where)
    // Ties are common: one edit that touches three fields writes three rows
    // with the identical `created_at`. `id` breaks the tie so paging cannot
    // show or skip the same row twice.
    .orderBy(desc(taskActivity.createdAt), desc(taskActivity.id))
    .limit(limit)
    .offset(offset)
    .all()

  const [{ count }] = db
    .select({ count: sql<number>`count(*)` })
    .from(taskActivity)
    .where(where)
    .all()

  return {
    entries: rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      action: row.action,
      field: row.field,
      oldValue: row.oldValue,
      newValue: row.newValue,
      actor: row.actor,
      // Resolved here rather than shipping the raw device id: the UI shows
      // "You" or nothing, never a machine name.
      isThisDevice: currentDeviceId !== null && row.deviceId === currentDeviceId,
      createdAt: row.createdAt
    })),
    total: count,
    hasMore: offset + rows.length < count
  }
}

/**
 * Drops rows past the retention cutoff.
 *
 * Peers prune independently from the same age rule, and `applyUpsert` rejects
 * anything older than the cutoff, so a row deleted here cannot come back on the
 * next pull. Deletes are deliberately not synced.
 */
export function pruneTaskActivity(db: DataDb, cutoffIso: string): number {
  const result = db.delete(taskActivity).where(lt(taskActivity.createdAt, cutoffIso)).run()
  return result.changes
}
