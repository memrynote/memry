import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { projects } from '@memry/db-schema/schema/projects'
import { statuses } from '@memry/db-schema/schema/statuses'
import { SyncQueueManager } from './queue'
import {
  ProjectSyncService,
  initProjectSyncService,
  getProjectSyncService,
  resetProjectSyncService
} from './project-sync'
import type { VectorClock } from '@memry/contracts/sync-api'

const TEST_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  color: '#000',
  position: 0,
  isInbox: false
}

const TEST_STATUS = {
  id: 'status-1',
  projectId: 'proj-1',
  name: 'Todo',
  color: '#6b7280',
  position: 0,
  isDefault: true,
  isDone: false
}

describe('ProjectSyncService', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let service: ProjectSyncService

  beforeEach(() => {
    testDb = createTestDataDb()
    queue = new SyncQueueManager(asClientDb(testDb.db))
    service = new ProjectSyncService({
      queue,
      db: asClientDb(testDb.db),
      getDeviceId: () => 'device-A'
    })
  })

  afterEach(() => {
    resetProjectSyncService()
    testDb.close()
  })

  describe('#given a project with statuses #when enqueueCreate called', () => {
    it('#then enqueues a create operation with embedded statuses and incremented clock', () => {
      testDb.db.insert(projects).values(TEST_PROJECT).run()
      testDb.db.insert(statuses).values(TEST_STATUS).run()

      service.enqueueCreate('proj-1')

      const stats = queue.getQueueStats()
      expect(stats.pending).toBe(1)

      const [item] = queue.dequeue(1)
      expect(item.itemId).toBe('proj-1')
      expect(item.operation).toBe('create')
      expect(item.type).toBe('project')

      const payload = JSON.parse(item.payload)
      expect(payload.clock).toEqual({ 'device-A': 1 })
      expect(payload.statuses).toHaveLength(1)
      expect(payload.statuses[0].id).toBe('status-1')
    })
  })

  describe('#given a project exists #when enqueueUpdate called', () => {
    it('#then enqueues an update operation and increments clock', () => {
      testDb.db.insert(projects).values(TEST_PROJECT).run()

      service.enqueueUpdate('proj-1')

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('update')

      const payload = JSON.parse(item.payload)
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })
  })

  describe('#given a project with existing clock #when enqueueUpdate called', () => {
    it('#then increments the existing clock', () => {
      const existingClock: VectorClock = { 'device-A': 2, 'device-B': 1 }
      testDb.db
        .insert(projects)
        .values({ ...TEST_PROJECT, clock: existingClock })
        .run()

      service.enqueueUpdate('proj-1')

      const [item] = queue.dequeue(1)
      const payload = JSON.parse(item.payload)
      expect(payload.clock).toEqual({ 'device-A': 3, 'device-B': 1 })
    })
  })

  describe('#given no device ID #when enqueue called', () => {
    it('#then records offline clocks and avoids enqueueing', () => {
      const noDeviceService = new ProjectSyncService({
        queue,
        db: asClientDb(testDb.db),
        getDeviceId: () => null
      })
      testDb.db.insert(projects).values(TEST_PROJECT).run()

      noDeviceService.enqueueUpdate('proj-1', ['color'])

      expect(queue.getQueueStats().pending).toBe(0)

      const updated = testDb.db.select().from(projects).where(eq(projects.id, 'proj-1')).get()
      expect(updated).toBeDefined()

      const updatedClock = updated!.clock as Record<string, number>
      const updatedFieldClocks = updated!.fieldClocks as Record<string, Record<string, number>>

      expect(updatedClock).toEqual({ _offline: 1 })
      expect(updatedFieldClocks.color).toEqual({ _offline: 1 })
    })
  })

  describe('#given offline-marked dirty project #when enqueueRecoveredUpdate called', () => {
    it('#then rebinds offline clocks to current device without incrementing untouched fields', () => {
      const clock: VectorClock = { 'device-old': 2, _offline: 1 }
      const fieldClocks = {
        name: { 'device-old': 2, _offline: 1 },
        color: { 'device-old': 2 }
      }

      testDb.db
        .insert(projects)
        .values({ ...TEST_PROJECT, clock, fieldClocks, syncedAt: '2026-01-01T00:00:00Z' })
        .run()

      service.enqueueRecoveredUpdate('proj-1')

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('update')
      const payload = JSON.parse(item.payload)

      expect(payload.clock).toEqual({ 'device-old': 2, 'device-A': 1 })
      expect(payload.fieldClocks.name).toEqual({ 'device-old': 2, 'device-A': 1 })
      expect(payload.fieldClocks.color).toEqual({ 'device-old': 2 })

      const updated = testDb.db.select().from(projects).where(eq(projects.id, 'proj-1')).get()
      expect(updated).toBeDefined()
      const updatedClock = updated!.clock as Record<string, number>
      const updatedFieldClocks = updated!.fieldClocks as Record<string, Record<string, number>>
      expect(updatedClock._offline).toBeUndefined()
      expect(updatedFieldClocks.name._offline).toBeUndefined()
    })
  })

  describe('#given project does not exist #when enqueue called', () => {
    it('#then skips silently', () => {
      service.enqueueCreate('nonexistent')
      expect(queue.getQueueStats().pending).toBe(0)
    })
  })

  describe('#when enqueueDelete called', () => {
    it('#then enqueues a delete payload with incremented clock', () => {
      const snapshot = JSON.stringify({ ...TEST_PROJECT, statuses: [TEST_STATUS] })
      service.enqueueDelete('proj-1', snapshot)

      const [item] = queue.dequeue(1)
      expect(item.itemId).toBe('proj-1')
      expect(item.operation).toBe('delete')
      const payload = JSON.parse(item.payload)
      expect(payload.name).toBe('Test Project')
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })
  })

  describe('module-level accessors', () => {
    it('#then getProjectSyncService returns null before init', () => {
      expect(getProjectSyncService()).toBeNull()
    })

    it('#then getProjectSyncService returns instance after init', () => {
      const svc = initProjectSyncService({
        queue,
        db: asClientDb(testDb.db),
        getDeviceId: () => 'dev-1'
      })
      expect(getProjectSyncService()).toBe(svc)
    })

    it('#then resetProjectSyncService clears instance', () => {
      initProjectSyncService({ queue, db: asClientDb(testDb.db), getDeviceId: () => 'dev-1' })
      resetProjectSyncService()
      expect(getProjectSyncService()).toBeNull()
    })
  })
})
