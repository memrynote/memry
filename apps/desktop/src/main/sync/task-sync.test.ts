import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { SyncQueueManager } from './queue'
import {
  TaskSyncService,
  initTaskSyncService,
  getTaskSyncService,
  resetTaskSyncService
} from './task-sync'
import type { VectorClock } from '@memry/contracts/sync-api'

const TEST_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  color: '#000',
  position: 0,
  isInbox: false
}

const TEST_TASK = {
  id: 'task-1',
  projectId: 'proj-1',
  title: 'Test Task',
  priority: 0,
  position: 0
}

describe('TaskSyncService', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let service: TaskSyncService

  beforeEach(() => {
    testDb = createTestDataDb()
    queue = new SyncQueueManager(asClientDb(testDb.db))
    service = new TaskSyncService({ queue, db: asClientDb(testDb.db), getDeviceId: () => 'device-A' })

    testDb.db.insert(projects).values(TEST_PROJECT).run()
  })

  afterEach(() => {
    resetTaskSyncService()
    testDb.close()
  })

  describe('#given a task exists #when enqueueCreate called', () => {
    it('#then enqueues a create operation and increments clock', () => {
      testDb.db.insert(tasks).values(TEST_TASK).run()

      service.enqueueCreate('task-1')

      const stats = queue.getQueueStats()
      expect(stats.pending).toBe(1)

      const [item] = queue.dequeue(1)
      expect(item.itemId).toBe('task-1')
      expect(item.operation).toBe('create')
      expect(item.type).toBe('task')

      const payload = JSON.parse(item.payload)
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })
  })

  describe('#given a task exists #when enqueueUpdate called', () => {
    it('#then enqueues an update operation and increments clock', () => {
      testDb.db.insert(tasks).values(TEST_TASK).run()

      service.enqueueUpdate('task-1')

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('update')

      const payload = JSON.parse(item.payload)
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })
  })

  describe('#given a task with existing clock #when enqueueUpdate called', () => {
    it('#then increments the existing clock', () => {
      const existingClock: VectorClock = { 'device-A': 2, 'device-B': 1 }
      testDb.db
        .insert(tasks)
        .values({ ...TEST_TASK, clock: existingClock })
        .run()

      service.enqueueUpdate('task-1')

      const [item] = queue.dequeue(1)
      const payload = JSON.parse(item.payload)
      expect(payload.clock).toEqual({ 'device-A': 3, 'device-B': 1 })
    })
  })

  describe('#given no device ID #when enqueue called', () => {
    it('#then records offline clocks and avoids enqueueing', () => {
      const noDeviceService = new TaskSyncService({
        queue,
        db: asClientDb(testDb.db),
        getDeviceId: () => null
      })
      testDb.db.insert(tasks).values(TEST_TASK).run()

      noDeviceService.enqueueUpdate('task-1', ['statusId'])

      expect(queue.getQueueStats().pending).toBe(0)

      const updated = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()
      expect(updated).toBeDefined()

      const updatedClock = updated!.clock as Record<string, number>
      const updatedFieldClocks = updated!.fieldClocks as Record<string, Record<string, number>>

      expect(updatedClock).toEqual({ _offline: 1 })
      expect(updatedFieldClocks.statusId).toEqual({ _offline: 1 })
    })
  })

  describe('#given offline-marked dirty task #when enqueueRecoveredUpdate called', () => {
    it('#then rebinds offline clocks to current device without incrementing untouched fields', () => {
      const clock: VectorClock = { 'device-old': 1, _offline: 1 }
      const fieldClocks = {
        title: { 'device-old': 1 },
        statusId: { 'device-old': 1, _offline: 1 },
        dueDate: { 'device-old': 1 }
      }

      testDb.db
        .insert(tasks)
        .values({ ...TEST_TASK, clock, fieldClocks, syncedAt: '2026-01-01T00:00:00Z' })
        .run()

      service.enqueueRecoveredUpdate('task-1')

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('update')
      const payload = JSON.parse(item.payload)

      expect(payload.clock).toEqual({ 'device-old': 1, 'device-A': 1 })
      expect(payload.fieldClocks.statusId).toEqual({ 'device-old': 1, 'device-A': 1 })
      expect(payload.fieldClocks.title).toEqual({ 'device-old': 1 })
      expect(payload.fieldClocks.dueDate).toEqual({ 'device-old': 1 })

      const updated = testDb.db.select().from(tasks).where(eq(tasks.id, 'task-1')).get()
      expect(updated).toBeDefined()
      const updatedClock = updated!.clock as Record<string, number>
      const updatedFieldClocks = updated!.fieldClocks as Record<string, Record<string, number>>
      expect(updatedClock._offline).toBeUndefined()
      expect(updatedFieldClocks.statusId._offline).toBeUndefined()
    })
  })

  describe('#given task does not exist #when enqueue called', () => {
    it('#then skips silently', () => {
      service.enqueueCreate('nonexistent')
      expect(queue.getQueueStats().pending).toBe(0)
    })
  })

  describe('#when enqueueDelete called', () => {
    it('#then enqueues a delete payload with incremented clock', () => {
      const snapshot = JSON.stringify(TEST_TASK)
      service.enqueueDelete('task-1', snapshot)

      const [item] = queue.dequeue(1)
      expect(item.itemId).toBe('task-1')
      expect(item.operation).toBe('delete')
      const payload = JSON.parse(item.payload)
      expect(payload).toMatchObject(TEST_TASK)
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })
  })

  describe('module-level accessor', () => {
    it('#then getTaskSyncService returns null before init', () => {
      expect(getTaskSyncService()).toBeNull()
    })

    it('#then getTaskSyncService returns instance after init', () => {
      const svc = initTaskSyncService({ queue, db: asClientDb(testDb.db), getDeviceId: () => 'dev-1' })
      expect(getTaskSyncService()).toBe(svc)
    })

    it('#then resetTaskSyncService clears instance', () => {
      initTaskSyncService({ queue, db: asClientDb(testDb.db), getDeviceId: () => 'dev-1' })
      resetTaskSyncService()
      expect(getTaskSyncService()).toBeNull()
    })
  })
})
