import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { projects } from '@memry/db-schema/schema/projects'
import { statuses } from '@memry/db-schema/schema/statuses'
import { tasks } from '@memry/db-schema/schema/tasks'
import { ItemApplier } from './apply-item'
import { SyncQueueManager } from './queue'
import { TASK_SYNCABLE_FIELDS, initAllFieldClocks, type FieldClocks } from './field-merge'
import { TaskSyncService, initTaskSyncService, resetTaskSyncService } from './task-sync'
import { recoverDirtyItems } from './dirty-recovery'
import { taskHandler } from './item-handlers/task-handler'
import type { DrizzleDb } from './item-handlers/types'
import { resetProjectSyncService } from './project-sync'

const BASE_PROJECT = {
  id: 'proj-1',
  name: 'Project',
  color: '#000',
  position: 0,
  isInbox: false
}

const BASE_STATUSES = [
  {
    id: 'status-todo',
    projectId: 'proj-1',
    name: 'Todo',
    color: '#6b7280',
    position: 0,
    isDefault: true,
    isDone: false
  },
  {
    id: 'status-done',
    projectId: 'proj-1',
    name: 'Done',
    color: '#22c55e',
    position: 1,
    isDefault: false,
    isDone: true
  }
]

function seedBaseTask(db: TestDatabaseResult): void {
  db.db.insert(projects).values(BASE_PROJECT).run()
  db.db.insert(statuses).values(BASE_STATUSES).run()

  const baseClock = { 'device-A': 1 }
  const baseFieldClocks = initAllFieldClocks(baseClock, TASK_SYNCABLE_FIELDS)

  db.db
    .insert(tasks)
    .values({
      id: 'task-1',
      projectId: 'proj-1',
      statusId: 'status-todo',
      title: 'Task',
      priority: 0,
      position: 0,
      dueDate: null,
      clock: baseClock,
      fieldClocks: baseFieldClocks,
      syncedAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z'
    })
    .run()
}

describe('task merge integration', () => {
  let deviceA: TestDatabaseResult
  let deviceB: TestDatabaseResult
  let queueA: SyncQueueManager
  let queueB: SyncQueueManager

  beforeEach(() => {
    resetTaskSyncService()
    resetProjectSyncService()

    deviceA = createTestDataDb()
    deviceB = createTestDataDb()

    queueA = new SyncQueueManager(deviceA.db as any)
    queueB = new SyncQueueManager(deviceB.db as any)

    seedBaseTask(deviceA)
    seedBaseTask(deviceB)
  })

  afterEach(() => {
    resetTaskSyncService()
    resetProjectSyncService()
    deviceA.close()
    deviceB.close()
  })

  it('preserves both field edits across signout/signin recovery and round-trip sync', () => {
    // #given DeviceA signed out edits status (no device id => offline clock path)
    deviceA.db
      .update(tasks)
      .set({
        statusId: 'status-done',
        modifiedAt: '2026-01-02T00:00:00.000Z'
      })
      .where(eq(tasks.id, 'task-1'))
      .run()

    const signedOutServiceA = new TaskSyncService({
      queue: queueA,
      db: deviceA.db as any,
      getDeviceId: () => null
    })
    signedOutServiceA.enqueueUpdate('task-1', ['statusId'])
    expect(queueA.getPendingCount()).toBe(0)

    // #and DeviceB online edits dueDate and enqueues sync update
    deviceB.db
      .update(tasks)
      .set({
        dueDate: '2026-03-15',
        modifiedAt: '2026-01-02T00:00:00.000Z'
      })
      .where(eq(tasks.id, 'task-1'))
      .run()

    const onlineServiceB = new TaskSyncService({
      queue: queueB,
      db: deviceB.db as any,
      getDeviceId: () => 'device-B'
    })
    onlineServiceB.enqueueUpdate('task-1', ['dueDate'])

    const remoteQueueItem = queueB.peek(1)[0]
    expect(remoteQueueItem?.operation).toBe('update')
    const remotePayload = JSON.parse(remoteQueueItem.payload) as Record<string, unknown>

    // #when DeviceA signs in, dirty recovery re-enqueues local update (rebased)
    initTaskSyncService({
      queue: queueA,
      db: deviceA.db as any,
      getDeviceId: () => 'device-A'
    })

    const recovered = recoverDirtyItems(
      deviceA.db as unknown as Parameters<typeof recoverDirtyItems>[0]
    )
    expect(recovered.tasks).toBe(1)

    // Frozen queue payload was captured before pull and can be stale.
    const frozenQueuedPayload = JSON.parse(queueA.peek(1)[0].payload) as Record<string, unknown>
    expect(frozenQueuedPayload.statusId).toBe('status-done')
    expect(frozenQueuedPayload.dueDate).toBeNull()

    // #and DeviceA pulls DeviceB change (concurrent merge on task fields)
    const applierA = new ItemApplier(deviceA.db as any, vi.fn())
    const resultA = applierA.apply({
      itemId: 'task-1',
      type: 'task',
      operation: 'update',
      content: new TextEncoder().encode(JSON.stringify(remotePayload)),
      clock: (remotePayload.clock as Record<string, number>) ?? {}
    })
    expect(resultA).toBe('applied')

    const taskAfterPullA = deviceA.db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()
    expect(taskAfterPullA).toBeDefined()
    expect(taskAfterPullA!.statusId).toBe('status-done')
    expect(taskAfterPullA!.dueDate).toBe('2026-03-15')
    expect(taskAfterPullA!.clock).toEqual({ 'device-A': 2, 'device-B': 1 })

    const mergedFieldClocksA = taskAfterPullA!.fieldClocks as FieldClocks
    expect(mergedFieldClocksA.statusId).toEqual({ 'device-A': 2 })
    expect(mergedFieldClocksA.dueDate).toEqual({ 'device-A': 1, 'device-B': 1 })

    // #then push payload must be rebuilt from current DB state (not stale queue snapshot)
    const rebuiltPushPayload = taskHandler.buildPushPayload(
      deviceA.db as unknown as DrizzleDb,
      'task-1',
      'device-A',
      'update'
    )
    expect(rebuiltPushPayload).toBeTruthy()
    const pushedFromA = JSON.parse(rebuiltPushPayload!) as Record<string, unknown>
    expect(pushedFromA.statusId).toBe('status-done')
    expect(pushedFromA.dueDate).toBe('2026-03-15')

    // #and DeviceB applies DeviceA push without losing its dueDate edit
    const applierB = new ItemApplier(deviceB.db as any, vi.fn())
    const resultB = applierB.apply({
      itemId: 'task-1',
      type: 'task',
      operation: 'update',
      content: new TextEncoder().encode(JSON.stringify(pushedFromA)),
      clock: (pushedFromA.clock as Record<string, number>) ?? {}
    })
    expect(resultB).toBe('applied')

    const finalTaskB = deviceB.db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()
    expect(finalTaskB).toBeDefined()
    expect(finalTaskB!.statusId).toBe('status-done')
    expect(finalTaskB!.dueDate).toBe('2026-03-15')
  })
})
