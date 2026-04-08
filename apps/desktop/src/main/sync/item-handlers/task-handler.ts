import { eq, isNull } from 'drizzle-orm'
import { tasks } from '@memry/db-schema/schema/tasks'
import { taskTags, taskNotes } from '@memry/db-schema/schema/task-relations'
import { TaskSyncPayloadSchema, type TaskSyncPayload } from '@memry/contracts/sync-payloads'
import { TasksChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock, FieldClocks } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { mergeTaskFields, initAllFieldClocks, TASK_SYNCABLE_FIELDS } from '../field-merge'
import { createLogger } from '../../lib/logger'
import { resolveClockConflict } from './types'
import type { SyncItemHandler, ApplyContext, ApplyResult, DrizzleDb } from './types'
import { publishProjectionEvent } from '../../projections'

const log = createLogger('TaskHandler')

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

function writeTags(db: DrizzleDb, taskId: string, tags: string[]): void {
  db.delete(taskTags).where(eq(taskTags.taskId, taskId)).run()
  if (tags.length > 0) {
    db.insert(taskTags)
      .values(tags.map((tag) => ({ taskId, tag: tag.toLowerCase().trim() })))
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

export const taskHandler: SyncItemHandler<TaskSyncPayload> = {
  type: 'task',
  schema: TaskSyncPayloadSchema,

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
        const resolution = resolveClockConflict(existing.clock, remoteClock)

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

          const updated = tx.select().from(tasks).where(eq(tasks.id, itemId)).get()
          ctx.emit(TasksChannels.events.UPDATED, { id: itemId, task: updated, changes: {} })
          publishProjectionEvent({ type: 'task.upserted', taskId: itemId })
          return result.hadConflicts ? 'conflict' : 'applied'
        }

        const appliedFC = remoteFieldClocks ?? initAllFieldClocks(remoteClock, TASK_SYNCABLE_FIELDS)

        tx.update(tasks)
          .set({
            title: data.title,
            description: data.description ?? null,
            projectId: data.projectId,
            statusId: data.statusId ?? null,
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
        publishProjectionEvent({ type: 'task.upserted', taskId: itemId })
        return 'applied'
      }

      const insertedFC = remoteFieldClocks ?? initAllFieldClocks(remoteClock, TASK_SYNCABLE_FIELDS)

      tx.insert(tasks)
        .values({
          id: itemId,
          title: data.title ?? 'Untitled',
          projectId: data.projectId!,
          statusId: data.statusId ?? null,
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
      publishProjectionEvent({ type: 'task.upserted', taskId: itemId })
      return 'applied'
    })
  },

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(tasks).where(eq(tasks.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = resolveClockConflict(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote task delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(tasks).where(eq(tasks.id, itemId)).run()
    ctx.emit(TasksChannels.events.DELETED, { id: itemId })
    publishProjectionEvent({ type: 'task.deleted', taskId: itemId })
    return 'applied'
  },

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(tasks).where(eq(tasks.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  },

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const task = db.select().from(tasks).where(eq(tasks.id, itemId)).get()
    if (!task) return null
    const tags = queryTags(db, itemId)
    const linkedNoteIds = queryNoteIds(db, itemId)
    return JSON.stringify({ ...task, tags, linkedNoteIds })
  },

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(tasks).set({ syncedAt: utcNow() }).where(eq(tasks.id, itemId)).run()
  },

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
