import { eq, isNull } from 'drizzle-orm'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { statuses } from '@memry/db-schema/schema/statuses'
import { taskTags, taskNotes } from '@memry/db-schema/schema/task-relations'
import { TaskSyncPayloadSchema, type TaskSyncPayload } from '@memry/contracts/sync-payloads'
import { TasksChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock, FieldClocks } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '../queue'
import { increment } from '@memry/sync-client/vector-clock'
import { mergeTaskFields, initAllFieldClocks, TASK_SYNCABLE_FIELDS } from '../field-merge'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import { MissingSyncParentError } from './types'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'
import { publishProjectionEvent } from '../../projections'
import { recordTaskSuperseded } from '../../tasks/activity-log'

const log = createLogger('TaskHandler')

/**
 * `tasks.project_id` is NOT NULL and FK-bound, so an absent project makes the
 * row unwritable. Surface it as a typed error naming the missing id instead of
 * SQLite's anonymous `FOREIGN KEY constraint failed` (#837).
 */
function requireProject(tx: DrizzleDb, taskId: string, projectId: string): void {
  const parent = tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get()
  if (!parent) throw new MissingSyncParentError('task', taskId, 'project', projectId)
}

/**
 * `tasks.status_id` is FK-bound with ON DELETE SET NULL, so null IS the
 * schema's own answer for a status that no longer exists (a project update can
 * reconcile statuses away underneath a task that still references one). Drop
 * the dangling reference rather than failing the whole apply.
 */
function resolveStatusId(
  tx: DrizzleDb,
  taskId: string,
  statusId: string | null | undefined
): string | null {
  if (!statusId) return null
  const parent = tx
    .select({ id: statuses.id })
    .from(statuses)
    .where(eq(statuses.id, statusId))
    .get()
  if (parent) return statusId
  log.warn('Task references a status that no longer exists — clearing statusId', {
    itemId: taskId,
    statusId
  })
  return null
}

function queryTags(db: DrizzleDb, taskId: string): string[] {
  return db
    .select({ tag: taskTags.tag })
    .from(taskTags)
    .where(eq(taskTags.taskId, taskId))
    .all()
    .map((r) => r.tag)
}

function queryNoteIds(db: DrizzleDb, taskId: string): string[] {
  return db
    .select({ noteId: taskNotes.noteId })
    .from(taskNotes)
    .where(eq(taskNotes.taskId, taskId))
    .all()
    .map((r) => r.noteId)
}

function writeTags(db: DrizzleDb, taskId: string, tagList: string[]): void {
  db.delete(taskTags).where(eq(taskTags.taskId, taskId)).run()
  // Case preserved; dedupe case-insensitively (NOCASE PK on (taskId, tag))
  const byKey = new Map<string, string>()
  for (const raw of tagList) {
    const tag = raw.trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (!byKey.has(key)) byKey.set(key, tag)
  }
  if (byKey.size > 0) {
    db.insert(taskTags)
      .values([...byKey.values()].map((tag) => ({ taskId, tag })))
      .run()
  }
}

function writeNoteIds(db: DrizzleDb, taskId: string, noteIds: string[]): void {
  db.delete(taskNotes).where(eq(taskNotes.taskId, taskId)).run()
  if (noteIds.length > 0) {
    db.insert(taskNotes)
      .values(noteIds.map((noteId) => ({ taskId, noteId })))
      .run()
  }
}

class TaskHandler extends BaseItemHandler<TaskSyncPayload> {
  readonly type = 'task' as const
  readonly schema = TaskSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: TaskSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(tasks).where(eq(tasks.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const remoteFieldClocks = data.fieldClocks ?? null
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock, remoteClock)

        if (resolution.action === 'skip') {
          return 'skipped'
        }

        if (resolution.action === 'merge') {
          const localFC =
            (existing.fieldClocks as FieldClocks) ??
            initAllFieldClocks(existing.clock ?? {}, TASK_SYNCABLE_FIELDS)
          const remoteFC =
            remoteFieldClocks ?? initAllFieldClocks(remoteClock, TASK_SYNCABLE_FIELDS)

          const result = mergeTaskFields(
            existing as Record<string, unknown>,
            data as Record<string, unknown>,
            localFC,
            remoteFC
          )

          log.info('=== TASK SYNC: MERGE RESULT ===', {
            itemId,
            hadConflicts: result.hadConflicts,
            conflictedFields: result.conflictedFields,
            merged: {
              title: result.merged.title,
              projectId: result.merged.projectId,
              statusId: result.merged.statusId,
              priority: result.merged.priority,
              description: (result.merged.description as string)?.slice(0, 50) ?? null
            }
          })

          const mergedTx = tx as unknown as DrizzleDb
          // Same "unchanged means omitted" rule as the plain-apply branch below.
          const mergedProjectId = result.merged.projectId as string | undefined
          if (mergedProjectId) requireProject(mergedTx, itemId, mergedProjectId)
          result.merged.statusId = resolveStatusId(
            mergedTx,
            itemId,
            result.merged.statusId as string | null
          )

          tx.update(tasks)
            .set({
              ...result.merged,
              clock: resolution.mergedClock,
              fieldClocks: result.mergedFieldClocks,
              syncedAt: now,
              modifiedAt: data.modifiedAt ?? now
            })
            .where(eq(tasks.id, itemId))
            .run()

          if (data.tags) {
            const localTags = queryTags(tx as unknown as DrizzleDb, itemId)
            const merged = [...new Set([...localTags, ...data.tags])]
            writeTags(tx as unknown as DrizzleDb, itemId, merged)
          }
          if (data.linkedNoteIds) {
            const localNotes = queryNoteIds(tx as unknown as DrizzleDb, itemId)
            const merged = [...new Set([...localNotes, ...data.linkedNoteIds])]
            writeNoteIds(tx as unknown as DrizzleDb, itemId, merged)
          }

          // The only activity rows a remote apply may write. Ordinary applied
          // changes arrive on their own as synced `task_activity` rows from the
          // device that made them; emitting here too would duplicate every
          // entry once per device. A lost merge has no such row — until now it
          // was only ever a log line — so this is where it gets recorded.
          for (const conflict of result.conflicts) {
            if (JSON.stringify(conflict.mergedValue) === JSON.stringify(conflict.localValue)) {
              continue
            }
            recordTaskSuperseded({
              taskId: itemId,
              field: conflict.field,
              losingValue: conflict.localValue,
              winningValue: conflict.mergedValue,
              mergedClock: conflict.mergedClock
            })
          }

          const updated = tx.select().from(tasks).where(eq(tasks.id, itemId)).get()
          ctx.emit(TasksChannels.events.UPDATED, { id: itemId, task: updated, changes: {} })
          if (data.tags) ctx.emit('notes:tags-changed', {})
          publishProjectionEvent({ type: 'task.upserted', taskId: itemId })
          return result.hadConflicts ? 'conflict' : 'applied'
        }

        const appliedFC = remoteFieldClocks ?? initAllFieldClocks(remoteClock, TASK_SYNCABLE_FIELDS)

        // An absent projectId means "unchanged" — drizzle omits the column, so
        // the existing (already valid) parent stays. Only a supplied one needs
        // checking.
        if (data.projectId) requireProject(tx as unknown as DrizzleDb, itemId, data.projectId)
        const appliedStatusId = resolveStatusId(tx as unknown as DrizzleDb, itemId, data.statusId)

        tx.update(tasks)
          .set({
            title: data.title,
            description: data.description ?? null,
            projectId: data.projectId,
            statusId: appliedStatusId,
            parentId: data.parentId ?? null,
            priority: data.priority ?? 0,
            position: data.position ?? 0,
            dueDate: data.dueDate ?? null,
            dueTime: data.dueTime ?? null,
            startDate: data.startDate ?? null,
            repeatConfig: data.repeatConfig ?? null,
            repeatFrom: data.repeatFrom ?? null,
            sourceNoteId: data.sourceNoteId ?? null,
            completedAt: data.completedAt ?? null,
            archivedAt: data.archivedAt ?? null,
            clock: resolution.mergedClock,
            fieldClocks: appliedFC,
            syncedAt: now,
            modifiedAt: data.modifiedAt ?? now
          })
          .where(eq(tasks.id, itemId))
          .run()

        if (data.tags) writeTags(tx as unknown as DrizzleDb, itemId, data.tags)
        if (data.linkedNoteIds) writeNoteIds(tx as unknown as DrizzleDb, itemId, data.linkedNoteIds)

        const updated = tx.select().from(tasks).where(eq(tasks.id, itemId)).get()
        ctx.emit(TasksChannels.events.UPDATED, { id: itemId, task: updated, changes: {} })
        if (data.tags) ctx.emit('notes:tags-changed', {})
        publishProjectionEvent({ type: 'task.upserted', taskId: itemId })
        return 'applied'
      }

      const insertedFC = remoteFieldClocks ?? initAllFieldClocks(remoteClock, TASK_SYNCABLE_FIELDS)

      requireProject(tx as unknown as DrizzleDb, itemId, data.projectId!)
      const insertedStatusId = resolveStatusId(tx as unknown as DrizzleDb, itemId, data.statusId)

      tx.insert(tasks)
        .values({
          id: itemId,
          title: data.title ?? 'Untitled',
          projectId: data.projectId!,
          statusId: insertedStatusId,
          parentId: data.parentId ?? null,
          description: data.description ?? null,
          priority: data.priority ?? 0,
          position: data.position ?? 0,
          dueDate: data.dueDate ?? null,
          dueTime: data.dueTime ?? null,
          startDate: data.startDate ?? null,
          repeatConfig: data.repeatConfig ?? null,
          repeatFrom: data.repeatFrom ?? null,
          sourceNoteId: data.sourceNoteId ?? null,
          completedAt: data.completedAt ?? null,
          archivedAt: data.archivedAt ?? null,
          clock: remoteClock,
          fieldClocks: insertedFC,
          syncedAt: now,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()

      if (data.tags) writeTags(tx as unknown as DrizzleDb, itemId, data.tags)
      if (data.linkedNoteIds) writeNoteIds(tx as unknown as DrizzleDb, itemId, data.linkedNoteIds)

      const inserted = tx.select().from(tasks).where(eq(tasks.id, itemId)).get()
      ctx.emit(TasksChannels.events.CREATED, { task: inserted })
      if (data.tags) ctx.emit('notes:tags-changed', {})
      publishProjectionEvent({ type: 'task.upserted', taskId: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(tasks).where(eq(tasks.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote task delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    const hadTags = queryTags(ctx.db, itemId).length > 0

    ctx.db.delete(tasks).where(eq(tasks.id, itemId)).run()
    ctx.emit(TasksChannels.events.DELETED, { id: itemId })
    if (hadTags) ctx.emit('notes:tags-changed', {})
    publishProjectionEvent({ type: 'task.deleted', taskId: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(tasks).where(eq(tasks.id, itemId)).get() as
      Record<string, unknown> | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const task = db.select().from(tasks).where(eq(tasks.id, itemId)).get()
    if (!task) return null
    const tagList = queryTags(db, itemId)
    const linkedNoteIds = queryNoteIds(db, itemId)
    return JSON.stringify({ ...task, tags: tagList, linkedNoteIds })
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(tasks).set({ syncedAt: utcNow() }).where(eq(tasks.id, itemId)).run()
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(tasks).where(isNull(tasks.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      const fieldClocks = initAllFieldClocks(clock, TASK_SYNCABLE_FIELDS)
      db.update(tasks).set({ clock, fieldClocks }).where(eq(tasks.id, item.id)).run()
      queue.enqueue({
        type: 'task',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({
          ...item,
          clock,
          fieldClocks,
          tags: queryTags(db, item.id),
          linkedNoteIds: queryNoteIds(db, item.id)
        }),
        priority: 0
      })
    }
    return items.length
  }
}

export const taskHandler = new TaskHandler()
