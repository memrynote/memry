import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Logger from 'electron-log'
import type { SyncItemType, VectorClock } from '@memry/contracts/sync-api'
import type { NoteMetadata } from '@memry/db-schema/data-schema'
import { ContentSyncService } from './content-sync-base'

// The base class every note/journal/canvas-style content sync service extends.
// Its decision surface is small but load-bearing for a paying multi-device
// user: which local rows are allowed to leave the device, how the vector clock
// advances (and is persisted) before a push, and which enqueues are dropped.
// The real RecordSyncController from @memry/sync-core is used deliberately —
// mocking it (as content-sync-services.test.ts does) hides the wiring this
// file exists to provide.

const mocks = vi.hoisted(() => ({
  local: undefined as NoteMetadata | undefined,
  getNoteMetadataById: vi.fn(),
  updateNoteMetadata: vi.fn(),
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => mocks.log
}))

vi.mock('../database/client', () => ({
  getDatabase: vi.fn(() => ({ __db: 'data' }))
}))

vi.mock('@memry/storage-data', () => ({
  getNoteMetadataById: (...args: unknown[]) => mocks.getNoteMetadataById(...args),
  updateNoteMetadata: (...args: unknown[]) => mocks.updateNoteMetadata(...args)
}))

interface QueuedItem {
  type: SyncItemType
  itemId: string
  operation: string
  payload: string
  priority?: number
}

function makeQueue(): { items: QueuedItem[]; enqueue: (item: QueuedItem) => string } {
  const items: QueuedItem[] = []
  return {
    items,
    enqueue(item) {
      items.push(item)
      return `queue-${items.length}`
    }
  }
}

function makeNote(overrides: Partial<NoteMetadata> = {}): NoteMetadata {
  return {
    id: 'note-1',
    path: 'notes/Plan.md',
    title: 'Plan',
    clock: {},
    localOnly: false,
    ...overrides
  } as NoteMetadata
}

type SnapshotCall = {
  cached: NoteMetadata
  clock: VectorClock
  operation: 'create' | 'update'
  extra: string[]
}

class TestContentSync extends ContentSyncService<Record<string, unknown>, []> {
  readonly itemType: SyncItemType = 'note'
  protected readonly log = mocks.log as unknown as Logger.LogFunctions
  readonly snapshotCalls: SnapshotCall[] = []
  readonly deleteCalls: Array<{ cached: NoteMetadata | undefined; clock: VectorClock }> = []
  deletePayload: Record<string, unknown> | null = { tombstone: true }

  protected buildSnapshotPayload(
    cached: NoteMetadata,
    clock: VectorClock,
    operation: 'create' | 'update'
  ): Record<string, unknown> {
    this.snapshotCalls.push({ cached, clock, operation, extra: [] })
    return { id: cached.id, title: cached.title, clock, operation }
  }

  protected buildDeletePayload(
    cached: NoteMetadata | undefined,
    clock: VectorClock
  ): Record<string, unknown> | null {
    this.deleteCalls.push({ cached, clock })
    return this.deletePayload === null ? null : { ...this.deletePayload, clock }
  }
}

/** Journal-shaped subclass: extra args (the journal date) must reach both builders. */
class TestDatedContentSync extends ContentSyncService<Record<string, unknown>, [string]> {
  readonly itemType: SyncItemType = 'journal'
  protected readonly log = mocks.log as unknown as Logger.LogFunctions
  readonly extras: string[][] = []

  protected buildSnapshotPayload(
    cached: NoteMetadata,
    clock: VectorClock,
    operation: 'create' | 'update',
    date: string
  ): Record<string, unknown> {
    this.extras.push(['snapshot', operation, date])
    return { id: cached.id, date, clock }
  }

  protected buildDeletePayload(
    _cached: NoteMetadata | undefined,
    clock: VectorClock,
    date: string
  ): Record<string, unknown> | null {
    this.extras.push(['delete', date])
    return { date, clock }
  }
}

function makeService(deviceId: string | null = 'dev-a'): {
  service: TestContentSync
  queue: ReturnType<typeof makeQueue>
} {
  const queue = makeQueue()
  const service = new TestContentSync({
    queue: queue as never,
    getDeviceId: () => deviceId
  })
  return { service, queue }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.local = makeNote()
  mocks.getNoteMetadataById.mockImplementation(() => mocks.local)
  mocks.updateNoteMetadata.mockImplementation((_db, _id, updates) => ({
    ...(mocks.local as NoteMetadata),
    ...updates
  }))
})

describe('ContentSyncService', () => {
  describe('#given a syncable note #when enqueueCreate/enqueueUpdate', () => {
    it('#then the clock is incremented, persisted, and pushed as one value', () => {
      // The clock written to the row and the clock inside the payload must be
      // identical: a divergence means the server records a version the local
      // row never claims, and the item re-pushes forever.
      const { service, queue } = makeService()
      mocks.local = makeNote({ clock: {} })

      service.enqueueCreate('note-1')

      expect(mocks.updateNoteMetadata).toHaveBeenCalledWith({ __db: 'data' }, 'note-1', {
        clock: { 'dev-a': 1 }
      })
      expect(queue.items).toHaveLength(1)
      expect(queue.items[0]).toMatchObject({
        type: 'note',
        itemId: 'note-1',
        operation: 'create',
        priority: 0
      })
      expect(JSON.parse(queue.items[0].payload)).toEqual({
        id: 'note-1',
        title: 'Plan',
        clock: { 'dev-a': 1 },
        operation: 'create'
      })
    })

    it('#then other devices’ clock entries are preserved, not overwritten', () => {
      // Dropping a peer entry makes the merge look like a fresh write and
      // silently wins conflicts it should lose.
      const { service, queue } = makeService()
      mocks.local = makeNote({ clock: { 'dev-a': 2, 'dev-b': 7 } as never })

      service.enqueueUpdate('note-1')

      expect(JSON.parse(queue.items[0].payload).clock).toEqual({ 'dev-a': 3, 'dev-b': 7 })
    })

    it('#then a missing clock column is treated as an empty clock', () => {
      const { service, queue } = makeService()
      mocks.local = makeNote({ clock: null as never })

      service.enqueueUpdate('note-1')

      expect(JSON.parse(queue.items[0].payload).clock).toEqual({ 'dev-a': 1 })
    })

    it('#then the snapshot builder receives the persisted row and the new clock', () => {
      const { service } = makeService()
      mocks.local = makeNote({ clock: { 'dev-a': 5 } as never })

      service.enqueueUpdate('note-1')

      expect(service.snapshotCalls).toHaveLength(1)
      expect(service.snapshotCalls[0].operation).toBe('update')
      expect(service.snapshotCalls[0].clock).toEqual({ 'dev-a': 6 })
      expect(service.snapshotCalls[0].cached.clock).toEqual({ 'dev-a': 6 })
    })

    it('#then the in-memory clock is still used when the row write returns nothing', () => {
      // updateNoteMetadata returns undefined when the row vanished mid-write
      // (concurrent delete). The push must still go out with the advanced
      // clock rather than being dropped.
      const { service, queue } = makeService()
      mocks.local = makeNote({ clock: { 'dev-a': 1 } as never })
      mocks.updateNoteMetadata.mockReturnValue(undefined)

      service.enqueueUpdate('note-1')

      expect(queue.items).toHaveLength(1)
      expect(JSON.parse(queue.items[0].payload).clock).toEqual({ 'dev-a': 2 })
    })
  })

  describe('#given a local-only note #when enqueued', () => {
    it('#then nothing is queued and no clock is written', () => {
      // localOnly is the user's "this never leaves my machine" switch. A leak
      // here uploads private content to the server.
      const { service, queue } = makeService()
      mocks.local = makeNote({ localOnly: true })

      service.enqueueCreate('note-1')
      service.enqueueUpdate('note-1')
      service.enqueueRecoveredUpdate('note-1')

      expect(queue.items).toEqual([])
      expect(mocks.updateNoteMetadata).not.toHaveBeenCalled()
    })

    it('#then a row that becomes local-only during the write is still skipped', () => {
      const { service, queue } = makeService()
      mocks.local = makeNote({ localOnly: false })
      mocks.updateNoteMetadata.mockImplementation((_db, _id, updates) => ({
        ...makeNote({ localOnly: true }),
        ...updates
      }))

      service.enqueueUpdate('note-1')

      expect(queue.items).toEqual([])
    })
  })

  describe('#given the note row is missing #when enqueued', () => {
    it('#then the enqueue is dropped silently and no missing-device warning is logged', () => {
      const { service, queue } = makeService()
      mocks.local = undefined

      service.enqueueCreate('gone')
      service.enqueueUpdate('gone')
      service.enqueueRecoveredUpdate('gone')

      expect(queue.items).toEqual([])
      expect(mocks.updateNoteMetadata).not.toHaveBeenCalled()
      expect(mocks.log.warn).not.toHaveBeenCalled()
    })
  })

  describe('#given no device id yet #when enqueued', () => {
    it('#then the create/update enqueue warns and writes nothing', () => {
      const { service, queue } = makeService(null)

      service.enqueueCreate('note-1')
      service.enqueueUpdate('note-1')

      expect(queue.items).toEqual([])
      expect(mocks.updateNoteMetadata).not.toHaveBeenCalled()
      expect(mocks.log.warn).toHaveBeenCalledWith('No device ID, skipping note create enqueue', {
        itemId: 'note-1'
      })
      expect(mocks.log.warn).toHaveBeenCalledWith('No device ID, skipping note update enqueue', {
        itemId: 'note-1'
      })
    })

    it('#then the delete enqueue is dropped WITHOUT any warning', () => {
      // Asymmetry in the shared controller: enqueueDelete returns before
      // handleMissingDevice, so a delete issued while the device id is
      // momentarily unavailable disappears with no trace in the log. Recorded
      // here as current behaviour, not endorsed.
      const { service, queue } = makeService(null)

      service.enqueueDelete('note-1')

      expect(queue.items).toEqual([])
      expect(mocks.log.warn).not.toHaveBeenCalled()
    })

    it('#then the device id is read per enqueue, so sync recovers once it appears', () => {
      // The controller is built lazily and cached; the device id must NOT be
      // captured with it, or a service constructed before device registration
      // stays dead for the whole session.
      const queue = makeQueue()
      let deviceId: string | null = null
      const service = new TestContentSync({
        queue: queue as never,
        getDeviceId: () => deviceId
      })

      service.enqueueUpdate('note-1')
      expect(queue.items).toEqual([])

      deviceId = 'dev-late'
      service.enqueueUpdate('note-1')

      expect(queue.items).toHaveLength(1)
      expect(JSON.parse(queue.items[0].payload).clock).toEqual({ 'dev-late': 1 })
    })
  })

  describe('#given a delete #when enqueueDelete', () => {
    it('#then a tombstone is queued with an advanced clock and serialized once', () => {
      const { service, queue } = makeService()
      mocks.local = makeNote({ clock: { 'dev-a': 4 } as never })

      service.enqueueDelete('note-1')

      expect(queue.items).toHaveLength(1)
      expect(queue.items[0].operation).toBe('delete')
      expect(typeof queue.items[0].payload).toBe('string')
      expect(JSON.parse(queue.items[0].payload)).toEqual({
        tombstone: true,
        clock: { 'dev-a': 5 }
      })
      // The delete path never rewrites the local row's clock.
      expect(mocks.updateNoteMetadata).not.toHaveBeenCalled()
    })

    it('#then a builder returning null suppresses the enqueue entirely', () => {
      const { service, queue } = makeService()
      service.deletePayload = null

      service.enqueueDelete('note-1')

      expect(queue.items).toEqual([])
    })

    it('#then a delete for an already-removed row still builds from an empty clock', () => {
      const { service, queue } = makeService()
      mocks.local = undefined

      service.enqueueDelete('note-1')

      expect(service.deleteCalls[0].cached).toBeUndefined()
      expect(service.deleteCalls[0].clock).toEqual({ 'dev-a': 1 })
      expect(queue.items).toHaveLength(1)
    })

    // BUG: `shouldSkip` (localOnly) is wired into the snapshot path only — the
    // controller's delete path never consults it. Deleting a note the user
    // marked local-only therefore pushes a tombstone, and the real
    // NoteSyncService.buildDeletePayload puts the note's TITLE in it. A note
    // that was promised never to leave the device leaks its title to the
    // server the moment it is deleted. Fix belongs here: apply the same
    // localOnly guard to buildDeletePayload (return null for local-only rows).
    it.fails('#then a local-only row is NOT tombstoned to the server', () => {
      const { service, queue } = makeService()
      mocks.local = makeNote({ localOnly: true })

      service.enqueueDelete('note-1')

      expect(queue.items).toEqual([])
    })
  })

  describe('#given a push that never reached the server #when enqueueRecoveredUpdate', () => {
    it('#then the stored clock is replayed unchanged and never re-incremented', () => {
      // Documented contract of enqueueRecoveredUpdate: bumping the clock again
      // widens the gap with the server instead of closing it. The server
      // replay-detects an in-step item and just marks it synced.
      const { service, queue } = makeService()
      mocks.local = makeNote({ clock: { 'dev-a': 9, 'dev-b': 2 } as never })

      service.enqueueRecoveredUpdate('note-1')

      expect(mocks.updateNoteMetadata).not.toHaveBeenCalled()
      expect(queue.items).toHaveLength(1)
      expect(queue.items[0].operation).toBe('update')
      expect(JSON.parse(queue.items[0].payload).clock).toEqual({ 'dev-a': 9, 'dev-b': 2 })
    })

    it('#then it is dropped when there is no device id', () => {
      const { service, queue } = makeService(null)

      service.enqueueRecoveredUpdate('note-1')

      expect(queue.items).toEqual([])
    })
  })

  describe('#given a service with extra args #when enqueued', () => {
    it('#then the extras reach both the snapshot and the delete builder', () => {
      const queue = makeQueue()
      const service = new TestDatedContentSync({
        queue: queue as never,
        getDeviceId: () => 'dev-a'
      })

      service.enqueueCreate('journal-1', '2026-08-05')
      service.enqueueDelete('journal-1', '2026-08-05')

      expect(service.extras).toEqual([
        ['snapshot', 'create', '2026-08-05'],
        ['delete', '2026-08-05']
      ])
      expect(queue.items.map((i) => i.type)).toEqual(['journal', 'journal'])
      expect(JSON.parse(queue.items[0].payload).date).toBe('2026-08-05')
    })

    it('#then a recovered update loses the extras (falls back to empty args)', () => {
      // enqueueRecoveredUpdate takes no extras by design, so a dated subclass
      // rebuilds its payload with an empty date. Journal recovery relies on
      // the date being derivable from the row.
      const queue = makeQueue()
      const service = new TestDatedContentSync({
        queue: queue as never,
        getDeviceId: () => 'dev-a'
      })

      service.enqueueRecoveredUpdate('journal-1')

      expect(service.extras).toEqual([['snapshot', 'update', undefined as unknown as string]])
    })
  })

  describe('#given repeated enqueues #when the controller is reused', () => {
    it('#then every enqueue re-reads the row rather than caching the first load', () => {
      const { service, queue } = makeService()
      mocks.local = makeNote({ title: 'First', clock: {} })

      service.enqueueUpdate('note-1')
      mocks.local = makeNote({ title: 'Second', clock: {} })
      service.enqueueUpdate('note-1')

      expect(queue.items.map((i) => JSON.parse(i.payload).title)).toEqual(['First', 'Second'])
      expect(mocks.getNoteMetadataById).toHaveBeenCalledTimes(2)
    })
  })
})
