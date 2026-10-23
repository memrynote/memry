import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { OFFLINE_CLOCK_DEVICE_ID } from '@memry/contracts/sync-api'
import type { TaskActivityEntry } from '@memry/contracts/tasks-api'
import { projects, statuses, syncDevices, taskActivity, tasks } from '@memry/db-schema/data-schema'
import type { DataDb } from './database.ts'

export interface TaskActivityListInput {
  taskId: string
  limit?: number
  offset?: number
  actions?: string[]
}

export interface TaskActivityListResult {
  entries: TaskActivityEntry[]
  total: number
  hasMore: boolean
}

export interface TaskActivityService {
  list(input: TaskActivityListInput): Promise<TaskActivityListResult>
}

const DEFAULT_LIMIT = 50

// Mirrors apps/desktop/src/main/database/queries/task-activity.ts (`listTaskActivity`).
// Read only: desktop prunes expired rows on read, and the CLI leaves that to it.

/**
 * Fields whose stored value is an entity id. The name is looked up at read time so a
 * rename does not rewrite history.
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

/** Falls back to the raw id when the referenced row is gone: a deleted project still happened. */
function displayValue(field: string | null, raw: string | null, names: NameLookup): string | null {
  if (raw === null || !field || !REFERENCE_FIELDS[field]) return raw
  const id = decodeId(raw)
  if (!id) return raw
  return JSON.stringify(names[id] ?? id)
}

export function createTaskActivityService(dataDb: DataDb): TaskActivityService {
  return {
    async list(input) {
      const limit = input.limit ?? DEFAULT_LIMIT
      const offset = input.offset ?? 0

      const filters = [eq(taskActivity.taskId, input.taskId)]
      if (input.actions && input.actions.length > 0) {
        filters.push(inArray(taskActivity.action, input.actions))
      }
      const where = and(...filters)

      const rows = dataDb
        .select()
        .from(taskActivity)
        .where(where)
        // One edit that touches three fields writes three rows with the same
        // `created_at`; `id` breaks the tie so paging never repeats or skips a row.
        .orderBy(desc(taskActivity.createdAt), desc(taskActivity.id))
        .limit(limit)
        .offset(offset)
        .all()
      const [{ count }] = dataDb
        .select({ count: sql<number>`count(*)` })
        .from(taskActivity)
        .where(where)
        .all()

      const names = resolveReferencedNames(dataDb, rows)
      // `null` means this device has no registered id yet; the writer stamps such
      // rows with OFFLINE_CLOCK_DEVICE_ID.
      const thisDeviceId =
        dataDb
          .select({ id: syncDevices.id })
          .from(syncDevices)
          .where(eq(syncDevices.isCurrentDevice, true))
          .get()?.id ?? OFFLINE_CLOCK_DEVICE_ID

      return {
        entries: rows.map((row) => ({
          id: row.id,
          taskId: row.taskId,
          action: row.action,
          field: row.field,
          oldValue: displayValue(row.field, row.oldValue, names),
          newValue: displayValue(row.field, row.newValue, names),
          actor: row.actor,
          isThisDevice: row.deviceId === thisDeviceId,
          createdAt: row.createdAt
        })),
        total: count,
        hasMore: offset + rows.length < count
      }
    }
  }
}
