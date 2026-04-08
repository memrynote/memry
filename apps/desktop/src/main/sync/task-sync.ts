import { eq } from 'drizzle-orm'
import { tasks } from '@memry/db-schema/schema/tasks'
import { taskTags, taskNotes } from '@memry/db-schema/schema/task-relations'
import type { VectorClock, FieldClocks } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'
import { initAllFieldClocks, TASK_SYNCABLE_FIELDS } from './field-merge'
import {
  hasOfflineClockData,
  incrementTaskClocksOffline,
  rebindOfflineClockData
} from './offline-clock'
import { createLogger } from '../lib/logger'
import type { DrizzleDb } from '../database/client'

const log = createLogger('TaskSync')

function enrichWithJunctionData(
  db: DrizzleDb,
  taskId: string,
  base: Record<string, unknown>
): Record<string, unknown> {
  const tags = db
    .select({ tag: taskTags.tag })
    .from(taskTags)
    .where(eq(taskTags.taskId, taskId))
    .all()
    .map((r) => r.tag)
  const linkedNoteIds = db
    .select({ noteId: taskNotes.noteId })
    .from(taskNotes)
    .where(eq(taskNotes.taskId, taskId))
    .all()
    .map((r) => r.noteId)
  return { ...base, tags, linkedNoteIds }
}

interface TaskSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: TaskSyncService | null = null

export function initTaskSyncService(deps: TaskSyncDeps): TaskSyncService {
  instance = new TaskSyncService(deps)
  return instance
}

export function getTaskSyncService(): TaskSyncService | null {
  return instance
}

export function resetTaskSyncService(): void {
  instance = null
}

export class TaskSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [string[]?], [string]>

  constructor(deps: TaskSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'task',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (taskId) =>
        deps.db.select().from(tasks).where(eq(tasks.id, taskId)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId, operation, extra }) => {
        const changedFields = extra[0]
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        let fieldClocks = (local.fieldClocks as FieldClocks) ?? null
        if (!fieldClocks) {
          fieldClocks = initAllFieldClocks(existingClock, TASK_SYNCABLE_FIELDS)
        }

        const fieldsToIncrement =
          operation === 'create' ? TASK_SYNCABLE_FIELDS : (changedFields ?? TASK_SYNCABLE_FIELDS)
        const updatedFieldClocks = { ...fieldClocks }
        for (const field of fieldsToIncrement) {
          updatedFieldClocks[field] = incrementClock(updatedFieldClocks[field] ?? {}, deviceId)
        }

        deps.db
          .update(tasks)
          .set({ clock: newClock, fieldClocks: updatedFieldClocks })
          .where(eq(tasks.id, itemId))
          .run()

        return enrichWithJunctionData(deps.db, itemId, {
          ...local,
          clock: newClock,
          fieldClocks: updatedFieldClocks
        })
      },
      serialize: (local) => local,
      handleMissingDevice: (taskId, operation, extra) => {
        const changedFields = extra[0]
        log.warn('No device ID available, tracking task change with offline clock', {
          taskId,
          operation
        })
        if (operation === 'create') {
          incrementTaskClocksOffline(deps.db, taskId, [])
        } else {
          incrementTaskClocksOffline(deps.db, taskId, changedFields ?? [...TASK_SYNCABLE_FIELDS])
        }
      },
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId),
      buildFreshPayload: (taskId, _operation) => {
        const task = deps.db.select().from(tasks).where(eq(tasks.id, taskId)).get()
        if (!task) {
          log.warn('Task not found for re-enqueue', { taskId })
          return null
        }

        return JSON.stringify(
          enrichWithJunctionData(deps.db, taskId, task as Record<string, unknown>)
        )
      },
      recoverPendingChange: (taskId, deviceId) => {
        const task = deps.db.select().from(tasks).where(eq(tasks.id, taskId)).get()
        if (!task) {
          log.warn('Task not found for recovered enqueue', { taskId })
          return null
        }

        const existingClock = (task.clock as VectorClock) ?? {}
        const existingFieldClocks = task.fieldClocks ?? null

        if (!hasOfflineClockData(existingClock, existingFieldClocks)) {
          return null
        }

        const rebased = rebindOfflineClockData(
          existingClock,
          existingFieldClocks,
          deviceId,
          TASK_SYNCABLE_FIELDS
        )

        deps.db
          .update(tasks)
          .set({ clock: rebased.clock, fieldClocks: rebased.fieldClocks })
          .where(eq(tasks.id, taskId))
          .run()

        return enrichWithJunctionData(deps.db, taskId, {
          ...(task as Record<string, unknown>),
          clock: rebased.clock,
          fieldClocks: rebased.fieldClocks
        })
      },
      serializeRecovered: (local) => local
    })
  }

  enqueueCreate(taskId: string): void {
    this.controller.enqueueCreate(taskId)
  }

  enqueueUpdate(taskId: string, changedFields?: string[]): void {
    this.controller.enqueueUpdate(taskId, changedFields)
  }

  enqueueForPush(taskId: string, operation: 'create' | 'update'): void {
    this.controller.enqueueForPush(taskId, operation)
  }

  enqueueRecoveredUpdate(taskId: string): void {
    this.controller.enqueueRecoveredUpdate(taskId)
  }

  enqueueDelete(taskId: string, snapshotPayload: string): void {
    this.controller.enqueueDelete(taskId, snapshotPayload)
  }
}
