import { eq } from 'drizzle-orm'
import { tasks } from '@memry/db-schema/schema/tasks'
import type { VectorClock, FieldClocks } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from './queue'
import { increment } from './vector-clock'
import { initAllFieldClocks, TASK_SYNCABLE_FIELDS } from './field-merge'
import {
  hasOfflineClockData,
  incrementTaskClocksOffline,
  rebindOfflineClockData
} from './offline-clock'
import { createLogger } from '../lib/logger'
import type { DrizzleDb } from '../database/client'

const log = createLogger('TaskSync')

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
  private queue: SyncQueueManager
  private db: DrizzleDb
  private getDeviceId: () => string | null

  constructor(deps: TaskSyncDeps) {
    this.queue = deps.queue
    this.db = deps.db
    this.getDeviceId = deps.getDeviceId
  }

  enqueueCreate(taskId: string): void {
    this.enqueue(taskId, 'create')
  }

  enqueueUpdate(taskId: string, changedFields?: string[]): void {
    this.enqueue(taskId, 'update', changedFields)
  }

  enqueueForPush(taskId: string, operation: 'create' | 'update'): void {
    try {
      const task = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get()
      if (!task) {
        log.warn('Task not found for re-enqueue', { taskId })
        return
      }

      this.queue.enqueue({
        type: 'task',
        itemId: taskId,
        operation,
        payload: JSON.stringify(task),
        priority: 0
      })
    } catch (err) {
      log.error('Failed to re-enqueue task for push', err)
    }
  }

  enqueueRecoveredUpdate(taskId: string): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID available, skipping recovered task enqueue')
      return
    }

    try {
      const task = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get()
      if (!task) {
        log.warn('Task not found for recovered enqueue', { taskId })
        return
      }

      const existingClock = (task.clock as VectorClock) ?? {}
      const existingFieldClocks = (task.fieldClocks as FieldClocks | null) ?? null

      if (!hasOfflineClockData(existingClock, existingFieldClocks)) {
        // No offline marker: local clocks were already advanced when the change was made.
        this.enqueueForPush(taskId, 'update')
        return
      }

      const rebased = rebindOfflineClockData(
        existingClock,
        existingFieldClocks,
        deviceId,
        TASK_SYNCABLE_FIELDS
      )

      this.db
        .update(tasks)
        .set({ clock: rebased.clock, fieldClocks: rebased.fieldClocks })
        .where(eq(tasks.id, taskId))
        .run()

      this.queue.enqueue({
        type: 'task',
        itemId: taskId,
        operation: 'update',
        payload: JSON.stringify({
          ...task,
          clock: rebased.clock,
          fieldClocks: rebased.fieldClocks
        }),
        priority: 0
      })
    } catch (err) {
      log.error('Failed to enqueue recovered task update', err)
    }
  }

  enqueueDelete(taskId: string, snapshotPayload: string): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID available, skipping sync enqueue for delete')
      return
    }

    try {
      const payload = this.withIncrementedClock(snapshotPayload, deviceId)
      this.queue.enqueue({
        type: 'task',
        itemId: taskId,
        operation: 'delete',
        payload,
        priority: 0
      })
    } catch (err) {
      log.error('Failed to enqueue task delete', err)
    }
  }

  private enqueue(taskId: string, operation: 'create' | 'update', changedFields?: string[]): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID available, tracking task change with offline clock', {
        taskId,
        operation
      })
      if (operation === 'create') {
        incrementTaskClocksOffline(this.db, taskId, [])
      } else {
        incrementTaskClocksOffline(this.db, taskId, changedFields ?? [...TASK_SYNCABLE_FIELDS])
      }
      return
    }

    try {
      const task = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get()
      if (!task) {
        log.warn('Task not found for sync enqueue', { taskId })
        return
      }

      const existingClock = (task.clock as VectorClock) ?? {}
      const newClock = increment(existingClock, deviceId)

      let fieldClocks = (task.fieldClocks as FieldClocks) ?? null
      if (!fieldClocks) {
        fieldClocks = initAllFieldClocks(existingClock, TASK_SYNCABLE_FIELDS)
      }

      const fieldsToIncrement =
        operation === 'create' ? TASK_SYNCABLE_FIELDS : (changedFields ?? TASK_SYNCABLE_FIELDS)
      const updatedFieldClocks = { ...fieldClocks }
      for (const field of fieldsToIncrement) {
        updatedFieldClocks[field] = increment(updatedFieldClocks[field] ?? {}, deviceId)
      }

      this.db
        .update(tasks)
        .set({ clock: newClock, fieldClocks: updatedFieldClocks })
        .where(eq(tasks.id, taskId))
        .run()

      const payload = JSON.stringify({
        ...task,
        clock: newClock,
        fieldClocks: updatedFieldClocks
      })

      this.queue.enqueue({
        type: 'task',
        itemId: taskId,
        operation,
        payload,
        priority: 0
      })
    } catch (err) {
      log.error(`Failed to enqueue task ${operation}`, err)
    }
  }

  private withIncrementedClock(payload: string, deviceId: string): string {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      const existingClock =
        parsed.clock && typeof parsed.clock === 'object' && !Array.isArray(parsed.clock)
          ? (parsed.clock as VectorClock)
          : {}
      const newClock = increment(existingClock, deviceId)
      return JSON.stringify({ ...parsed, clock: newClock })
    } catch {
      return payload
    }
  }
}
