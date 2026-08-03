import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createTestDataDb,
  createTestIndexDb,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { templates } from '@memry/db-schema/schema/templates'
import { settings } from '@memry/db-schema/schema/settings'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { canvases } from '@memry/db-schema/schema/canvas'
import { reminders } from '@memry/db-schema/schema/reminders'
import { noteMetadata } from '@memry/db-schema/data-schema'
import type { VectorClock } from '@memry/contracts/sync-api'
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
    queue = new SyncQueueManager(asClientDb(testDb.db))
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
        db: asSyncDb(testDb.db),
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
        db: asSyncDb(testDb.db),
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
        db: asSyncDb(testDb.db),
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
        db: asSyncDb(testDb.db),
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      }

      // #when — first call succeeds
      const first = await checkManifestIntegrity(deps)
      expect(getServerSpy).toHaveBeenCalledTimes(1)

      // second call within rate limit window
      getServerSpy.mockClear()
      await checkManifestIntegrity({ ...deps, lastCheckAt: first.checkedAt })

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
        db: asSyncDb(testDb.db),
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

  describe('#given clocked and unclocked templates #when check runs', () => {
    it('#then re-enqueues only the clocked template', async () => {
      // #given — an unclocked row belongs to seedUnclocked, not manifest repair
      testDb.db
        .insert(templates)
        .values([
          { id: 'tpl-synced', name: 'Synced', clock: { 'device-A': 1 } as VectorClock },
          { id: 'tpl-local', name: 'Local Only' }
        ])
        .run()

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        serverTime: Math.floor(Date.now() / 1000)
      })

      const { checkManifestIntegrity } = await import('./manifest-check')

      // #when
      await checkManifestIntegrity({
        db: asSyncDb(testDb.db),
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })

      // #then
      const items = queue.dequeue(10)
      const queued = items.find((i) => i.itemId === 'tpl-synced')
      expect(queued).toBeDefined()
      expect(queued!.type).toBe('template')
      expect(items.find((i) => i.itemId === 'tpl-local')).toBeUndefined()
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
        db: asSyncDb(testDb.db),
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
        db: asSyncDb(testDb.db),
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })

      // #then
      expect(result.rePullNeeded).toBe(false)
      expect(result.serverOnlyCount).toBe(0)
    })
  })

  describe('#given note with clock only in data db #when check runs', () => {
    it('#then recognizes note as local and does not trigger re-pull', async () => {
      // #given
      const clock: VectorClock = { 'device-A': 1 }
      testDb.db
        .insert(noteMetadata)
        .values({
          id: 'note-1',
          path: 'notes/test.md',
          title: 'Test Note',
          clock,
          createdAt: '2026-05-15T08:00:00.000Z',
          modifiedAt: '2026-05-15T08:01:00.000Z'
        })
        .run()

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [{ id: 'note-1', type: 'note', version: 1, modifiedAt: 1000, size: 50 }],
        serverTime: Math.floor(Date.now() / 1000)
      })

      const { checkManifestIntegrity } = await import('./manifest-check')

      // #when
      const result = await checkManifestIntegrity({
        db: asSyncDb(testDb.db),
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
        db: asSyncDb(testDb.db),
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
        db: asSyncDb(testDb.db),
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })

      // #then
      expect(result.rePullNeeded).toBe(false)
      expect(result.serverOnlyCount).toBe(0)
    })
  })

  describe('#given a triggered reminder missing from server manifest #when check runs', () => {
    it('#then re-enqueues it with status normalized to pending (triggered is device-local)', async () => {
      // #given
      const clock: VectorClock = { 'device-A': 1 }
      testDb.db
        .insert(reminders)
        .values({
          id: 'rem-1',
          targetType: 'note',
          targetId: 'note-1',
          remindAt: '2026-05-15T08:00:00.000Z',
          status: 'triggered',
          triggeredAt: '2026-05-15T08:00:01.000Z',
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
        db: asSyncDb(testDb.db),
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })

      // #then — re-enqueued as create, but with status normalized and
      // triggeredAt stripped, matching reminder-sync.ts/reminder-handler.ts
      const items = queue.dequeue(10)
      const reminderItem = items.find((i) => i.itemId === 'rem-1')
      expect(reminderItem).toBeDefined()
      expect(reminderItem!.type).toBe('reminder')
      const payload = JSON.parse(reminderItem!.payload)
      expect(payload.status).toBe('pending')
      expect(payload).not.toHaveProperty('triggeredAt')
    })
  })

  function insertCanvas(id: string, deletedAt: number | null): void {
    testDb.db
      .insert(canvases)
      .values({
        id,
        vaultId: 'vault-1',
        title: 'C',
        snapshotCiphertext: 'ciphertext',
        vectorClock: {},
        createdAt: 1,
        updatedAt: 1,
        deletedAt,
        lastSyncedAt: null,
        clock: { 'device-A': 1 }
      })
      .run()
  }

  describe('#given a synced canvas present on server #when check runs', () => {
    it('#then recognizes canvas as local and does not trigger re-pull', async () => {
      insertCanvas('canvas-1', null)

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [{ id: 'canvas-1', type: 'canvas', version: 1, modifiedAt: 1000, size: 50 }],
        serverTime: Math.floor(Date.now() / 1000)
      })

      const { checkManifestIntegrity } = await import('./manifest-check')
      const result = await checkManifestIntegrity({
        db: asSyncDb(testDb.db),
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })

      expect(result.rePullNeeded).toBe(false)
      expect(result.serverOnlyCount).toBe(0)
      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#given a synced canvas missing from server #when check runs', () => {
    it('#then re-enqueues it as a create', async () => {
      insertCanvas('canvas-live', null)

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        serverTime: Math.floor(Date.now() / 1000)
      })

      const { checkManifestIntegrity } = await import('./manifest-check')
      await checkManifestIntegrity({
        db: asSyncDb(testDb.db),
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })

      const items = queue.dequeue(10)
      const canvasItem = items.find((i) => i.itemId === 'canvas-live')
      expect(canvasItem).toBeDefined()
      expect(canvasItem!.type).toBe('canvas')
      expect(canvasItem!.operation).toBe('create')
    })
  })

  describe('#given a TOMBSTONED canvas missing from server #when check runs (D2)', () => {
    it('#then does NOT re-enqueue it (no fleet-wide resurrection)', async () => {
      insertCanvas('canvas-del', Date.now())

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        serverTime: Math.floor(Date.now() / 1000)
      })

      const { checkManifestIntegrity } = await import('./manifest-check')
      await checkManifestIntegrity({
        db: asSyncDb(testDb.db),
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })

      const items = queue.dequeue(10)
      expect(items.find((i) => i.itemId === 'canvas-del')).toBeUndefined()
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
        db: asSyncDb(testDb.db),
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
