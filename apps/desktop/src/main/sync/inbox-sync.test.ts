import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import type { VectorClock } from '@memry/contracts/sync-api'
import { SyncQueueManager } from './queue'
import {
  InboxSyncService,
  initInboxSyncService,
  getInboxSyncService,
  resetInboxSyncService
} from './inbox-sync'

const TEST_INBOX_ITEM = {
  id: 'inbox-1',
  title: 'Test Item',
  type: 'note' as const
}

describe('InboxSyncService', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let service: InboxSyncService

  beforeEach(() => {
    testDb = createTestDataDb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queue = new SyncQueueManager(testDb.db as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new InboxSyncService({ queue, db: testDb.db as any, getDeviceId: () => 'device-A' })
  })

  afterEach(() => {
    resetInboxSyncService()
    testDb.close()
  })

  describe('#given an inbox item exists #when enqueueCreate called', () => {
    it('#then enqueues a create operation and increments clock', () => {
      // #given
      testDb.db.insert(inboxItems).values(TEST_INBOX_ITEM).run()

      // #when
      service.enqueueCreate('inbox-1')

      // #then
      const [item] = queue.dequeue(1)
      expect(item.itemId).toBe('inbox-1')
      expect(item.operation).toBe('create')
      expect(item.type).toBe('inbox')

      const payload = JSON.parse(item.payload)
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })
  })

  describe('#given an inbox item exists #when enqueueUpdate called', () => {
    it('#then enqueues an update operation', () => {
      testDb.db.insert(inboxItems).values(TEST_INBOX_ITEM).run()

      service.enqueueUpdate('inbox-1')

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('update')
    })
  })

  describe('#given inbox item with existing clock #when enqueueUpdate called', () => {
    it('#then increments the existing clock', () => {
      const existingClock: VectorClock = { 'device-A': 2, 'device-B': 1 }
      testDb.db
        .insert(inboxItems)
        .values({ ...TEST_INBOX_ITEM, clock: existingClock })
        .run()

      service.enqueueUpdate('inbox-1')

      const [item] = queue.dequeue(1)
      const payload = JSON.parse(item.payload)
      expect(payload.clock).toEqual({ 'device-A': 3, 'device-B': 1 })
    })
  })

  describe('#given inbox item is localOnly #when enqueue called', () => {
    it('#then skips without enqueueing', () => {
      testDb.db
        .insert(inboxItems)
        .values({ ...TEST_INBOX_ITEM, localOnly: true })
        .run()

      service.enqueueCreate('inbox-1')

      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#given no device ID #when enqueue called', () => {
    it('#then skips silently', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const noDeviceService = new InboxSyncService({
        queue,
        db: testDb.db as any,
        getDeviceId: () => null
      })
      testDb.db.insert(inboxItems).values(TEST_INBOX_ITEM).run()

      noDeviceService.enqueueCreate('inbox-1')

      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#given inbox item does not exist #when enqueue called', () => {
    it('#then skips silently', () => {
      service.enqueueCreate('nonexistent')
      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#when enqueueDelete called', () => {
    it('#then enqueues a delete payload with incremented clock', () => {
      const snapshot = JSON.stringify(TEST_INBOX_ITEM)
      service.enqueueDelete('inbox-1', snapshot)

      const [item] = queue.dequeue(1)
      expect(item.itemId).toBe('inbox-1')
      expect(item.operation).toBe('delete')
      const payload = JSON.parse(item.payload)
      expect(payload).toMatchObject(TEST_INBOX_ITEM)
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })
  })

  describe('module-level accessor', () => {
    it('#then getInboxSyncService returns null before init', () => {
      expect(getInboxSyncService()).toBeNull()
    })

    it('#then getInboxSyncService returns instance after init', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = initInboxSyncService({ queue, db: testDb.db as any, getDeviceId: () => 'dev-1' })
      expect(getInboxSyncService()).toBe(svc)
    })

    it('#then resetInboxSyncService clears instance', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      initInboxSyncService({ queue, db: testDb.db as any, getDeviceId: () => 'dev-1' })
      resetInboxSyncService()
      expect(getInboxSyncService()).toBeNull()
    })
  })
})
