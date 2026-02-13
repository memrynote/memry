import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@shared/db/schema/data-schema'
import { tasks } from '@shared/db/schema/tasks'
import type { VectorClock } from '@shared/contracts/sync-api'
import type { SyncQueueManager } from './queue'
import { increment } from './vector-clock'
import { createLogger } from '../lib/logger'

type DrizzleDb = BetterSQLite3Database<typeof schema>

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

  enqueueUpdate(taskId: string): void {
    this.enqueue(taskId, 'update')
  }

  enqueueDelete(taskId: string, snapshotPayload: string): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID available, skipping sync enqueue for delete')
      return
    }

    try {
      this.queue.enqueue({
        type: 'task',
        itemId: taskId,
        operation: 'delete',
        payload: snapshotPayload,
        priority: 0
      })
    } catch (err) {
      log.error('Failed to enqueue task delete', err)
    }
  }

  private enqueue(taskId: string, operation: 'create' | 'update'): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID available, skipping sync enqueue')
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

      this.db.update(tasks).set({ clock: newClock }).where(eq(tasks.id, taskId)).run()

      const payload = JSON.stringify({ ...task, clock: newClock })

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
}
