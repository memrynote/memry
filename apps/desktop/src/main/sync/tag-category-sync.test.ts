import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createTestDataDb,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { tagCategories } from '@memry/db-schema/schema/tag-categories'
import { TagCategorySyncPayloadSchema } from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import { eq } from 'drizzle-orm'
import { SyncQueueManager } from './queue'
import { tagCategoryHandler } from './item-handlers/tag-category-handler'
import {
  TagCategorySyncService,
  initTagCategorySyncService,
  getTagCategorySyncService,
  resetTagCategorySyncService
} from './tag-category-sync'

const TEST_CATEGORY = {
  id: 'category-1',
  name: 'Work',
  sortOrder: 0
}

describe('TagCategorySyncService', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let service: TagCategorySyncService

  beforeEach(() => {
    testDb = createTestDataDb()
    queue = new SyncQueueManager(asClientDb(testDb.db))
    service = new TagCategorySyncService({
      queue,
      db: asSyncDb(testDb.db),
      getDeviceId: () => 'device-A'
    })
  })

  afterEach(() => {
    resetTagCategorySyncService()
    testDb.close()
  })

  describe('#given a category exists #when enqueueCreate called', () => {
    it('#then enqueues a create operation with the row payload', () => {
      testDb.db.insert(tagCategories).values(TEST_CATEGORY).run()

      service.enqueueCreate('category-1')

      const [item] = queue.dequeue(1)
      expect(item.itemId).toBe('category-1')
      expect(item.operation).toBe('create')
      expect(item.type).toBe('tag_category')

      const payload = JSON.parse(item.payload)
      expect(payload.name).toBe('Work')
      expect(payload.sortOrder).toBe(0)
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })
  })

  describe('#given a category exists #when enqueueUpdate called', () => {
    it('#then bumps the row clock in the database and enqueues the updated payload', () => {
      testDb.db.insert(tagCategories).values(TEST_CATEGORY).run()

      service.enqueueUpdate('category-1')

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('update')
      const payload = JSON.parse(item.payload)
      expect(payload.clock).toEqual({ 'device-A': 1 })

      const row = testDb.db
        .select()
        .from(tagCategories)
        .where(eq(tagCategories.id, 'category-1'))
        .get()
      expect(row?.clock).toEqual({ 'device-A': 1 })
    })
  })

  describe('#given category with existing clock #when enqueueUpdate called', () => {
    it('#then increments the existing clock in the database', () => {
      const existingClock: VectorClock = { 'device-A': 2, 'device-B': 1 }
      testDb.db
        .insert(tagCategories)
        .values({ ...TEST_CATEGORY, clock: existingClock })
        .run()

      service.enqueueUpdate('category-1')

      const row = testDb.db
        .select()
        .from(tagCategories)
        .where(eq(tagCategories.id, 'category-1'))
        .get()
      expect(row?.clock).toEqual({ 'device-A': 3, 'device-B': 1 })

      const [item] = queue.dequeue(1)
      const payload = JSON.parse(item.payload)
      expect(payload.clock).toEqual({ 'device-A': 3, 'device-B': 1 })
    })
  })

  describe('#given no device ID #when enqueue called', () => {
    it('#then skips silently', () => {
      const noDeviceService = new TagCategorySyncService({
        queue,
        db: asSyncDb(testDb.db),
        getDeviceId: () => null
      })
      testDb.db.insert(tagCategories).values(TEST_CATEGORY).run()

      noDeviceService.enqueueCreate('category-1')

      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#given category does not exist #when enqueue called', () => {
    it('#then skips silently', () => {
      service.enqueueCreate('nonexistent')
      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#given a snapshot payload #when enqueueDelete called', () => {
    it('#then enqueues that payload with an incremented clock', () => {
      const snapshot = JSON.stringify(TEST_CATEGORY)
      service.enqueueDelete('category-1', snapshot)

      const [item] = queue.dequeue(1)
      expect(item.itemId).toBe('category-1')
      expect(item.operation).toBe('delete')
      const payload = JSON.parse(item.payload)
      expect(payload).toMatchObject(TEST_CATEGORY)
      expect(payload.clock).toEqual({ 'device-A': 1 })
    })
  })

  describe('#given no snapshot payload #when enqueueDelete called', () => {
    it('#then enqueues a fallback payload that parses against the schema and carries deletedAt', () => {
      service.enqueueDelete('category-1')

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('delete')

      const raw = JSON.parse(item.payload)
      const parsed = TagCategorySyncPayloadSchema.parse(raw)

      // A fallback without deletedAt would let a receiving device resurrect a
      // deleted category instead of tombstoning it.
      expect(parsed.deletedAt).toBeTruthy()
    })
  })

  describe('#given a peer deletes a category with no snapshot #when the built payload is applied through applyDelete on another device', () => {
    it('#then the delete propagates instead of being skipped', () => {
      // Origin: the row already has a non-trivial real clock (as it would
      // after prior syncs), and the delete carries no snapshot -- the case
      // syncTagCategoryDelete always hits.
      const originClock: VectorClock = { 'device-A': 2 }
      testDb.db
        .insert(tagCategories)
        .values({ ...TEST_CATEGORY, clock: originClock })
        .run()

      service.enqueueDelete('category-1')

      const [item] = queue.dequeue(1)
      expect(item.operation).toBe('delete')
      const payload = JSON.parse(item.payload) as { clock: VectorClock }

      // Peer: the same category, at the same clock it had after the last
      // sync -- exactly the state a receiving device would be in.
      const peerDb = createTestDataDb()
      try {
        peerDb.db
          .insert(tagCategories)
          .values({ ...TEST_CATEGORY, clock: originClock })
          .run()

        const result = tagCategoryHandler.applyDelete(
          { db: asSyncDb(peerDb.db), emit: vi.fn() },
          'category-1',
          payload.clock
        )

        expect(result).toBe('applied')
        const row = peerDb.db
          .select()
          .from(tagCategories)
          .where(eq(tagCategories.id, 'category-1'))
          .get()
        expect(row?.deletedAt).toBeTruthy()
      } finally {
        peerDb.close()
      }
    })
  })

  describe('module-level accessor', () => {
    it('#then getTagCategorySyncService returns null before init', () => {
      expect(getTagCategorySyncService()).toBeNull()
    })

    it('#then getTagCategorySyncService returns instance after init', () => {
      const svc = initTagCategorySyncService({
        queue,
        db: asSyncDb(testDb.db),
        getDeviceId: () => 'dev-1'
      })
      expect(getTagCategorySyncService()).toBe(svc)
    })

    it('#then resetTagCategorySyncService clears instance', () => {
      initTagCategorySyncService({ queue, db: asSyncDb(testDb.db), getDeviceId: () => 'dev-1' })
      resetTagCategorySyncService()
      expect(getTagCategorySyncService()).toBeNull()
    })
  })
})
