/**
 * Read side of the task activity log.
 *
 * Writes live in `tasks/activity-log.ts`; this module only reads and prunes.
 *
 * @module database/queries/task-activity
 */

import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { taskActivity } from '@memry/db-schema/schema/task-activity'
import { statuses } from '@memry/db-schema/schema/statuses'
import { projects } from '@memry/db-schema/schema/projects'
import { tasks } from '@memry/db-schema/schema/tasks'
import type { TaskActivityEntry } from '@memry/contracts/tasks-api'
import { OFFLINE_CLOCK_DEVICE_ID } from '@memry/contracts/sync-api'
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

  const names = resolveReferencedNames(db, rows)

  // `null` means this device has no registered id yet — signed out, or before
  // the first link. The writer stamps those rows with OFFLINE_CLOCK_DEVICE_ID,
  // so mirroring its fallback here is what keeps a signed-out user's own edits
  // from reading as "Another device".
  const thisDeviceId = currentDeviceId ?? OFFLINE_CLOCK_DEVICE_ID

  return {
    entries: rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      action: row.action,
      field: row.field,
      oldValue: displayValue(row.field, row.oldValue, names),
      newValue: displayValue(row.field, row.newValue, names),
      actor: row.actor,
      // Resolved here rather than shipping the raw device id: the UI shows
      // "You" or nothing, never a machine name.
      isThisDevice: row.deviceId === thisDeviceId,
      createdAt: row.createdAt
    })),
    total: count,
    hasMore: offset + rows.length < count
  }
}

/**
 * Fields whose stored value is an entity id. The row stores the id because that
 * is what changed and what stays stable; the name is looked up at read time so
 * a rename does not rewrite history — and so the feed never shows `st_a1b2c3`.
 */
const REFERENCE_FIELDS: Record<string, 'status' | 'project' | 'task'> = {
  statusId: 'status',
  projectId: 'project',
  parentId: 'task'
}

type NameLookup = Record<string, string>

function decodeId(raw: string | null): string | null {
  if (raw === null) return null
  try {
    const value = JSON.parse(raw)
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

function resolveReferencedNames(
  db: DataDb,
  rows: Array<typeof taskActivity.$inferSelect>
): NameLookup {
  const wanted: Record<'status' | 'project' | 'task', Set<string>> = {
    status: new Set(),
    project: new Set(),
    task: new Set()
  }

  for (const row of rows) {
    const kind = row.field ? REFERENCE_FIELDS[row.field] : undefined
    if (!kind) continue
    for (const raw of [row.oldValue, row.newValue]) {
      const id = decodeId(raw)
      if (id) wanted[kind].add(id)
    }
  }

  const names: NameLookup = {}
  if (wanted.status.size > 0) {
    for (const row of db
      .select({ id: statuses.id, name: statuses.name })
      .from(statuses)
      .where(inArray(statuses.id, [...wanted.status]))
      .all()) {
      names[row.id] = row.name
    }
  }
  if (wanted.project.size > 0) {
    for (const row of db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(inArray(projects.id, [...wanted.project]))
      .all()) {
      names[row.id] = row.name
    }
  }
  if (wanted.task.size > 0) {
    for (const row of db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(inArray(tasks.id, [...wanted.task]))
      .all()) {
      names[row.id] = row.title
    }
  }
  return names
}

/** Falls back to the raw id when the referenced row is gone — a deleted project still happened. */
function displayValue(field: string | null, raw: string | null, names: NameLookup): string | null {
  if (raw === null || !field || !REFERENCE_FIELDS[field]) return raw
  const id = decodeId(raw)
  if (!id) return raw
  return JSON.stringify(names[id] ?? id)
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
