import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createTestDataDb,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { eq } from 'drizzle-orm'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import type { VectorClock } from '@memry/contracts/sync-api'
import { SyncQueueManager } from '@memry/sync-client/queue'
import {
  InboxSyncService,
  initInboxSyncService,
  getInboxSyncService,
  resetInboxSyncService
} from '@memry/sync-client/inbox-sync'

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
    queue = new SyncQueueManager(asClientDb(testDb.db))
    service = new InboxSyncService({
      queue,
      db: asSyncDb(testDb.db),
      getDeviceId: () => 'device-A'
    })
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
      const noDeviceService = new InboxSyncService({
        queue,
        db: asSyncDb(testDb.db),
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

  describe('#given a localOnly inbox item #when enqueueDelete called', () => {
    it('#then no tombstone leaves the device', () => {
      // Mirrors handleDeletePermanent (inbox/crud.ts), which snapshots the row,
      // DELETES it, and only then enqueues. The row is deliberately NOT seeded:
      // seeding it would test a state production never reaches and would go
      // green off the controller's row guard instead of the snapshot guard that
      // is the only thing actually running here.
      expect(
        testDb.db.select().from(inboxItems).where(eq(inboxItems.id, 'inbox-1')).get()
      ).toBeUndefined()

      service.enqueueDelete('inbox-1', JSON.stringify({ ...TEST_INBOX_ITEM, localOnly: true }))

      expect(queue.getPendingCount()).toBe(0)
    })

    it('#then an unparseable snapshot still tombstones instead of swallowing the delete', () => {
      // Older builds wrote this payload too. A snapshot we cannot read tells us
      // nothing about localOnly, and dropping the delete would strand the item
      // on every other device — the worse of the two failure modes.
      service.enqueueDelete('inbox-1', 'not json')

      expect(queue.getPendingCount()).toBe(1)
    })
  })

  describe('module-level accessor', () => {
    it('#then getInboxSyncService returns null before init', () => {
      expect(getInboxSyncService()).toBeNull()
    })

    it('#then getInboxSyncService returns instance after init', () => {
      const svc = initInboxSyncService({
        queue,
        db: asSyncDb(testDb.db),
        getDeviceId: () => 'dev-1'
      })
      expect(getInboxSyncService()).toBe(svc)
    })

    it('#then resetInboxSyncService clears instance', () => {
      initInboxSyncService({ queue, db: asSyncDb(testDb.db), getDeviceId: () => 'dev-1' })
      resetInboxSyncService()
      expect(getInboxSyncService()).toBeNull()
    })
  })
})
