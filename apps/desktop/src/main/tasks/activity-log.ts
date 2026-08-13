/**
 * Task activity log — the write side.
 *
 * Every task mutation in the app reaches this module through
 * `createTasksPublisher()`, which is the only choke point that sees them all:
 * IPC handlers, Agent Chat / MCP, the Todoist and TickTick importers, the
 * markdown-checkbox reconcile, and note runtime effects all mutate tasks
 * through the domain. Hooking the query layer or a SQLite trigger instead would
 * also catch sync-apply and push-ack writes, so every device would log every
 * peer's change and then sync those rows back — N² duplication.
 *
 * Nothing in here may throw. Publisher callbacks are fire-and-forget at several
 * call sites, so a failed audit row must never take the mutation down with it.
 *
 * @module tasks/activity-log
 */

import { createHash } from 'node:crypto'
import type { Task } from '@memry/domain-tasks'
import {
  taskActivity,
  TaskActivityActions,
  TaskActivityActors,
  type TaskActivityAction,
  type TaskActivityActor
} from '@memry/db-schema/schema/task-activity'
import { OFFLINE_CLOCK_DEVICE_ID } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import { getDatabase } from '../database'
import { generateId } from '../lib/id'
import { createLogger } from '../lib/logger'
import { enqueueLocalSyncCreate } from '../sync/local-mutations'
import { getCurrentDeviceId } from '../sync/current-device-id'

const log = createLogger('TaskActivity')

/**
 * Reordering loops every id in the list, so a 200-task drag would otherwise
 * write 200 rows and push 200 sync items — for a change nobody audits.
 */
const IGNORED_FIELDS = new Set(['position', 'modifiedAt'])

/** Stored as a length delta, never as the body text. See the schema module. */
const LENGTH_ONLY_FIELDS = new Set(['description'])

interface ActivityRowInput {
  taskId: string
  action: TaskActivityAction
  field?: string | null
  oldValue?: string | null
  newValue?: string | null
  actor?: TaskActivityActor
  /** Only `superseded` rows set this; everything else gets a fresh id. */
  id?: string
}

function encodeValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function textLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0
}

/**
 * Fields worth an entry: everything the differ reported minus the noise list.
 * An empty result means the mutation was a no-op — `reconcile-markdown-tasks`
 * runs on every external file edit *and* every note open, and must not write a
 * row for either.
 */
function auditableFields(changedFields: string[] | undefined): string[] {
  return (changedFields ?? []).filter((field) => !IGNORED_FIELDS.has(field))
}

function writeRows(rows: ActivityRowInput[]): void {
  if (rows.length === 0) return

  try {
    const db = getDatabase()
    const deviceId = getCurrentDeviceId(db) ?? OFFLINE_CLOCK_DEVICE_ID
    const createdAt = utcNow()

    for (const row of rows) {
      const id = row.id ?? generateId()

      // Insert-if-absent by hand: `superseded` rows carry a deterministic id
      // that the other side of the same conflict may already have written.
      db.insert(taskActivity)
        .values({
          id,
          taskId: row.taskId,
          action: row.action,
          field: row.field ?? null,
          oldValue: row.oldValue ?? null,
          newValue: row.newValue ?? null,
          actor: row.actor ?? TaskActivityActors.USER,
          deviceId,
          createdAt
        })
        .onConflictDoNothing()
        .run()

      enqueueLocalSyncCreate('task_activity', id)
    }
  } catch (err) {
    // Swallowed on purpose — see the module comment.
    log.warn('Failed to record task activity', { error: err, count: rows.length })
  }
}

function fieldRows(
  taskId: string,
  action: TaskActivityAction,
  changedFields: string[] | undefined,
  next: Partial<Task>,
  previous: Partial<Task> | undefined,
  actor: TaskActivityActor
): ActivityRowInput[] {
  return auditableFields(changedFields).map((field) => {
    if (LENGTH_ONLY_FIELDS.has(field)) {
      const delta =
        textLength(next[field as keyof Task]) - textLength(previous?.[field as keyof Task])
      return { taskId, action, field, oldValue: null, newValue: JSON.stringify({ delta }), actor }
    }

    return {
      taskId,
      action,
      field,
      oldValue: encodeValue(previous?.[field as keyof Task]),
      newValue: encodeValue(next[field as keyof Task]),
      actor
    }
  })
}

/**
 * Takes the row shape rather than a full `Task` — the inbox filing path builds
 * its task straight from `insertTask` and never materializes a domain `Task`.
 */
export function recordTaskCreated(
  task: { id: string; title: string },
  actor: TaskActivityActor = TaskActivityActors.USER
): void {
  writeRows([
    {
      taskId: task.id,
      action: TaskActivityActions.CREATED,
      newValue: encodeValue(task.title),
      actor
    }
  ])
}

export function recordTaskUpdated(event: {
  id: string
  task: Task
  changes: Partial<Task>
  changedFields: string[]
  previous?: Partial<Task>
  actor?: TaskActivityActor
}): void {
  writeRows(
    fieldRows(
      event.id,
      TaskActivityActions.UPDATED,
      event.changedFields,
      { ...event.task, ...event.changes },
      event.previous,
      event.actor ?? TaskActivityActors.USER
    )
  )
}

export function recordTaskMoved(event: {
  id: string
  task: Task
  changedFields: string[]
  previous?: Partial<Task>
}): void {
  writeRows(
    fieldRows(
      event.id,
      TaskActivityActions.MOVED,
      event.changedFields,
      event.task,
      event.previous,
      TaskActivityActors.USER
    )
  )
}

export function recordTaskCompleted(event: {
  id: string
  task: Task
  previous?: Partial<Task>
}): void {
  const wasComplete = Boolean(event.previous?.completedAt)
  const isComplete = Boolean(event.task.completedAt)
  if (wasComplete === isComplete) return

  writeRows([
    {
      taskId: event.id,
      action: isComplete ? TaskActivityActions.COMPLETED : TaskActivityActions.UNCOMPLETED,
      field: 'completedAt',
      oldValue: encodeValue(event.previous?.completedAt),
      newValue: encodeValue(event.task.completedAt),
      actor: TaskActivityActors.USER
    }
  ])
}

export function recordTaskDeleted(id: string, snapshot?: Task): void {
  writeRows([
    {
      taskId: id,
      action: TaskActivityActions.DELETED,
      oldValue: encodeValue(snapshot?.title),
      actor: TaskActivityActors.USER
    }
  ])
}

/**
 * A write that bypasses the tasks domain publisher — today only the Google
 * Calendar writeback, which updates task columns directly.
 *
 * Diffs the raw column updates against a pre-read row so unchanged columns
 * (Google re-sends the same title on every poll) produce no entry.
 */
export function recordExternalTaskUpdate(
  taskId: string,
  before: Record<string, unknown> | undefined,
  updates: Record<string, unknown>,
  actor: TaskActivityActor
): void {
  const changedFields = Object.keys(updates).filter((field) => {
    if (IGNORED_FIELDS.has(field)) return false
    return JSON.stringify(before?.[field] ?? null) !== JSON.stringify(updates[field] ?? null)
  })

  writeRows(
    fieldRows(
      taskId,
      TaskActivityActions.UPDATED,
      changedFields,
      updates as Partial<Task>,
      before as Partial<Task> | undefined,
      actor
    )
  )
}

/** Stable JSON — object keys in sorted order, so two devices hash identically. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/**
 * The id both sides of a conflict must agree on.
 *
 * Derived from the *merged* field clock rather than from the winning device:
 * clock merge is commutative, so the two devices observing mirror images of the
 * same conflict compute the same value, mint the same id, and insert-if-absent
 * collapses their two rows into one. Keying off the winner would not converge —
 * each device sees the other as the winner.
 */
export function taskSupersededActivityId(
  taskId: string,
  field: string,
  mergedClock: Record<string, number>
): string {
  const digest = createHash('sha256')
    .update(`${taskId} ${field} ${canonicalJson(mergedClock)}`)
    .digest('hex')
  return `tac_${digest.slice(0, 20)}`
}

/**
 * A local edit that lost a sync merge.
 *
 * Written from the losing device's point of view. In the rare mirror case both
 * devices write a row and the first one to land wins the shared id; both
 * describe the same conflict on the same field, so the survivor is still true.
 */
export function recordTaskSuperseded(conflict: {
  taskId: string
  field: string
  losingValue: unknown
  winningValue: unknown
  mergedClock: Record<string, number>
}): void {
  writeRows([
    {
      id: taskSupersededActivityId(conflict.taskId, conflict.field, conflict.mergedClock),
      taskId: conflict.taskId,
      action: TaskActivityActions.SUPERSEDED,
      field: conflict.field,
      oldValue: encodeValue(conflict.losingValue),
      newValue: encodeValue(conflict.winningValue),
      actor: TaskActivityActors.SYNC
    }
  ])
}
