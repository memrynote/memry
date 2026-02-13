import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { tasks } from '@shared/db/schema/tasks'
import { projects } from '@shared/db/schema/projects'
import { inboxItems } from '@shared/db/schema/inbox'
import type { VectorClock } from '@shared/contracts/sync-api'
import { SyncQueueManager } from './queue'

const TEST_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  color: '#000',
  position: 0,
  isInbox: false
}

describe('checkManifestIntegrity', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager

  beforeEach(() => {
    vi.resetModules()
    testDb = createTestDataDb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queue = new SyncQueueManager(testDb.db as any)
    testDb.db.insert(projects).values(TEST_PROJECT).run()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    testDb.close()
  })

  describe('#given local item missing from server manifest #when check runs', () => {
    it('#then re-enqueues the missing item', async () => {
      // #given
      const clock: VectorClock = { 'device-A': 1 }
      testDb.db
        .insert(tasks)
        .values({ id: 'task-1', projectId: 'proj-1', title: 'Synced Task', priority: 0, position: 0, clock })
        .run()

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        serverTime: Math.floor(Date.now() / 1000)
      })

      const { checkManifestIntegrity } = await import('./manifest-check')

      // #when
      await checkManifestIntegrity({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: testDb.db as any,
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })

      // #then
      const [item] = queue.dequeue(1)
      expect(item).toBeDefined()
      expect(item.itemId).toBe('task-1')
      expect(item.type).toBe('task')
      expect(item.operation).toBe('update')
    })
  })

  describe('#given all local items present on server #when check runs', () => {
    it('#then does not re-enqueue anything', async () => {
      // #given
      const clock: VectorClock = { 'device-A': 1 }
      testDb.db
        .insert(tasks)
        .values({ id: 'task-1', projectId: 'proj-1', title: 'Synced', priority: 0, position: 0, clock })
        .run()

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [{ id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 50 }],
        serverTime: Math.floor(Date.now() / 1000)
      })

      const { checkManifestIntegrity } = await import('./manifest-check')

      // #when
      await checkManifestIntegrity({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: testDb.db as any,
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })

      // #then
      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#given no access token #when check runs', () => {
    it('#then returns early without network call', async () => {
      const getServerSpy = vi.spyOn(await import('./http-client'), 'getFromServer')

      const { checkManifestIntegrity } = await import('./manifest-check')

      await checkManifestIntegrity({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: testDb.db as any,
        queue,
        getAccessToken: async () => null,
        isOnline: () => true
      })

      expect(getServerSpy).not.toHaveBeenCalled()
    })
  })

  describe('#given rate limit not elapsed #when check runs twice', () => {
    it('#then second call returns early', async () => {
      // #given
      const clock: VectorClock = { 'device-A': 1 }
      testDb.db
        .insert(tasks)
        .values({ id: 'task-1', projectId: 'proj-1', title: 'T', priority: 0, position: 0, clock })
        .run()

      const getServerSpy = vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [{ id: 'task-1', type: 'task', version: 1, modifiedAt: 1000, size: 50 }],
        serverTime: Math.floor(Date.now() / 1000)
      })

      const { checkManifestIntegrity } = await import('./manifest-check')

      const deps = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: testDb.db as any,
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      }

      // #when — first call succeeds
      await checkManifestIntegrity(deps)
      expect(getServerSpy).toHaveBeenCalledTimes(1)

      // second call within rate limit window
      getServerSpy.mockClear()
      await checkManifestIntegrity(deps)

      // #then — no second network call
      expect(getServerSpy).not.toHaveBeenCalled()
    })
  })

  describe('#given inbox item with clock #when check runs', () => {
    it('#then includes inbox in local syncable items', async () => {
      // #given
      const clock: VectorClock = { 'device-A': 1 }
      testDb.db
        .insert(inboxItems)
        .values({ id: 'inbox-1', title: 'Synced Inbox', type: 'note', clock })
        .run()

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        serverTime: Math.floor(Date.now() / 1000)
      })

      const { checkManifestIntegrity } = await import('./manifest-check')

      // #when
      await checkManifestIntegrity({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: testDb.db as any,
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })

      // #then — inbox item re-enqueued
      const items = queue.dequeue(10)
      const inboxQueueItem = items.find((i) => i.itemId === 'inbox-1')
      expect(inboxQueueItem).toBeDefined()
      expect(inboxQueueItem!.type).toBe('inbox')
    })
  })
})
