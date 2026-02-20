import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { tasks } from '@shared/db/schema/tasks'
import { projects } from '@shared/db/schema/projects'
import { inboxItems } from '@shared/db/schema/inbox'
import { settings } from '@shared/db/schema/settings'
import { tagDefinitions } from '@shared/db/schema/tag-definitions'
import { noteCache } from '@shared/db/schema/notes-cache'
import type { VectorClock } from '@shared/contracts/sync-api'
import { SyncQueueManager } from './queue'

vi.mock('../database/client', () => ({
  getIndexDatabase: vi.fn()
}))

const TEST_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  color: '#000',
  position: 0,
  isInbox: false
}

describe('checkManifestIntegrity', () => {
  let testDb: TestDatabaseResult
  let testIndexDb: TestDatabaseResult
  let queue: SyncQueueManager

  beforeEach(async () => {
    vi.resetModules()
    testDb = createTestDataDb()
    testIndexDb = createTestIndexDb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queue = new SyncQueueManager(testDb.db as any)
    testDb.db.insert(projects).values(TEST_PROJECT).run()

    const { getIndexDatabase } = await import('../database/client')
    vi.mocked(getIndexDatabase).mockReturnValue(testIndexDb.db)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    testDb.close()
    testIndexDb.close()
  })

  describe('#given local item missing from server manifest #when check runs', () => {
    it('#then re-enqueues the missing item', async () => {
      // #given
      const clock: VectorClock = { 'device-A': 1 }
      testDb.db
        .insert(tasks)
        .values({
          id: 'task-1',
          projectId: 'proj-1',
          title: 'Synced Task',
          priority: 0,
          position: 0,
          clock
        })
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
      expect(item.operation).toBe('create')
    })
  })

  describe('#given all local items present on server #when check runs', () => {
    it('#then does not re-enqueue anything', async () => {
      // #given
      const clock: VectorClock = { 'device-A': 1 }
      testDb.db
        .insert(tasks)
        .values({
          id: 'task-1',
          projectId: 'proj-1',
          title: 'Synced',
          priority: 0,
          position: 0,
          clock
        })
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

      const getServerSpy = vi
        .spyOn(await import('./http-client'), 'getFromServer')
        .mockResolvedValue({
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

  describe('#given project with clock on server #when check runs', () => {
    it('#then recognizes project as local and does not trigger re-pull', async () => {
      // #given
      const clock: VectorClock = { 'device-A': 1 }
      testDb.db.update(projects).set({ clock }).run()

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [{ id: 'proj-1', type: 'project', version: 1, modifiedAt: 1000, size: 50 }],
        serverTime: Math.floor(Date.now() / 1000)
      })

      const { checkManifestIntegrity } = await import('./manifest-check')

      // #when
      const result = await checkManifestIntegrity({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: testDb.db as any,
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })

      // #then
      expect(result.rePullNeeded).toBe(false)
      expect(result.serverOnlyCount).toBe(0)
    })
  })

  describe('#given note with clock in index db #when check runs', () => {
    it('#then recognizes note as local and does not trigger re-pull', async () => {
      // #given
      const clock: VectorClock = { 'device-A': 1 }
      testIndexDb.db
        .insert(noteCache)
        .values({
          id: 'note-1',
          path: 'notes/test.md',
          title: 'Test Note',
          clock,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString()
        })
        .run()

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [{ id: 'note-1', type: 'note', version: 1, modifiedAt: 1000, size: 50 }],
        serverTime: Math.floor(Date.now() / 1000)
      })

      const { checkManifestIntegrity } = await import('./manifest-check')

      // #when
      const result = await checkManifestIntegrity({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: testDb.db as any,
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })

      // #then
      expect(result.rePullNeeded).toBe(false)
      expect(result.serverOnlyCount).toBe(0)
    })
  })

  describe('#given journal with clock in index db #when check runs', () => {
    it('#then recognizes journal as local and does not trigger re-pull', async () => {
      // #given
      const clock: VectorClock = { 'device-A': 1 }
      testIndexDb.db
        .insert(noteCache)
        .values({
          id: 'journal-1',
          path: 'journals/2026-02-18.md',
          title: '2026-02-18',
          date: '2026-02-18',
          clock,
          createdAt: new Date().toISOString(),
          modifiedAt: new Date().toISOString()
        })
        .run()

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [{ id: 'journal-1', type: 'journal', version: 1, modifiedAt: 1000, size: 50 }],
        serverTime: Math.floor(Date.now() / 1000)
      })

      const { checkManifestIntegrity } = await import('./manifest-check')

      // #when
      const result = await checkManifestIntegrity({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: testDb.db as any,
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })

      // #then
      expect(result.rePullNeeded).toBe(false)
      expect(result.serverOnlyCount).toBe(0)
    })
  })

  describe('#given tag_definition with clock on server #when check runs', () => {
    it('#then recognizes tag as local and does not trigger re-pull', async () => {
      // #given
      const clock: VectorClock = { 'device-A': 1 }
      testDb.db.insert(tagDefinitions).values({ name: 'important', color: '#ff0000', clock }).run()

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [
          { id: 'important', type: 'tag_definition', version: 1, modifiedAt: 1000, size: 50 }
        ],
        serverTime: Math.floor(Date.now() / 1000)
      })

      const { checkManifestIntegrity } = await import('./manifest-check')

      // #when
      const result = await checkManifestIntegrity({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: testDb.db as any,
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })

      // #then
      expect(result.rePullNeeded).toBe(false)
      expect(result.serverOnlyCount).toBe(0)
    })
  })

  describe('#given synced_settings exists locally and on server #when check runs', () => {
    it('#then recognizes settings as local and does not trigger re-pull', async () => {
      // #given
      testDb.db.insert(settings).values({ key: 'synced_settings', value: '{}' }).run()

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [
          { id: 'synced_settings', type: 'settings', version: 1, modifiedAt: 1000, size: 50 }
        ],
        serverTime: Math.floor(Date.now() / 1000)
      })

      const { checkManifestIntegrity } = await import('./manifest-check')

      // #when
      const result = await checkManifestIntegrity({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: testDb.db as any,
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })

      // #then
      expect(result.rePullNeeded).toBe(false)
      expect(result.serverOnlyCount).toBe(0)
    })
  })
})
