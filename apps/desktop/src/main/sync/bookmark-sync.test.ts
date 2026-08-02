import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import { SyncQueueManager } from './queue'
import {
  BookmarkSyncService,
  initBookmarkSyncService,
  getBookmarkSyncService,
  resetBookmarkSyncService
} from './bookmark-sync'

const TEST_BOOKMARK = {
  id: 'bm-1',
  itemType: 'note',
  itemId: 'note-1',
  position: 0
}

describe('BookmarkSyncService', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let service: BookmarkSyncService

  beforeEach(() => {
    testDb = createTestDataDb()
    queue = new SyncQueueManager(asClientDb(testDb.db))
    service = new BookmarkSyncService({
      queue,
      db: asClientDb(testDb.db),
      getDeviceId: () => 'device-A'
    })
  })

  afterEach(() => {
    resetBookmarkSyncService()
    testDb.close()
  })

  describe('#given a bookmark exists #when enqueueCreate called', () => {
    it('#then enqueues a create operation', () => {
      testDb.db.insert(bookmarks).values(TEST_BOOKMARK).run()

      service.enqueueCreate('bm-1')

      const [item] = queue.dequeue(1)
      expect(item.itemId).toBe('bm-1')
      expect(item.operation).toBe('create')
      expect(item.type).toBe('bookmark')
    })
  })

  describe('#given a bookmark exists #when enqueueUpdate called', () => {
    it('#then enqueues an update operation and persists the incremented clock to the row', () => {
      testDb.db.insert(bookmarks).values(TEST_BOOKMARK).run()

      service.enqueueUpdate('bm-1')

      const [item] = queue.dequeue(1)
      expect(item.itemId).toBe('bm-1')
      expect(item.operation).toBe('update')
      const payload = JSON.parse(item.payload)
      expect(payload.clock).toEqual({ 'device-A': 1 })

      // The clock bump must be persisted to the row itself, not just returned
      // in the payload — this is what lets an offline edit survive: a later
      // local change (or a manifest check) must see the bumped clock without
      // a network round-trip.
      const row = testDb.db.select().from(bookmarks).where(eq(bookmarks.id, 'bm-1')).get()
      expect(row?.clock).toEqual({ 'device-A': 1 })
    })

    it('#then a second local change increments the clock again from the persisted value', () => {
      testDb.db.insert(bookmarks).values(TEST_BOOKMARK).run()

      service.enqueueUpdate('bm-1')
      queue.dequeue(1)
      service.enqueueUpdate('bm-1')

      const row = testDb.db.select().from(bookmarks).where(eq(bookmarks.id, 'bm-1')).get()
      expect(row?.clock).toEqual({ 'device-A': 2 })
    })
  })

  describe('#when enqueueDelete called', () => {
    it('#then enqueues a delete payload with incremented clock', () => {
      const snapshot = JSON.stringify(TEST_BOOKMARK)
      service.enqueueDelete('bm-1', snapshot)

      const [item] = queue.dequeue(1)
      expect(item.itemId).toBe('bm-1')
      expect(item.operation).toBe('delete')
      const payload = JSON.parse(item.payload)
      expect(payload).toMatchObject(TEST_BOOKMARK)
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })
  })

  describe('module-level accessor', () => {
    it('#then getBookmarkSyncService returns null before init', () => {
      expect(getBookmarkSyncService()).toBeNull()
    })

    it('#then getBookmarkSyncService returns instance after init', () => {
      const svc = initBookmarkSyncService({
        queue,
        db: asClientDb(testDb.db),
        getDeviceId: () => 'dev-1'
      })
      expect(getBookmarkSyncService()).toBe(svc)
    })

    it('#then resetBookmarkSyncService clears instance', () => {
      initBookmarkSyncService({ queue, db: asClientDb(testDb.db), getDeviceId: () => 'dev-1' })
      resetBookmarkSyncService()
      expect(getBookmarkSyncService()).toBeNull()
    })
  })
})
