import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteMetadata } from '@memry/db-schema/data-schema'
import {
  FolderConfigSyncService,
  getFolderConfigSyncService,
  initFolderConfigSyncService,
  resetFolderConfigSyncService
} from '@memry/sync-client/folder-config-sync'
import {
  JournalSyncService,
  getJournalSyncService,
  initJournalSyncService,
  resetJournalSyncService
} from './journal-sync'
import {
  NoteSyncService,
  getNoteSyncService,
  initNoteSyncService,
  resetNoteSyncService
} from './note-sync'

type QueueItem = {
  type: string
  itemId: string
  operation: string
  payload: string
}

type FakeQueue = {
  items: QueueItem[]
  enqueue: (item: QueueItem) => void
  removeByItemId: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => ({
  local: undefined as NoteMetadata | undefined,
  updateNoteMetadata: vi.fn(),
  getNoteProperties: vi.fn(),
  getPinnedTagsForNote: vi.fn(),
  parseNote: vi.fn(),
  parseJournalEntry: vi.fn(),
  readFileSync: vi.fn(),
  log: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  },
  registerRenameSyncCallback: vi.fn(),
  unregisterRenameSyncCallback: vi.fn()
}))

vi.mock('@memry/sync-core', () => {
  const incrementClock = (clock: Record<string, number>, deviceId: string) => ({
    ...clock,
    [deviceId]: (clock[deviceId] ?? 0) + 1
  })

  return {
    incrementClock,
    withIncrementedClock: (payload: string, deviceId: string) => {
      const parsed = JSON.parse(payload)
      return JSON.stringify({
        ...parsed,
        clock: incrementClock((parsed.clock as Record<string, number>) ?? {}, deviceId)
      })
    },
    RecordSyncController: class FakeRecordSyncController {
      private config: Record<string, any>

      constructor(config: Record<string, any>) {
        this.config = config
      }

      enqueueCreate(itemId: string, ...extra: string[]) {
        this.enqueueSnapshot('create', itemId, extra)
      }

      enqueueUpdate(itemId: string, ...extra: string[]) {
        this.enqueueSnapshot('update', itemId, extra)
      }

      enqueueDelete(itemId: string, ...extra: string[]) {
        const deviceId = this.config.getDeviceId()
        if (!deviceId) {
          this.config.handleMissingDevice?.(itemId, 'delete')
          return
        }

        const payload = this.config.buildDeletePayload({
          itemId,
          local: this.config.load?.(itemId),
          deviceId,
          extra
        })
        if (payload === null) return

        this.config.queue.enqueue({
          type: this.config.type,
          itemId,
          operation: 'delete',
          payload: typeof payload === 'string' ? payload : JSON.stringify(payload)
        })
      }

      private enqueueSnapshot(operation: string, itemId: string, extra: string[]) {
        const deviceId = this.config.getDeviceId()
        if (!deviceId) {
          this.config.handleMissingDevice?.(itemId, operation)
          return
        }

        const local = this.config.load(itemId)
        if (!local || this.config.shouldSkip?.(local)) return

        const changed = this.config.applyLocalChange({ itemId, local, deviceId })
        const payload = this.config.serialize(changed, operation, extra)
        this.config.queue.enqueue({
          type: this.config.type,
          itemId,
          operation,
          payload: typeof payload === 'string' ? payload : JSON.stringify(payload)
        })
      }
    }
  }
})

vi.mock('fs', () => ({
  default: {
    readFileSync: (...args: unknown[]) => mocks.readFileSync(...args)
  }
}))

vi.mock('../database/client', () => ({
  getDatabase: vi.fn(() => ({})),
  getIndexDatabase: vi.fn(() => ({}))
}))

vi.mock('@memry/storage-data', () => ({
  getNoteMetadataById: vi.fn(() => mocks.local),
  updateNoteMetadata: (...args: unknown[]) => mocks.updateNoteMetadata(...args)
}))

vi.mock('@main/database/queries/notes', () => ({
  getNoteProperties: (...args: unknown[]) => mocks.getNoteProperties(...args)
}))

vi.mock('@memry/sync-client/item-handlers/note-pin-helpers', () => ({
  getPinnedTagsForNote: (...args: unknown[]) => mocks.getPinnedTagsForNote(...args)
}))

vi.mock('../vault/frontmatter', () => ({
  parseNote: (...args: unknown[]) => mocks.parseNote(...args),
  serializeNote: vi.fn(),
  serializeParsedNote: vi.fn()
}))

vi.mock('../vault/journal', () => ({
  getJournalPath: (date: string) => `/vault/journals/${date}.md`,
  parseJournalEntry: (...args: unknown[]) => mocks.parseJournalEntry(...args)
}))

vi.mock('../vault/notes', () => ({
  toAbsolutePath: (relativePath: string) => `/vault/${relativePath}`
}))

vi.mock('../vault/index', () => ({
  getConfig: () => ({ defaultNoteFolder: 'notes' })
}))

vi.mock('../vault/rename-tracker', () => ({
  registerRenameSyncCallback: (...args: unknown[]) => mocks.registerRenameSyncCallback(...args),
  unregisterRenameSyncCallback: (...args: unknown[]) => mocks.unregisterRenameSyncCallback(...args)
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => mocks.log
}))

function makeQueue(): FakeQueue {
  return {
    items: [],
    enqueue(item) {
      this.items.push(item)
    },
    removeByItemId: vi.fn(() => 1)
  }
}

function makeNote(overrides: Partial<NoteMetadata> = {}): NoteMetadata {
  return {
    id: 'note-1',
    path: 'notes/Projects/Plan.md',
    title: 'Plan',
    emoji: null,
    fileType: 'markdown',
    mimeType: null,
    fileSize: null,
    attachmentId: null,
    clock: {},
    createdAt: '2026-05-01T00:00:00.000Z',
    modifiedAt: '2026-05-02T00:00:00.000Z',
    localOnly: false,
    propertyDefinitionNames: null,
    createdAtEpoch: null,
    modifiedAtEpoch: null,
    deletedAt: null,
    ...overrides
  } as NoteMetadata
}

function makeFolderDb(local: Record<string, unknown> | undefined) {
  const updateRun = vi.fn()
  return {
    updateRun,
    select: () => ({ from: () => ({ where: () => ({ get: () => local }) }) }),
    update: () => ({ set: () => ({ where: () => ({ run: updateRun }) }) })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.local = makeNote()
  mocks.updateNoteMetadata.mockImplementation((_db, _id, updates) => ({
    ...mocks.local,
    ...updates
  }))
  mocks.getNoteProperties.mockReturnValue([{ name: 'Status', value: 'draft' }])
  mocks.getPinnedTagsForNote.mockReturnValue(['Pinned'])
  mocks.parseNote.mockReturnValue({
    content: 'body',
    frontmatter: { tags: ['tag'] }
  })
  mocks.parseJournalEntry.mockReturnValue({
    content: 'journal body',
    frontmatter: { tags: ['daily'], properties: { Mood: 'good' } }
  })
  mocks.readFileSync.mockReturnValue('raw')
  resetNoteSyncService()
  resetJournalSyncService()
  resetFolderConfigSyncService()
})

describe('content sync services', () => {
  it('queues markdown note snapshots, binary metadata, deletes, and remove-by-id', () => {
    const queue = makeQueue()
    const service = new NoteSyncService({
      queue: queue as never,
      getDeviceId: () => 'dev-a'
    })

    service.enqueueCreate('note-1')
    expect(JSON.parse(queue.items[0].payload)).toMatchObject({
      title: 'Plan',
      content: 'body',
      tags: ['tag'],
      properties: { Status: 'draft' },
      pinnedTags: ['Pinned'],
      folderPath: 'notes/Projects',
      clock: { 'dev-a': 1 }
    })

    mocks.local = makeNote({
      fileType: 'pdf',
      mimeType: 'application/pdf',
      attachmentId: 'att-1',
      path: 'notes/Files/Report.pdf'
    })
    service.enqueueUpdate('note-1')
    expect(JSON.parse(queue.items[1].payload)).toMatchObject({
      fileType: 'pdf',
      mimeType: 'application/pdf',
      attachmentId: 'att-1',
      folderPath: 'notes/Files'
    })

    service.enqueueDelete('note-1')
    // The tombstone carries the clock and nothing the user typed — no title.
    expect(JSON.parse(queue.items[2].payload)).toMatchObject({
      clock: { 'dev-a': 1 }
    })
    expect(JSON.parse(queue.items[2].payload)).not.toHaveProperty('title')
    expect(service.removeQueueItems('note-1')).toBe(1)
  })

  it('skips local-only notes, missing notes, missing devices, and unreadable files', () => {
    const queue = makeQueue()
    const service = new NoteSyncService({
      queue: queue as never,
      getDeviceId: () => 'dev-a'
    })

    mocks.local = makeNote({ localOnly: true })
    service.enqueueCreate('local-only')
    expect(queue.items).toEqual([])

    mocks.local = undefined
    service.enqueueCreate('missing')
    service.enqueueDelete('missing')
    expect(queue.items).toEqual([])
    expect(mocks.log.warn).toHaveBeenCalledWith('Note not found in cache for delete enqueue')

    const noDevice = new NoteSyncService({
      queue: queue as never,
      getDeviceId: () => null
    })
    mocks.local = makeNote()
    noDevice.enqueueUpdate('note-1')
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'No device ID, skipping note update enqueue',
      expect.any(Object)
    )

    mocks.readFileSync.mockImplementationOnce(() => {
      throw new Error('unreadable')
    })
    service.enqueueUpdate('note-1')
    expect(JSON.parse(queue.items[0].payload)).toMatchObject({ content: null, tags: [] })
  })

  it('tracks module-level note service lifecycle and rename callback wiring', () => {
    expect(getNoteSyncService()).toBeNull()
    const queue = makeQueue()
    const service = initNoteSyncService({
      queue: queue as never,
      getDeviceId: () => 'dev-a'
    })

    expect(getNoteSyncService()).toBe(service)
    expect(mocks.registerRenameSyncCallback).toHaveBeenCalledWith(expect.any(Function))
    const renameCallback = mocks.registerRenameSyncCallback.mock.calls[0][0] as (id: string) => void
    renameCallback('note-1')
    expect(queue.items).toHaveLength(1)

    resetNoteSyncService()
    expect(mocks.unregisterRenameSyncCallback).toHaveBeenCalled()
    expect(getNoteSyncService()).toBeNull()
  })

  it('queues journal snapshots and delete tombstones with date extra args', () => {
    const queue = makeQueue()
    const service = new JournalSyncService({
      queue: queue as never,
      getDeviceId: () => 'dev-a'
    })

    service.enqueueCreate('journal-2026-05-10', '2026-05-10')
    expect(JSON.parse(queue.items[0].payload)).toMatchObject({
      date: '2026-05-10',
      content: 'journal body',
      tags: ['daily'],
      properties: { Mood: 'good' },
      clock: { 'dev-a': 1 }
    })

    mocks.readFileSync.mockImplementationOnce(() => {
      throw new Error('missing')
    })
    service.enqueueUpdate('journal-2026-05-10', '2026-05-10')
    expect(JSON.parse(queue.items[1].payload)).toMatchObject({
      content: null,
      tags: [],
      properties: null
    })

    service.enqueueDelete('journal-2026-05-10', '2026-05-10')
    // The tombstone keeps the clock (push-coordinator reads it back out) but
    // drops the journalled day — no receiver ever decodes a delete body.
    const tombstone = JSON.parse(queue.items[2].payload) as Record<string, unknown>
    expect(tombstone).toMatchObject({ clock: { 'dev-a': 1 } })
    expect(Object.prototype.hasOwnProperty.call(tombstone, 'date')).toBe(false)

    expect(getJournalSyncService()).toBeNull()
    expect(
      initJournalSyncService({ queue: queue as never, getDeviceId: () => 'dev-a' })
    ).toBeInstanceOf(JournalSyncService)
    expect(getJournalSyncService()).toBeInstanceOf(JournalSyncService)
    resetJournalSyncService()
    expect(getJournalSyncService()).toBeNull()
  })

  it('queues folder config create, update, delete snapshot, and fallback delete payloads', () => {
    const queue = makeQueue()
    const db = makeFolderDb({ path: 'Work', icon: 'briefcase', clock: { 'dev-a': 2 } })
    const service = new FolderConfigSyncService({
      queue: queue as never,
      db: db as never,
      getDeviceId: () => 'dev-a'
    })

    service.enqueueCreate('Work')
    service.enqueueUpdate('Work')
    expect(queue.items.map((item) => item.operation)).toEqual(['create', 'update'])
    expect(JSON.parse(queue.items[0].payload).clock).toEqual({ 'dev-a': 3 })
    expect(db.updateRun).toHaveBeenCalled()

    service.enqueueDelete('Work', JSON.stringify({ path: 'Work', icon: 'briefcase' }))
    expect(JSON.parse(queue.items[2].payload)).toMatchObject({
      path: 'Work',
      icon: 'briefcase',
      clock: { 'dev-a': 1 }
    })

    service.enqueueDelete('Inbox')
    expect(JSON.parse(queue.items[3].payload)).toEqual({
      path: 'Inbox',
      icon: null,
      clock: { 'dev-a': 1 }
    })

    expect(getFolderConfigSyncService()).toBeNull()
    expect(
      initFolderConfigSyncService({
        queue: queue as never,
        db: db as never,
        getDeviceId: () => 'dev-a'
      })
    ).toBeInstanceOf(FolderConfigSyncService)
    expect(getFolderConfigSyncService()).toBeInstanceOf(FolderConfigSyncService)
    resetFolderConfigSyncService()
    expect(getFolderConfigSyncService()).toBeNull()
  })
})
