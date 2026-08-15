import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq, isNotNull } from 'drizzle-orm'
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
import { homePages } from '@memry/db-schema/schema/home-pages'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import { savedFilters, settings } from '@memry/db-schema/schema/settings'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { canvases } from '@memry/db-schema/schema/canvas'
import { canvasFolders } from '@memry/db-schema/schema/canvas-folder'
import { canvasFolderSyncId } from '@memry/contracts/canvas-folder-types'
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

  describe('#given clocked and unclocked home boards #when check runs', () => {
    it('#then re-enqueues only the clocked board, with the full row as the payload', async () => {
      // #given — an unclocked row belongs to seedUnclocked, not manifest repair
      testDb.db
        .insert(homePages)
        .values([
          { id: 'board-synced', name: 'Synced', clock: { 'device-A': 1 } as VectorClock },
          { id: 'board-local', name: 'Local Only' }
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

      // #then — buildRefPayload must have a `home_page` arm; the default returns ''
      const items = queue.dequeue(10)
      const queued = items.find((i) => i.itemId === 'board-synced')
      expect(queued).toBeDefined()
      expect(queued!.type).toBe('home_page')
      const [row] = testDb.db.select().from(homePages).where(eq(homePages.id, 'board-synced')).all()
      expect(queued!.payload).toBe(JSON.stringify(row))
      expect(items.find((i) => i.itemId === 'board-local')).toBeUndefined()
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

  function insertCanvasFolder(folderPath: string, deletedAt: number | null): void {
    testDb.db
      .insert(canvasFolders)
      .values({
        id: canvasFolderSyncId(folderPath),
        vaultId: 'vault-1',
        path: folderPath,
        icon: null,
        createdAt: 1,
        updatedAt: 1,
        deletedAt,
        clock: { 'device-A': 1 }
      })
      .run()
  }

  describe('#given a TOMBSTONED canvas folder missing from server #when check runs', () => {
    it('#then does NOT re-enqueue it (no fleet-wide resurrection)', async () => {
      // Same rule as the canvas block: the server manifest omits soft-deleted
      // items, so listing a tombstone here reads as `!serverRef` and re-enqueues
      // it as a `create`, NULLing the server's deleted_at and bringing the folder
      // (and its whole subtree) back on every device within 30 minutes.
      insertCanvasFolder('Deleted', Date.now())

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
      expect(items.find((i) => i.type === 'canvas_folder')).toBeUndefined()
    })
  })

  describe('#given a LIVE canvas folder missing from server #when check runs', () => {
    it('#then re-enqueues it as a create', async () => {
      insertCanvasFolder('Work', null)

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
      const folderItem = items.find((i) => i.type === 'canvas_folder')
      expect(folderItem).toBeDefined()
      expect(folderItem!.itemId).toBe(canvasFolderSyncId('Work'))
      expect(folderItem!.operation).toBe('create')
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

  /** One row of every syncable type, plus the manifest that matches it. */
  function seedOneOfEverySyncedType(): Array<{ id: string; type: string }> {
    const clock: VectorClock = { 'device-A': 1 }
    const timestamp = '2026-05-15T08:00:00.000Z'

    testDb.db.update(projects).set({ clock }).run()
    testDb.db
      .insert(tasks)
      .values({ id: 'task-1', projectId: 'proj-1', title: 'T', priority: 0, position: 0, clock })
      .run()
    testDb.db.insert(inboxItems).values({ id: 'inbox-1', title: 'I', type: 'note', clock }).run()
    testDb.db
      .insert(savedFilters)
      .values({ id: 'filter-1', name: 'F', config: { query: 'x' }, clock })
      .run()
    testDb.db.insert(templates).values({ id: 'tpl-1', name: 'Tpl', clock }).run()
    testDb.db
      .insert(bookmarks)
      .values({ id: 'bm-1', itemType: 'note', itemId: 'note-1', clock })
      .run()
    testDb.db
      .insert(reminders)
      .values({
        id: 'rem-1',
        targetType: 'note',
        targetId: 'note-1',
        remindAt: timestamp,
        status: 'triggered',
        triggeredAt: '2026-05-15T08:00:01.000Z',
        clock
      })
      .run()
    insertCanvas('canvas-1', null)
    testDb.db.insert(tagDefinitions).values({ name: 'important', color: '#ff0000', clock }).run()
    testDb.db.insert(settings).values({ key: 'synced_settings', value: '{}' }).run()
    testIndexDb.db
      .insert(noteCache)
      .values({
        id: 'note-1',
        path: 'notes/a.md',
        title: 'A',
        clock,
        createdAt: timestamp,
        modifiedAt: timestamp
      })
      .run()
    testIndexDb.db
      .insert(noteCache)
      .values({
        id: 'journal-1',
        path: 'journals/2026-02-18.md',
        title: '2026-02-18',
        date: '2026-02-18',
        clock,
        createdAt: timestamp,
        modifiedAt: timestamp
      })
      .run()

    return [
      { id: 'task-1', type: 'task' },
      { id: 'proj-1', type: 'project' },
      { id: 'inbox-1', type: 'inbox' },
      { id: 'filter-1', type: 'filter' },
      { id: 'tpl-1', type: 'template' },
      { id: 'bm-1', type: 'bookmark' },
      { id: 'rem-1', type: 'reminder' },
      { id: 'canvas-1', type: 'canvas' },
      { id: 'important', type: 'tag_definition' },
      { id: 'synced_settings', type: 'settings' },
      { id: 'note-1', type: 'note' },
      { id: 'journal-1', type: 'journal' }
    ]
  }

  describe('#given a clean vault where every local item is on the server #when check runs', () => {
    it('#then materializes no row payloads at all', async () => {
      // #given — one row of every syncable type, all present on the server
      const manifestItems = seedOneOfEverySyncedType()

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: manifestItems.map((i) => ({ ...i, version: 1, modifiedAt: 1000, size: 50 })),
        serverTime: Math.floor(Date.now() / 1000)
      })

      const { checkManifestIntegrity } = await import('./manifest-check')

      // #when — every row stringify on this path would be wasted work
      const stringifySpy = vi.spyOn(JSON, 'stringify')
      const result = await checkManifestIntegrity({
        db: asSyncDb(testDb.db),
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })
      const rowStringifies = stringifySpy.mock.calls.filter(
        ([value]) => typeof value === 'object' && value !== null
      )
      stringifySpy.mockRestore()

      // #then
      expect(rowStringifies).toEqual([])
      expect(result.rePullNeeded).toBe(false)
      expect(result.serverOnlyCount).toBe(0)
      expect(queue.getPendingCount()).toBe(0)
    })
  })

  describe('#given every local item missing from the server #when check runs', () => {
    it('#then the re-enqueued payloads are byte-identical to a full-table pass', async () => {
      // #given
      seedOneOfEverySyncedType()

      vi.spyOn(await import('./http-client'), 'getFromServer').mockResolvedValue({
        items: [],
        serverTime: Math.floor(Date.now() / 1000)
      })

      const { checkManifestIntegrity } = await import('./manifest-check')
      const { toOutboundReminderPayload } = await import('./reminder-outbound')

      // #when
      await checkManifestIntegrity({
        db: asSyncDb(testDb.db),
        queue,
        getAccessToken: async () => 'test-token',
        isOnline: () => true
      })

      // #then — expectations come from the eager full-table selects the old
      // implementation used, so any drift in serialized shape or key order
      // (which the server would read as a changed item) fails here.
      const queued = new Map(queue.dequeue(50).map((i) => [`${i.type}:${i.itemId}`, i.payload]))
      const [taskRow] = testDb.db.select().from(tasks).where(isNotNull(tasks.clock)).all()
      const [projectRow] = testDb.db.select().from(projects).where(isNotNull(projects.clock)).all()
      const [inboxRow] = testDb.db
        .select()
        .from(inboxItems)
        .where(isNotNull(inboxItems.clock))
        .all()
      const [filterRow] = testDb.db
        .select()
        .from(savedFilters)
        .where(isNotNull(savedFilters.clock))
        .all()
      const [templateRow] = testDb.db
        .select()
        .from(templates)
        .where(isNotNull(templates.clock))
        .all()
      const [bookmarkRow] = testDb.db
        .select()
        .from(bookmarks)
        .where(isNotNull(bookmarks.clock))
        .all()
      const [reminderRow] = testDb.db
        .select()
        .from(reminders)
        .where(isNotNull(reminders.clock))
        .all()
      const [canvasRow] = testDb.db.select().from(canvases).where(isNotNull(canvases.clock)).all()
      const [tagRow] = testDb.db
        .select()
        .from(tagDefinitions)
        .where(isNotNull(tagDefinitions.clock))
        .all()
      const [settingsRow] = testDb.db.select().from(settings).all()

      expect(queued.get('task:task-1')).toBe(JSON.stringify(taskRow))
      expect(queued.get('project:proj-1')).toBe(JSON.stringify(projectRow))
      expect(queued.get('inbox:inbox-1')).toBe(JSON.stringify(inboxRow))
      expect(queued.get('filter:filter-1')).toBe(JSON.stringify(filterRow))
      expect(queued.get('template:tpl-1')).toBe(JSON.stringify(templateRow))
      expect(queued.get('bookmark:bm-1')).toBe(JSON.stringify(bookmarkRow))
      expect(queued.get('reminder:rem-1')).toBe(
        JSON.stringify(toOutboundReminderPayload(reminderRow))
      )
      expect(queued.get('canvas:canvas-1')).toBe(
        JSON.stringify({
          id: canvasRow.id,
          vaultId: canvasRow.vaultId,
          title: canvasRow.title,
          clock: canvasRow.clock,
          deletedAt: null
        })
      )
      expect(queued.get('tag_definition:important')).toBe(JSON.stringify(tagRow))
      expect(queued.get('settings:synced_settings')).toBe(JSON.stringify(settingsRow))
      expect(queued.get('note:note-1')).toBe('')
      expect(queued.get('journal:journal-1')).toBe('')
    })
  })
})
