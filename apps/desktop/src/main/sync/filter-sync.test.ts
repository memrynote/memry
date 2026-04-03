import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createTestDataDb,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { savedFilters } from '@memry/db-schema/schema/settings'
import type { VectorClock } from '@memry/contracts/sync-api'
import { SyncQueueManager } from './queue'
import {
  FilterSyncService,
  initFilterSyncService,
  getFilterSyncService,
  resetFilterSyncService
} from './filter-sync'

const TEST_FILTER = {
  id: 'filter-1',
  name: 'Test Filter',
  config: { priority: 'high' },
  position: 0
}

describe('FilterSyncService', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let service: FilterSyncService

  beforeEach(() => {
    testDb = createTestDataDb()
    queue = new SyncQueueManager(asClientDb(testDb.db))
    service = new FilterSyncService({
      queue,
      db: asSyncDb(testDb.db),
      getDeviceId: () => 'device-A'
    })
  })

  afterEach(() => {
    resetFilterSyncService()
    testDb.close()
  })

  describe('#given a filter exists #when enqueueCreate called', () => {
    it('#then enqueues a create operation and increments clock', () => {
      testDb.db.insert(savedFilters).values(TEST_FILTER).run()

      service.enqueueCreate('filter-1')

      const [item] = queue.dequeue(1)
      expect(item.itemId).toBe('filter-1')
      expect(item.operation).toBe('create')
      expect(item.type).toBe('filter')

      const payload = JSON.parse(item.payload)
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })
  })

  describe('#given a filter exists #when enqueueUpdate called', () => {
    it('#then enqueues an update operation', () => {
      testDb.db.insert(savedFilters).values(TEST_FILTER).run()

      service.enqueueUpdate('filter-1')

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('update')
    })
  })

  describe('#given filter with existing clock #when enqueueUpdate called', () => {
    it('#then increments the existing clock', () => {
      const existingClock: VectorClock = { 'device-A': 2, 'device-B': 1 }
      testDb.db
        .insert(savedFilters)
        .values({ ...TEST_FILTER, clock: existingClock })
        .run()

      service.enqueueUpdate('filter-1')

      const [item] = queue.dequeue(1)
      const payload = JSON.parse(item.payload)
      expect(payload.clock).toEqual({ 'device-A': 3, 'device-B': 1 })
    })
  })

  describe('#given no device ID #when enqueue called', () => {
    it('#then skips silently', () => {
      const noDeviceService = new FilterSyncService({
        queue,
        db: asSyncDb(testDb.db),
        getDeviceId: () => null
      })
      testDb.db.insert(savedFilters).values(TEST_FILTER).run()

      noDeviceService.enqueueCreate('filter-1')

      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#given filter does not exist #when enqueue called', () => {
    it('#then skips silently', () => {
      service.enqueueCreate('nonexistent')
      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#when enqueueDelete called', () => {
    it('#then enqueues a delete payload with incremented clock', () => {
      const snapshot = JSON.stringify(TEST_FILTER)
      service.enqueueDelete('filter-1', snapshot)

      const [item] = queue.dequeue(1)
      expect(item.itemId).toBe('filter-1')
      expect(item.operation).toBe('delete')
      const payload = JSON.parse(item.payload)
      expect(payload).toMatchObject(TEST_FILTER)
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })
  })

  describe('module-level accessor', () => {
    it('#then getFilterSyncService returns null before init', () => {
      expect(getFilterSyncService()).toBeNull()
    })

    it('#then getFilterSyncService returns instance after init', () => {
      const svc = initFilterSyncService({
        queue,
        db: asSyncDb(testDb.db),
        getDeviceId: () => 'dev-1'
      })
      expect(getFilterSyncService()).toBe(svc)
    })

    it('#then resetFilterSyncService clears instance', () => {
      initFilterSyncService({ queue, db: asSyncDb(testDb.db), getDeviceId: () => 'dev-1' })
      resetFilterSyncService()
      expect(getFilterSyncService()).toBeNull()
    })
  })
})
