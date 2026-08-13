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
import { TaskActivityChannels } from '@memry/contracts/ipc-channels'
import { utcNow } from '@memry/shared/utc'
import { getDatabase } from '../database'
import { generateId } from '../lib/id'
import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
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
export function isAuditableField(field: string): boolean {
  return !IGNORED_FIELDS.has(field)
}

function auditableFields(changedFields: string[] | undefined): string[] {
  return (changedFields ?? []).filter(isAuditableField)
}

function writeRows(rows: ActivityRowInput[]): void {
  if (rows.length === 0) return

  let db: ReturnType<typeof getDatabase>
  let deviceId: string
  try {
    db = getDatabase()
    deviceId = getCurrentDeviceId(db) ?? OFFLINE_CLOCK_DEVICE_ID
  } catch (err) {
    // Swallowed on purpose — see the module comment.
    log.warn('Failed to record task activity', { error: err, count: rows.length })
    return
  }

  const createdAt = utcNow()
  const touchedTaskIds = new Set<string>()

  for (const row of rows) {
    // Per row, not per batch: one bad row must not silently drop the rest of a
    // multi-field edit.
    try {
      const id = row.id ?? generateId()

      // Insert-if-absent by hand: `superseded` rows carry a deterministic id
      // that the other side of the same conflict may already have written.
      const result = db
        .insert(taskActivity)
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

      // Nothing inserted means the peer's copy of this deterministic-id row is
      // already here. Enqueuing anyway would bump the clock on a row this
      // device did not author and push a redundant encrypted blob.
      if (result.changes === 0) continue

      enqueueLocalSyncCreate('task_activity', id)
      touchedTaskIds.add(row.taskId)
    } catch (err) {
      log.warn('Failed to record task activity row', { error: err, taskId: row.taskId })
    }
  }

  // The renderer's activity query cannot rely on `tasks:updated` alone: the
  // Google Calendar writeback never emits it, and a peer's task update that
  // loses whole-row LWW returns 'skipped' without emitting either — while its
  // activity rows still land. So the write itself announces.
  for (const taskId of touchedTaskIds) {
    try {
      broadcastToAllWindows(TaskActivityChannels.events.CREATED, { taskId })
    } catch (err) {
      log.warn('Failed to announce task activity', { error: err, taskId })
    }
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
  const rows: ActivityRowInput[] = []

  for (const field of auditableFields(changedFields)) {
    if (LENGTH_ONLY_FIELDS.has(field)) {
      rows.push(lengthOnlyRow(taskId, action, field, next, previous, actor))
      continue
    }

    const oldValue = encodeValue(previous?.[field as keyof Task])
    const newValue = encodeValue(next[field as keyof Task])

    // `changedFields` on the move and bulk-move paths is built from which
    // inputs the caller supplied, not from a diff, so moving a task to the
    // project it is already in would otherwise log `proj-A → proj-A`.
    if (oldValue === newValue) continue

    rows.push({ taskId, action, field, oldValue, newValue, actor })
  }

  return rows
}

/**
 * A row for a field whose value must never be stored — today only
 * `description`. Carries the character delta so the UI can say what happened
 * without the body ever reaching the database or an encrypted payload.
 */
function lengthOnlyRow(
  taskId: string,
  action: TaskActivityAction,
  field: string,
  next: Partial<Task>,
  previous: Partial<Task> | undefined,
  actor: TaskActivityActor
): ActivityRowInput {
  const delta = textLength(next[field as keyof Task]) - textLength(previous?.[field as keyof Task])
  return { taskId, action, field, oldValue: null, newValue: JSON.stringify({ delta }), actor }
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
  const next = { ...event.task, ...event.changes }
  const actor = event.actor ?? TaskActivityActors.USER

  // `uncompleteTask` publishes taskUpdated, not taskCompleted, so completion
  // has to be recognized here too — otherwise reopening a task reads as a
  // generic edit to a timestamp field and the `uncompleted` action is dead.
  const completion = completionRow(event.id, next, event.previous)
  const rest = event.changedFields.filter((field) => field !== 'completedAt')

  writeRows([
    ...(completion ? [completion] : []),
    ...fieldRows(event.id, TaskActivityActions.UPDATED, rest, next, event.previous, actor)
  ])
}

/** Completion is a state flip, not a timestamp edit — logged as its own action. */
function completionRow(
  taskId: string,
  next: Partial<Task>,
  previous: Partial<Task> | undefined
): ActivityRowInput | null {
  const wasComplete = Boolean(previous?.completedAt)
  const isComplete = Boolean(next.completedAt)
  if (wasComplete === isComplete) return null

  return {
    taskId,
    action: isComplete ? TaskActivityActions.COMPLETED : TaskActivityActions.UNCOMPLETED,
    field: 'completedAt',
    oldValue: encodeValue(previous?.completedAt),
    newValue: encodeValue(next.completedAt),
    actor: TaskActivityActors.USER
  }
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
  const row = completionRow(event.id, event.task, event.previous)
  writeRows(row ? [row] : [])
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
  // `position` is a syncable field, so two devices reordering the same project
  // offline produce one conflict per task. Those are exactly the rows the noise
  // rule exists to suppress, and here they would each become a sync item too.
  if (!isAuditableField(conflict.field)) return

  const isLengthOnly = LENGTH_ONLY_FIELDS.has(conflict.field)

  writeRows([
    {
      id: taskSupersededActivityId(conflict.taskId, conflict.field, conflict.mergedClock),
      taskId: conflict.taskId,
      action: TaskActivityActions.SUPERSEDED,
      field: conflict.field,
      // A losing description is still a description: storing it here would put
      // note-sized markdown into an encrypted sync payload, which is the one
      // thing this table promises never to do.
      oldValue: isLengthOnly ? null : encodeValue(conflict.losingValue),
      newValue: isLengthOnly
        ? JSON.stringify({
            delta: textLength(conflict.winningValue) - textLength(conflict.losingValue)
          })
        : encodeValue(conflict.winningValue),
      actor: TaskActivityActors.SYNC
    }
  ])
}
